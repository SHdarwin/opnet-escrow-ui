"use client";

import { useState } from "react";

export default function Home() {
  const [connected, setConnected] = useState(false);
  const [address, setAddress] = useState<string | null>(null);

  const [role, setRole] = useState<"Buyer" | "Seller">("Buyer");
  const [serviceType, setServiceType] = useState("Web Development");
  const [customService, setCustomService] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");

  const serviceOptions = [
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

  // ✅ OPWALLET NATIVE CONNECT (через injected provider)
  const connectWallet = async () => {
    try {
      const opnet = (window as any).opnet;

      if (opnet?.web3?.provider?.requestAccounts) {
        const accounts = await opnet.web3.provider.requestAccounts();

        if (accounts?.length) {
          setAddress(accounts[0]);
          setConnected(true);
          return;
        }
      }

      alert("OPWallet not found");
    } catch (err) {
      console.error("Wallet connection error:", err);
    }
  };

  const disconnectWallet = async () => {
    try {
      const opnet = (window as any).opnet;
      if (opnet?.web3?.provider?.disconnect) {
        await opnet.web3.provider.disconnect();
      }
    } catch (e) {}

    setConnected(false);
    setAddress(null);
  };

  const createEscrow = () => {
    const finalService =
      serviceType === "Other (Custom Service)"
        ? customService
        : serviceType;

    console.log("Escrow Data:", {
      role,
      service: finalService,
      description,
      amount,
      address,
    });
  };

  return (
    <main
      className="min-h-screen relative flex flex-col items-center justify-center text-white bg-cover bg-center"
      style={{ backgroundImage: "url('/bg.png')" }}
    >
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm"></div>

      <div className="relative z-10 bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-10 shadow-2xl max-w-lg w-full">

        <h1 className="text-3xl font-semibold mb-2 text-center tracking-wide">
          OPNet Marketplace
        </h1>

        <p className="text-white/50 mb-8 text-center text-sm">
          Decentralized Service Escrow on Bitcoin L2
        </p>

        {!connected ? (
          <button
            onClick={connectWallet}
            className="w-full py-2 mb-6 rounded-lg border border-orange-500 text-orange-400 hover:bg-orange-500 hover:text-white transition text-sm font-medium cursor-pointer focus:outline-none"
          >
            Connect Wallet
          </button>
        ) : (
          <div className="mb-6 text-center">
            <p className="text-green-400 text-xs mb-1">
              Connected
            </p>

            <div className="bg-black/40 p-2 rounded text-xs break-all mb-3">
              {address}
            </div>

            <button
              onClick={disconnectWallet}
              className="px-4 py-1 text-xs border border-red-500 text-red-400 rounded-md hover:bg-red-500 hover:text-white transition cursor-pointer focus:outline-none"
            >
              Log out
            </button>
          </div>
        )}

        <div className="flex mb-6 bg-black/40 rounded-lg p-1 text-sm border border-white/10">
          <button
            onClick={() => setRole("Buyer")}
            className={`w-1/2 py-2 rounded-md transition cursor-pointer focus:outline-none ${
              role === "Buyer"
                ? "bg-orange-500/20 text-orange-400"
                : "text-white/60 hover:text-white"
            }`}
          >
            Buyer
          </button>

          <button
            onClick={() => setRole("Seller")}
            className={`w-1/2 py-2 rounded-md transition cursor-pointer focus:outline-none ${
              role === "Seller"
                ? "bg-orange-500/20 text-orange-400"
                : "text-white/60 hover:text-white"
            }`}
          >
            Seller
          </button>
        </div>

        <h2 className="text-lg font-medium mb-4">
          Create Service Escrow
        </h2>

        <select
          value={serviceType}
          onChange={(e) => setServiceType(e.target.value)}
          className="w-full mb-4 p-3 rounded-lg bg-black/40 border border-white/10 text-sm focus:outline-none cursor-pointer"
        >
          {serviceOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>

        {serviceType === "Other (Custom Service)" && (
          <input
            type="text"
            placeholder="Custom service"
            value={customService}
            onChange={(e) => setCustomService(e.target.value)}
            className="w-full mb-4 p-3 rounded-lg bg-black/40 border border-white/10 text-sm focus:outline-none"
          />
        )}

        <textarea
          placeholder="Optional description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full mb-4 p-3 rounded-lg bg-black/40 border border-white/10 min-h-[90px] text-sm focus:outline-none"
        />

        <input
          type="number"
          placeholder="Amount (OP tokens)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="w-full mb-6 p-3 rounded-lg bg-black/40 border border-white/10 text-sm focus:outline-none"
        />

        <button
          onClick={createEscrow}
          disabled={!connected}
          className="w-full py-2 rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-40 transition text-sm font-medium cursor-pointer focus:outline-none"
        >
          Create Escrow
        </button>

      </div>

      <div className="relative z-10 mt-8 flex gap-6 text-sm text-white/50">
        <a
          href="https://github.com/SHdarwin"
          target="_blank"
          className="hover:text-orange-400 transition cursor-pointer"
        >
          GitHub
        </a>

        <a
          href="https://x.com/OxDarwin"
          target="_blank"
          className="hover:text-orange-400 transition cursor-pointer"
        >
          Creator
        </a>
      </div>

    </main>
  );
}