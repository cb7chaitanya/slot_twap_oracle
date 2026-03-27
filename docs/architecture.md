# Slot TWAP Oracle — Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SOLANA NETWORK                                │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                  Slot TWAP Oracle Program (Anchor)                  │   │
│   │              7LKj9Yk62ddRjtTHvvV6fmquD9h7XbcvKKa7yGtocdsT          │   │
│   │                                                                     │   │
│   │  Instructions:                                                      │   │
│   │  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐    │   │
│   │  │ initialize_oracle│ │  update_price    │ │    get_swap      │    │   │
│   │  │  (create pair)   │ │ (permissionless) │ │  (read-only)     │    │   │
│   │  └──────────────────┘ └──────────────────┘ └──────────────────┘    │   │
│   │  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐    │   │
│   │  │transfer_ownership│ │   set_paused     │ │  resize_buffer   │    │   │
│   │  │  (owner only)    │ │  (owner only)    │ │  (owner only)    │    │   │
│   │  └──────────────────┘ └──────────────────┘ └──────────────────┘    │   │
│   │  ┌──────────────────┐                                              │   │
│   │  │ set_max_deviation│  Emits: OracleUpdate, OwnershipTransferred,  │   │
│   │  │  (owner only)    │  OraclePauseToggled, BufferResized,          │   │
│   │  └──────────────────┘  DeviationThresholdUpdated                   │   │
│   │                                                                     │   │
│   │  Accounts (per trading pair):                                       │   │
│   │  ┌──────────────┐    ┌─────────────────────────┐                   │   │
│   │  │  Oracle PDA  │    │  ObservationBuffer PDA  │                   │   │
│   │  │              │    │                         │                   │   │
│   │  │ owner        │    │  Fixed-size ring buffer │                   │   │
│   │  │ baseMint     │    │  head / len / capacity  │                   │   │
│   │  │ quoteMint    │    │  observations[]         │                   │   │
│   │  │ lastPrice    │    │                         │                   │   │
│   │  │ cumulative   │    │  PDA: [observation,     │                   │   │
│   │  │ lastSlot     │    │        oracle.key()]    │                   │   │
│   │  │ lastUpdater  │    └─────────────────────────┘                   │   │
│   │  │ paused       │                                                   │   │
│   │  │ maxDeviation │    PDA: [oracle, baseMint, quoteMint]            │   │
│   │  └──────────────┘                                                   │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐         │
│   │   Raydium AMM    │  │  Orca Whirlpool  │  │  Meteora DLMM   │         │
│   │   (price source) │  │  (price source)  │  │  (price source)  │         │
│   └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘         │
└────────────┼─────────────────────┼─────────────────────┼───────────────────┘
             │                     │                     │
             └──────────┬──────────┴──────────┬──────────┘
                        │  fetch prices       │
                        ▼                     │
┌───────────────────────────────────────────────────────────────────────────┐
│                          UPDATER BOT (Node.js)                            │
│                                                                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                      │
│  │ sources/    │  │ sources/    │  │ sources/    │  Pool mint validation │
│  │ raydium.ts  │  │ orca.ts     │  │ meteora.ts  │  + auto-inversion    │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                      │
│         └────────┬───────┴───────┬────────┘                              │
│                  ▼               │                                        │
│  ┌──────────────────────────┐    │     ┌────────────────────────────┐    │
│  │  Aggregation Pipeline    │    │     │  Monitoring                │    │
│  │                          │    │     │                            │    │
│  │  1. Parallel fetch       │    │     │  metrics.ts (persistent)  │    │
│  │  2. Outlier rejection    │    │     │  prometheus.ts (:9090)    │    │
│  │     (>5% from median)   │    │     │  alerts.ts (Telegram)     │    │
│  │  3. Min-sources check   │    │     │                            │    │
│  │  4. Median computation  │    │     │  Staleness detection      │    │
│  │  5. Deviation guard     │    │     │  (>100 slots)             │    │
│  │  6. Submit update_price │    │     └────────────────────────────┘    │
│  └──────────────────────────┘    │                                       │
│                                   │     ┌────────────────────────────┐   │
│  Config: config/pairs.json       │     │  Graceful shutdown         │   │
│  Multi-pair support              │     │  SIGINT / SIGTERM          │   │
│  30s update interval             │     └────────────────────────────┘   │
└──────────────────────┬───────────────────────────────┬───────────────────┘
                       │                               │
                       │ update_price tx               │ :9090/metrics
                       ▼                               ▼
┌──────────────────────────────┐    ┌──────────────────────────────────────┐
│        Solana RPC            │    │         Prometheus + Grafana         │
│                              │    │                                      │
│  Reads / writes on-chain     │    │  Scrapes /metrics endpoint          │
│  accounts and transactions   │    │                                      │
└──────────┬───────────────────┘    │  Dashboard: grafana/dashboard.json  │
           │                        │  6 panels: rates, totals, slots,    │
           │                        │  staleness, slot lag                 │
           │                        └──────────────────────────────────────┘
           │
           │  fetch accounts / tx logs
           ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                         TypeScript SDK                                    │
│                     @slot-twap-oracle/sdk                                 │
│                                                                           │
│  ┌────────────────────────────────────────────────────────────┐          │
│  │  SlotTwapOracleClient                                      │          │
│  │                                                            │          │
│  │  Instructions:    initializeOracle, updatePrice, getSwap,  │          │
│  │                   transferOwnership, setPaused,             │          │
│  │                   resizeBuffer, setMaxDeviation             │          │
│  │                                                            │          │
│  │  Fetchers:        fetchOracle, fetchObservationBuffer      │          │
│  │                                                            │          │
│  │  Off-chain TWAP:  computeSwap, computeSwapFromChain       │          │
│  │                   (with staleness enforcement)             │          │
│  │                                                            │          │
│  │  Events:          parseOracleUpdateEvents,                 │          │
│  │                   getOracleUpdates,                        │          │
│  │                   decodeOracleUpdateLogs                   │          │
│  │                                                            │          │
│  │  PDA helpers:     findOraclePda, findObservationBufferPda  │          │
│  └────────────────────────────────────────────────────────────┘          │
│                                                                           │
│  CLI: slot-twap-oracle (init, update-price, get-swap,                    │
│       parse-events, inspect)                                              │
│                                                                           │
│  IDL: auto-synced from target/idl/ via scripts/sync-idl.sh              │
└──────────┬────────────────────────────────┬──────────────────────────────┘
           │                                │
           │  imports SDK                   │  imports SDK
           ▼                                ▼
┌──────────────────────────┐  ┌────────────────────────────────────────────┐
│    REST API (Express)    │  │         gRPC Event Indexer                 │
│         :3000            │  │                                            │
│                          │  │  Yellowstone Geyser subscription          │
│  GET /price?oracle=...   │  │  → decode OracleUpdate events             │
│  GET /twap?oracle=...    │  │  → insert into PostgreSQL                 │
│  GET /history?oracle=... │  │                                            │
│  GET /health             │  │  Schema: oracle_updates                   │
│  WS  /ws                 │  │  (tx_sig, oracle, price, cumulative,      │
│                          │  │   slot, updater, indexed_at)              │
│  Zod validation          │  │                                            │
│  25 Jest + supertest     │  │  Idempotent inserts                       │
│  tests                   │  │  Graceful shutdown                        │
└──────────────────────────┘  └────────────────────────────────────────────┘
           │
           │  WebSocket stream
           ▼
┌──────────────────────────┐
│       Consumers          │
│                          │
│  Web dashboards          │
│  Trading bots            │
│  DeFi protocols (CPI)    │
│  Analytics pipelines     │
└──────────────────────────┘


═══════════════════════════════════════════════════════════════════════

  Data Flow Summary:

  1. DEX Pools → Updater Bot (fetch prices)
  2. Updater Bot → Solana Program (submit update_price tx)
  3. Solana Program → Oracle PDA + ObservationBuffer PDA (state)
  4. SDK → Solana RPC (read state, parse events)
  5. API Server → SDK → Solana RPC (serve HTTP/WS to consumers)
  6. gRPC Indexer → Geyser → PostgreSQL (historical data)
  7. Updater Bot → Prometheus → Grafana (monitoring)
  8. Updater Bot → Telegram (staleness alerts)

═══════════════════════════════════════════════════════════════════════

  Test Coverage:

  Layer              Tests   Framework
  ─────────────────  ─────   ──────────────────
  Rust program       65      LiteSVM
  SDK mocha          18      mocha + tsx
  API endpoints      25      Jest + supertest
  E2E script         10      solana-test-validator
  Fuzz (arithmetic)  26M+    cargo-fuzz / libFuzzer
  ─────────────────  ─────
  Total              108+

═══════════════════════════════════════════════════════════════════════
```
