# Devnet E2E Test Plan

## Prerequisites

- [ ] Solana CLI configured for devnet: `solana config set --url devnet`
- [ ] Deployer keypair with >= 5 SOL: `solana airdrop 5`
- [ ] `anchor build` completed
- [ ] SDK built and linked: `cd sdk && npm run build && npm link`
- [ ] Root deps: `npm install && npm link @slot-twap-oracle/sdk`
- [ ] API deps: `cd api && npm install && npm link @slot-twap-oracle/sdk`
- [ ] (Optional) PostgreSQL running for indexer
- [ ] (Optional) Geyser endpoint for gRPC indexer

## Run

```bash
# Full run
bash scripts/devnet-e2e.sh

# Skip deployment (if already deployed)
bash scripts/devnet-e2e.sh --skip-deploy

# Custom keypair
DEPLOYER_KEYPAIR=./my-wallet.json bash scripts/devnet-e2e.sh
```

## Test Steps

### Step 1: Deploy Program
- Deploy `slot_twap_oracle.so` to devnet via `solana program deploy`
- Verify account is executable on-chain

### Step 2: Initialize Oracle + Rewards
- Create Token-2022 test mints (base, quote, reward)
- `initialize_oracle` with capacity 64
- `initialize_reward_vault` with 1M lamport reward per update
- `fund_reward_vault` with 50M reward tokens
- Write config to `/tmp/devnet-e2e-config.json`

### Step 3: Seed Prices
- 5 price updates: 1.0, 1.05, 1.1, 1.05, 1.0 (scaled to 1e9)
- 2 second delay between each for slot advancement
- Verify all transactions confirm

### Step 4: Start API Server
- Express server on `:3000`
- Connected to devnet RPC
- Verify `/health` responds

### Step 5: Validate API Endpoints
- `GET /price?oracle=<pda>` — price > 0
- `GET /twap?oracle=<pda>&window=10` — TWAP > 0
- `GET /history?oracle=<pda>&limit=5` — count > 0
- `GET /health` — status == "ok"

### Step 6: WebSocket Test
- Connect to `ws://localhost:3000/ws`
- Subscribe to oracle with window=10
- Verify "subscribed" message received within 5 seconds

### Step 7: Verify Oracle State
- Fetch oracle account: lastPrice > 0, cumulativePrice > 0, not paused
- Fetch observation buffer: len >= 5, capacity == 64

## Manual Checklist (Post-Script)

After the automated script completes:

- [ ] Check Explorer: `https://explorer.solana.com/address/<program_id>?cluster=devnet`
- [ ] Inspect oracle PDA on Explorer
- [ ] Try CLI: `npx slot-twap-oracle inspect --oracle <pda> --rpc https://api.devnet.solana.com`
- [ ] Try parse-events: `npx slot-twap-oracle parse-events --oracle <pda> --rpc https://api.devnet.solana.com`

## Optional: Extended Monitoring

```bash
# Start updater bot (if devnet pools exist)
cd bots/updater
# Configure pairs.json with devnet pool addresses
npm start

# Start gRPC indexer (if Geyser available)
GEYSER_ENDPOINT=http://your-geyser:10000 \
POSTGRES_URL=postgres://user:pass@localhost/oracle \
npx tsx scripts/index-events.ts

# Check Prometheus metrics
curl http://localhost:9090/metrics
```

## Logs

All logs written to `/tmp/devnet-e2e-*.log`:
- `devnet-e2e-init.log` — oracle + vault initialization
- `devnet-e2e-prices.log` — price seeding
- `devnet-e2e-api.log` — API server output
- `devnet-e2e-ws.log` — WebSocket test
- `devnet-e2e-state.log` — final state verification
- `devnet-e2e-config.json` — oracle addresses for manual inspection
