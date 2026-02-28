"use client";

import { useState, useEffect, useCallback } from "react";
// JSONRpcProvider removed — using raw fetch for RPC calls
import { BinaryWriter } from "@btc-vision/transaction";
import { networks } from "@btc-vision/bitcoin";
import { Buffer } from "buffer";

(globalThis as any).Buffer = Buffer;

// ── Config ────────────────────────────────────────────────────────────────────
// P2OP (SegWit v16) — native OPNet contract address format, do NOT convert
const CONTRACT_ADDRESS = "opr1sqpnevnum64xv0x80jze9lesrwksty7hjhqxffn9g";
const OPNET_RPC_URL    = "https://regtest.opnet.org";
const NETWORK          = networks.regtest;

// ─────────────────────────────────────────────────────────────────────────────
//  SELECTORS
//  OPNet selector = перші 4 байти SHA-256 від назви методу (UTF-8)
//  Кешуємо після першого обчислення
// ─────────────────────────────────────────────────────────────────────────────

const selectorCache: Record<string, Uint8Array> = {};

async function selector(name: string): Promise<Uint8Array> {
  if (selectorCache[name]) return selectorCache[name];
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name));
  selectorCache[name] = new Uint8Array(hash).slice(0, 4);
  return selectorCache[name];
}

// ─────────────────────────────────────────────────────────────────────────────
//  CALLDATA ENCODERS — BinaryWriter з @btc-vision/transaction
// ─────────────────────────────────────────────────────────────────────────────

function writerToBuffer(writer: BinaryWriter): Buffer {
  // BinaryWriter may expose buffer via different properties
  const buf = (writer as any).buffer
    ?? (writer as any).toBuffer?.()
    ?? (writer as any).getBuffer?.()
    ?? (writer as any).toBytes?.()
    ?? (writer as any)._buffer;
  if (!buf) throw new Error("BinaryWriter: cannot extract buffer. Check @btc-vision/transaction version.");
  return Buffer.from(buf);
}

async function encodeCreateOrder(price: bigint, deadlineBlocks: bigint): Promise<Buffer> {
  const sel    = await selector("createOrder");
  const writer = new BinaryWriter();
  writer.writeU256(price);
  writer.writeU64(deadlineBlocks);
  return Buffer.concat([Buffer.from(sel), writerToBuffer(writer)]);
}

async function encodeWithOrderId(method: string, orderId: bigint): Promise<Buffer> {
  const sel    = await selector(method);
  const writer = new BinaryWriter();
  writer.writeU64(orderId);
  return Buffer.concat([Buffer.from(sel), writerToBuffer(writer)]);
}

async function encodeGetEscrowStats(): Promise<Buffer> {
  return Buffer.from(await selector("getEscrowStats"));
}

// ─────────────────────────────────────────────────────────────────────────────
//  RESPONSE DECODERS
// ─────────────────────────────────────────────────────────────────────────────

function decodeOrderResponse(hex: string): any {
  try {
    const buf = Buffer.from(hex.replace(/^0x/, ""), "hex");
    if (buf.length < 8) return null;
    let offset = 0;

    const readU64 = () => {
      const lo = buf.readUInt32LE(offset);
      const hi = buf.readUInt32LE(offset + 4);
      offset += 8;
      return BigInt(hi) * 0x100000000n + BigInt(lo);
    };

    const readU256 = () => {
      const bytes = buf.slice(offset, offset + 32);
      offset += 32;
      let val = 0n;
      for (let i = 31; i >= 0; i--) val = (val << 8n) | BigInt(bytes[i]);
      return val;
    };

    const readAddress = () => {
      const bytes = buf.slice(offset, offset + 33);
      offset += 33;
      return "0x" + bytes.toString("hex");
    };

    const readU8 = () => { const v = buf[offset]; offset++; return v; };

    return {
      orderId:    readU64(),
      seller:     readAddress(),
      buyer:      readAddress(),
      price:      readU256(),
      locked:     readU256(),
      state:      readU8(),
      deadline:   readU64(),
      acceptedAt: readU64(),
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TX SENDER
// ─────────────────────────────────────────────────────────────────────────────

async function sendContractTx(
  provider: any,
  calldata: Buffer,
  statusCb: (msg: string) => void
): Promise<void> {
  statusCb("Preparing transaction…");
  statusCb("Fetching UTXOs…");
  const rawUtxos: any[] = await provider.getBitcoinUtxos();
  if (!rawUtxos.length) throw new Error("No UTXOs available");

  const raw        = [...rawUtxos].sort((a, b) => Number(b.value) - Number(a.value))[0];
  const inputValue = BigInt(raw.value);
  const fee        = 10_000n;
  const change     = inputValue - fee;
  if (change <= 546n) throw new Error("Insufficient balance to cover fee");

  const scriptHex = (raw.scriptPubKey?.hex ?? "") as string;
  const scriptBuf = Buffer.from(scriptHex, "hex");

  const opReturnData   = Buffer.concat([Buffer.from(CONTRACT_ADDRESS, "utf8"), calldata]);
  const opReturnScript = Uint8Array.from(
    Buffer.concat([Buffer.from([0x6a, opReturnData.length]), opReturnData])
  );

  const { Psbt } = await import("bitcoinjs-lib");
  const psbt = new Psbt({ network: NETWORK as any });

  if (scriptHex.startsWith("5120")) {
    psbt.addInput({
      hash:           raw.transactionId,
      index:          raw.outputIndex,
      witnessUtxo:    { script: scriptBuf, value: inputValue },
      tapInternalKey: Buffer.from(scriptHex.slice(4), "hex"),
    });
  } else {
    psbt.addInput({
      hash:        raw.transactionId,
      index:       raw.outputIndex,
      witnessUtxo: { script: scriptBuf, value: inputValue },
    });
  }

  psbt.addOutput({ script: opReturnScript,             value: 0n     });
  psbt.addOutput({ script: Uint8Array.from(scriptBuf), value: change });

  statusCb("Waiting for wallet signature…");
  const signed = await provider.signPsbt(psbt.toHex());
  statusCb("Broadcasting…");
  await provider.pushPsbt(signed);
}

// ─────────────────────────────────────────────────────────────────────────────
//  READ-ONLY RPC CALL
// ─────────────────────────────────────────────────────────────────────────────

async function rpcCall(calldata: Buffer): Promise<string | null> {
  const res = await fetch(OPNET_RPC_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      jsonrpc: "2.0",
      id:      1,
      method:  "btc_call",
      params:  [CONTRACT_ADDRESS, "0x" + calldata.toString("hex"), "latest"],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error("RPC: " + JSON.stringify(json.error));
  return json.result ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const STATE_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: "None",      color: "text-zinc-500"    },
  1: { label: "Created",   color: "text-sky-400"     },
  2: { label: "Accepted",  color: "text-violet-400"  },
  3: { label: "Funded",    color: "text-amber-400"   },
  4: { label: "Completed", color: "text-emerald-400" },
  5: { label: "Cancelled", color: "text-red-400"     },
  6: { label: "Disputed",  color: "text-orange-400"  },
};

const SERVICE_OPTIONS = [
  "Web Development",
  "Smart Contract Development",
  "Smart Contract Audit",
  "UI/UX Design",
  "Graphic Design",
  "Content Creation",
  "Marketing & Growth",
  "Consulting",
  "Security Review",
  "Other (Custom Service)",
];

function shortAddr(addr: string | null): string {
  if (!addr) return "—";
  return addr.slice(0, 8) + "…" + addr.slice(-6);
}

function satsToRbtc(sats: bigint): string {
  return (Number(sats) / 1e8).toFixed(8);
}

// ─────────────────────────────────────────────────────────────────────────────
//  COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function MarketplacePage() {
  const [connected, setConnected]     = useState(false);
  const [address, setAddress]         = useState<string | null>(null);
  const [rbtcBalance, setRbtcBalance] = useState("0.00000000");

  const [myPubKey, setMyPubKey]           = useState<string | null>(null);
  const [pubKeyLoading, setPubKeyLoading] = useState(false);
  const [pubKeyCopied, setPubKeyCopied]   = useState(false);
  const [counterpartyPubKey, setCounterpartyPubKey] = useState("");

  const [role, setRole]             = useState<"Buyer" | "Seller">("Buyer");
  const [activeTab, setActiveTab]   = useState<"create" | "manage">("create");
  const [status, setStatus]         = useState<string | null>(null);
  const [statusType, setStatusType] = useState<"info" | "ok" | "err">("info");

  const [serviceType, setServiceType]       = useState(SERVICE_OPTIONS[0]);
  const [customService, setCustomService]   = useState("");
  const [description, setDescription]       = useState("");
  const [priceRbtc, setPriceRbtc]           = useState("");
  const [deadlineBlocks, setDeadlineBlocks] = useState("144");

  const [orderIdInput, setOrderIdInput] = useState("");
  const [orderData, setOrderData]       = useState<any | null>(null);
  const [loadingOrder, setLoadingOrder] = useState(false);

  const ok  = (msg: string) => { setStatus(msg); setStatusType("ok");   };
  const err = (msg: string) => { setStatus(msg); setStatusType("err");  };
  const inf = (msg: string) => { setStatus(msg); setStatusType("info"); };

  const connectWallet = async () => {
    try {
      const opnet = (window as any).opnet;
      if (!opnet?.web3?.provider?.requestAccounts) {
        alert("OPWallet not found. Please install the OPNet wallet extension.");
        return;
      }
      const accounts = await opnet.web3.provider.requestAccounts();
      if (accounts?.length) {
        setAddress(accounts[0]);
        setConnected(true);
        try {
          const p = opnet.web3.provider;
          let pk: string | null = null;
          if (typeof p.getPublicKey === "function") pk = await p.getPublicKey();
          else if (typeof p.getPublicKeyInfo === "function") {
            const info = await p.getPublicKeyInfo(accounts[0]);
            pk = info?.publicKey ?? null;
          }
          if (pk) setMyPubKey(pk.replace(/^0x/, ""));
        } catch { /* non-fatal */ }
      }
    } catch (e: any) {
      err("Wallet connection failed: " + e.message);
    }
  };

  const disconnectWallet = () => {
    setConnected(false);
    setAddress(null);
    setMyPubKey(null);
  };

  const refreshBalance = useCallback(async () => {
    if (!connected) return;
    try {
      const utxos: any[] = await (window as any).opnet.web3.provider.getBitcoinUtxos();
      const total = utxos.reduce((a: bigint, u: any) => a + BigInt(u.value), 0n);
      setRbtcBalance(satsToRbtc(total));
    } catch { /* silent */ }
  }, [connected]);

  useEffect(() => { if (connected) refreshBalance(); }, [connected, refreshBalance]);

  const fetchMyPubKey = async () => {
    if (!connected || !address) { err("Connect wallet first"); return; }
    setPubKeyLoading(true);
    try {
      const p = (window as any).opnet.web3.provider;
      let pk: string | null = null;
      if (typeof p.getPublicKey === "function") pk = await p.getPublicKey();
      else if (typeof p.getPublicKeyInfo === "function") {
        const info = await p.getPublicKeyInfo(address);
        pk = info?.publicKey ?? null;
      }
      if (!pk) throw new Error("Wallet returned no public key");
      setMyPubKey(pk.replace(/^0x/, ""));
    } catch (e: any) {
      err("Could not fetch public key: " + e.message);
    } finally {
      setPubKeyLoading(false);
    }
  };

  const copyMyPubKey = async () => {
    if (!myPubKey) return;
    await navigator.clipboard.writeText(myPubKey);
    setPubKeyCopied(true);
    setTimeout(() => setPubKeyCopied(false), 1500);
  };

  const handleCreateOrder = async () => {
    if (!connected || !address) { err("Connect wallet first"); return; }
    if (!priceRbtc || Number(priceRbtc) <= 0) { err("Enter a valid price"); return; }
    try {
      inf("Encoding calldata…");
      const priceSats   = BigInt(Math.floor(Number(priceRbtc) * 1e8));
      const deadlineN   = BigInt(deadlineBlocks || "144");
      const calldata    = await encodeCreateOrder(priceSats, deadlineN);
      const serviceName = serviceType === "Other (Custom Service)" ? customService : serviceType;

      const provider = (window as any).opnet.web3.provider;
      await sendContractTx(provider, calldata, inf);

      ok(`✅ Order created! "${serviceName}" · ${priceRbtc} rBTC`);
      await refreshBalance();
    } catch (e: any) {
      err("❌ createOrder failed: " + e.message);
    }
  };

  const handleGetOrder = async () => {
    if (!orderIdInput) { err("Enter an order ID"); return; }
    setLoadingOrder(true);
    setOrderData(null);
    try {
      const calldata = await encodeWithOrderId("getOrder", BigInt(orderIdInput));
      const raw      = await rpcCall(calldata);
      if (!raw) throw new Error("No response — order may not exist");
      const decoded = decodeOrderResponse(raw);
      if (!decoded) throw new Error("Failed to decode response");
      setOrderData(decoded);
    } catch (e: any) {
      err("❌ getOrder failed: " + e.message);
    } finally {
      setLoadingOrder(false);
    }
  };

  const handleAction = async (method: string, orderId: bigint, label: string) => {
    if (!connected || !address) { err("Connect wallet first"); return; }
    try {
      inf(`Encoding ${label}…`);
      const calldata = await encodeWithOrderId(method, orderId);
      const provider = (window as any).opnet.web3.provider;
      await sendContractTx(provider, calldata, inf);
      ok(`✅ ${label} submitted`);
      if (orderIdInput) await handleGetOrder();
      await refreshBalance();
    } catch (e: any) {
      err(`❌ ${label} failed: ` + e.message);
    }
  };

  return (
    <main
      className="min-h-screen relative flex flex-col items-center justify-start text-white bg-cover bg-center"
      style={{ backgroundImage: "url('/bg.png')" }}
    >
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm pointer-events-none" />

      {/* ── WALLET PANEL ── */}
      <div className="absolute top-6 right-6 z-20 bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl p-4 shadow-lg w-64">
        {!connected ? (
          <button
            onClick={connectWallet}
            className="w-full py-2 rounded-lg border border-orange-500 text-orange-400 hover:bg-orange-500 hover:text-white transition text-sm font-medium cursor-pointer"
          >
            Connect OPWallet
          </button>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-2">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-emerald-400 text-xs">Connected</span>
            </div>
            <div className="bg-black/40 p-2 rounded text-xs break-all mb-1 text-white/70">{address}</div>
            <div className="flex items-center justify-between mb-3 pl-1">
              <span className="text-orange-400 text-xs font-semibold">{rbtcBalance} rBTC</span>
              <button onClick={refreshBalance} className="text-white/30 hover:text-white/60 transition text-xs" title="Refresh">↻</button>
            </div>
            <button
              onClick={disconnectWallet}
              className="w-full py-2 text-xs border border-red-500 text-red-400 rounded-md hover:bg-red-500 hover:text-white transition cursor-pointer"
            >
              Disconnect
            </button>
          </>
        )}
      </div>

      {/* ── LOGO ── */}
      <div className="relative z-10 mt-10 mb-5">
        <img src="/logo.png" alt="OPNet" className="h-16 mx-auto object-contain" />
      </div>

      {/* ── PUBLIC KEY PANEL ── */}
      {connected && (
        <div className="relative z-10 w-full max-w-lg mx-4 mb-4">
          <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl p-5 shadow-lg">
            <div className="flex items-start justify-between mb-3 gap-3">
              <div>
                <p className="text-white/60 text-xs uppercase tracking-widest font-semibold">Your Public Key</p>
                <p className="text-white/25 text-xs mt-0.5">Share with your counterparty</p>
              </div>
              <button
                onClick={fetchMyPubKey}
                disabled={pubKeyLoading}
                className="flex-shrink-0 px-3 py-1.5 rounded-lg border border-orange-500/60 text-orange-400 hover:bg-orange-500 hover:text-white disabled:opacity-40 transition text-xs font-medium cursor-pointer whitespace-nowrap"
              >
                {pubKeyLoading ? "Fetching…" : myPubKey ? "Refresh" : "Generate"}
              </button>
            </div>
            {myPubKey ? (
              <div
                onClick={copyMyPubKey}
                className="group relative bg-black/50 border border-white/10 hover:border-orange-500/40 rounded-lg px-3 py-2.5 cursor-pointer transition mb-4"
              >
                <p className="text-green-400 text-xs font-mono break-all leading-relaxed pr-7">
                  {pubKeyCopied ? "✓ Copied to clipboard!" : myPubKey}
                </p>
                <span className="absolute top-2.5 right-2.5 text-white/20 group-hover:text-orange-400 transition text-xs">
                  {pubKeyCopied ? "✓" : "⎘"}
                </span>
              </div>
            ) : (
              <div className="bg-black/30 border border-dashed border-white/10 rounded-lg px-3 py-2.5 text-center mb-4">
                <p className="text-white/20 text-xs">Click "Generate" to reveal your public key</p>
              </div>
            )}
            <div>
              <p className="text-white/40 text-xs uppercase tracking-widest mb-1.5">
                {role === "Buyer" ? "Seller" : "Buyer"} Public Key
              </p>
              <input
                type="text"
                placeholder={`Paste ${role === "Buyer" ? "seller" : "buyer"}'s public key (hex)`}
                value={counterpartyPubKey}
                onChange={(e) => setCounterpartyPubKey(e.target.value)}
                className="w-full bg-black/40 border border-white/10 focus:border-orange-500/50 rounded-lg px-3 py-2.5 text-xs font-mono text-white/80 placeholder-white/20 focus:outline-none transition"
              />
            </div>
          </div>
        </div>
      )}

      {/* ── MAIN CARD ── */}
      <div className="relative z-10 bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-10 shadow-2xl w-full max-w-lg mx-4 mb-10">

        <h1 className="text-3xl font-semibold mb-1 text-center tracking-wide">OPNet Marketplace</h1>
        <p className="text-white/50 mb-8 text-center text-sm">Decentralized Service Escrow on Bitcoin L2</p>

        {/* Role toggle */}
        <div className="flex mb-6 bg-black/40 rounded-lg p-1 text-sm border border-white/10">
          {(["Buyer", "Seller"] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRole(r)}
              className={`w-1/2 py-2 rounded-md transition ${
                role === r ? "bg-orange-500/20 text-orange-400" : "text-white/60 hover:text-white"
              }`}
            >
              {r}
            </button>
          ))}
        </div>

        {/* Tabs */}
        <div className="flex gap-6 mb-6 border-b border-white/10">
          {(["create", "manage"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`pb-3 text-sm tracking-wide uppercase transition ${
                activeTab === tab
                  ? "text-orange-400 border-b-2 border-orange-500"
                  : "text-white/30 hover:text-white/60"
              }`}
            >
              {tab === "create" ? (role === "Seller" ? "New Listing" : "Browse") : "My Orders"}
            </button>
          ))}
        </div>

        {/* ── CREATE — SELLER ── */}
        {activeTab === "create" && role === "Seller" && (
          <section className="space-y-4">
            <h2 className="text-white/50 text-xs uppercase tracking-widest mb-2">Create Service Listing</h2>

            <select
              value={serviceType}
              onChange={(e) => setServiceType(e.target.value)}
              className="w-full p-3 rounded-lg bg-black/40 border border-white/10 text-sm focus:outline-none focus:border-orange-500/50 transition"
            >
              {SERVICE_OPTIONS.map((o) => (
                <option key={o} value={o} className="bg-[#0d0d12]">{o}</option>
              ))}
            </select>

            {serviceType === "Other (Custom Service)" && (
              <input
                type="text"
                placeholder="Custom service name"
                value={customService}
                onChange={(e) => setCustomService(e.target.value)}
                className="w-full p-3 rounded-lg bg-black/40 border border-white/10 text-sm focus:outline-none focus:border-orange-500/50 transition"
              />
            )}

            <textarea
              placeholder="Describe scope, deliverables, timeline…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full p-3 rounded-lg bg-black/40 border border-white/10 text-sm focus:outline-none focus:border-orange-500/50 transition resize-none"
            />

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-white/40 mb-1.5">Price (rBTC)</label>
                <input
                  type="number" step="0.00000001" min="0" placeholder="0.001"
                  value={priceRbtc}
                  onChange={(e) => setPriceRbtc(e.target.value)}
                  className="w-full p-3 rounded-lg bg-black/40 border border-white/10 text-sm focus:outline-none focus:border-orange-500/50 transition"
                />
              </div>
              <div>
                <label className="block text-xs text-white/40 mb-1.5">Deadline (blocks)</label>
                <input
                  type="number" min="6" placeholder="144 ≈ 1 day"
                  value={deadlineBlocks}
                  onChange={(e) => setDeadlineBlocks(e.target.value)}
                  className="w-full p-3 rounded-lg bg-black/40 border border-white/10 text-sm focus:outline-none focus:border-orange-500/50 transition"
                />
                <p className="text-white/20 text-xs mt-1">6 blocks ≈ 1 hour</p>
              </div>
            </div>

            <button
              onClick={handleCreateOrder}
              disabled={!connected}
              className="w-full py-3 rounded-lg bg-orange-500/20 hover:bg-orange-500 border border-orange-500/50 text-orange-400 hover:text-white disabled:opacity-30 transition text-sm font-semibold cursor-pointer"
            >
              {connected ? "Create Order on OPNet →" : "Connect Wallet First"}
            </button>
          </section>
        )}

        {/* ── CREATE — BUYER ── */}
        {activeTab === "create" && role === "Buyer" && (
          <section className="space-y-4">
            <h2 className="text-white/50 text-xs uppercase tracking-widest mb-2">Accept an Order</h2>
            <p className="text-white/40 text-sm">
              Get the Order ID from the seller, view it, then accept and fund the escrow.
            </p>

            <div>
              <label className="block text-xs text-white/40 mb-1.5">Order ID</label>
              <input
                type="number" min="1" placeholder="e.g. 1"
                value={orderIdInput}
                onChange={(e) => setOrderIdInput(e.target.value)}
                className="w-full p-3 rounded-lg bg-black/40 border border-white/10 text-sm focus:outline-none focus:border-orange-500/50 transition"
              />
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleGetOrder}
                disabled={loadingOrder}
                className="flex-1 py-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-white/70 hover:text-white text-sm transition cursor-pointer"
              >
                {loadingOrder ? "Loading…" : "View Order"}
              </button>
              <button
                onClick={() => handleAction("acceptOrder", BigInt(orderIdInput || "0"), "Accept Order")}
                disabled={!connected || !orderIdInput}
                className="flex-1 py-2.5 rounded-lg bg-orange-500/20 hover:bg-orange-500 border border-orange-500/50 text-orange-400 hover:text-white disabled:opacity-30 text-sm font-semibold transition cursor-pointer"
              >
                Accept →
              </button>
            </div>
          </section>
        )}

        {/* ── MANAGE ── */}
        {activeTab === "manage" && (
          <section className="space-y-5">
            <h2 className="text-white/50 text-xs uppercase tracking-widest">Order Manager</h2>

            <div className="flex gap-3">
              <input
                type="number" min="1" placeholder="Order ID"
                value={orderIdInput}
                onChange={(e) => setOrderIdInput(e.target.value)}
                className="flex-1 p-3 rounded-lg bg-black/40 border border-white/10 text-sm focus:outline-none focus:border-orange-500/50 transition"
              />
              <button
                onClick={handleGetOrder}
                disabled={loadingOrder}
                className="px-5 py-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-sm text-white/70 hover:text-white transition cursor-pointer"
              >
                {loadingOrder ? "…" : "Load"}
              </button>
            </div>

            {orderData && (
              <div className="rounded-xl border border-white/10 bg-black/40 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-white/40 text-xs uppercase tracking-widest">
                    Order #{orderData.orderId?.toString()}
                  </span>
                  {orderData.state !== undefined && (
                    <span className={`text-xs font-bold ${STATE_LABELS[Number(orderData.state)]?.color}`}>
                      ● {STATE_LABELS[Number(orderData.state)]?.label}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                  <div>
                    <p className="text-white/30 text-xs mb-0.5">Seller</p>
                    <p className="text-white/80 font-mono text-xs">{shortAddr(orderData.seller)}</p>
                  </div>
                  <div>
                    <p className="text-white/30 text-xs mb-0.5">Buyer</p>
                    <p className="text-white/80 font-mono text-xs">{shortAddr(orderData.buyer)}</p>
                  </div>
                  <div>
                    <p className="text-white/30 text-xs mb-0.5">Price</p>
                    <p className="text-orange-300 font-semibold">
                      {orderData.price !== undefined ? satsToRbtc(BigInt(orderData.price)) : "—"} rBTC
                    </p>
                  </div>
                  <div>
                    <p className="text-white/30 text-xs mb-0.5">Locked</p>
                    <p className="text-amber-300 font-semibold">
                      {orderData.locked !== undefined ? satsToRbtc(BigInt(orderData.locked)) : "0.00000000"} rBTC
                    </p>
                  </div>
                  <div>
                    <p className="text-white/30 text-xs mb-0.5">Deadline Block</p>
                    <p className="text-white/60 text-xs">{orderData.deadline?.toString()}</p>
                  </div>
                  <div>
                    <p className="text-white/30 text-xs mb-0.5">Accepted At</p>
                    <p className="text-white/60 text-xs">
                      {orderData.acceptedAt !== undefined
                        ? BigInt(orderData.acceptedAt) === 0n ? "Not accepted" : orderData.acceptedAt.toString()
                        : "—"}
                    </p>
                  </div>
                </div>

                <div className="pt-3 border-t border-white/10">
                  <p className="text-white/30 text-xs uppercase tracking-widest mb-3">Actions</p>
                  <div className="flex flex-wrap gap-2">
                    {Number(orderData.state) === 1 && role === "Buyer" && (
                      <button
                        onClick={() => handleAction("acceptOrder", BigInt(orderIdInput), "Accept Order")}
                        className="px-4 py-2 rounded-lg bg-violet-600/30 hover:bg-violet-600 border border-violet-500/50 text-violet-300 hover:text-white text-xs font-semibold transition"
                      >Accept Order</button>
                    )}
                    {Number(orderData.state) === 1 && role === "Seller" && (
                      <button
                        onClick={() => handleAction("cancelOrder", BigInt(orderIdInput), "Cancel Order")}
                        className="px-4 py-2 rounded-lg bg-red-600/20 hover:bg-red-600/50 border border-red-500/30 text-red-400 hover:text-white text-xs font-semibold transition"
                      >Cancel Listing</button>
                    )}
                    {Number(orderData.state) === 2 && role === "Buyer" && (
                      <button
                        onClick={() => handleAction("fundOrder", BigInt(orderIdInput), "Fund Order")}
                        className="px-4 py-2 rounded-lg bg-orange-500/20 hover:bg-orange-500 border border-orange-500/50 text-orange-300 hover:text-black text-xs font-bold transition"
                      >Fund Escrow</button>
                    )}
                    {Number(orderData.state) === 3 && role === "Buyer" && (
                      <>
                        <button
                          onClick={() => handleAction("confirmCompletion", BigInt(orderIdInput), "Confirm Completion")}
                          className="px-4 py-2 rounded-lg bg-emerald-600/30 hover:bg-emerald-600 border border-emerald-500/50 text-emerald-300 hover:text-white text-xs font-bold transition"
                        >✓ Confirm Delivery</button>
                        <button
                          onClick={() => handleAction("openDispute", BigInt(orderIdInput), "Open Dispute")}
                          className="px-4 py-2 rounded-lg bg-orange-600/20 hover:bg-orange-600/50 border border-orange-500/30 text-orange-400 hover:text-white text-xs font-semibold transition"
                        >⚠ Open Dispute</button>
                      </>
                    )}
                    {Number(orderData.state) === 3 && role === "Seller" && (
                      <button
                        onClick={() => handleAction("openDispute", BigInt(orderIdInput), "Open Dispute")}
                        className="px-4 py-2 rounded-lg bg-orange-600/20 hover:bg-orange-600/50 border border-orange-500/30 text-orange-400 hover:text-white text-xs font-semibold transition"
                      >⚠ Open Dispute</button>
                    )}
                    {(Number(orderData.state) === 4 || Number(orderData.state) === 5) && (
                      <p className="text-white/30 text-xs italic">
                        This order is {STATE_LABELS[Number(orderData.state)]?.label.toLowerCase()}.
                      </p>
                    )}
                    {[1, 2, 3, 6].includes(Number(orderData.state)) && (
                      <button
                        onClick={() => handleAction("cancelOrder", BigInt(orderIdInput), "Cancel Order")}
                        className="px-4 py-2 rounded-lg border border-red-500/20 text-red-400/70 hover:text-red-400 hover:bg-red-500/10 text-xs font-semibold transition"
                      >Cancel</button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {/* ── Status ── */}
        {status && (
          <div className={`mt-6 rounded-lg border px-4 py-3 text-sm break-all ${
            statusType === "ok"  ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300" :
            statusType === "err" ? "border-red-500/30 bg-red-500/5 text-red-300" :
                                   "border-white/10 bg-black/40 text-white/60"
          }`}>
            {status}
          </div>
        )}

        {/* ── Footer ── */}
        <div className="mt-10 pt-5 border-t border-white/5 flex items-center justify-between text-xs text-white/20">
          <span>Contract: <span className="text-white/40">{shortAddr(CONTRACT_ADDRESS)}</span></span>
          <span>OPNet Regtest</span>
        </div>
      </div>
    </main>
  );
}