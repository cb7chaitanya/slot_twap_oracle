use anchor_lang::prelude::*;

#[event]
pub struct OracleUpdate {
    pub oracle: Pubkey,
    pub price: u128,
    pub cumulative_price: u128,
    pub slot: u64,
    pub updater: Pubkey,
}
