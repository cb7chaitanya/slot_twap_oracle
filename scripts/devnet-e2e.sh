#!/usr/bin/env bash
#
# Devnet End-to-End Test Plan
#
# Prerequisites:
#   - solana CLI configured for devnet
#   - Funded deployer keypair (>= 5 SOL on devnet)
#   - anchor build has been run
#   - npm install in root, sdk, bots/updater, api
#   - SDK linked: cd sdk && npm run build && npm link
#   - PostgreSQL running locally (optional, for indexer)
#   - Geyser endpoint available (optional, for indexer)
#
# Usage:
#   bash scripts/devnet-e2e.sh [--skip-deploy] [--skip-indexer] [--duration 1800]
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── Config ──
DEVNET_RPC="https://api.devnet.solana.com"
KEYPAIR="${DEPLOYER_KEYPAIR:-$HOME/.config/solana/id.json}"
DURATION=${DURATION:-1800}  # 30 minutes default
API_PORT=3000
SKIP_DEPLOY=false
SKIP_INDEXER=false

for arg in "$@"; do
  case $arg in
    --skip-deploy) SKIP_DEPLOY=true ;;
    --skip-indexer) SKIP_INDEXER=true ;;
    --duration=*) DURATION="${arg#*=}" ;;
  esac
done

# ── Helpers ──
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { echo "$(ts) [e2e] $1"; }
ok() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILURES=$((FAILURES + 1)); }
FAILURES=0
PIDS=()

cleanup() {
  log "Shutting down background processes..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  log "Cleanup done."
}
trap cleanup EXIT

check_prereqs() {
  log "Checking prerequisites..."
  command -v solana >/dev/null || { fail "solana CLI not found"; exit 1; }
  command -v anchor >/dev/null || { fail "anchor CLI not found"; exit 1; }
  command -v npx >/dev/null || { fail "npx not found"; exit 1; }
  [ -f "$KEYPAIR" ] || { fail "Keypair not found: $KEYPAIR"; exit 1; }
  [ -f target/deploy/slot_twap_oracle.so ] || { fail "Program not built. Run: anchor build"; exit 1; }

  DEPLOYER=$(solana address -k "$KEYPAIR" 2>/dev/null)
  BALANCE=$(solana balance "$DEPLOYER" --url "$DEVNET_RPC" 2>/dev/null | awk '{print $1}')
  log "Deployer: $DEPLOYER"
  log "Balance:  $BALANCE SOL"
  ok "Prerequisites met"
}

# ── Step 1: Deploy ──
deploy_program() {
  if [ "$SKIP_DEPLOY" = true ]; then
    log "Skipping deployment (--skip-deploy)"
    return
  fi

  log "Step 1: Deploying program to devnet..."
  solana program deploy target/deploy/slot_twap_oracle.so \
    --program-id target/deploy/slot_twap_oracle-keypair.json \
    --url "$DEVNET_RPC" \
    --keypair "$KEYPAIR" \
    --with-compute-unit-price 1000

  PROGRAM_ID=$(solana address -k target/deploy/slot_twap_oracle-keypair.json)
  log "Program deployed: $PROGRAM_ID"
  ok "Program deployed"
}

# ── Step 2: Initialize oracle + reward vault ──
initialize_oracle() {
  log "Step 2: Initializing oracle..."

  # Use well-known devnet mints (or create new ones)
  # SOL wrapped = So11111111111111111111111111111111111111112
  # For devnet testing, we create fresh Token-2022 mints
  npx tsx -e "
import { AnchorProvider, BN, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import { createInitializeMint2Instruction, getMintLen, TOKEN_2022_PROGRAM_ID, createInitializeAccountInstruction, createMintToInstruction, ACCOUNT_SIZE } from '@solana/spl-token';
import { SlotTwapOracleClient, PROGRAM_ID } from '@slot-twap-oracle/sdk';
import fs from 'fs';

const conn = new Connection('${DEVNET_RPC}', 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('${KEYPAIR}', 'utf-8'))));
const provider = new AnchorProvider(conn, new Wallet(payer), { commitment: 'confirmed' });
const client = new SlotTwapOracleClient(provider);

async function createMint(): Promise<PublicKey> {
  const mint = Keypair.generate();
  const space = getMintLen([]);
  const rent = await conn.getMinimumBalanceForRentExemption(space);
  const tx = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space, lamports: rent, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeMint2Instruction(mint.publicKey, 6, payer.publicKey, null, TOKEN_2022_PROGRAM_ID)
  );
  await sendAndConfirmTransaction(conn, tx, [payer, mint]);
  return mint.publicKey;
}

(async () => {
  console.log('Creating test mints...');
  const baseMint = await createMint();
  const quoteMint = await createMint();
  console.log('BASE_MINT=' + baseMint.toBase58());
  console.log('QUOTE_MINT=' + quoteMint.toBase58());

  console.log('Initializing oracle...');
  const sig = await client.initializeOracle(baseMint, quoteMint, 64, payer);
  const [oraclePda] = client.findOraclePda(baseMint, quoteMint);
  console.log('ORACLE_PDA=' + oraclePda.toBase58());
  console.log('INIT_TX=' + sig);

  // Initialize reward vault
  const rewardMint = await createMint();
  console.log('REWARD_MINT=' + rewardMint.toBase58());

  console.log('Initializing reward vault...');
  const vaultSig = await client.initializeRewardVault(
    oraclePda, rewardMint, new BN(1_000_000), payer
  );
  console.log('VAULT_TX=' + vaultSig);

  // Fund reward vault
  const [vaultPda] = client.findRewardVaultPda(oraclePda);
  const [vaultToken] = client.findVaultTokenAccountPda(oraclePda);

  // Create token account, mint, and fund
  const funderAta = Keypair.generate();
  const rent2 = await conn.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
  const tx = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: funderAta.publicKey, space: ACCOUNT_SIZE, lamports: rent2, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeAccountInstruction(funderAta.publicKey, rewardMint, payer.publicKey, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(rewardMint, funderAta.publicKey, payer.publicKey, 100_000_000, [], TOKEN_2022_PROGRAM_ID),
  );
  await sendAndConfirmTransaction(conn, tx, [payer, funderAta]);

  const fundSig = await client.fundRewardVault(
    oraclePda, rewardMint, funderAta.publicKey, new BN(50_000_000), payer
  );
  console.log('FUND_TX=' + fundSig);

  // Write config for other steps
  const config = {
    baseMint: baseMint.toBase58(),
    quoteMint: quoteMint.toBase58(),
    oraclePda: oraclePda.toBase58(),
    rewardMint: rewardMint.toBase58(),
  };
  fs.writeFileSync('/tmp/devnet-e2e-config.json', JSON.stringify(config, null, 2));
  console.log('Config written to /tmp/devnet-e2e-config.json');
})();
" 2>&1 | tee /tmp/devnet-e2e-init.log

  if grep -q "ORACLE_PDA=" /tmp/devnet-e2e-init.log; then
    ok "Oracle + reward vault initialized"
  else
    fail "Oracle initialization failed"
    return
  fi
}

# ── Step 3: Seed initial prices ──
seed_prices() {
  log "Step 3: Seeding initial prices..."

  npx tsx -e "
import { AnchorProvider, BN, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair } from '@solana/web3.js';
import { SlotTwapOracleClient } from '@slot-twap-oracle/sdk';
import fs from 'fs';

const conn = new Connection('${DEVNET_RPC}', 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('${KEYPAIR}', 'utf-8'))));
const provider = new AnchorProvider(conn, new Wallet(payer), { commitment: 'confirmed' });
const client = new SlotTwapOracleClient(provider);
const config = JSON.parse(fs.readFileSync('/tmp/devnet-e2e-config.json', 'utf-8'));

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

(async () => {
  const oracle = config.oraclePda;
  const prices = [1000000000, 1050000000, 1100000000, 1050000000, 1000000000];

  for (let i = 0; i < prices.length; i++) {
    await sleep(2000); // wait for slot to advance
    const sig = await client.updatePrice(oracle, new BN(prices[i]), payer);
    console.log('Update ' + (i+1) + ': price=' + prices[i] + ' tx=' + sig.slice(0, 16) + '...');
  }
  console.log('PRICES_SEEDED=true');
})();
" 2>&1 | tee /tmp/devnet-e2e-prices.log

  if grep -q "PRICES_SEEDED=true" /tmp/devnet-e2e-prices.log; then
    ok "5 price updates seeded"
  else
    fail "Price seeding failed"
  fi
}

# ── Step 4: Start API server ──
start_api() {
  log "Step 4: Starting API server on :$API_PORT..."
  cd "$ROOT/api"
  RPC_URL="$DEVNET_RPC" PORT=$API_PORT npx tsx src/index.ts > /tmp/devnet-e2e-api.log 2>&1 &
  PIDS+=($!)
  cd "$ROOT"
  sleep 3

  if curl -sf "http://localhost:$API_PORT/health" > /dev/null 2>&1; then
    ok "API server running"
  else
    fail "API server failed to start"
  fi
}

# ── Step 5: Validate API endpoints ──
validate_api() {
  log "Step 5: Validating API endpoints..."
  CONFIG=$(cat /tmp/devnet-e2e-config.json)
  ORACLE=$(echo "$CONFIG" | python3 -c "import sys,json; print(json.load(sys.stdin)['oraclePda'])")

  # /price
  PRICE_RESP=$(curl -sf "http://localhost:$API_PORT/price?oracle=$ORACLE" 2>/dev/null || echo "FAIL")
  if echo "$PRICE_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); assert int(d['price']) > 0" 2>/dev/null; then
    ok "/price returns valid price"
  else
    fail "/price failed: $PRICE_RESP"
  fi

  # /twap
  TWAP_RESP=$(curl -sf "http://localhost:$API_PORT/twap?oracle=$ORACLE&window=10" 2>/dev/null || echo "FAIL")
  if echo "$TWAP_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); assert int(d['twap']) > 0" 2>/dev/null; then
    ok "/twap returns valid TWAP"
  else
    fail "/twap failed: $TWAP_RESP"
  fi

  # /history
  HIST_RESP=$(curl -sf "http://localhost:$API_PORT/history?oracle=$ORACLE&limit=5" 2>/dev/null || echo "FAIL")
  if echo "$HIST_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['count'] > 0" 2>/dev/null; then
    ok "/history returns events"
  else
    fail "/history failed: $HIST_RESP"
  fi

  # /health
  HEALTH=$(curl -sf "http://localhost:$API_PORT/health" 2>/dev/null || echo "FAIL")
  if echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['status'] == 'ok'" 2>/dev/null; then
    ok "/health returns ok"
  else
    fail "/health failed"
  fi
}

# ── Step 6: WebSocket test ──
test_websocket() {
  log "Step 6: Testing WebSocket..."
  CONFIG=$(cat /tmp/devnet-e2e-config.json)
  ORACLE=$(echo "$CONFIG" | python3 -c "import sys,json; print(json.load(sys.stdin)['oraclePda'])")

  npx tsx -e "
import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:$API_PORT/ws');
let gotUpdate = false;
ws.on('open', () => {
  ws.send(JSON.stringify({action: 'subscribe', oracle: '$ORACLE', window: 10}));
});
ws.on('message', (data: any) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'update' || msg.type === 'subscribed') {
    console.log('WS_MSG=' + msg.type);
    gotUpdate = true;
  }
  if (msg.type === 'error') {
    console.log('WS_ERROR=' + msg.error);
  }
});
setTimeout(() => {
  ws.close();
  console.log(gotUpdate ? 'WS_OK=true' : 'WS_TIMEOUT=true');
  process.exit(0);
}, 5000);
" 2>&1 | tee /tmp/devnet-e2e-ws.log

  if grep -q "WS_MSG=subscribed" /tmp/devnet-e2e-ws.log; then
    ok "WebSocket subscription works"
  else
    fail "WebSocket test failed"
  fi
}

# ── Step 7: Verify oracle state ──
verify_state() {
  log "Step 7: Verifying oracle state..."
  CONFIG=$(cat /tmp/devnet-e2e-config.json)
  ORACLE=$(echo "$CONFIG" | python3 -c "import sys,json; print(json.load(sys.stdin)['oraclePda'])")

  npx tsx -e "
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { SlotTwapOracleClient } from '@slot-twap-oracle/sdk';
import fs from 'fs';

const conn = new Connection('${DEVNET_RPC}', 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('${KEYPAIR}', 'utf-8'))));
const provider = new AnchorProvider(conn, new Wallet(payer), { commitment: 'confirmed' });
const client = new SlotTwapOracleClient(provider);
const config = JSON.parse(fs.readFileSync('/tmp/devnet-e2e-config.json', 'utf-8'));

(async () => {
  const oracle = await client.fetchOracle(new PublicKey(config.oraclePda));
  console.log('lastPrice=' + oracle.lastPrice.toString());
  console.log('cumulativePrice=' + oracle.cumulativePrice.toString());
  console.log('lastSlot=' + oracle.lastSlot.toString());
  console.log('lastUpdater=' + oracle.lastUpdater.toBase58());
  console.log('paused=' + oracle.paused);
  console.log('maxDeviationBps=' + oracle.maxDeviationBps);

  const [bufPda] = client.findObservationBufferPda(new PublicKey(config.oraclePda));
  const buf = await client.fetchObservationBuffer(bufPda);
  console.log('bufferLen=' + buf.len);
  console.log('bufferCapacity=' + buf.capacity);

  const checks = [
    oracle.lastPrice.toNumber() > 0,
    oracle.cumulativePrice.toNumber() > 0,
    buf.len >= 5,
    !oracle.paused,
  ];
  console.log('STATE_OK=' + checks.every(Boolean));
})();
" 2>&1 | tee /tmp/devnet-e2e-state.log

  if grep -q "STATE_OK=true" /tmp/devnet-e2e-state.log; then
    ok "Oracle state verified"
  else
    fail "Oracle state check failed"
  fi
}

# ── Summary ──
summary() {
  echo ""
  echo "════════════════════════════════════════════════════════"
  echo "  Devnet E2E Test Results"
  echo "════════════════════════════════════════════════════════"
  if [ $FAILURES -eq 0 ]; then
    echo "  ✓ All checks passed"
  else
    echo "  ✗ $FAILURES check(s) failed"
  fi
  echo ""
  echo "  Logs:"
  echo "    Init:    /tmp/devnet-e2e-init.log"
  echo "    Prices:  /tmp/devnet-e2e-prices.log"
  echo "    API:     /tmp/devnet-e2e-api.log"
  echo "    WS:      /tmp/devnet-e2e-ws.log"
  echo "    State:   /tmp/devnet-e2e-state.log"
  echo "    Config:  /tmp/devnet-e2e-config.json"
  echo "════════════════════════════════════════════════════════"
  exit $FAILURES
}

# ── Main ──
log "Starting Devnet E2E Test"
log "RPC: $DEVNET_RPC"
log "Keypair: $KEYPAIR"
echo ""

check_prereqs
deploy_program
initialize_oracle
seed_prices
start_api
validate_api
test_websocket
verify_state
summary
