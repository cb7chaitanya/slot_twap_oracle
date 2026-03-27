#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use solana_sdk::pubkey::Pubkey;
use slot_twap_oracle::state::observation::{Observation, ObservationBuffer};
use slot_twap_oracle::utils::{get_observation_before_slot, push_observation};

/// A single price update to feed into the ring buffer.
#[derive(Debug, Arbitrary)]
struct Update {
    price: u128,
    slot_delta: u16, // added to running slot (capped to prevent overflow)
}

/// Fuzz input: capacity (clamped 1..=512) and a sequence of updates.
#[derive(Debug, Arbitrary)]
struct RingBufferInput {
    raw_capacity: u8, // mapped to 1..=512
    updates: Vec<Update>,
}

fuzz_target!(|input: RingBufferInput| {
    let capacity = (input.raw_capacity as u32 % 512) + 1; // 1..=512
    let num_updates = input.updates.len().min(2048); // cap iterations

    // Simulate oracle state
    let mut buffer = ObservationBuffer {
        oracle: Pubkey::default(),
        head: 0,
        len: 0,
        capacity,
        observations: vec![Observation::default(); capacity as usize],
    };

    let mut last_price: u128 = 0;
    let mut cumulative_price: u128 = 0;
    let mut current_slot: u64 = 1;

    // Track all pushed observations in order for verification
    let mut history: Vec<(u64, u128)> = Vec::new();

    for update in input.updates.iter().take(num_updates) {
        let slot_delta = (update.slot_delta as u64).max(1); // at least 1 slot

        // Accumulate like update_price does
        let weighted = match last_price.checked_mul(slot_delta as u128) {
            Some(v) => v,
            None => return, // overflow — skip
        };
        cumulative_price = match cumulative_price.checked_add(weighted) {
            Some(v) => v,
            None => return, // overflow — skip
        };

        current_slot = match current_slot.checked_add(slot_delta) {
            Some(v) => v,
            None => return, // overflow — skip
        };

        last_price = update.price;

        push_observation(&mut buffer, current_slot, cumulative_price);
        history.push((current_slot, cumulative_price));
    }

    let populated = buffer.populated();
    let cap = capacity as usize;

    // ── Invariant 1: len is correct ──
    assert!(populated <= cap, "len {} > capacity {}", populated, cap);
    assert_eq!(populated, history.len().min(cap));

    // ── Invariant 2: head is correct ──
    let expected_head = if history.len() < cap {
        history.len() as u32
    } else {
        (history.len() as u32) % capacity
    };
    assert_eq!(buffer.head, expected_head,
        "head mismatch: got {}, expected {} (history={}, cap={})",
        buffer.head, expected_head, history.len(), cap);

    // ── Invariant 3: most recent observations are in the buffer ──
    if populated > 0 {
        // The last `populated` entries from history should be in the ring
        let start = history.len().saturating_sub(populated);
        let expected_entries = &history[start..];

        for (i, (exp_slot, exp_cumul)) in expected_entries.iter().enumerate() {
            // Ring index: entries are stored starting from (head - populated) mod cap
            let ring_idx = (buffer.head as usize + cap - populated + i) % cap;
            let obs = &buffer.observations[ring_idx];

            assert_eq!(obs.slot, *exp_slot,
                "slot mismatch at ring[{}]: got {}, expected {}",
                ring_idx, obs.slot, exp_slot);
            assert_eq!(obs.cumulative_price, *exp_cumul,
                "cumulative mismatch at ring[{}]: got {}, expected {}",
                ring_idx, obs.cumulative_price, exp_cumul);
        }
    }

    // ── Invariant 4: cumulative prices are monotonically non-decreasing ──
    if populated >= 2 {
        let mut prev_cumul = 0u128;
        for i in 0..populated {
            let ring_idx = (buffer.head as usize + cap - populated + i) % cap;
            let cumul = buffer.observations[ring_idx].cumulative_price;
            assert!(cumul >= prev_cumul,
                "cumulative not monotonic: {} -> {} at position {}",
                prev_cumul, cumul, i);
            prev_cumul = cumul;
        }
    }

    // ── Invariant 5: slots are strictly increasing ──
    if populated >= 2 {
        let mut prev_slot = 0u64;
        for i in 0..populated {
            let ring_idx = (buffer.head as usize + cap - populated + i) % cap;
            let slot = buffer.observations[ring_idx].slot;
            assert!(slot > prev_slot,
                "slots not strictly increasing: {} -> {} at position {}",
                prev_slot, slot, i);
            prev_slot = slot;
        }
    }

    // ── Invariant 6: get_observation_before_slot returns correct result ──
    if populated > 0 {
        let newest_slot = history.last().unwrap().0;
        // Query for slot after newest — should return the newest observation
        let result = get_observation_before_slot(&buffer, newest_slot + 1);
        assert!(result.is_some(), "Should find observation before slot {}", newest_slot + 1);
        assert_eq!(result.unwrap().slot, newest_slot);

        // Query for slot equal to oldest in buffer — should return None
        let oldest_idx = history.len().saturating_sub(populated);
        let oldest_slot = history[oldest_idx].0;
        let result = get_observation_before_slot(&buffer, oldest_slot);
        assert!(result.is_none(),
            "Should not find observation before oldest slot {} (oldest in buffer)",
            oldest_slot);
    }

    // ── Invariant 7: TWAP from first to last observation is consistent ──
    if populated >= 2 {
        let first_idx = (buffer.head as usize + cap - populated) % cap;
        let last_idx = (buffer.head as usize + cap - 1) % cap;
        let first = &buffer.observations[first_idx];
        let last = &buffer.observations[last_idx];

        let cumul_delta = last.cumulative_price - first.cumulative_price;
        let slot_delta = last.slot - first.slot;
        assert!(slot_delta > 0);
        let swap = cumul_delta / slot_delta as u128;

        // SWAP should be reasonable — between 0 and some bound related to max price
        // (We can't predict exact value, but verify no panic/overflow in division)
        let _ = swap;
    }
});
