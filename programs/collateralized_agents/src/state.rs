use anchor_lang::prelude::*;

use crate::constants::*;

/// An AI trading agent registered on the protocol. Its collateral vault
/// backs every open position it accepts.
#[account]
#[derive(InitSpace)]
pub struct Agent {
    /// Wallet that operates the agent (deposits collateral, draws & settles).
    pub authority: Pubkey,
    #[max_len(MAX_NAME_LEN)]
    pub name: String,
    #[max_len(MAX_STRATEGY_LEN)]
    pub strategy: String,
    /// Collateral guaranteed per deposited lamport, in bps (3000 = 30%).
    pub collateral_ratio_bps: u16,
    /// Performance fee on profit, in bps. Derived from collateral_ratio_bps.
    pub fee_bps: u16,
    /// Loss the agent may incur before it counts as misbehaviour, in bps of principal.
    pub max_drawdown_bps: u16,
    /// Whether the agent accepts new positions.
    pub accepting: bool,
    /// Total lamports the agent has in its vault (excluding rent floor).
    pub total_collateral: u64,
    /// Lamports currently locked as guarantees for open positions.
    pub locked_collateral: u64,
    /// Total capital under management across open positions.
    pub capital_managed: u64,
    pub open_positions: u32,
    pub settled_positions: u32,
    pub defaulted_positions: u32,
    /// Lifetime lamports slashed from this agent.
    pub slashed_total: u64,
    /// Lifetime fees earned.
    pub fees_earned: u64,
    pub created_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

impl Agent {
    pub fn free_collateral(&self) -> u64 {
        self.total_collateral.saturating_sub(self.locked_collateral)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum PositionStatus {
    /// Trader deposited; agent has not drawn the funds yet.
    Open,
    /// Agent drew the principal and is trading with it.
    Trading,
    /// Agent returned funds and the position was settled.
    Settled,
    /// Agent missed the deadline; collateral was paid out to the trader.
    Defaulted,
    /// Trader cancelled before the agent drew funds.
    Cancelled,
}

/// A trader's capital allocation to an agent, backed by locked collateral.
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub trader: Pubkey,
    pub agent: Pubkey,
    /// Per-trader nonce used in the PDA seed.
    pub nonce: u64,
    /// Lamports the trader deposited.
    pub principal: u64,
    /// Lamports of agent collateral locked as a guarantee for this position.
    pub locked_collateral: u64,
    /// Snapshot of the agent's terms at open time.
    pub fee_bps: u16,
    pub max_drawdown_bps: u16,
    pub status: PositionStatus,
    pub opened_at: i64,
    pub deadline: i64,
    pub drawn_at: i64,
    pub closed_at: i64,
    /// Lamports the agent returned at settlement.
    pub returned: u64,
    /// Lamports paid to the trader from the agent's collateral.
    pub slashed: u64,
    /// Fee paid to the agent.
    pub fee_paid: u64,
    pub bump: u8,
    pub vault_bump: u8,
}
