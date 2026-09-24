"use client";

import { useId, type SVGProps } from "react";

const base = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

type P = SVGProps<SVGSVGElement>;

export const IconAgents = (p: P) => (
  <svg {...base} {...p}>
    <rect x="4" y="7" width="16" height="12" rx="3" />
    <path d="M12 3v4M9 12h.01M15 12h.01M9.5 15.5h5" />
  </svg>
);
export const IconPositions = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3 17l5-5 4 4 8-8" />
    <path d="M14 8h6v6" />
  </svg>
);
export const IconConsole = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
);
export const IconBook = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2V5z" />
    <path d="M4 19a2 2 0 012-2h13" />
    <path d="M9 7h6M9 11h4" />
  </svg>
);
export const IconDrop = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 3s6 6.5 6 11a6 6 0 01-12 0c0-4.5 6-11 6-11z" />
  </svg>
);
export const IconChart = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 19V5M4 19h16" />
    <path d="M7.5 15.5l3.5-5 3 3 4.5-7" />
  </svg>
);
export const IconArrowDown = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </svg>
);
export const IconRefresh = (p: P) => (
  <svg {...base} width={16} height={16} strokeWidth={2} {...p}>
    <path d="M21 12a9 9 0 11-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </svg>
);
export const IconShield = IconConsole;

export function Logo({ size = 28 }: { size?: number }) {
  const id = `ca-g-${useId().replace(/:/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#c7f284" />
          <stop offset="1" stopColor="#39d0d8" />
        </linearGradient>
      </defs>
      <path d="M16 2l12 6v8c0 7.5-5.2 12.3-12 14-6.8-1.7-12-6.5-12-14V8l12-6z" fill={`url(#${id})`} />
      <path d="M11 16.5l3.5 3.5 7-7.5" stroke="#090d10" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
