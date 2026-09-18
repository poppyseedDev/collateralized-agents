import type { Metadata } from "next";

export const metadata: Metadata = { title: "How it works" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
