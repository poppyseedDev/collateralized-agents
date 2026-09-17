"use client";

import { ReactNode, useCallback, useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { UnsafeBurnerWalletAdapter } from "@solana/wallet-adapter-unsafe-burner";
import { CLUSTER, RPC_URL } from "@/lib/program";
import "@solana/wallet-adapter-react-ui/styles.css";

export function Providers({ children }: { children: ReactNode }) {
  // Wallet extensions throw when a connection request is already pending or the
  // user closes the popup. Neither is a page error, so keep them out of the console overlay.
  const onWalletError = useCallback((e: Error) => {
    if (/already pending|User rejected|WalletNotSelected/i.test(e.message)) return;
    console.warn("wallet:", e.message);
  }, []);
  // Wallet-standard wallets (Phantom, Solflare, Backpack…) register themselves.
  // On localnet we also offer an in-memory burner wallet for quick testing.
  const wallets = useMemo(
    () => (CLUSTER === "localnet" ? [new UnsafeBurnerWalletAdapter()] : []),
    [],
  );
  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect onError={onWalletError}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
