# Building a Production-Grade Slot-Based TWAP Oracle on Solana

Oracles are the most attacked component in DeFi. Flash loans, sandwich attacks, and low-liquidity manipulation have drained billions from protocols that trusted a single price source at a single point in time. The fix isn't better price sources — it's better price math.

This is a technical walkthrough of building a slot-weighted TWAP oracle on Solana from scratch: the program, the updater network, the indexing pipeline, and the failure modes we designed around.

## The Problem With Spot Prices

A spot price oracle reads a pool's reserves and computes `quote / base`. This works until someone:

1. Takes a flash loan
2. Dumps into the pool, moving the price 50%
3. Triggers a liquidation or mint at the manipulated price
4. Repays the loan in the same transaction

The oracle reported a "correct" price — it just happened to be correct for 400 milliseconds during an attack. Protocols using this price as truth get wrecked.

## Why TWAP

Time-weighted average prices solve this by averaging price over a window. A flash loan can spike the price for one slot, but it can't sustain the spike for 100 slots. The longer the TWAP window, the harder it is to manipulate.

The math is simple. On every update:

```
cumulative_price += last_price × (current_slot - last_slot)
```

To query TWAP over any window:

```
TWAP = (cumulative_now - cumulative_past) / (slot_now - slot_past)
```

This is the same approach Uniswap V2/V3 uses, adapted for Solana's slot-based architecture.

## Why Slots, Not Timestamps

Solana's `Clock::unix_timestamp` is set by validators via a stake-weighted median. It can:

- Drift seconds from real time
- Stall (same timestamp across multiple slots)
- Move non-monotonically in edge cases

Slots are the native unit of chain progress on Solana. They increment deterministically, never repeat, and cost zero to read from the Clock sysvar. Using slots as the time axis makes the TWAP:

- Strictly monotonic
- Immune to validator timestamp manipulation
- Deterministic across replays

Every slot that passes with a price active contributes proportionally to the cumulative value. No gaps, no drift, no manipulation surface.

## Architecture

The system has four layers:

```
DEX Pools (Raydium, Orca, Meteora)
    ↓ fetch prices
Updater Bot (off-chain, multi-source)
    ↓ submit update_price tx
On-Chain Program (Anchor, 10 instructions)
    ↓ emit events
Indexer (gRPC → PostgreSQL) + API Server (Express + WebSocket)
    ↓ serve consumers
DeFi protocols, dashboards, trading bots
```

### On-Chain Program

The program is 10 instructions built with Anchor 0.31.1:

**Core**: `initialize_oracle`, `update_price` (permissionless), `get_swap` (read-only with staleness protection)

**Admin**: `transfer_ownership`, `set_paused`, `resize_buffer`, `set_max_deviation`

**Rewards**: `initialize_reward_vault`, `fund_reward_vault`, auto-pay via `update_price`

Each oracle pair gets two PDAs — an Oracle account and an ObservationBuffer — seeded by `["oracle", base_mint, quote_mint]` and `["observation", oracle]`. No shared global state.

The observation buffer is a fixed-size pre-allocated ring buffer. We moved from `Vec<Observation>` (which borsh serializes the length prefix on every update) to a pre-zeroed array with a separate `len` field. This eliminates the per-write serialization overhead for the vec length.

### Updater Network

The updater bot fetches prices from three DEX protocols in parallel:

- **Raydium AMM v4**: Read vault token balances at known offsets (336, 368)
- **Orca Whirlpools**: Read `sqrt_price` field (offset 65) — vault-based pricing doesn't work for concentrated liquidity because reserves don't reflect spot price
- **Meteora DLMM**: Read reserve token balances (offsets 152, 184)

Each source validates pool mints against the oracle's base/quote and auto-inverts if the pool ordering is reversed.

The aggregation pipeline:

1. Fetch all sources via `Promise.allSettled`
2. Reject any source deviating >5% from the median (per-source outlier filter)
3. Check min-sources threshold (default 2)
4. Compute spread on remaining prices — skip if >5%
5. Compute confidence score: `(valid_sources / total) × (1 - spread)`
6. Submit median price to the on-chain program

### Indexer

A gRPC stream via Yellowstone Geyser subscribes to all transactions involving the oracle program. Each confirmed transaction's logs are decoded for `OracleUpdate` events and inserted into PostgreSQL with idempotent `ON CONFLICT DO NOTHING` and dual uniqueness constraints (tx_signature + oracle, slot + oracle).

This feeds the `/historical` API endpoint for charting and the reward distribution calculator.

### API Server

Express + Zod with rate limiting and WebSocket:

- `GET /price` — current oracle state with staleness gap
- `GET /twap` — off-chain TWAP over N slots
- `GET /history` — decoded events from recent transactions
- `GET /historical` — bucketed price data from PostgreSQL for charts
- `WS /ws` — subscribe to live TWAP updates per oracle pair

WebSocket clients get updates every 2 seconds with backpressure protection — slow clients are disconnected when their send buffer exceeds 64KB.

## Sealevel Parallelism

This is where Solana's architecture pays off. Each oracle pair's accounts (Oracle PDA, ObservationBuffer PDA) are derived from unique mint addresses. Two oracles share zero writable accounts.

The Sealevel scheduler sees:

```
tx1 write-locks: {sol_oracle, sol_obs_buffer}
tx2 write-locks: {eth_oracle, eth_obs_buffer}
tx3 write-locks: {btc_oracle, btc_obs_buffer}
```

No intersection → all three execute in parallel threads within the same slot. We validated this with a 50-pair concurrent update test — all 50 succeed in the same slot with zero contention.

This means the oracle scales linearly with Solana's core count. Adding a new trading pair doesn't slow down existing pairs.

## Multi-Source Aggregation

Single-source oracles are fragile. A pool can be manipulated, have stale liquidity, or simply go down. We aggregate from three independent DEX protocols, each with different AMM mechanisms:

- Raydium: constant-product AMM (vault balances)
- Orca: concentrated liquidity (sqrt_price from the program state)
- Meteora: DLMM with discrete bins (reserve balances)

The per-source outlier rejection is critical. If Raydium reports $150 but Orca and Meteora report $83, Raydium gets rejected (>5% deviation from median). The median of the remaining two sources becomes the submitted price.

Each source also validates on-chain that the pool's token mints match the oracle's expected base/quote. If someone configures the wrong pool address, the source throws before producing a price — it never returns bad data.

## Reward Incentives

Permissionless oracles need economic incentives. Anyone can call `update_price`, but why would they?

The reward system works through a vault PDA per oracle. The owner funds it with reward tokens, and each `update_price` transaction automatically pays the *previous* updater from the vault. This happens atomically in the same instruction — no separate claim step, no double-claim risk.

The key design choice: rewards are paid to the **previous** updater, not the current one. This means:

1. Updater A submits a price at slot 100
2. Updater B submits at slot 110 — A gets paid
3. Updater C submits at slot 120 — B gets paid

If nobody submits after you, you don't get paid. This creates a natural incentive to keep the oracle fresh — there's always someone behind you waiting to collect their reward by pushing the next update.

A `last_rewarded_slot` field prevents the same update from being rewarded twice.

## Failure Modes and Protections

Every component has explicit failure handling:

**On-chain:**
- `StaleSlot` — rejects update if slot hasn't advanced
- `PriceDeviationTooLarge` — rejects jumps beyond per-oracle configurable threshold (default 10%)
- `StaleOracle` — `get_swap` rejects if oracle not updated within caller-specified staleness window
- `OraclePaused` — owner can freeze the oracle
- `InsufficientHistory` — `get_swap` fails gracefully when buffer lacks data for the requested window

**Bot:**
- Per-source outlier rejection
- Cross-source spread check
- Min-sources guard
- Retry with exponential backoff (5 attempts)
- Graceful SIGTERM handling
- Persistent metrics survive restart

**Monitoring:**
- Prometheus metrics: update counts, staleness, slot lag, confidence scores
- Telegram alerts when any oracle is stale >100 slots
- Grafana dashboard with 6 panels

**Indexer:**
- Idempotent inserts with dual uniqueness constraints
- Verification script compares chain TWAP vs DB TWAP

## Benchmarks

Measured against solana-test-validator (localhost):

| Operation | p50 Latency | Compute Units |
|---|---|---|
| update_price | 455ms | ~17,143 CU |
| get_swap (simulate) | 1ms | — |
| fetchOracle | <1ms | — |
| computeSwapFromChain | 1ms | — |
| initialize_oracle | 464ms | — |

`update_price` at ~17K CU is well under the 200K limit. The latency is dominated by transaction confirmation, not program execution. On mainnet with priority fees, expect p50 under 1 second.

## Test Coverage

| Layer | Tests |
|---|---|
| Rust integration (LiteSVM) | 80 |
| SDK (mocha) | 24 |
| API (Jest + supertest) | 32 |
| E2E (test-validator) | 10 checks |
| Fuzz (libFuzzer) | 4 targets, 28M+ runs |

The fuzz targets test u128 arithmetic at boundaries — compute_swap division, deviation check overflow, cumulative accumulation, and ring buffer integrity with random capacities and wrap-arounds. Zero crashes across 28 million runs.

## Lessons Learned

**Orca's vault-based pricing is broken for Whirlpools.** Concentrated liquidity pools don't store spot price in vault balances — the vaults reflect total deposited liquidity across all tick ranges, not the current trading price. We switched to reading `sqrt_price` directly from the Whirlpool account state. This is the authoritative price and updates every swap.

**Byte offsets are fragile.** We hardcode struct offsets for three different DEX protocols. A single program upgrade on their end silently breaks our price extraction. The mitigation is a validation script that probes live mainnet pools and verifies the extracted pubkeys are valid mints and token accounts. Run it before adding any new pool to the config.

**Ring buffers in Solana are tricky with realloc.** Growing a buffer that has wrapped requires linearizing first — otherwise the write head points into the wrong position after resize. We caught this with a fuzz test that exercised random capacity changes with wrapped buffers.

**IDL drift is real.** The hand-maintained TypeScript IDL drifted from the generated Anchor IDL multiple times during development. We solved this by importing the generated JSON directly and auto-syncing it in CI. The CI pipeline fails if the IDL is out of date.

**Optional accounts in Anchor need placeholders.** `Option<Account>` still requires the account to be passed in the instruction — you use the program ID as a `None` placeholder. This isn't obvious from the docs and broke our test suite when we added optional reward accounts to `update_price`.

## What's Next

The oracle is functional but not yet battle-tested on mainnet. The immediate gaps:

1. Validate all three DEX pool byte offsets against live mainnet pools
2. Run the bot against real pools with a dry-run mode
3. Publish the SDK to npm
4. Deploy to devnet with the full stack (bot + indexer + API)

The code is open source. If you're building on Solana and need manipulation-resistant pricing, this is one way to do it.

---

*Program ID: `7LKj9Yk62ddRjtTHvvV6fmquD9h7XbcvKKa7yGtocdsT`*
