use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ErrorCode,
    state::{Agent, AgentStatus, AgentTerms},
};

/// Edits a draft agent's identity and terms. Published terms are permanent.
#[derive(Accounts)]
pub struct UpdateAgent<'info> {
    pub operator: Signer<'info>,
    #[account(
        mut,
        seeds = [AGENT_SEED, agent.operator.as_ref(), &agent.agent_id.to_le_bytes()],
        bump = agent.bump,
        has_one = operator @ ErrorCode::UnauthorizedOperator,
    )]
    pub agent: Account<'info, Agent>,
}

pub fn handle_update_agent(
    ctx: Context<UpdateAgent>,
    name: String,
    description: String,
    terms: AgentTerms,
) -> Result<()> {
    let agent = &mut ctx.accounts.agent;
    require!(agent.status == AgentStatus::Draft, ErrorCode::TermsLocked);
    super::create_agent::validate_identity(&name, &description)?;
    terms.validate()?;
    agent.name = name;
    agent.description = description;
    agent.terms = terms;
    Ok(())
}
