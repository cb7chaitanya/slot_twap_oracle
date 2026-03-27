use anchor_lang::prelude::*;

use crate::errors::OracleError;
use crate::events::DeviationThresholdUpdated;
use crate::state::Oracle;

#[derive(Accounts)]
pub struct SetMaxDeviation<'info> {
    #[account(
        mut,
        seeds = [b"oracle", oracle.base_mint.as_ref(), oracle.quote_mint.as_ref()],
        bump,
        has_one = owner,
    )]
    pub oracle: Account<'info, Oracle>,

    pub owner: Signer<'info>,
}

pub fn handler(ctx: Context<SetMaxDeviation>, new_max_deviation_bps: u16) -> Result<()> {
    require!(new_max_deviation_bps > 0, OracleError::InvalidCapacity);

    let oracle = &mut ctx.accounts.oracle;
    let old = oracle.max_deviation_bps;
    oracle.max_deviation_bps = new_max_deviation_bps;

    emit!(DeviationThresholdUpdated {
        oracle: oracle.key(),
        old_max_deviation_bps: old,
        new_max_deviation_bps,
    });

    Ok(())
}
