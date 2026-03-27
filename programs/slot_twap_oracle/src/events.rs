use anchor_lang::prelude::*;

#[event]
pub struct OracleUpdate {
    pub oracle: Pubkey,
    pub price: u128,
    pub cumulative_price: u128,
    pub slot: u64,
    pub updater: Pubkey,
}

#[event]
pub struct OwnershipTransferred {
    pub oracle: Pubkey,
    pub previous_owner: Pubkey,
    pub new_owner: Pubkey,
}

#[event]
pub struct OraclePauseToggled {
    pub oracle: Pubkey,
    pub paused: bool,
}

#[event]
pub struct BufferResized {
    pub oracle: Pubkey,
    pub old_capacity: u32,
    pub new_capacity: u32,
    pub observations_retained: u32,
}

#[event]
pub struct DeviationThresholdUpdated {
    pub oracle: Pubkey,
    pub old_max_deviation_bps: u16,
    pub new_max_deviation_bps: u16,
}

#[event]
pub struct RewardClaimed {
    pub oracle: Pubkey,
    pub updater: Pubkey,
    pub amount: u64,
    pub total_distributed: u64,
}
