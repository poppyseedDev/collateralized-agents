import { parseArgs } from "node:util";
import { Keypair, PublicKey } from "@solana/web3.js";
import { chmodSync, writeFileSync } from "node:fs";
import { BN, LAMPORTS, PoaClient, agentPda, loadKeypair } from "./client.js";
import { Runner } from "./runner.js";

const HELP = `poa — operate a Proof of Agent agent from your own server

  poa agent create   --key operator.json --name "…" [--description "…"] --ratio 30 --fee 10 --drawdown 15
                     --min-hours 1 --max-days 7 --assets SOL,USDC --rules "…" [--id 1]
  poa agent deposit  --key operator.json --agent <pubkey> --sol 1.5
  poa agent withdraw --key operator.json --agent <pubkey> --sol 1.5
  poa agent bind     --key operator.json --agent <pubkey> --trading-key <pubkey>
  poa agent publish  --key operator.json --agent <pubkey>
  poa agent pause|resume --key operator.json --agent <pubkey>
  poa agent status   --agent <pubkey>

  poa run --key trading.json --agent <pubkey> [--hook "cmd"] [--hold-min 15] [--buffer-min 5] [--grace-sec 60]
          [--paper] [--notify "cmd"] [--poll 15]

  poa keygen --out trading.json
  poa dev open   --key trader.json --agent <pubkey> --sol 0.1 --minutes 30      (test helper)
  poa dev cancel --key trader.json --agent <pubkey> --position <pubkey>       (before the agent draws it)

Options: --rpc <url> (default: $POA_RPC_URL or https://api.mainnet-beta.solana.com)
`;

const ASSETS: Record<string, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  DEVUSDC: "BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k",
};

const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rpc: { type: "string" }, key: { type: "string" }, agent: { type: "string" }, id: { type: "string", default: "1" },
    name: { type: "string" }, description: { type: "string", default: "" }, ratio: { type: "string" }, fee: { type: "string" },
    drawdown: { type: "string" }, "min-hours": { type: "string", default: "1" }, "max-days": { type: "string", default: "7" },
    assets: { type: "string", default: "SOL,USDC" }, rules: { type: "string" }, sol: { type: "string" }, "trading-key": { type: "string" },
    hook: { type: "string" }, notify: { type: "string" }, "hold-min": { type: "string", default: "15" }, "buffer-min": { type: "string", default: "5" },
    "grace-sec": { type: "string", default: "60" }, position: { type: "string" },
    paper: { type: "boolean", default: false }, poll: { type: "string", default: "15" }, minutes: { type: "string", default: "30" },
    out: { type: "string", default: "trading.json" }, state: { type: "string", default: ".poa/state.json" }, help: { type: "boolean", default: false },
  },
});

const rpc = v.rpc ?? process.env.POA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const need = (x: string | undefined, name: string) => { if (!x) throw new Error(`--${name} is required`); return x; };
const pk = (s: string) => new PublicKey(s);
const lamports = (solStr: string) => Math.round(parseFloat(solStr) * LAMPORTS);
const bps = (pct: string) => Math.round(parseFloat(pct) * 100);
const fmt = (n: BN | number) => (Number(n.toString()) / LAMPORTS).toFixed(4);

async function main() {
  const [group, cmd] = positionals;
  if (v.help || !group) { console.log(HELP); return; }

  if (group === "keygen") {
    const kp = Keypair.generate();
    try {
      // "wx": never overwrite an existing key file
      writeFileSync(v.out!, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600, flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${v.out} already exists; not overwriting a key file`);
      throw e;
    }
    chmodSync(v.out!, 0o600); // the mode above is subject to umask
    console.log(`wrote ${v.out} (mode 600)\npublic key: ${kp.publicKey.toBase58()}\nkeep it out of git: add ${v.out} to your .gitignore`);
    return;
  }

  if (group === "agent") {
    if (cmd === "status") {
      const c = new PoaClient(rpc, Keypair.generate());
      const a = await c.agent(pk(need(v.agent, "agent")));
      if (!a) { console.log("agent not found"); return; }
      const t = a.terms;
      console.log(`${a.name} (${a.status})\n  operator     ${a.operator.toBase58()}\n  trading key  ${a.executor.toBase58()}\n  terms        ${t.collateralRatioBps / 100}% collateral · ${t.feeBps / 100}% fee · ${t.maxDrawdownBps / 100}% max drawdown · ${t.minDurationSecs.toNumber() / 3600}h–${t.maxDurationSecs.toNumber() / 86400}d\n  collateral   ${fmt(a.totalCollateral)} SOL (${fmt(a.lockedCollateral)} reserved) · capacity ${fmt(Math.floor((a.totalCollateral.toNumber() - a.lockedCollateral.toNumber()) * 10_000 / t.collateralRatioBps))} SOL\n  record       ${a.settledPositions} settled · ${a.openPositions} open · ${a.breachCount} breaches · ${fmt(a.feesEarned)} SOL fees`);
      const ps = await c.positions(a.publicKey);
      for (const p of ps.filter((p) => p.status === "open" || p.status === "trading")) {
        console.log(`  position ${p.publicKey.toBase58()} ${p.status} ${fmt(p.principal)} SOL, deadline ${new Date(p.deadline.toNumber() * 1000).toISOString()}`);
      }
      return;
    }
    const c = new PoaClient(rpc, loadKeypair(need(v.key, "key")));
    if (cmd === "create") {
      const id = parseInt(v.id!, 10);
      const terms = {
        collateralRatioBps: bps(need(v.ratio, "ratio")), feeBps: bps(need(v.fee, "fee")), maxDrawdownBps: bps(need(v.drawdown, "drawdown")),
        minDurationSecs: new BN(Math.round(parseFloat(v["min-hours"]!) * 3600)), maxDurationSecs: new BN(Math.round(parseFloat(v["max-days"]!) * 86400)),
        allowedAssets: v.assets!.split(",").map((s) => pk(ASSETS[s.trim().toUpperCase()] ?? s.trim())), rules: need(v.rules, "rules"),
      };
      const sig = await c.createAgent(id, need(v.name, "name"), v.description!, terms);
      console.log(`created draft agent ${agentPda(c.signer.publicKey, id).toBase58()} (${sig.slice(0, 12)}…)\nnext: deposit collateral, bind a trading key, then publish`);
      return;
    }
    const agent = pk(need(v.agent, "agent"));
    const sig =
      cmd === "deposit" ? await c.depositCollateral(agent, lamports(need(v.sol, "sol")))
      : cmd === "withdraw" ? await c.withdrawCollateral(agent, lamports(need(v.sol, "sol")))
      : cmd === "bind" ? await c.setExecutor(agent, pk(need(v["trading-key"], "trading-key")))
      : cmd === "publish" ? await c.publishAgent(agent)
      : cmd === "pause" ? await c.setAccepting(agent, false)
      : cmd === "resume" ? await c.setAccepting(agent, true)
      : (() => { throw new Error(`unknown command: agent ${cmd}`); })();
    console.log(`${cmd} ok (${sig.slice(0, 12)}…)`);
    return;
  }

  if (group === "run") {
    const runner = new Runner({
      rpcUrl: rpc, agent: pk(need(v.agent, "agent")), tradingKey: loadKeypair(need(v.key, "key")), hook: v.hook, notify: v.notify,
      holdSecs: Math.round(parseFloat(v["hold-min"]!) * 60), bufferSecs: Math.round(parseFloat(v["buffer-min"]!) * 60),
      graceSecs: Math.round(parseFloat(v["grace-sec"]!)),
      paper: v.paper!, pollMs: parseInt(v.poll!, 10) * 1000, stateFile: v.state!,
    });
    await runner.start();
    return;
  }

  if (group === "dev" && cmd === "open") {
    const c = new PoaClient(rpc, loadKeypair(need(v.key, "key")));
    const { position, sig } = await c.openPosition(pk(need(v.agent, "agent")), lamports(need(v.sol, "sol")), Math.round(parseFloat(v.minutes!) * 60));
    console.log(`opened ${position.toBase58()} (${sig.slice(0, 12)}…)`);
    return;
  }

  if (group === "dev" && cmd === "cancel") {
    const c = new PoaClient(rpc, loadKeypair(need(v.key, "key")));
    const sig = await c.cancelPosition(pk(need(v.agent, "agent")), pk(need(v.position, "position")));
    console.log(`cancelled (${sig.slice(0, 12)}…)`);
    return;
  }

  console.log(HELP);
}

main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
