use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ErrorCode,
    events::AgentCreated,
    state::{Agent, AgentStatus, AgentTerms},
};

/// Creates an agent as a draft. Traders cannot allocate to it until the
/// operator deposits collateral and publishes it.
#[derive(Accounts)]
#[instruction(agent_id: u64)]
pub struct CreateAgent<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(
        init,
        payer = operator,
        space = 8 + Agent::INIT_SPACE,
        seeds = [AGENT_SEED, operator.key().as_ref(), &agent_id.to_le_bytes()],
        bump
    )]
    pub agent: Account<'info, Agent>,
    #[account(
        mut,
        seeds = [AGENT_VAULT_SEED, agent.key().as_ref()],
        bump
    )]
    pub agent_vault: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn validate_identity(name: &str, description: &str) -> Result<()> {
    require!(
        !name.trim().is_empty() && name.len() <= MAX_NAME_LEN,
        ErrorCode::InvalidName
    );
    require!(description.len() <= MAX_DESCRIPTION_LEN, ErrorCode::InvalidDescription);
    Ok(())
}

pub fn handle_create_agent(
    ctx: Context<CreateAgent>,
    agent_id: u64,
    name: String,
    description: String,
    terms: AgentTerms,
) -> Result<()> {
    validate_identity(&name, &description)?;
    terms.validate()?;

    // Fund the vault's rent floor so it survives with zero collateral.
    let rent_floor = Rent::get()?.minimum_balance(0);
    super::transfer_from_signer(
        &ctx.accounts.operator.to_account_info(),
        &ctx.accounts.agent_vault.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        rent_floor,
    )?;

    let operator = ctx.accounts.operator.key();
    let agent = &mut ctx.accounts.agent;
    agent.operator = operator;
    agent.executor = operator;
    agent.agent_id = agent_id;
    agent.status = AgentStatus::Draft;
    agent.name = name;
    agent.description = description;
    agent.terms = terms;
    agent.created_at = Clock::get()?.unix_timestamp;
    agent.published_at = 0;
    agent.total_collateral = 0;
    agent.locked_collateral = 0;
    agent.capital_managed = 0;
    agent.open_positions = 0;
    agent.settled_positions = 0;
    agent.defaulted_positions = 0;
    agent.breach_count = 0;
    agent.slashed_total = 0;
    agent.fees_earned = 0;
    agent.bump = ctx.bumps.agent;
    agent.vault_bump = ctx.bumps.agent_vault;

    emit!(AgentCreated {
        agent: agent.key(),
        operator,
        agent_id,
    });
    Ok(())
}
