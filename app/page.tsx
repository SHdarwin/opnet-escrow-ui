"use client";

import { useState } from "react";

export default function Home() {
  const [connected, setConnected] = useState(false);
  const [address, setAddress] = useState("");
  const [type, setType] = useState<"buyer" | "seller" | null>(null);
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");

  const connectWallet = async () => {
    try {
      if (typeof window === "undefined") return;

      const opnet = (window as any).opnet;

      if (!opnet?.web3?.provider) {
        alert("OPWallet not found. Install OPWallet extension.");
        return;
      }

      const accounts = await opnet.web3.provider.requestAccounts();

      if (accounts?.length) {
        setAddress(accounts[0]);
        setConnected(true);
      }
    } catch (err) {
      console.error("OPWallet connection error:", err);
    }
  };

  const disconnectWallet = async () => {
    try {
      const opnet = (window as any).opnet;
      if (opnet?.web3?.provider?.disconnect) {
        await opnet.web3.provider.disconnect();
      }
    } catch (err) {
      console.error(err);
    }

    setConnected(false);
    setAddress("");
  };

  const createEscrow = () => {
    alert("Escrow created (demo)");
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#0f0f0f",
        color: "white",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        fontFamily: "Arial",
      }}
    >
      <div
        style={{
          width: "420px",
          padding: "30px",
          borderRadius: "12px",
          background: "#181818",
          boxShadow: "0 0 30px rgba(255,140,0,0.15)",
        }}
      >
        <h1 style={{ marginBottom: "20px" }}>OPNet Marketplace</h1>

        {!connected ? (
          <button
            onClick={connectWallet}
            style={{
              padding: "8px 16px",
              fontSize: "14px",
              background: "transparent",
              border: "1px solid #ff8c00",
              color: "#ff8c00",
              borderRadius: "6px",
              cursor: "pointer",
            }}
          >
            Connect OPWallet
          </button>
        ) : (
          <>
            <div style={{ marginBottom: "10px", fontSize: "13px" }}>
              Connected: {address.slice(0, 6)}...
              {address.slice(-4)}
            </div>

            <button
              onClick={disconnectWallet}
              style={{
                padding: "6px 14px",
                fontSize: "13px",
                background: "transparent",
                border: "1px solid #555",
                color: "#aaa",
                borderRadius: "6px",
                cursor: "pointer",
                marginBottom: "20px",
              }}
            >
              Log out
            </button>

            <h3>Create Service Escrow</h3>

            <div style={{ display: "flex", gap: "10px", margin: "15px 0" }}>
              <button
                onClick={() => setType("buyer")}
                style={{
                  flex: 1,
                  padding: "8px",
                  background: type === "buyer" ? "#ff8c00" : "transparent",
                  border: "1px solid #ff8c00",
                  color: "white",
                  borderRadius: "6px",
                  cursor: "pointer",
                }}
              >
                Buyer
              </button>

              <button
                onClick={() => setType("seller")}
                style={{
                  flex: 1,
                  padding: "8px",
                  background: type === "seller" ? "#ff8c00" : "transparent",
                  border: "1px solid #ff8c00",
                  color: "white",
                  borderRadius: "6px",
                  cursor: "pointer",
                }}
              >
                Seller
              </button>
            </div>

            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              style={{
                width: "100%",
                padding: "8px",
                marginBottom: "12px",
                background: "#222",
                color: "white",
                borderRadius: "6px",
                border: "1px solid #333",
                cursor: "pointer",
              }}
            >
              <option value="">Select Category</option>
              <option>Web Development</option>
              <option>Design</option>
              <option>Marketing</option>
              <option>Consulting</option>
              <option>Writing</option>
              <option>Trading</option>
              <option>Education</option>
              <option>Software</option>
              <option>Digital Goods</option>
              <option>Other</option>
            </select>

            <textarea
              placeholder="Optional description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              style={{
                width: "100%",
                padding: "8px",
                marginBottom: "12px",
                background: "#222",
                color: "white",
                borderRadius: "6px",
                border: "1px solid #333",
              }}
            />

            <input
              placeholder="Amount (OP tokens)"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              style={{
                width: "100%",
                padding: "8px",
                marginBottom: "15px",
                background: "#222",
                color: "white",
                borderRadius: "6px",
                border: "1px solid #333",
              }}
            />

            <button
              onClick={createEscrow}
              style={{
                width: "100%",
                padding: "10px",
                background: "#ff8c00",
                border: "none",
                borderRadius: "6px",
                color: "black",
                fontWeight: "bold",
                cursor: "pointer",
              }}
            >
              Create Escrow
            </button>
          </>
        )}

        <div
          style={{
            marginTop: "30px",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <a
            href="https://github.com/SHdarwin"
            target="_blank"
            style={{
              color: "#888",
              textDecoration: "none",
              cursor: "pointer",
            }}
          >
            GitHub
          </a>

          <a
            href="https://x.com/OxDarwin"
            target="_blank"
            style={{
              color: "#888",
              textDecoration: "none",
              cursor: "pointer",
            }}
          >
            Creator
          </a>
        </div>
      </div>
    </main>
  );
}