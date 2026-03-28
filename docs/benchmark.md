# Slot TWAP Oracle — Performance Benchmarks

Generated: 2026-03-28T18:47:19.982Z
Environment: solana-test-validator (localhost)

## Results

| Benchmark | Iterations | Avg (ms) | p50 (ms) | p95 (ms) | Min (ms) | Max (ms) | Avg CU |
|---|---|---|---|---|---|---|---|
| initialize_oracle | 5 | 450 | 464 | 517 | 364 | 517 | — |
| update_price | 20 | 622 | 455 | 526 | 288 | 4166 | 17143 |
| get_swap (simulate) | 10 | 1 | 1 | 2 | 0 | 2 | — |
| computeSwapFromChain (off-chain) | 10 | 1 | 1 | 3 | 0 | 3 | — |
| fetchOracle | 20 | 0 | 0 | 1 | 0 | 1 | — |
| parseOracleUpdateEvents | 10 | 1 | 1 | 3 | 0 | 3 | — |

## Notes

- All benchmarks run against local solana-test-validator (not representative of mainnet latency)
- Compute units measured from confirmed transaction metadata
- update_price oscillates ±5% to stay within deviation guard
- get_swap uses simulate (not view) due to WS limitation in test-validator
- Off-chain computeSwapFromChain includes 3 RPC calls (oracle + buffer + slot)
