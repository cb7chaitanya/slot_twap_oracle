use anchor_lang::prelude::*;

#[error_code]
pub enum OracleError {
    #[msg("Price overflow detected")]
    PriceOverflow,

    #[msg("Stale oracle update — slot has not advanced")]
    StaleSlot,
}
