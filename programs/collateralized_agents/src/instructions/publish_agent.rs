use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ErrorCode,
    events::AgentPublished,
    state::{Agent, AgentStatus},
};

/// Publishes a draft agent: its rules and collateral terms become permanent
/// and traders can start allocating to it.
#[derive(Accounts)]
pub struct PublishAgent<'info> {
    pub operator: Signer<'info>,
    #[account(
        mut,
        seeds = [AGENT_SEED, agent.operator.as_ref(), &agent.agent_id.to_le_bytes()],
        bump = agent.bump,
        has_one = operator @ ErrorCode::UnauthorizedOperator,
    )]
    pub agent: Account<'info, Agent>,
}

pub fn handle_publish_agent(ctx: Context<PublishAgent>) -> Result<()> {
    let agent = &mut ctx.accounts.agent;
    require!(agent.status == AgentStatus::Draft, ErrorCode::AlreadyPublished);
    require!(agent.total_collateral > 0, ErrorCode::NoCollateral);
    agent.terms.validate()?;

    agent.status = AgentStatus::Active;
    agent.published_at = Clock::get()?.unix_timestamp;

    emit!(AgentPublished {
        agent: agent.key(),
        operator: agent.operator,
        terms: agent.terms.clone(),
        collateral: agent.total_collateral,
    });
    Ok(())
}
