"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { CLUSTER } from "@/lib/program";
import { IconDrop } from "./Icons";

/** Localnet-only: airdrop 10 SOL to the connected wallet. */
export function LocalFaucet() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [state, setState] = useState<"idle" | "busy" | "done" | "err">("idle");

  if (CLUSTER !== "localnet" || !publicKey) return null;

  const drop = async () => {
    setState("busy");
    try {
      const sig = await connection.requestAirdrop(publicKey, 10 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      setState("done");
      setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("err");
    }
  };

  return (
    <button className="btn ghost sm faucet" onClick={drop} disabled={state === "busy"} title={`Airdrop 10 SOL to ${publicKey.toBase58()}`}>
      <IconDrop width={14} height={14} />
      <span className="faucet-label">
        {state === "busy" ? "Airdropping…" : state === "done" ? "+10 SOL" : state === "err" ? "Airdrop failed" : "Airdrop 10 SOL"}
      </span>
    </button>
  );
}
