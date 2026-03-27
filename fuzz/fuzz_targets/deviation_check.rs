#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;

const BPS_DENOMINATOR: u128 = 10_000;

/// Replicates the deviation check from update_price.rs without the Anchor context.
fn check_deviation(last_price: u128, new_price: u128, max_deviation_bps: u16) -> Result<(), &'static str> {
    if last_price == 0 {
        return Ok(()); // first update always passes
    }

    let diff = if new_price >= last_price {
        new_price - last_price
    } else {
        last_price - new_price
    };

    let deviation_bps = match diff.checked_mul(BPS_DENOMINATOR) {
        Some(v) => v / last_price,
        None => return Err("overflow"),
    };

    if deviation_bps <= max_deviation_bps as u128 {
        Ok(())
    } else {
        Err("deviation too large")
    }
}

#[derive(Debug, Arbitrary)]
struct DeviationInput {
    last_price: u128,
    new_price: u128,
    max_deviation_bps: u16,
}

fuzz_target!(|input: DeviationInput| {
    let result = check_deviation(input.last_price, input.new_price, input.max_deviation_bps);

    match result {
        Ok(()) => {
            if input.last_price == 0 {
                return; // first update, no check
            }

            // Verify the deviation is actually within bounds
            let diff = if input.new_price >= input.last_price {
                input.new_price - input.last_price
            } else {
                input.last_price - input.new_price
            };

            // If diff * BPS_DENOMINATOR doesn't overflow, deviation must be <= max
            if let Some(scaled) = diff.checked_mul(BPS_DENOMINATOR) {
                let bps = scaled / input.last_price;
                assert!(
                    bps <= input.max_deviation_bps as u128,
                    "Deviation {} bps exceeds max {} bps (last={}, new={})",
                    bps, input.max_deviation_bps, input.last_price, input.new_price
                );
            }
        }
        Err("overflow") => {
            // diff * BPS_DENOMINATOR overflowed u128
            let diff = if input.new_price >= input.last_price {
                input.new_price - input.last_price
            } else {
                input.last_price - input.new_price
            };
            assert!(
                diff.checked_mul(BPS_DENOMINATOR).is_none(),
                "Expected overflow but multiplication succeeded"
            );
        }
        Err("deviation too large") => {
            assert_ne!(input.last_price, 0);
            let diff = if input.new_price >= input.last_price {
                input.new_price - input.last_price
            } else {
                input.last_price - input.new_price
            };
            if let Some(scaled) = diff.checked_mul(BPS_DENOMINATOR) {
                let bps = scaled / input.last_price;
                assert!(
                    bps > input.max_deviation_bps as u128,
                    "Deviation {} bps should exceed max {} bps",
                    bps, input.max_deviation_bps
                );
            }
        }
        Err(e) => panic!("Unexpected error: {}", e),
    }
});
