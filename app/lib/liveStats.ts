/**
 * Counts for the landing page's live stats, read straight from raw account bytes so the page
 * doesn't need the Solana client libraries.
 */

export const AGENT_DISCRIMINATOR = "CAagent2";
export const POSITION_DISCRIMINATOR = "CApos_v2";
// Byte offsets from programs/proof_of_agent/src/state.rs (and lib/idl.json); fixed-size fields only.
export const AGENT_STATUS_OFFSET = 8 + 32 + 32 + 8; // discriminator + operator + executor + agent_id
const AGENT_DRAFT = 0; // AgentStatus::Draft; Active = 1, Paused = 2
export const POSITION_STATUS_OFFSET = 8 + 32 + 32 + 8 + 8 + 8 + 2 + 2; // discriminator + trader + agent + nonce + principal + locked + fee + drawdown
export const POSITION_BREACH_OFFSET = POSITION_STATUS_OFFSET + 1;
const POSITION_SETTLED = 2; // PositionStatus::Settled
const BREACH_NONE = 0;

export type LiveCounts = { agents: number; positions: number; settled: number };

/** Published agents, all positions, and positions settled without a breach, from base64 account data. */
export function countLiveStats(accounts: { data: string }[]): LiveCounts {
  let agents = 0, positions = 0, settled = 0;
  for (const a of accounts) {
    const raw = atob(a.data);
    const disc = raw.slice(0, 8);
    if (disc === AGENT_DISCRIMINATOR) {
      // Published agents only (live or paused); drafts aren't visible to traders.
      if (raw.length > AGENT_STATUS_OFFSET && raw.charCodeAt(AGENT_STATUS_OFFSET) !== AGENT_DRAFT) agents++;
    } else if (disc === POSITION_DISCRIMINATOR) {
      positions++;
      if (raw.charCodeAt(POSITION_STATUS_OFFSET) === POSITION_SETTLED && raw.charCodeAt(POSITION_BREACH_OFFSET) === BREACH_NONE) settled++;
    }
  }
  return { agents, positions, settled };
}
