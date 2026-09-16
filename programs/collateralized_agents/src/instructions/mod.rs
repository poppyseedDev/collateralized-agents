pub mod cancel_position;
pub mod claim_default;
pub mod deposit_collateral;
pub mod draw_funds;
pub mod open_position;
pub mod register_agent;
pub mod set_accepting;
pub mod settle_position;
pub mod withdraw_collateral;

pub use cancel_position::*;
pub use claim_default::*;
pub use deposit_collateral::*;
pub use draw_funds::*;
pub use open_position::*;
pub use register_agent::*;
pub use set_accepting::*;
pub use settle_position::*;
pub use withdraw_collateral::*;

use anchor_lang::prelude::*;

/// Transfer lamports out of a program-owned system account (vault PDA).
pub(crate) fn transfer_from_vault<'info>(
    vault: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let signer_seeds: &[&[&[u8]]] = &[seeds];
    let cpi = CpiContext::new_with_signer(
        *system_program.key,
        anchor_lang::system_program::Transfer {
            from: vault.clone(),
            to: to.clone(),
        },
        signer_seeds,
    );
    anchor_lang::system_program::transfer(cpi, amount)
}

/// Transfer lamports from a signer into any account.
pub(crate) fn transfer_from_signer<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let cpi = CpiContext::new(
        *system_program.key,
        anchor_lang::system_program::Transfer {
            from: from.clone(),
            to: to.clone(),
        },
    );
    anchor_lang::system_program::transfer(cpi, amount)
}
