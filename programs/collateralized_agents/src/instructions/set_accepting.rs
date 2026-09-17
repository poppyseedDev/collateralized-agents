use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ErrorCode,
    state::{Agent, AgentStatus},
};

/// Pauses or resumes new positions on a published agent.
#[derive(Accounts)]
pub struct SetAccepting<'info> {
    pub operator: Signer<'info>,
    #[account(
        mut,
        seeds = [AGENT_SEED, agent.operator.as_ref(), &agent.agent_id.to_le_bytes()],
        bump = agent.bump,
        has_one = operator @ ErrorCode::UnauthorizedOperator,
    )]
    pub agent: Account<'info, Agent>,
}

pub fn handle_set_accepting(ctx: Context<SetAccepting>, accepting: bool) -> Result<()> {
    let agent = &mut ctx.accounts.agent;
    require!(agent.is_published(), ErrorCode::NotPublished);
    agent.status = if accepting { AgentStatus::Active } else { AgentStatus::Paused };
    Ok(())
}
