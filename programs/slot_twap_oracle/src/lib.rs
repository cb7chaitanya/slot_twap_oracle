use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;
pub mod utils;

use instructions::*;

declare_id!("7LKj9Yk62ddRjtTHvvV6fmquD9h7XbcvKKa7yGtocdsT");

#[program]
pub mod slot_twap_oracle {
    use super::*;

    pub fn initialize_oracle(
        ctx: Context<InitializeOracle>,
        capacity: u32,
    ) -> Result<()> {
        instructions::initialize_oracle::handler(ctx, capacity)
    }

    pub fn update_price(ctx: Context<UpdatePrice>, new_price: u128) -> Result<()> {
        instructions::update_price::handler(ctx, new_price)
    }

    pub fn get_swap(ctx: Context<GetSwap>, window_slots: u64, max_staleness_slots: u64) -> Result<u128> {
        instructions::get_swap::handler(ctx, window_slots, max_staleness_slots)
    }

    pub fn transfer_ownership(ctx: Context<TransferOwnership>) -> Result<()> {
        instructions::transfer_ownership::handler(ctx)
    }

    pub fn accept_ownership(ctx: Context<AcceptOwnership>) -> Result<()> {
        instructions::transfer_ownership::accept_handler(ctx)
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::set_paused::handler(ctx, paused)
    }

    pub fn resize_buffer(ctx: Context<ResizeBuffer>, new_capacity: u32) -> Result<()> {
        instructions::resize_buffer::handler(ctx, new_capacity)
    }

    pub fn set_max_deviation(ctx: Context<SetMaxDeviation>, new_max_deviation_bps: u16) -> Result<()> {
        instructions::set_max_deviation::handler(ctx, new_max_deviation_bps)
    }

    pub fn withdraw_reward_vault(ctx: Context<WithdrawRewardVault>, amount: u64) -> Result<()> {
        instructions::withdraw_reward_vault::handler(ctx, amount)
    }

    pub fn initialize_reward_vault(ctx: Context<InitializeRewardVault>, reward_per_update: u64) -> Result<()> {
        instructions::initialize_reward_vault::handler(ctx, reward_per_update)
    }

    pub fn fund_reward_vault(ctx: Context<FundRewardVault>, amount: u64) -> Result<()> {
        instructions::fund_reward_vault::handler(ctx, amount)
    }

}
