import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { BN, BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import idl from "@/lib/idl.json";
import {
  AGENT_DISCRIMINATOR,
  AGENT_STATUS_OFFSET,
  POSITION_BREACH_OFFSET,
  POSITION_DISCRIMINATOR,
  POSITION_STATUS_OFFSET,
  countLiveStats,
} from "@/lib/liveStats";

const coder = new BorshAccountsCoder(idl as Idl);
const key = () => Keypair.generate().publicKey;

type AgentStatus = "draft" | "active" | "paused";
type PositionStatus = "open" | "trading" | "settled" | "defaulted" | "cancelled";
type Breach = "none" | "drawdown" | "missedDeadline";

// The coder built straight from lib/idl.json uses the IDL's own names: snake_case fields and
// PascalCase enum variants.
const variant = (v: string) => ({ [v[0].toUpperCase() + v.slice(1)]: {} });

async function agent(status: AgentStatus, name = "Agent") {
  return coder.encode("Agent", {
    operator: key(),
    executor: key(),
    agent_id: new BN(7),
    status: variant(status),
    name,
    description: "d".repeat(name.length * 3),
    terms: {
      collateral_ratio_bps: 3_000,
      fee_bps: 1_000,
      max_drawdown_bps: 2_000,
      min_duration_secs: new BN(60),
      max_duration_secs: new BN(86_400),
      allowed_assets: [key(), key()],
      rules: "Rules",
    },
    created_at: new BN(1),
    published_at: new BN(2),
    total_collateral: new BN(5_000_000_000),
    locked_collateral: new BN(0),
    capital_managed: new BN(0),
    open_positions: 0,
    settled_positions: 0,
    defaulted_positions: 0,
    breach_count: 0,
    slashed_total: new BN(0),
    fees_earned: new BN(0),
    bump: 255,
    vault_bump: 254,
  });
}

async function position(status: PositionStatus, breach: Breach) {
  return coder.encode("Position", {
    trader: key(),
    agent: key(),
    nonce: new BN(3),
    principal: new BN(1_000_000_000),
    locked_collateral: new BN(300_000_000),
    fee_bps: 0x0102, // non-zero bytes either side of the status offset
    max_drawdown_bps: 0x0304,
    status: variant(status),
    breach: variant(breach),
    opened_at: new BN(0x0505),
    deadline: new BN(0x0606),
    drawn_at: new BN(0),
    closed_at: new BN(0),
    returned: new BN(0),
    slashed: new BN(0),
    fee_paid: new BN(0),
    bump: 1,
    vault_bump: 2,
  });
}

const b64 = (buf: Buffer) => ({ data: buf.toString("base64") });

/** Byte offset of `field` in an IDL struct, summing the fixed-size fields before it. */
function idlOffset(struct: string, field: string): number {
  const sizes: Record<string, number> = { pubkey: 32, u64: 8, i64: 8, u32: 4, u16: 2, u8: 1 };
  const t = idl.types.find((x) => x.name === struct)!;
  let off = 8; // discriminator
  for (const f of (t.type as { fields: { name: string; type: unknown }[] }).fields) {
    if (f.name === field) return off;
    if (typeof f.type === "string" && f.type in sizes) off += sizes[f.type];
    else if (typeof f.type === "object" && f.type && "defined" in f.type) off += 1; // fieldless enum
    else throw new Error(`${struct}.${f.name} is not fixed-size; ${field} has no fixed offset`);
  }
  throw new Error(`no field ${field}`);
}

describe("LiveStats byte offsets", () => {
  it("are 80, 100 and 101", () => {
    assert.equal(AGENT_STATUS_OFFSET, 80);
    assert.equal(POSITION_STATUS_OFFSET, 100);
    assert.equal(POSITION_BREACH_OFFSET, 101);
  });

  it("match the account layouts in lib/idl.json", () => {
    assert.equal(idlOffset("Agent", "status"), AGENT_STATUS_OFFSET);
    assert.equal(idlOffset("Position", "status"), POSITION_STATUS_OFFSET);
    assert.equal(idlOffset("Position", "breach"), POSITION_BREACH_OFFSET);
  });

  it("the discriminators match the IDL", () => {
    const disc = (name: string) => Buffer.from(idl.accounts.find((a) => a.name === name)!.discriminator).toString("latin1");
    assert.equal(disc("Agent"), AGENT_DISCRIMINATOR);
    assert.equal(disc("Position"), POSITION_DISCRIMINATOR);
  });
});

describe("LiveStats reading Anchor-encoded accounts", () => {
  let agents: Record<AgentStatus, Buffer>;
  before(async () => {
    agents = { draft: await agent("draft"), active: await agent("active"), paused: await agent("paused") };
  });

  it("the agent status byte sits at offset 80", () => {
    assert.equal(agents.draft[AGENT_STATUS_OFFSET], 0);
    assert.equal(agents.active[AGENT_STATUS_OFFSET], 1);
    assert.equal(agents.paused[AGENT_STATUS_OFFSET], 2);
    for (const s of ["draft", "active", "paused"] as const) {
      assert.deepEqual(coder.decode("Agent", agents[s]).status, variant(s));
    }
  });

  it("the agent status offset doesn't move with variable-length fields", async () => {
    const long = await agent("paused", "x".repeat(32));
    assert.equal(long[AGENT_STATUS_OFFSET], 2);
  });

  it("the position status and breach bytes sit at 100 and 101", async () => {
    const statuses: PositionStatus[] = ["open", "trading", "settled", "defaulted", "cancelled"];
    const breaches: Breach[] = ["none", "drawdown", "missedDeadline"];
    for (const [si, s] of statuses.entries()) {
      for (const [bi, b] of breaches.entries()) {
        const buf = await position(s, b);
        assert.equal(buf[POSITION_STATUS_OFFSET], si, `${s}/${b} status`);
        assert.equal(buf[POSITION_BREACH_OFFSET], bi, `${s}/${b} breach`);
      }
    }
  });

  it("counts published agents, all positions, and clean settlements", async () => {
    const accounts = [
      b64(agents.draft),
      b64(agents.active),
      b64(agents.paused),
      b64(await agent("active", "Another")),
      b64(await position("open", "none")),
      b64(await position("trading", "none")),
      b64(await position("settled", "none")),
      b64(await position("settled", "none")),
      b64(await position("settled", "drawdown")),
      b64(await position("settled", "missedDeadline")),
      b64(await position("defaulted", "missedDeadline")),
      b64(await position("cancelled", "none")),
    ];
    assert.deepEqual(countLiveStats(accounts), { agents: 3, positions: 8, settled: 2 });
  });

  it("ignores accounts with other discriminators and truncated agents", () => {
    const other = Buffer.alloc(120, 2);
    other.write("OTHERACC", 0, "latin1");
    const truncated = Buffer.from(agents.active.subarray(0, AGENT_STATUS_OFFSET));
    assert.deepEqual(countLiveStats([b64(other), b64(truncated), { data: "" }]), { agents: 0, positions: 0, settled: 0 });
  });
});
