use anchor_lang::prelude::*;

#[constant]
pub const AGENT_SEED: &[u8] = b"agent";
#[constant]
pub const AGENT_VAULT_SEED: &[u8] = b"agent_vault";
#[constant]
pub const POSITION_SEED: &[u8] = b"position";
#[constant]
pub const POSITION_VAULT_SEED: &[u8] = b"position_vault";

pub const BPS_DENOMINATOR: u64 = 10_000;

/// Minimum collateral an agent must guarantee per unit of capital (10%).
#[constant]
pub const MIN_COLLATERAL_RATIO_BPS: u16 = 1_000;
/// Maximum collateral ratio (100%: every deposited lamport is fully backed).
#[constant]
pub const MAX_COLLATERAL_RATIO_BPS: u16 = 10_000;
/// Maximum drawdown an agent may declare as "normal trading loss" (50%).
#[constant]
pub const MAX_DRAWDOWN_BPS: u16 = 5_000;

/// Performance fee = collateral ratio / FEE_DIVISOR.
/// 30% collateral -> 15% of profit, 100% collateral -> 50% of profit.
#[constant]
pub const FEE_DIVISOR: u16 = 2;

#[constant]
pub const MIN_POSITION_DURATION: i64 = 60; // 1 minute
#[constant]
pub const MAX_POSITION_DURATION: i64 = 90 * 24 * 60 * 60; // 90 days

pub const MAX_NAME_LEN: usize = 32;
pub const MAX_STRATEGY_LEN: usize = 128;
