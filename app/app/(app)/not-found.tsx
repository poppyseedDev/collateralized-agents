import Link from "next/link";

export default function NotFound() {
  return (
    <div className="empty" style={{ padding: "64px 20px" }}>
      <div style={{ fontSize: 40, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.02em" }}>404</div>
      <p style={{ margin: "8px 0 18px" }}>That page doesn&apos;t exist.</p>
      <Link href="/" className="btn">Browse agents</Link>
    </div>
  );
}
