use anchor_lang::prelude::*;

use crate::state::{AgentTerms, Breach, PositionStatus};

#[event]
pub struct AgentCreated {
    pub agent: Pubkey,
    pub operator: Pubkey,
    pub agent_id: u64,
}

#[event]
pub struct AgentPublished {
    pub agent: Pubkey,
    pub operator: Pubkey,
    pub terms: AgentTerms,
    pub collateral: u64,
}

#[event]
pub struct ExecutorBound {
    pub agent: Pubkey,
    pub executor: Pubkey,
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
    pub breach: Breach,
    pub returned: u64,
    pub slashed: u64,
    pub fee_paid: u64,
    pub trader_payout: u64,
}

#[event]
pub struct BreachRecorded {
    pub agent: Pubkey,
    pub position: Pubkey,
    pub breach: Breach,
    pub slashed: u64,
}
