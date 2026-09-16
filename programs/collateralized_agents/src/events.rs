use anchor_lang::prelude::*;

use crate::state::PositionStatus;

#[event]
pub struct AgentRegistered {
    pub agent: Pubkey,
    pub authority: Pubkey,
    pub collateral_ratio_bps: u16,
    pub fee_bps: u16,
}

#[event]
pub struct CollateralChanged {
    pub agent: Pubkey,
    pub delta: i64,
    pub total_collateral: u64,
}

#[event]
pub struct PositionOpened {
    pub position: Pubkey,
    pub agent: Pubkey,
    pub trader: Pubkey,
    pub principal: u64,
    pub locked_collateral: u64,
    pub deadline: i64,
}

#[event]
pub struct PositionClosed {
    pub position: Pubkey,
    pub agent: Pubkey,
    pub trader: Pubkey,
    pub status: PositionStatus,
    pub returned: u64,
    pub slashed: u64,
    pub fee_paid: u64,
    pub trader_payout: u64,
}
