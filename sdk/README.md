# @slot-twap-oracle/sdk

TypeScript SDK for the Slot TWAP Oracle Solana program.

## Install

```bash
npm install @slot-twap-oracle/sdk
```

## Setup

```typescript
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import { SlotTwapOracleClient } from "@slot-twap-oracle/sdk";

const connection = new Connection("https://api.mainnet-beta.solana.com");
const wallet = new Wallet(Keypair.generate());
const provider = new AnchorProvider(connection, wallet, {
  commitment: "confirmed",
});

const client = new SlotTwapOracleClient(provider);
```

## Initialize an oracle

```typescript
const baseMint = new PublicKey("So11111111111111111111111111111111111111112");
const quoteMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const sig = await client.initializeOracle(baseMint, quoteMint, 64, payer);
```

## Update price

```typescript
const [oraclePda] = client.findOraclePda(baseMint, quoteMint);
const sig = await client.updatePrice(oraclePda, new BN(134_500_000_000), payer);
```

## Query TWAP

```typescript
import { BN } from "@coral-xyz/anchor";

// On-chain via instruction
const twap = await client.getSwap(
  oraclePda,
  new BN(100),    // window: 100 slots
  new BN(200)     // max staleness: 200 slots
);

// Off-chain from fetched state
const twap = await client.computeSwapFromChain(baseMint, quoteMint, 100);
```

## Fetch accounts

```typescript
const oracle = await client.fetchOracle(oraclePda);
console.log(oracle.lastPrice.toString());
console.log(oracle.lastUpdater.toBase58());

const buffer = await client.fetchObservationBuffer(bufferPda);
console.log(buffer.observations.length);
```

## Parse events

```typescript
// From a single transaction
const events = await client.parseOracleUpdateEvents(txSignature);
for (const e of events) {
  console.log(`${e.updater.toBase58()} updated ${e.oracle.toBase58()} to ${e.price} at slot ${e.slot}`);
}

// Recent events for an oracle
const updates = await client.getOracleUpdates(oraclePda, 50);
```

## PDA helpers

```typescript
import { findOraclePda, findObservationBufferPda } from "@slot-twap-oracle/sdk";

const [oraclePda] = findOraclePda(baseMint, quoteMint);
const [bufferPda] = findObservationBufferPda(oraclePda);
```

## Types

```typescript
import type {
  OracleAccount,
  ObservationBufferAccount,
  Observation,
  OracleUpdateEvent,
} from "@slot-twap-oracle/sdk";
```

## Publishing

```bash
cd sdk
npm run build
# Remove "private": true from package.json if present, then:
npm publish --access public
```
