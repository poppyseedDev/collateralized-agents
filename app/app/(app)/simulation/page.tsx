"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { Histogram, LineChart, type Series } from "@/components/Charts";
import charts from "@/lib/simulationCharts.json";
import { SIM } from "@/lib/simulation";

const COLORS: Record<string, string> = {
  hold: "var(--muted)",
  momentum: "var(--lime)",
  mean_reversion: "var(--cyan)",
  coinflip: "var(--violet)",
  overtrader: "var(--amber)",
  leveraged_chaser: "var(--orange)",
  dishonest: "var(--red)",
};

const LABELS = charts.meta.labels as Record<string, string>;
const ORDER = charts.meta.order as string[];
const CURVE_KEYS = charts.meta.curveKeys as string[];
const DRAWDOWNS = charts.meta.drawdowns as number[];
const DURATIONS = charts.meta.durations as number[];

const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;
/** Keeps small values on a log axis legible: 0.001× stays 0.001×, not 0.00×. */
const mult = (v: number) => {
  if (v >= 100) return `${v.toFixed(0)}×`;
  if (v >= 1) return `${v.toFixed(1)}×`;
  if (v <= 0) return "0×";
  return `${v.toFixed(Math.min(6, Math.max(2, -Math.floor(Math.log10(v)))))}×`;
};

/**
 * Curve x values are indices; map them back to readable years. The series
 * starts mid-2020, so that partial year is skipped: its label would sit on
 * top of the first full one.
 */
function yearTicks(dates: string[]) {
  const ticks: number[] = [];
  let last = dates[0]?.slice(0, 4) ?? "";
  dates.forEach((d, i) => {
    const y = d.slice(0, 4);
    if (y !== last) {
      ticks.push(i);
      last = y;
    }
  });
  return ticks;
}

export default function SimulationPage() {
  return (
    <div className="sim-page">
      <header className="sim-hero">
        <div className="eyebrow">Simulation</div>
        <h1>What the bond actually costs an operator</h1>
        <p className="lead">
          Every chart here comes from the same run: {charts.meta.candles.toLocaleString()} days of real SOL/USD
          closes from {charts.meta.firstDate} to {charts.meta.lastDate}, a position opened on every single date, and
          each one settled through a port of the on-chain equation. About {SIM.positionsPerCell.toLocaleString()}{" "}
          positions behind every number.
        </p>
        <div className="sim-hero-links">
          <Link className="btn ghost" href="/how-it-works#risk">
            Read the summary
          </Link>
          <Link className="btn ghost" href="/">
            Browse agents
          </Link>
        </div>
      </header>

      <PriceChart />
      <EquityChart />
      <OutcomeChart />
      <BreachChart />
      <Caveats />
    </div>
  );
}

function Section({
  n,
  title,
  lede,
  children,
  note,
}: {
  n: number;
  title: string;
  lede: string;
  children: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <section className="card sim-section">
      <div className="eyebrow">Figure {n}</div>
      <h2>{title}</h2>
      <p>{lede}</p>
      {children}
      {note && <p className="tiny sim-note">{note}</p>}
    </section>
  );
}

function PriceChart() {
  const { dates, close } = charts.price;
  const series: Series[] = [
    {
      key: "sol",
      label: "SOL/USD",
      color: "var(--lime)",
      x: close.map((_, i) => i),
      y: close,
    },
  ];
  const ticks = useMemo(() => yearTicks(dates), [dates]);
  return (
    <Section
      n={1}
      title="The history everything runs on"
      lede="Six years of daily closes, covering two full cycles: the 2021 run, the 2022 collapse, and the recovery since. No synthetic paths and no assumed distribution."
    >
      <LineChart
        series={series}
        logY
        height={230}
        yFormat={(v) => `$${v >= 1 ? v.toFixed(0) : v.toFixed(2)}`}
        xFormat={(i) => dates[Math.round(i)]?.slice(0, 4) ?? ""}
        xReadFormat={(i) => dates[Math.round(i)] ?? ""}
        xTicks={ticks}
        ariaLabel="SOL price in dollars, log scale, 2020 to 2026"
      />
    </Section>
  );
}

function EquityChart() {
  const [denom, setDenom] = useState<"sol" | "usd">("sol");
  const dates = charts.curves.hold.dates;
  const series: Series[] = CURVE_KEYS.map((k) => {
    const c = (charts.curves as Record<string, { sol: number[]; usd: number[] }>)[k];
    return {
      key: k,
      label: LABELS[k],
      color: COLORS[k],
      x: c[denom].map((_, i) => i),
      y: c[denom],
      dashed: k === "hold",
    };
  });
  const ticks = useMemo(() => yearTicks(dates), [dates]);

  return (
    <Section
      n={2}
      title="The same strategies, valued two ways"
      lede="Proof of Agent settles in SOL, so the only thing that decides a breach is how much SOL comes back. Switch the denomination and the ranking changes completely."
      note={
        <>
          Coin-flipping turned every dollar into {mult(charts.curves.coinflip.usd.at(-1)!)} and every SOL into{" "}
          {mult(charts.curves.coinflip.sol.at(-1)!)}. An operator watching a dollar dashboard would think it was
          working. The protocol would have been slashing it the whole time.
        </>
      }
    >
      <div className="chart-toolbar">
        <div className="segmented">
          <button className={denom === "sol" ? "on" : ""} onClick={() => setDenom("sol")}>
            In SOL
          </button>
          <button className={denom === "usd" ? "on" : ""} onClick={() => setDenom("usd")}>
            In dollars
          </button>
        </div>
        <span className="tiny">Log scale, both starting at 1.0</span>
      </div>
      <LineChart
        series={series}
        logY
        height={300}
        yFormat={(v) => mult(v)}
        xFormat={(i) => dates[Math.round(i)]?.slice(0, 4) ?? ""}
        xReadFormat={(i) => dates[Math.round(i)] ?? ""}
        xTicks={ticks}
        markers={[{ y: 1, label: "start" }]}
        ariaLabel={`Strategy value denominated in ${denom}, log scale`}
      />
    </Section>
  );
}

function OutcomeChart() {
  const [strategy, setStrategy] = useState("momentum");
  const [tol, setTol] = useState(2000);
  const h = (charts.histogram as Record<string, {
    lo: number; hi: number; bins: number[]; under: number; over: number; median: number;
  }>)[strategy];
  const floor = 1 - tol / 10000;
  // Exact rate from the run, not counted off the bars.
  const breach =
    (charts.lines as Record<string, Record<string, { breach: number[] }>>)[strategy][
      String(charts.meta.histDuration)
    ].breach[DRAWDOWNS.indexOf(tol)];

  return (
    <Section
      n={3}
      title="What comes back at settlement"
      lede={`Every ${charts.meta.histDuration}-day position, sorted by the SOL multiple the operator returned. Anything left of the floor is a breach and pays the trader out of the bond. Drag the tolerance and watch the red region grow.`}
      note={
        <>
          Holding SOL is a single bar at exactly 1.00×, which is why it can never breach. The tall bar at 1.00× for
          trend following is every window where the signal never fired, so the agent simply held and returned what it
          drew.
        </>
      }
    >
      <div className="chart-toolbar wrap">
        <div className="segmented">
          {ORDER.map((k) => (
            <button key={k} className={k === strategy ? "on" : ""} onClick={() => setStrategy(k)}>
              {LABELS[k]}
            </button>
          ))}
        </div>
      </div>
      <label className="chart-slider">
        Drawdown tolerance · {tol / 100}% · floor at {floor.toFixed(2)}× · breaches{" "}
        {pct(breach, 1)} of positions
        <input
          type="range"
          min={0}
          max={DRAWDOWNS.length - 1}
          step={1}
          value={DRAWDOWNS.indexOf(tol)}
          onChange={(e) => setTol(DRAWDOWNS[Number(e.target.value)])}
        />
      </label>
      <Histogram
        bins={h.bins}
        lo={h.lo}
        hi={h.hi}
        under={h.under}
        over={h.over}
        floor={floor}
        breachRate={breach}
        color={COLORS[strategy]}
        ariaLabel={`Distribution of SOL returned by ${LABELS[strategy]}`}
      />
    </Section>
  );
}

function BreachChart() {
  const [duration, setDuration] = useState(30);
  const lines = charts.lines as Record<string, Record<string, { breach: number[]; apr: number[] }>>;
  const x = DRAWDOWNS.map((d) => d / 100);

  const breachSeries: Series[] = ORDER.map((k) => ({
    key: k,
    label: LABELS[k],
    color: COLORS[k],
    x,
    y: lines[k][String(duration)].breach,
    dashed: k === "hold",
  }));
  const aprSeries: Series[] = ORDER.filter((k) => k !== "dishonest").map((k) => ({
    key: k,
    label: LABELS[k],
    color: COLORS[k],
    x,
    y: lines[k][String(duration)].apr,
    dashed: k === "hold",
  }));

  return (
    <Section
      n={4}
      title="Choosing the tolerance is the whole decision"
      lede="An operator publishes one number that decides everything: how often they breach, and whether the fees cover it. Below is that trade-off across every tolerance the program allows, at a 30% collateral ratio."
      note={
        <>
          The second chart is the one that matters to an operator. Where a line crosses zero is the tightest floor
          that strategy can honestly promise. Trend following crosses early and stays up. Dishonesty is excluded
          because it loses the whole bond at every tolerance.
        </>
      }
    >
      <div className="chart-toolbar">
        <div className="segmented">
          {DURATIONS.map((d) => (
            <button key={d} className={d === duration ? "on" : ""} onClick={() => setDuration(d)}>
              {d}d
            </button>
          ))}
        </div>
        <span className="tiny">Position length</span>
      </div>

      <h3>How often the bond is touched</h3>
      <LineChart
        series={breachSeries}
        height={260}
        yFormat={(v) => pct(v)}
        xFormat={(v) => `${v}%`}
        xReadFormat={(v) => `${v}% tolerance`}
        xTicks={x}
        ariaLabel="Breach rate against drawdown tolerance"
      />

      <h3>What the operator earns on their bond</h3>
      <LineChart
        series={aprSeries}
        height={260}
        yFormat={(v) => pct(v)}
        xFormat={(v) => `${v}%`}
        xReadFormat={(v) => `${v}% tolerance`}
        xTicks={x}
        markers={[{ y: 0, label: "break even", color: "var(--text)" }]}
        ariaLabel="Annual operator return on bond against drawdown tolerance"
      />
    </Section>
  );
}

function Caveats() {
  return (
    <section className="card sim-section">
      <h2>What this does not show</h2>
      <ul className="bullets">
        <li>
          These are SOL and USDC rotations on daily closes. A strategy trading other assets has its own tracking error
          against SOL, and so its own safe tolerance.
        </li>
        <li>
          Six years is one sample. It covers two large drawdowns and two rallies, but the next regime can differ.
        </li>
        <li>
          Nothing here says a trader makes money. The protocol makes an agent accountable to its published floor. It
          does not create returns.
        </li>
        <li>
          Dishonesty costs the operator the whole reserved bond, but at any ratio below 100% they still keep more than
          they lose. The bond makes bad trading expensive, not theft unprofitable.
        </li>
      </ul>
      <p className="tiny">
        Source: {SIM.source}, {SIM.swapCostBps} bps of swap cost charged on every trade. The simulation is in{" "}
        <code>sim/</code> in the repository and runs with nothing beyond the Python standard library.
      </p>
    </section>
  );
}
