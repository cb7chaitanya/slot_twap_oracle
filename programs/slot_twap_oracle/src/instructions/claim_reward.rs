use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, TokenAccount, TokenInterface, TransferChecked, Mint};

use crate::errors::OracleError;
use crate::events::RewardClaimed;
use crate::state::{Oracle, RewardVault};

#[derive(Accounts)]
pub struct ClaimReward<'info> {
    #[account(
        seeds = [b"oracle", oracle.base_mint.as_ref(), oracle.quote_mint.as_ref()],
        bump,
        // Only the last_updater can claim
        constraint = oracle.last_updater == updater.key() @ OracleError::Unauthorized,
    )]
    pub oracle: Account<'info, Oracle>,

    #[account(
        mut,
        seeds = [b"reward", oracle.key().as_ref()],
        bump,
        has_one = oracle,
    )]
    pub reward_vault: Account<'info, RewardVault>,

    #[account(
        mut,
        seeds = [b"reward_tokens", oracle.key().as_ref()],
        bump,
    )]
    pub vault_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        address = reward_vault.reward_mint,
    )]
    pub reward_mint: InterfaceAccount<'info, Mint>,

    /// Updater's token account to receive the reward.
    #[account(
        mut,
        token::mint = reward_vault.reward_mint,
    )]
    pub updater_token_account: InterfaceAccount<'info, TokenAccount>,

    pub updater: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<ClaimReward>) -> Result<()> {
    let vault = &ctx.accounts.reward_vault;
    let reward_amount = vault.reward_per_update;

    // Check vault has enough tokens
    require!(
        ctx.accounts.vault_token_account.amount >= reward_amount,
        OracleError::InsufficientRewardBalance
    );

    // Transfer reward from vault to updater via PDA signer
    let oracle_key = ctx.accounts.oracle.key();
    let seeds: &[&[u8]] = &[b"reward", oracle_key.as_ref()];
    let (_, bump) = Pubkey::find_program_address(seeds, ctx.program_id);
    let signer_seeds: &[&[&[u8]]] = &[&[b"reward", oracle_key.as_ref(), &[bump]]];

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.updater_token_account.to_account_info(),
                mint: ctx.accounts.reward_mint.to_account_info(),
                authority: ctx.accounts.reward_vault.to_account_info(),
            },
            signer_seeds,
        ),
        reward_amount,
        ctx.accounts.reward_mint.decimals,
    )?;

    // Update accounting
    let vault = &mut ctx.accounts.reward_vault;
    vault.total_distributed = vault.total_distributed.checked_add(reward_amount)
        .ok_or(OracleError::PriceOverflow)?;
    vault.total_updates_rewarded = vault.total_updates_rewarded.checked_add(1)
        .ok_or(OracleError::PriceOverflow)?;

    emit!(RewardClaimed {
        oracle: ctx.accounts.oracle.key(),
        updater: ctx.accounts.updater.key(),
        amount: reward_amount,
        total_distributed: vault.total_distributed,
    });

    Ok(())
}
