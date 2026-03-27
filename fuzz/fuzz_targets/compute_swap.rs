#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use slot_twap_oracle::math::compute_swap;

#[derive(Debug, Arbitrary)]
struct SwapInput {
    cumulative_now: u128,
    cumulative_past: u128,
    slot_now: u64,
    slot_past: u64,
}

fuzz_target!(|input: SwapInput| {
    let result = compute_swap(
        input.cumulative_now,
        input.cumulative_past,
        input.slot_now,
        input.slot_past,
    );

    match result {
        Ok(swap) => {
            // slot_now must be > slot_past for Ok
            assert!(input.slot_now > input.slot_past);
            // cumulative_now must be >= cumulative_past for Ok
            assert!(input.cumulative_now >= input.cumulative_past);

            let slot_delta = (input.slot_now - input.slot_past) as u128;
            let cumulative_delta = input.cumulative_now - input.cumulative_past;

            // Integer division: swap * slot_delta <= cumulative_delta
            assert!(swap <= cumulative_delta);

            // Truncation check: swap == cumulative_delta / slot_delta
            assert_eq!(swap, cumulative_delta / slot_delta);

            // Remainder must be less than divisor
            let remainder = cumulative_delta % slot_delta;
            assert!(remainder < slot_delta);

            // Verify no precision loss beyond integer division
            assert_eq!(swap * slot_delta + remainder, cumulative_delta);
        }
        Err(_) => {
            // Error is expected when:
            // - slot_now <= slot_past (StaleSlot or underflow)
            // - cumulative_now < cumulative_past (underflow)
            let bad_slots = input.slot_now <= input.slot_past;
            let bad_cumulative = input.cumulative_now < input.cumulative_past;
            assert!(
                bad_slots || bad_cumulative,
                "compute_swap failed unexpectedly: now={}, past={}, slot_now={}, slot_past={}",
                input.cumulative_now, input.cumulative_past,
                input.slot_now, input.slot_past
            );
        }
    }
});
