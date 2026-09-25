import { Keypair, PublicKey } from "@solana/web3.js";
import { chmodSync, writeFileSync } from "node:fs";
import { BN, LAMPORTS, PoaClient, agentPda, loadKeypair } from "./client.js";
import { Runner } from "./runner.js";
import { parseCli, parseId, parsePercentBps, parseScaled, parseSol, runnerFees, runnerTiming } from "./args.js";

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
          [--paper] [--notify "cmd"] [--poll 15] [--priority-fee 1000] [--priority-fee-urgent 50000]

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

const { values: v, positionals } = parseCli();

const rpc = v.rpc ?? process.env.POA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const need = (x: string | undefined, name: string) => { if (!x) throw new Error(`--${name} is required`); return x; };
const pk = (s: string) => new PublicKey(s);
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
      const id = parseId(v.id!);
      const terms = {
        collateralRatioBps: parsePercentBps(need(v.ratio, "ratio"), "ratio"), feeBps: parsePercentBps(need(v.fee, "fee"), "fee"),
        maxDrawdownBps: parsePercentBps(need(v.drawdown, "drawdown"), "drawdown"),
        minDurationSecs: new BN(parseScaled(v["min-hours"]!, "min-hours", 3600)), maxDurationSecs: new BN(parseScaled(v["max-days"]!, "max-days", 86400)),
        allowedAssets: v.assets!.split(",").map((s) => pk(ASSETS[s.trim().toUpperCase()] ?? s.trim())), rules: need(v.rules, "rules"),
      };
      const sig = await c.createAgent(id, need(v.name, "name"), v.description!, terms);
      console.log(`created draft agent ${agentPda(c.signer.publicKey, id).toBase58()} (${sig.slice(0, 12)}…)\nnext: deposit collateral, bind a trading key, then publish`);
      return;
    }
    const agent = pk(need(v.agent, "agent"));
    const sig =
      cmd === "deposit" ? await c.depositCollateral(agent, parseSol(need(v.sol, "sol")))
      : cmd === "withdraw" ? await c.withdrawCollateral(agent, parseSol(need(v.sol, "sol")))
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
      ...runnerTiming(v), ...runnerFees(v), paper: v.paper!, stateFile: v.state!,
    });
    await runner.start();
    return;
  }

  if (group === "dev" && cmd === "open") {
    const c = new PoaClient(rpc, loadKeypair(need(v.key, "key")));
    const { position, sig } = await c.openPosition(pk(need(v.agent, "agent")), parseSol(need(v.sol, "sol")), parseScaled(v.minutes!, "minutes", 60));
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
