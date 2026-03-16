use anchor_lang::prelude::*;

use crate::state::Oracle;

#[derive(Accounts)]
#[instruction(base_mint: Pubkey, quote_mint: Pubkey)]
pub struct InitializeOracle<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Oracle::INIT_SPACE,
        seeds = [b"oracle", base_mint.as_ref(), quote_mint.as_ref()],
        bump,
    )]
    pub oracle: Account<'info, Oracle>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeOracle>,
    base_mint: Pubkey,
    quote_mint: Pubkey,
) -> Result<()> {
    let oracle = &mut ctx.accounts.oracle;
    let clock = Clock::get()?;

    oracle.base_mint = base_mint;
    oracle.quote_mint = quote_mint;
    oracle.last_price = 0;
    oracle.cumulative_price = 0;
    oracle.last_slot = clock.slot;
    oracle.bump = ctx.bumps.oracle;

    Ok(())
}
