use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ErrorCode,
    events::PositionOpened,
    state::{Agent, Position, PositionStatus},
};

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(
        mut,
        seeds = [AGENT_SEED, agent.authority.as_ref()],
        bump = agent.bump,
    )]
    pub agent: Account<'info, Agent>,
    #[account(
        init,
        payer = trader,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, agent.key().as_ref(), trader.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub position: Account<'info, Position>,
    #[account(
        mut,
        seeds = [POSITION_VAULT_SEED, position.key().as_ref()],
        bump
    )]
    pub position_vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Collateral the agent must lock for `principal`, rounded up so that even
/// dust-sized positions are backed.
pub fn required_collateral(principal: u64, ratio_bps: u16) -> Result<u64> {
    (principal as u128)
        .checked_mul(ratio_bps as u128)
        .and_then(|v| v.checked_add(BPS_DENOMINATOR as u128 - 1))
        .and_then(|v| v.checked_div(BPS_DENOMINATOR as u128))
        .and_then(|v| u64::try_from(v).ok())
        .ok_or_else(|| error!(ErrorCode::Overflow))
}

pub fn handle_open_position(
    ctx: Context<OpenPosition>,
    nonce: u64,
    amount: u64,
    duration_secs: i64,
) -> Result<()> {
    require!(amount > 0, ErrorCode::ZeroAmount);
    require!(
        (MIN_POSITION_DURATION..=MAX_POSITION_DURATION).contains(&duration_secs),
        ErrorCode::InvalidDuration
    );
    let agent = &mut ctx.accounts.agent;
    require!(agent.accepting, ErrorCode::AgentPaused);

    // Lock the agent's guarantee for this position. If the agent cannot
    // back the deposit at its advertised ratio, the position cannot open.
    let locked = required_collateral(amount, agent.collateral_ratio_bps)?;
    require!(
        locked <= agent.free_collateral(),
        ErrorCode::InsufficientFreeCollateral
    );
    agent.locked_collateral = agent
        .locked_collateral
        .checked_add(locked)
        .ok_or(ErrorCode::Overflow)?;
    agent.capital_managed = agent
        .capital_managed
        .checked_add(amount)
        .ok_or(ErrorCode::Overflow)?;
    agent.open_positions += 1;

    // Move principal (plus the vault rent floor) into the position vault.
    let rent_floor = Rent::get()?.minimum_balance(0);
    super::transfer_from_signer(
        &ctx.accounts.trader.to_account_info(),
        &ctx.accounts.position_vault.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        amount.checked_add(rent_floor).ok_or(ErrorCode::Overflow)?,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let position = &mut ctx.accounts.position;
    position.trader = ctx.accounts.trader.key();
    position.agent = agent.key();
    position.nonce = nonce;
    position.principal = amount;
    position.locked_collateral = locked;
    position.fee_bps = agent.fee_bps;
    position.max_drawdown_bps = agent.max_drawdown_bps;
    position.status = PositionStatus::Open;
    position.opened_at = now;
    position.deadline = now + duration_secs;
    position.drawn_at = 0;
    position.closed_at = 0;
    position.returned = 0;
    position.slashed = 0;
    position.fee_paid = 0;
    position.bump = ctx.bumps.position;
    position.vault_bump = ctx.bumps.position_vault;

    emit!(PositionOpened {
        position: position.key(),
        agent: agent.key(),
        trader: position.trader,
        principal: amount,
        locked_collateral: locked,
        deadline: position.deadline,
    });
    Ok(())
}
