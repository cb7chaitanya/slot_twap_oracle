# Slot TWAP Oracle

A Solana program that computes slot-weighted time-weighted average prices (TWAP) for arbitrary trading pairs. Built with [Anchor 0.31.1](https://www.anchor-lang.com/).

Slots are used instead of timestamps because Solana's `Clock::unix_timestamp` is a stake-weighted median that can drift or stall. Slots increment deterministically and are immune to validator manipulation.

## How It Works

On every `update_price` call:

```
cumulative_price += last_price * (current_slot - last_slot)
```

The TWAP (SWAP — Slot-Weighted Average Price) over any window:

```
SWAP = (cumulative_now - cumulative_past) / (slot_now - slot_past)
```

## Architecture

See [docs/architecture.md](docs/architecture.md) for the full system diagram.

```
slot_twap_oracle/
├── programs/slot_twap_oracle/  # Anchor program (10 instructions)
├── sdk/                        # TypeScript SDK + CLI
├── api/                        # Express REST + WebSocket API
├── bots/updater/               # Multi-source price updater bot
├── tests/                      # 85 Rust integration tests (LiteSVM)
├── sdk-tests/                  # 24 SDK mocha tests
├── fuzz/                       # 4 libFuzzer targets
├── scripts/                    # E2E, deploy, indexer, tooling
└── .github/workflows/          # CI pipeline
```

## Instructions

| Instruction | Access | Description |
|---|---|---|
| `initialize_oracle` | Anyone (pays rent) | Create oracle + ring buffer PDAs for a trading pair |
| `update_price` | Permissionless | Accumulate price, store observation, record updater. Per-oracle deviation guard. |
| `get_swap` | Read-only | TWAP over N slots with staleness protection |
| `transfer_ownership` | Owner only | Transfer oracle ownership |
| `set_paused` | Owner only | Pause/unpause oracle (blocks updates and queries) |
| `resize_buffer` | Owner only | Grow or shrink observation ring buffer via realloc |
| `set_max_deviation` | Owner only | Configure per-oracle price deviation threshold (bps) |
| `initialize_reward_vault` | Owner only | Create reward vault + token account for updater incentives |
| `fund_reward_vault` | Anyone | Deposit reward tokens into the vault |
| `claim_reward` | Last updater only | Claim reward tokens via PDA-signed transfer |

## Accounts

Each trading pair gets independent PDAs (no shared global state — optimized for Sealevel parallel execution):

| Account | Seeds | Description |
|---|---|---|
| Oracle | `["oracle", base_mint, quote_mint]` | Price state, owner, pause, deviation config |
| ObservationBuffer | `["observation", oracle]` | Fixed-size pre-allocated ring buffer |
| RewardVault | `["reward", oracle]` | Reward config and accounting |
| VaultTokenAccount | `["reward_tokens", oracle]` | Token account for reward distribution |

## Events

| Event | Emitted by |
|---|---|
| `OracleUpdate` | `update_price` — oracle, price, cumulative, slot, updater |
| `OwnershipTransferred` | `transfer_ownership` |
| `OraclePauseToggled` | `set_paused` |
| `BufferResized` | `resize_buffer` |
| `DeviationThresholdUpdated` | `set_max_deviation` |
| `RewardClaimed` | `claim_reward` |

## SDK

```bash
npm install @slot-twap-oracle/sdk
```

```typescript
import { SlotTwapOracleClient } from "@slot-twap-oracle/sdk";

const client = new SlotTwapOracleClient(provider);

// Initialize oracle
await client.initializeOracle(baseMint, quoteMint, 64, payer);

// Update price (permissionless)
const [oraclePda] = client.findOraclePda(baseMint, quoteMint);
await client.updatePrice(oraclePda, new BN(134_500_000_000), payer);

// Query TWAP (off-chain with staleness check)
const twap = await client.computeSwapFromChain(baseMint, quoteMint, 100, 200);

// Admin
await client.transferOwnership(oraclePda, newOwner, owner);
await client.setPaused(oraclePda, true, owner);
await client.setMaxDeviation(oraclePda, 500, owner); // 5%
await client.resizeBuffer(oraclePda, 128, owner);

// Rewards
await client.initializeRewardVault(oraclePda, rewardMint, new BN(1_000_000), owner);
await client.fundRewardVault(oraclePda, rewardMint, funderAta, new BN(10_000_000), funder);
await client.claimReward(oraclePda, rewardMint, updaterAta, updater);

// Parse events
const events = await client.parseOracleUpdateEvents(txSignature);
const updates = await client.getOracleUpdates(oraclePda, 50);
```

### CLI

```bash
npx slot-twap-oracle init --base-mint <pk> --quote-mint <pk> --capacity 64
npx slot-twap-oracle update-price --oracle <pk> --price 134500000000
npx slot-twap-oracle get-swap --base-mint <pk> --quote-mint <pk> --window 100
npx slot-twap-oracle inspect --oracle <pk>
npx slot-twap-oracle parse-events --oracle <pk> --limit 50
```

## API Server

Express + Zod REST API with WebSocket streaming:

```bash
cd api && npm run dev
```

| Endpoint | Description |
|---|---|
| `GET /price?oracle=<pk>` | Latest price, staleness gap, full oracle state |
| `GET /twap?oracle=<pk>&window=<slots>` | Off-chain TWAP computation |
| `GET /history?oracle=<pk>&limit=<n>` | Decoded OracleUpdate events |
| `GET /health` | RPC connectivity check |
| `WS /ws` | Subscribe to live TWAP updates per oracle |

## Updater Bot

Multi-pair, multi-source price updater with production infrastructure:

```bash
cd bots/updater
cp .env.example .env
cp config/pairs.example.json config/pairs.json
npm start
```

- **Sources**: Raydium, Orca, Meteora (with mint validation + auto-inversion)
- **Aggregation**: parallel fetch, outlier rejection (>5% from median), min-sources guard, median
- **Monitoring**: Prometheus metrics (`:9090`), Telegram alerts, persistent JSON metrics, Grafana dashboard
- **Reliability**: retry with backoff, graceful shutdown, structured logging

See [bots/updater/RUNBOOK.md](bots/updater/RUNBOOK.md) for operations guide.

## Testing

```bash
# Run everything
npm run test:all

# Individual layers
cargo test --manifest-path tests/Cargo.toml    # 85 Rust tests (LiteSVM)
npm run test:sdk                                # 24 SDK tests (mocha)
cd api && npm test                              # 25 API tests (Jest + supertest)
npx tsx scripts/e2e-test.ts                     # E2E against test-validator

# Fuzz testing
cd fuzz && cargo +nightly fuzz run fuzz_ring_buffer -- -max_total_time=60
```

| Layer | Tests | Framework |
|---|---|---|
| Rust integration | 85 | LiteSVM |
| SDK mocha | 24 | mocha + tsx |
| API (REST + WS) | 25 | Jest + supertest |
| E2E | 10 checks | solana-test-validator |
| Fuzz | 4 targets, 28M+ runs | cargo-fuzz / libFuzzer |
| **Total** | **134+ automated checks** |

## Scripts

| Script | Usage |
|---|---|
| `scripts/test-all.sh` | Run all test layers |
| `scripts/e2e-test.ts` | Full lifecycle E2E test |
| `scripts/deploy-devnet.ts` | Deploy/upgrade program on devnet |
| `scripts/sync-idl.sh` | Copy generated IDL to SDK |
| `scripts/index-events.ts` | gRPC event indexer (Yellowstone → PostgreSQL) |
| `scripts/calculate-rewards.ts` | Off-chain reward distribution report |
| `scripts/validate-pool-offsets.ts` | Validate DEX pool byte offsets against live data |

## Program ID

```
7LKj9Yk62ddRjtTHvvV6fmquD9h7XbcvKKa7yGtocdsT
```

## License

ISC
