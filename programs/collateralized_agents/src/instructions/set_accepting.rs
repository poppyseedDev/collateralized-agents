use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, state::Agent};

#[derive(Accounts)]
pub struct SetAccepting<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [AGENT_SEED, authority.key().as_ref()],
        bump = agent.bump,
        has_one = authority @ ErrorCode::UnauthorizedAgent,
    )]
    pub agent: Account<'info, Agent>,
}

pub fn handle_set_accepting(ctx: Context<SetAccepting>, accepting: bool) -> Result<()> {
    ctx.accounts.agent.accepting = accepting;
    Ok(())
}
