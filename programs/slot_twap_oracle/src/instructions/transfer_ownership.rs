use anchor_lang::prelude::*;

use crate::errors::OracleError;
use crate::events::OwnershipTransferred;
use crate::state::Oracle;

/// Step 1: Current owner proposes a new owner.
#[derive(Accounts)]
pub struct TransferOwnership<'info> {
    #[account(
        mut,
        seeds = [b"oracle", oracle.base_mint.as_ref(), oracle.quote_mint.as_ref()],
        bump,
        has_one = owner,
    )]
    pub oracle: Account<'info, Oracle>,

    pub owner: Signer<'info>,

    /// CHECK: New owner can be any valid pubkey. No on-chain account needed.
    pub new_owner: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<TransferOwnership>) -> Result<()> {
    let oracle = &mut ctx.accounts.oracle;
    let new_owner = ctx.accounts.new_owner.key();

    require!(new_owner != oracle.owner, OracleError::Unauthorized);
    require!(new_owner != Pubkey::default(), OracleError::Unauthorized);

    oracle.pending_owner = new_owner;

    Ok(())
}

/// Step 2: Proposed owner accepts ownership.
#[derive(Accounts)]
pub struct AcceptOwnership<'info> {
    #[account(
        mut,
        seeds = [b"oracle", oracle.base_mint.as_ref(), oracle.quote_mint.as_ref()],
        bump,
        constraint = oracle.pending_owner == new_owner.key() @ OracleError::Unauthorized,
    )]
    pub oracle: Account<'info, Oracle>,

    pub new_owner: Signer<'info>,
}

pub fn accept_handler(ctx: Context<AcceptOwnership>) -> Result<()> {
    let oracle = &mut ctx.accounts.oracle;
    let previous_owner = oracle.owner;

    oracle.owner = oracle.pending_owner;
    oracle.pending_owner = Pubkey::default();

    emit!(OwnershipTransferred {
        oracle: oracle.key(),
        previous_owner,
        new_owner: oracle.owner,
    });

    Ok(())
}
