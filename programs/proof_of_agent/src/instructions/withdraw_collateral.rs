use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, events::CollateralChanged, state::Agent};

#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(
        mut,
        seeds = [AGENT_SEED, agent.operator.as_ref(), &agent.agent_id.to_le_bytes()],
        bump = agent.bump,
        has_one = operator @ ErrorCode::UnauthorizedOperator,
    )]
    pub agent: Account<'info, Agent>,
    #[account(
        mut,
        seeds = [AGENT_VAULT_SEED, agent.key().as_ref()],
        bump = agent.vault_bump
    )]
    pub agent_vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_withdraw_collateral(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::ZeroAmount);
    let agent = &mut ctx.accounts.agent;
    // Only collateral that is not guaranteeing an open position may leave.
    require!(
        amount <= agent.free_collateral(),
        ErrorCode::InsufficientFreeCollateral
    );
    agent.total_collateral -= amount;

    let agent_key = agent.key();
    let seeds: &[&[u8]] = &[AGENT_VAULT_SEED, agent_key.as_ref(), &[agent.vault_bump]];
    super::transfer_from_vault(
        &ctx.accounts.agent_vault.to_account_info(),
        &ctx.accounts.operator.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        seeds,
        amount,
    )?;
    emit!(CollateralChanged {
        agent: agent_key,
        delta: -(amount as i64),
        total_collateral: agent.total_collateral,
    });
    Ok(())
}
