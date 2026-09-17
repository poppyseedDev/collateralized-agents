use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ErrorCode,
    events::{BreachRecorded, PositionClosed},
    state::{Agent, Breach, Position, PositionStatus},
};

/// The agent's trading key returns `returned` lamports and the position is
/// closed. Outcomes:
///   * profit  -> the operator earns `fee_bps` of the profit, trader gets the rest
///   * loss within max_drawdown -> tolerated trading loss, no fee, no slash
///   * loss beyond max_drawdown -> breach: the shortfall is paid to the trader
///     from the agent's reserved collateral (up to the guarantee)
#[derive(Accounts)]
pub struct SettlePosition<'info> {
    /// The bound trading key or the operator. Sends the returned SOL.
    #[account(mut, constraint = agent.can_execute(&executor.key()) @ ErrorCode::UnauthorizedExecutor)]
    pub executor: Signer<'info>,
    /// CHECK: must be the agent's operator; receives the performance fee.
    #[account(mut, address = agent.operator @ ErrorCode::UnauthorizedOperator)]
    pub operator: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [AGENT_SEED, agent.operator.as_ref(), &agent.agent_id.to_le_bytes()],
        bump = agent.bump,
    )]
    pub agent: Account<'info, Agent>,
    #[account(
        mut,
        seeds = [AGENT_VAULT_SEED, agent.key().as_ref()],
        bump = agent.vault_bump
    )]
    pub agent_vault: SystemAccount<'info>,
    #[account(
        mut,
        seeds = [POSITION_SEED, agent.key().as_ref(), position.trader.as_ref(), &position.nonce.to_le_bytes()],
        bump = position.bump,
        constraint = position.agent == agent.key() @ ErrorCode::InvalidStatus,
        has_one = trader @ ErrorCode::UnauthorizedTrader,
    )]
    pub position: Account<'info, Position>,
    #[account(
        mut,
        seeds = [POSITION_VAULT_SEED, position.key().as_ref()],
        bump = position.vault_bump
    )]
    pub position_vault: SystemAccount<'info>,
    /// CHECK: validated against position.trader via has_one; receives the payout.
    #[account(mut)]
    pub trader: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub struct Settlement {
    pub fee: u64,
    pub slash: u64,
}

pub fn compute_settlement(
    principal: u64,
    returned: u64,
    fee_bps: u16,
    max_drawdown_bps: u16,
    locked_collateral: u64,
) -> Result<Settlement> {
    let bps = |value: u64, rate: u16| -> Result<u64> {
        (value as u128)
            .checked_mul(rate as u128)
            .and_then(|v| v.checked_div(BPS_DENOMINATOR as u128))
            .and_then(|v| u64::try_from(v).ok())
            .ok_or_else(|| error!(ErrorCode::Overflow))
    };
    if returned >= principal {
        let profit = returned - principal;
        Ok(Settlement {
            fee: bps(profit, fee_bps)?,
            slash: 0,
        })
    } else {
        let loss = principal - returned;
        let allowed_loss = bps(principal, max_drawdown_bps)?;
        let shortfall = loss.saturating_sub(allowed_loss);
        Ok(Settlement {
            fee: 0,
            slash: shortfall.min(locked_collateral),
        })
    }
}

pub fn handle_settle_position(ctx: Context<SettlePosition>, returned: u64) -> Result<()> {
    let position = &mut ctx.accounts.position;
    let agent = &mut ctx.accounts.agent;
    require!(
        matches!(position.status, PositionStatus::Open | PositionStatus::Trading),
        ErrorCode::InvalidStatus
    );

    let sys = ctx.accounts.system_program.to_account_info();
    let position_key = position.key();
    let position_seeds: &[&[u8]] =
        &[POSITION_VAULT_SEED, position_key.as_ref(), &[position.vault_bump]];

    // If the agent never drew the funds, the principal is still in the vault
    // and counts as "returned in full" without the agent sending anything.
    let effective_returned = if position.status == PositionStatus::Open {
        position.principal
    } else {
        super::transfer_from_signer(
            &ctx.accounts.executor.to_account_info(),
            &ctx.accounts.position_vault.to_account_info(),
            &sys,
            returned,
        )?;
        returned
    };

    let s = compute_settlement(
        position.principal,
        effective_returned,
        position.fee_bps,
        position.max_drawdown_bps,
        position.locked_collateral,
    )?;

    // Pay the performance fee to the operator from the position vault.
    super::transfer_from_vault(
        &ctx.accounts.position_vault.to_account_info(),
        &ctx.accounts.operator.to_account_info(),
        &sys,
        position_seeds,
        s.fee,
    )?;

    // Slash the agent's collateral to cover the misbehaviour shortfall.
    if s.slash > 0 {
        let agent_key = agent.key();
        let agent_seeds: &[&[u8]] = &[AGENT_VAULT_SEED, agent_key.as_ref(), &[agent.vault_bump]];
        super::transfer_from_vault(
            &ctx.accounts.agent_vault.to_account_info(),
            &ctx.accounts.trader.to_account_info(),
            &sys,
            agent_seeds,
            s.slash,
        )?;
        agent.total_collateral -= s.slash;
        agent.slashed_total = agent
            .slashed_total
            .checked_add(s.slash)
            .ok_or(ErrorCode::Overflow)?;
    }

    // Drain the rest of the position vault (returned - fee + rent floor) to the trader.
    let remaining = ctx.accounts.position_vault.lamports();
    super::transfer_from_vault(
        &ctx.accounts.position_vault.to_account_info(),
        &ctx.accounts.trader.to_account_info(),
        &sys,
        position_seeds,
        remaining,
    )?;

    // Release the guarantee.
    agent.locked_collateral -= position.locked_collateral;
    agent.capital_managed -= position.principal;
    agent.open_positions -= 1;
    agent.settled_positions += 1;
    agent.fees_earned = agent
        .fees_earned
        .checked_add(s.fee)
        .ok_or(ErrorCode::Overflow)?;

    let breach = if s.slash > 0 { Breach::Drawdown } else { Breach::None };
    if breach != Breach::None {
        agent.breach_count += 1;
        emit!(BreachRecorded {
            agent: agent.key(),
            position: position_key,
            breach,
            slashed: s.slash,
        });
    }

    position.status = PositionStatus::Settled;
    position.breach = breach;
    position.returned = effective_returned;
    position.slashed = s.slash;
    position.fee_paid = s.fee;
    position.closed_at = Clock::get()?.unix_timestamp;

    emit!(PositionClosed {
        position: position_key,
        agent: agent.key(),
        trader: position.trader,
        status: PositionStatus::Settled,
        breach,
        returned: effective_returned,
        slashed: s.slash,
        fee_paid: s.fee,
        trader_payout: effective_returned - s.fee + s.slash,
    });
    Ok(())
}
