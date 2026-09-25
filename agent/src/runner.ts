import { AGENTS, POLL_MS } from "./config.js";
import { initOrca, mainPrice } from "./orca.js";
import { AgentRunner, glog, heartbeatNote, msg, refreshClock, tickAll } from "./agent.js";

const HEARTBEAT_URL = process.env.HEARTBEAT_URL ?? "https://dev.proofofagent.dev/api/heartbeat";
const HEARTBEAT_SECRET = process.env.HEARTBEAT_SECRET;

/** Tells the site the runner is alive so testers can see whether agents are online. */
async function heartbeat(agents: string[], note?: string) {
  if (!HEARTBEAT_SECRET) return;
  try {
    await fetch(HEARTBEAT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${HEARTBEAT_SECRET}` },
      body: JSON.stringify({ agents, note }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    glog("heartbeat failed:", (e as Error).message);
  }
}

async function main() {
  await initOrca();
  const only = process.argv.slice(2);
  const runners = AGENTS.filter((a) => !only.length || only.includes(a.id)).map((a) => new AgentRunner(a));
  for (const r of runners) await r.init();

  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
    console.log("stopping after this tick…");
  });

  while (!stopping) {
    await refreshClock();
    let price: number | null = null;
    try {
      price = await mainPrice();
    } catch (e) {
      glog("price unavailable:", msg(e));
    }
    const { ran, degraded } = await tickAll(runners, price);
    // Only report agents whose tick actually ran.
    if (ran.length) await heartbeat(ran, heartbeatNote(degraded));
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
  for (const r of runners) r.save();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
