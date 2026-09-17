use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode};

/// The rules and collateral terms an operator publishes for an agent.
/// Editable while the agent is a draft, permanent once it is published.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub struct AgentTerms {
    /// Collateral guaranteed per deposited lamport, in bps (3000 = 30%).
    pub collateral_ratio_bps: u16,
    /// Performance fee on profit, in bps. At most collateral_ratio_bps / FEE_CAP_DIVISOR.
    pub fee_bps: u16,
    /// Loss the agent may incur before its bond pays the trader, in bps of principal.
    pub max_drawdown_bps: u16,
    /// Shortest and longest position a trader may open, in seconds.
    pub min_duration_secs: i64,
    pub max_duration_secs: i64,
    /// Token mints the agent commits to trading.
    #[max_len(MAX_ALLOWED_ASSETS)]
    pub allowed_assets: Vec<Pubkey>,
    /// The agent's full trading rules in plain language.
    #[max_len(MAX_RULES_LEN)]
    pub rules: String,
}

impl AgentTerms {
    pub fn max_fee_bps(collateral_ratio_bps: u16) -> u16 {
        collateral_ratio_bps / FEE_CAP_DIVISOR
    }

    pub fn validate(&self) -> Result<()> {
        require!(
            (MIN_COLLATERAL_RATIO_BPS..=MAX_COLLATERAL_RATIO_BPS).contains(&self.collateral_ratio_bps),
            ErrorCode::InvalidCollateralRatio
        );
        require!(
            self.fee_bps <= Self::max_fee_bps(self.collateral_ratio_bps),
            ErrorCode::FeeTooHigh
        );
        require!(self.max_drawdown_bps <= MAX_DRAWDOWN_BPS, ErrorCode::InvalidDrawdown);
        require!(
            self.min_duration_secs >= MIN_POSITION_DURATION
                && self.max_duration_secs <= MAX_POSITION_DURATION
                && self.min_duration_secs <= self.max_duration_secs,
            ErrorCode::InvalidTradingWindow
        );
        require!(
            !self.allowed_assets.is_empty() && self.allowed_assets.len() <= MAX_ALLOWED_ASSETS,
            ErrorCode::InvalidAllowedAssets
        );
        for (i, a) in self.allowed_assets.iter().enumerate() {
            require!(
                !self.allowed_assets[..i].contains(a),
                ErrorCode::InvalidAllowedAssets
            );
        }
        require!(
            !self.rules.trim().is_empty() && self.rules.len() <= MAX_RULES_LEN,
            ErrorCode::InvalidRules
        );
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum AgentStatus {
    /// Terms can still change; traders cannot allocate.
    Draft,
    /// Published and accepting new positions.
    Active,
    /// Published; the operator has stopped new positions.
    Paused,
}

/// An AI trading agent created and managed by an operator.
#[account(discriminator = AGENT_DISCRIMINATOR)]
#[derive(InitSpace)]
pub struct Agent {
    /// Creator and manager: controls terms, collateral, and the trading key.
    pub operator: Pubkey,
    /// Key allowed to draw and settle positions. Defaults to the operator.
    pub executor: Pubkey,
    /// Per-operator index, part of the PDA seed.
    pub agent_id: u64,
    pub status: AgentStatus,
    #[max_len(MAX_NAME_LEN)]
    pub name: String,
    #[max_len(MAX_DESCRIPTION_LEN)]
    pub description: String,
    pub terms: AgentTerms,
    pub created_at: i64,
    pub published_at: i64,
    /// Lamports the operator has deposited as collateral (excluding the vault rent floor).
    pub total_collateral: u64,
    /// Collateral reserved for open positions.
    pub locked_collateral: u64,
    /// Principal currently under management.
    pub capital_managed: u64,
    pub open_positions: u32,
    pub settled_positions: u32,
    pub defaulted_positions: u32,
    /// Positions that ended with collateral paid to the trader.
    pub breach_count: u32,
    pub slashed_total: u64,
    pub fees_earned: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

impl Agent {
    pub fn free_collateral(&self) -> u64 {
        self.total_collateral.saturating_sub(self.locked_collateral)
    }

    pub fn is_published(&self) -> bool {
        self.status != AgentStatus::Draft
    }

    pub fn can_execute(&self, key: &Pubkey) -> bool {
        *key == self.executor || *key == self.operator
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum PositionStatus {
    /// Trader deposited; the agent has not drawn the funds yet.
    Open,
    /// The agent drew the principal and is trading with it.
    Trading,
    /// The agent returned funds and the position was settled.
    Settled,
    /// The agent missed the deadline; collateral was paid to the trader.
    Defaulted,
    /// The trader cancelled before the agent drew funds.
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Breach {
    None,
    /// Returned less than the principal minus the tolerated drawdown.
    Drawdown,
    /// Did not settle before the deadline.
    MissedDeadline,
}

/// A trader's capital allocation to an agent, backed by reserved collateral.
#[account(discriminator = POSITION_DISCRIMINATOR)]
#[derive(InitSpace)]
pub struct Position {
    pub trader: Pubkey,
    pub agent: Pubkey,
    /// Per-trader nonce used in the PDA seed.
    pub nonce: u64,
    pub principal: u64,
    pub locked_collateral: u64,
    /// Snapshot of the agent's terms at open time.
    pub fee_bps: u16,
    pub max_drawdown_bps: u16,
    pub status: PositionStatus,
    pub breach: Breach,
    pub opened_at: i64,
    pub deadline: i64,
    pub drawn_at: i64,
    pub closed_at: i64,
    pub returned: u64,
    pub slashed: u64,
    pub fee_paid: u64,
    pub bump: u8,
    pub vault_bump: u8,
}
