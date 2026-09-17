use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ErrorCode,
    events::PositionClosed,
    state::{Agent, Breach, Position, PositionStatus},
};

/// The trader withdraws before the agent has drawn the funds. No fee, no slash.
#[derive(Accounts)]
pub struct CancelPosition<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(
        mut,
        seeds = [AGENT_SEED, agent.operator.as_ref(), &agent.agent_id.to_le_bytes()],
        bump = agent.bump,
    )]
    pub agent: Account<'info, Agent>,
    #[account(
        mut,
        seeds = [POSITION_SEED, agent.key().as_ref(), trader.key().as_ref(), &position.nonce.to_le_bytes()],
        bump = position.bump,
        has_one = trader @ ErrorCode::UnauthorizedTrader,
        constraint = position.agent == agent.key() @ ErrorCode::InvalidStatus,
    )]
    pub position: Account<'info, Position>,
    #[account(
        mut,
        seeds = [POSITION_VAULT_SEED, position.key().as_ref()],
        bump = position.vault_bump
    )]
    pub position_vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_cancel_position(ctx: Context<CancelPosition>) -> Result<()> {
    let position = &mut ctx.accounts.position;
    let agent = &mut ctx.accounts.agent;
    require!(position.status == PositionStatus::Open, ErrorCode::InvalidStatus);

    let position_key = position.key();
    let position_seeds: &[&[u8]] =
        &[POSITION_VAULT_SEED, position_key.as_ref(), &[position.vault_bump]];
    let remaining = ctx.accounts.position_vault.lamports();
    super::transfer_from_vault(
        &ctx.accounts.position_vault.to_account_info(),
        &ctx.accounts.trader.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        position_seeds,
        remaining,
    )?;

    agent.locked_collateral -= position.locked_collateral;
    agent.capital_managed -= position.principal;
    agent.open_positions -= 1;

    position.status = PositionStatus::Cancelled;
    position.returned = position.principal;
    position.closed_at = Clock::get()?.unix_timestamp;

    emit!(PositionClosed {
        position: position_key,
        agent: agent.key(),
        trader: position.trader,
        status: PositionStatus::Cancelled,
        breach: Breach::None,
        returned: position.principal,
        slashed: 0,
        fee_paid: 0,
        trader_payout: position.principal,
    });
    Ok(())
}
