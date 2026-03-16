use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("7LKj9Yk62ddRjtTHvvV6fmquD9h7XbcvKKa7yGtocdsT");

#[program]
pub mod slot_twap_oracle {
    use super::*;

    pub fn initialize_oracle(
        ctx: Context<InitializeOracle>,
        base_mint: Pubkey,
        quote_mint: Pubkey,
    ) -> Result<()> {
        instructions::initialize_oracle::handler(ctx, base_mint, quote_mint)
    }
}
