//! Collateralized Agents — an over-collateralised marketplace for AI trading agents on Solana.
//!
//! * Agents register with a collateral ratio (e.g. 30%) and deposit SOL collateral.
//! * The higher the ratio an agent guarantees, the higher the performance fee it earns.
//! * When a trader allocates capital, `principal * ratio` of the agent's collateral is
//!   locked as a guarantee. An agent cannot accept capital it cannot back.
//! * If the agent misbehaves (loses beyond its declared drawdown, or never returns the
//!   funds by the deadline) the locked collateral is paid out to the trader.

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("49aHwbzdT1iN8WYWdUZxrGoZpjSryyugMm4q9VTjXgSr");

#[program]
pub mod collateralized_agents {
    use super::*;

    // ---- agent side ----

    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        name: String,
        strategy: String,
        collateral_ratio_bps: u16,
        max_drawdown_bps: u16,
    ) -> Result<()> {
        instructions::register_agent::handle_register_agent(
            ctx,
            name,
            strategy,
            collateral_ratio_bps,
            max_drawdown_bps,
        )
    }

    pub fn deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
        instructions::deposit_collateral::handle_deposit_collateral(ctx, amount)
    }

    pub fn withdraw_collateral(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
        instructions::withdraw_collateral::handle_withdraw_collateral(ctx, amount)
    }

    pub fn set_accepting(ctx: Context<SetAccepting>, accepting: bool) -> Result<()> {
        instructions::set_accepting::handle_set_accepting(ctx, accepting)
    }

    pub fn draw_funds(ctx: Context<DrawFunds>) -> Result<()> {
        instructions::draw_funds::handle_draw_funds(ctx)
    }

    pub fn settle_position(ctx: Context<SettlePosition>, returned: u64) -> Result<()> {
        instructions::settle_position::handle_settle_position(ctx, returned)
    }

    // ---- trader side ----

    pub fn open_position(
        ctx: Context<OpenPosition>,
        nonce: u64,
        amount: u64,
        duration_secs: i64,
    ) -> Result<()> {
        instructions::open_position::handle_open_position(ctx, nonce, amount, duration_secs)
    }

    pub fn cancel_position(ctx: Context<CancelPosition>) -> Result<()> {
        instructions::cancel_position::handle_cancel_position(ctx)
    }

    pub fn claim_default(ctx: Context<ClaimDefault>) -> Result<()> {
        instructions::claim_default::handle_claim_default(ctx)
    }
}
