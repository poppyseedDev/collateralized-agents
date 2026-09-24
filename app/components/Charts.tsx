"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

/** A plotted series. `x` and `y` must be the same length. */
export type Series = {
  key: string;
  label: string;
  color: string;
  x: number[];
  y: number[];
  dashed?: boolean;
};

type Pad = { top: number; right: number; bottom: number; left: number };

const H = 300;

/**
 * The viewBox is narrower on a phone so the same chart height fills more of
 * the screen and the labels stay legible. Everything below is expressed in
 * viewBox units, so only this width changes.
 */
function useChartBox() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [px, setPx] = useState(720);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setPx(entry.contentRect.width));
    ro.observe(el);
    setPx(el.getBoundingClientRect().width || 720);
    return () => ro.disconnect();
  }, []);
  const narrow = px < 560;
  const W = narrow ? 400 : 720;
  const pad: Pad = narrow
    ? { top: 14, right: 10, bottom: 28, left: 40 }
    : { top: 12, right: 14, bottom: 26, left: 44 };
  return { ref, W, pad, narrow };
}

function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!isFinite(lo) || !isFinite(hi) || lo === hi) return [lo];
  const span = hi - lo;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(v);
  return out;
}

function logTicks(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    const v = Math.pow(10, e);
    if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v);
  }
  return out.length >= 2 ? out : niceTicks(lo, hi);
}

export function LineChart({
  series,
  logY = false,
  yFormat = (v: number) => String(v),
  xFormat = (v: number) => String(v),
  xReadFormat,
  xTicks,
  markers = [],
  height = H,
  ariaLabel,
}: {
  series: Series[];
  logY?: boolean;
  yFormat?: (v: number) => string;
  xFormat?: (v: number) => string;
  /** Label for the hover readout, where there is room for more detail than
      an axis tick. Defaults to `xFormat`. */
  xReadFormat?: (v: number) => string;
  /** Explicit x positions to label; defaults to evenly spaced nice ticks. */
  xTicks?: number[];
  /** Horizontal reference lines, e.g. break-even. */
  markers?: { y: number; label: string; color?: string }[];
  height?: number;
  ariaLabel?: string;
}) {
  const gid = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const { ref, W, pad: PAD } = useChartBox();

  const geom = useMemo(() => {
    const xs = series.flatMap((s) => s.x);
    const ys = series.flatMap((s) => s.y).filter((v) => isFinite(v));
    const markerYs = markers.map((m) => m.y);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    let y0 = Math.min(...ys, ...markerYs);
    let y1 = Math.max(...ys, ...markerYs);
    if (logY) {
      const positive = ys.filter((v) => v > 0);
      y0 = Math.min(...positive);
      y1 = Math.max(...positive);
      y0 = Math.pow(10, Math.floor(Math.log10(y0)));
      y1 = Math.pow(10, Math.ceil(Math.log10(y1)));
    } else {
      const pad = (y1 - y0) * 0.08 || 1;
      y0 -= pad;
      y1 += pad;
    }
    const iw = W - PAD.left - PAD.right;
    const ih = height - PAD.top - PAD.bottom;
    const sx = (v: number) => PAD.left + ((v - x0) / (x1 - x0 || 1)) * iw;
    const sy = (v: number) =>
      logY
        ? PAD.top + ih - ((Math.log10(Math.max(v, y0)) - Math.log10(y0)) /
            (Math.log10(y1) - Math.log10(y0) || 1)) * ih
        : PAD.top + ih - ((v - y0) / (y1 - y0 || 1)) * ih;
    return { x0, x1, y0, y1, sx, sy, iw, ih };
  }, [series, logY, markers, height, W, PAD]);

  const yTickVals = logY ? logTicks(geom.y0, geom.y1) : niceTicks(geom.y0, geom.y1);
  const xTickVals = xTicks ?? niceTicks(geom.x0, geom.x1, 5);

  const paths = series.map((s) => {
    let d = "";
    let pen = false;
    for (let i = 0; i < s.x.length; i++) {
      const v = s.y[i];
      if (!isFinite(v) || (logY && v <= 0)) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${geom.sx(s.x[i]).toFixed(1)} ${geom.sy(v).toFixed(1)}`;
      pen = true;
    }
    return { ...s, d };
  });

  // Hover reads the nearest sample of the first series and shows every value there.
  const hoverIdx = useMemo(() => {
    if (hover === null || !series[0]) return null;
    const xs = series[0].x;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < xs.length; i++) {
      const d = Math.abs(geom.sx(xs[i]) - hover);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }, [hover, series, geom]);

  return (
    <div className="chart" ref={ref}>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        role="img"
        aria-label={ariaLabel}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(((e.clientX - r.left) / r.width) * W);
        }}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <clipPath id={`clip${gid}`}>
            <rect x={PAD.left} y={PAD.top} width={geom.iw} height={geom.ih} />
          </clipPath>
        </defs>

        {yTickVals.map((v) => (
          <g key={`y${v}`}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={geom.sy(v)}
              y2={geom.sy(v)}
              className="grid"
            />
            <text x={PAD.left - 7} y={geom.sy(v)} className="axis" textAnchor="end" dominantBaseline="middle">
              {yFormat(v)}
            </text>
          </g>
        ))}

        {xTickVals.map((v) => (
          <text key={`x${v}`} x={geom.sx(v)} y={height - 8} className="axis" textAnchor="middle">
            {xFormat(v)}
          </text>
        ))}

        {markers.map((m) => (
          <g key={m.label}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={geom.sy(m.y)}
              y2={geom.sy(m.y)}
              className="marker"
              style={{ stroke: m.color ?? "var(--faint)" }}
            />
            <text
              x={W - PAD.right}
              y={geom.sy(m.y) - 5}
              className="axis"
              textAnchor="end"
              style={{ fill: m.color ?? "var(--faint)" }}
            >
              {m.label}
            </text>
          </g>
        ))}

        <g clipPath={`url(#clip${gid})`}>
          {paths.map((p) => (
            <path
              key={p.key}
              d={p.d}
              fill="none"
              stroke={p.color}
              strokeWidth={1.8}
              strokeDasharray={p.dashed ? "4 3" : undefined}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
        </g>

        {hoverIdx !== null && series[0] && (
          <g>
            <line
              x1={geom.sx(series[0].x[hoverIdx])}
              x2={geom.sx(series[0].x[hoverIdx])}
              y1={PAD.top}
              y2={height - PAD.bottom}
              className="crosshair"
            />
            {series.map((s) =>
              isFinite(s.y[hoverIdx]) && !(logY && s.y[hoverIdx] <= 0) ? (
                <circle
                  key={s.key}
                  cx={geom.sx(s.x[hoverIdx])}
                  cy={geom.sy(s.y[hoverIdx])}
                  r={3}
                  fill={s.color}
                />
              ) : null,
            )}
          </g>
        )}
      </svg>

      {hoverIdx !== null && series[0] && (
        <div className="chart-read">
          <span className="chart-read-x">{(xReadFormat ?? xFormat)(series[0].x[hoverIdx])}</span>
          {series.map((s) => (
            <span key={s.key}>
              <i style={{ background: s.color }} />
              {s.label} <b>{yFormat(s.y[hoverIdx])}</b>
            </span>
          ))}
        </div>
      )}

      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.key}>
            <i style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Histogram({
  bins,
  lo,
  hi,
  under,
  over,
  color,
  floor,
  breachRate,
  height = 220,
  ariaLabel,
}: {
  bins: number[];
  lo: number;
  hi: number;
  under: number;
  over: number;
  color: string;
  /** Settlement floor: bars to its left are breaches. */
  floor: number;
  /** Exact breach rate from the run. Bars are binned, so this is not derived
      from them, which keeps the chart and the published tables in agreement. */
  breachRate: number;
  height?: number;
  ariaLabel?: string;
}) {
  const { ref, W, pad: PAD } = useChartBox();
  const peak = Math.max(...bins, 0.001);
  const iw = W - PAD.left - PAD.right;
  const ih = height - PAD.top - PAD.bottom;
  const bw = iw / bins.length;
  const sx = (v: number) => PAD.left + ((v - lo) / (hi - lo)) * iw;

  return (
    <div className="chart" ref={ref}>
      <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={ariaLabel}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1={PAD.left}
            x2={W - PAD.right}
            y1={PAD.top + ih - f * ih}
            y2={PAD.top + ih - f * ih}
            className="grid"
          />
        ))}
        {bins.map((v, i) => {
          const center = lo + (i + 0.5) * ((hi - lo) / bins.length);
          const h = (v / peak) * ih;
          const isBreach = center < floor;
          return (
            <rect
              key={i}
              x={PAD.left + i * bw + 0.5}
              y={PAD.top + ih - h}
              width={Math.max(0.8, bw - 1)}
              height={h}
              fill={isBreach ? "var(--red)" : color}
              opacity={isBreach ? 0.85 : 0.9}
            />
          );
        })}
        <line x1={sx(floor)} x2={sx(floor)} y1={PAD.top} y2={PAD.top + ih} className="marker" style={{ stroke: "var(--red)" }} />
        <text x={sx(floor)} y={PAD.top - 2} className="axis" textAnchor="middle" style={{ fill: "var(--red)" }}>
          floor
        </text>
        <line x1={sx(1)} x2={sx(1)} y1={PAD.top} y2={PAD.top + ih} className="marker" />
        <text x={sx(1)} y={PAD.top - 2} className="axis" textAnchor="middle">
          break even
        </text>
        {[lo, (lo + 1) / 2, 1, (1 + hi) / 2, hi].map((v) => (
          <text key={v} x={sx(v)} y={height - 8} className="axis" textAnchor="middle">
            {v.toFixed(2)}×
          </text>
        ))}
      </svg>
      <div className="chart-legend">
        <span>
          <i style={{ background: "var(--red)" }} />
          breached {(breachRate * 100).toFixed(1)}%
        </span>
        {under > 0 && <span className="tiny">{(under * 100).toFixed(1)}% below {lo}×</span>}
        {over > 0 && <span className="tiny">{(over * 100).toFixed(1)}% above {hi}×</span>}
      </div>
    </div>
  );
}
