use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ErrorCode,
    state::{Agent, Position, PositionStatus},
};

/// The agent pulls the trader's principal out of the position vault to trade
/// with it. From this moment the agent's locked collateral is at risk: it
/// must settle before the deadline or the trader claims the guarantee.
#[derive(Accounts)]
pub struct DrawFunds<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [AGENT_SEED, authority.key().as_ref()],
        bump = agent.bump,
        has_one = authority @ ErrorCode::UnauthorizedAgent,
    )]
    pub agent: Account<'info, Agent>,
    #[account(
        mut,
        seeds = [POSITION_SEED, agent.key().as_ref(), position.trader.as_ref(), &position.nonce.to_le_bytes()],
        bump = position.bump,
        constraint = position.agent == agent.key() @ ErrorCode::UnauthorizedAgent,
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

pub fn handle_draw_funds(ctx: Context<DrawFunds>) -> Result<()> {
    let position = &mut ctx.accounts.position;
    require!(position.status == PositionStatus::Open, ErrorCode::InvalidStatus);
    let now = Clock::get()?.unix_timestamp;
    require!(now < position.deadline, ErrorCode::DeadlinePassed);

    position.status = PositionStatus::Trading;
    position.drawn_at = now;

    let position_key = position.key();
    let seeds: &[&[u8]] = &[POSITION_VAULT_SEED, position_key.as_ref(), &[position.vault_bump]];
    super::transfer_from_vault(
        &ctx.accounts.position_vault.to_account_info(),
        &ctx.accounts.authority.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        seeds,
        position.principal,
    )
}
