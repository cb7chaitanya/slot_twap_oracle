use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::state::{Oracle, RewardVault};

#[derive(Accounts)]
pub struct InitializeRewardVault<'info> {
    #[account(
        seeds = [b"oracle", oracle.base_mint.as_ref(), oracle.quote_mint.as_ref()],
        bump,
        has_one = owner,
    )]
    pub oracle: Account<'info, Oracle>,

    #[account(
        init,
        payer = owner,
        space = 8 + RewardVault::INIT_SPACE,
        seeds = [b"reward", oracle.key().as_ref()],
        bump,
    )]
    pub reward_vault: Account<'info, RewardVault>,

    /// Token account held by the vault PDA to store reward tokens.
    #[account(
        init,
        payer = owner,
        token::mint = reward_mint,
        token::authority = reward_vault,
        seeds = [b"reward_tokens", oracle.key().as_ref()],
        bump,
    )]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,

    pub reward_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeRewardVault>, reward_per_update: u64) -> Result<()> {
    let vault = &mut ctx.accounts.reward_vault;
    vault.oracle = ctx.accounts.oracle.key();
    vault.reward_mint = ctx.accounts.reward_mint.key();
    vault.reward_per_update = reward_per_update;
    vault.total_distributed = 0;
    vault.total_updates_rewarded = 0;

    Ok(())
}
