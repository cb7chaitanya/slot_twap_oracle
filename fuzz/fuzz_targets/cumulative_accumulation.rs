#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;

/// Replicates the cumulative accumulation logic from update_price:
///   weighted = last_price * slot_delta
///   cumulative_price = cumulative_price + weighted
fn accumulate(
    cumulative_price: u128,
    last_price: u128,
    slot_delta: u64,
) -> Result<u128, &'static str> {
    let weighted = last_price
        .checked_mul(slot_delta as u128)
        .ok_or("price * slot_delta overflow")?;
    cumulative_price
        .checked_add(weighted)
        .ok_or("cumulative + weighted overflow")
}

#[derive(Debug, Arbitrary)]
struct AccumulationInput {
    cumulative_price: u128,
    last_price: u128,
    slot_delta: u64,
}

fuzz_target!(|input: AccumulationInput| {
    // Skip trivial case
    if input.slot_delta == 0 {
        return;
    }

    let result = accumulate(input.cumulative_price, input.last_price, input.slot_delta);

    match result {
        Ok(new_cumulative) => {
            // Must be >= old cumulative (prices are non-negative)
            assert!(
                new_cumulative >= input.cumulative_price,
                "Cumulative decreased: {} -> {}",
                input.cumulative_price, new_cumulative
            );

            // Verify the math: new = old + last_price * slot_delta
            let weighted = input.last_price as u128 * input.slot_delta as u128;
            assert_eq!(new_cumulative, input.cumulative_price + weighted);

            // If we compute SWAP from (old, new) over slot_delta, we get last_price
            let swap = (new_cumulative - input.cumulative_price) / input.slot_delta as u128;
            assert_eq!(swap, input.last_price);
        }
        Err("price * slot_delta overflow") => {
            // Verify overflow actually occurs
            assert!(
                input.last_price.checked_mul(input.slot_delta as u128).is_none(),
                "Expected overflow in price * slot_delta but it fit"
            );
        }
        Err("cumulative + weighted overflow") => {
            // price * slot_delta succeeded but adding to cumulative overflowed
            let weighted = input.last_price.checked_mul(input.slot_delta as u128);
            assert!(weighted.is_some(), "price * slot_delta should have succeeded");
            assert!(
                input.cumulative_price.checked_add(weighted.unwrap()).is_none(),
                "Expected overflow in cumulative + weighted but it fit"
            );
        }
        Err(e) => panic!("Unexpected error: {}", e),
    }
});
