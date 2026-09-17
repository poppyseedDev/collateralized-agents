use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, events::ExecutorBound, state::Agent};

/// Binds the key allowed to draw and settle positions, typically the AI's
/// hot wallet. The operator keeps control of terms and collateral.
#[derive(Accounts)]
pub struct SetExecutor<'info> {
    pub operator: Signer<'info>,
    #[account(
        mut,
        seeds = [AGENT_SEED, agent.operator.as_ref(), &agent.agent_id.to_le_bytes()],
        bump = agent.bump,
        has_one = operator @ ErrorCode::UnauthorizedOperator,
    )]
    pub agent: Account<'info, Agent>,
}

pub fn handle_set_executor(ctx: Context<SetExecutor>, executor: Pubkey) -> Result<()> {
    let agent = &mut ctx.accounts.agent;
    agent.executor = executor;
    emit!(ExecutorBound {
        agent: agent.key(),
        executor,
    });
    Ok(())
}
