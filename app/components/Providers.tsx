"use client";

import { ReactNode, useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { UnsafeBurnerWalletAdapter } from "@solana/wallet-adapter-unsafe-burner";
import { CLUSTER, RPC_URL } from "@/lib/program";
import "@solana/wallet-adapter-react-ui/styles.css";

export function Providers({ children }: { children: ReactNode }) {
  // Wallet-standard wallets (Phantom, Solflare, Backpack…) register themselves.
  // On localnet we also offer an in-memory burner wallet for quick testing.
  const wallets = useMemo(
    () => (CLUSTER === "localnet" ? [new UnsafeBurnerWalletAdapter()] : []),
    [],
  );
  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
