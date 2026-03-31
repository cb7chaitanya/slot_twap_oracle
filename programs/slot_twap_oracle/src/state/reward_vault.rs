use anchor_lang::prelude::*;

/// Per-oracle reward configuration and accounting.
/// PDA seeds: ["reward", oracle.key()]
#[account]
#[derive(InitSpace)]
pub struct RewardVault {
    pub oracle: Pubkey,
    pub reward_mint: Pubkey,
    pub reward_per_update: u64,
    pub total_distributed: u64,
    pub total_updates_rewarded: u64,
    /// Slot of the last rewarded update — prevents double-pay.
    pub last_rewarded_slot: u64,
    /// Cached PDA bump for efficient CPI signing.
    pub bump: u8,
}
