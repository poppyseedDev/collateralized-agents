use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, events::AgentRegistered, state::Agent};

#[derive(Accounts)]
pub struct RegisterAgent<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Agent::INIT_SPACE,
        seeds = [AGENT_SEED, authority.key().as_ref()],
        bump
    )]
    pub agent: Account<'info, Agent>,
    /// CHECK: system-owned PDA that holds the agent's SOL collateral.
    #[account(
        mut,
        seeds = [AGENT_VAULT_SEED, agent.key().as_ref()],
        bump
    )]
    pub agent_vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Fee schedule: the more collateral an agent guarantees per lamport managed,
/// the larger the performance fee it may charge on profit.
pub fn fee_for_ratio(collateral_ratio_bps: u16) -> u16 {
    collateral_ratio_bps / FEE_DIVISOR
}

pub fn handle_register_agent(
    ctx: Context<RegisterAgent>,
    name: String,
    strategy: String,
    collateral_ratio_bps: u16,
    max_drawdown_bps: u16,
) -> Result<()> {
    require!(
        !name.is_empty() && name.len() <= MAX_NAME_LEN,
        ErrorCode::InvalidName
    );
    require!(strategy.len() <= MAX_STRATEGY_LEN, ErrorCode::InvalidStrategy);
    require!(
        (MIN_COLLATERAL_RATIO_BPS..=MAX_COLLATERAL_RATIO_BPS).contains(&collateral_ratio_bps),
        ErrorCode::InvalidCollateralRatio
    );
    require!(max_drawdown_bps <= MAX_DRAWDOWN_BPS, ErrorCode::InvalidDrawdown);

    // Fund the vault with its rent floor so it survives with a zero balance.
    let rent_floor = Rent::get()?.minimum_balance(0);
    super::transfer_from_signer(
        &ctx.accounts.authority.to_account_info(),
        &ctx.accounts.agent_vault.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        rent_floor,
    )?;

    let agent = &mut ctx.accounts.agent;
    agent.authority = ctx.accounts.authority.key();
    agent.name = name;
    agent.strategy = strategy;
    agent.collateral_ratio_bps = collateral_ratio_bps;
    agent.fee_bps = fee_for_ratio(collateral_ratio_bps);
    agent.max_drawdown_bps = max_drawdown_bps;
    agent.accepting = true;
    agent.total_collateral = 0;
    agent.locked_collateral = 0;
    agent.capital_managed = 0;
    agent.open_positions = 0;
    agent.settled_positions = 0;
    agent.defaulted_positions = 0;
    agent.slashed_total = 0;
    agent.fees_earned = 0;
    agent.created_at = Clock::get()?.unix_timestamp;
    agent.bump = ctx.bumps.agent;
    agent.vault_bump = ctx.bumps.agent_vault;

    emit!(AgentRegistered {
        agent: agent.key(),
        authority: agent.authority,
        collateral_ratio_bps,
        fee_bps: agent.fee_bps,
    });
    Ok(())
}
