const PALETTE = [
  ["#c7f284", "#39d0d8"],
  ["#39d0d8", "#7c9cff"],
  ["#a78bfa", "#f472b6"],
  ["#f5b84a", "#f0616d"],
  ["#14f195", "#9945ff"],
];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function Avatar({ seed, name, size = 36 }: { seed: string; name: string; size?: number }) {
  const [a, b] = PALETTE[hash(seed) % PALETTE.length];
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span className="avatar" style={{ width: size, height: size, background: `linear-gradient(135deg, ${a}, ${b})` }}>
      {initials}
    </span>
  );
}
