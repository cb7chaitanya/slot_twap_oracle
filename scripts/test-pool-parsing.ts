#!/usr/bin/env npx tsx
/**
 * Integration test: fetches real mainnet pool accounts and validates
 * that the price parsing logic returns reasonable prices.
 *
 * Usage: npx tsx scripts/test-pool-parsing.ts
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { fetchPrice as fetchRaydium } from "../bots/updater/src/sources/raydium";
import { fetchPrice as fetchOrca } from "../bots/updater/src/sources/orca";
import { fetchPrice as fetchMeteora } from "../bots/updater/src/sources/meteora";

const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

function ok(msg: string): void { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
function fail(msg: string): void { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); }

interface PoolTest {
  name: string;
  fetch: (conn: Connection, pool: PublicKey, base: PublicKey, quote: PublicKey) => Promise<number>;
  pool: string;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  // Expected price range — SOL/USDC should be roughly $50-$500
  minPrice: number;
  maxPrice: number;
}

const tests: PoolTest[] = [
  {
    name: "Raydium SOL/USDC",
    fetch: fetchRaydium,
    pool: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
    baseMint: SOL_MINT,
    quoteMint: USDC_MINT,
    // Raw ratio: USDC(6 dec) / SOL(9 dec) ≈ price_usd / 1000
    // SOL at $50-$500 → raw 0.05 to 0.5
    minPrice: 0.01,
    maxPrice: 1.0,
  },
];

async function run(): Promise<void> {
  console.log("Pool Parsing Integration Tests\n");

  let passed = 0;
  let failed = 0;

  for (const t of tests) {
    console.log(`${t.name}:`);
    try {
      const price = await t.fetch(conn, new PublicKey(t.pool), t.baseMint, t.quoteMint);
      if (price >= t.minPrice && price <= t.maxPrice) {
        ok(`price=${price.toFixed(6)} (in range [${t.minPrice}, ${t.maxPrice}])`);
        passed++;
      } else {
        fail(`price=${price.toFixed(6)} OUT OF RANGE [${t.minPrice}, ${t.maxPrice}]`);
        failed++;
      }
    } catch (err) {
      fail((err as Error).message);
      failed++;
    }
    console.log();
  }

  // Also test mint mismatch detection
  console.log("Mint mismatch detection:");
  const fakeMint = new PublicKey("11111111111111111111111111111111");
  try {
    await fetchRaydium(conn, new PublicKey("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"), fakeMint, USDC_MINT);
    fail("Should have thrown mint mismatch");
    failed++;
  } catch (err) {
    if ((err as Error).message.includes("do not match")) {
      ok("Raydium correctly rejects mismatched mints");
      passed++;
    } else {
      fail((err as Error).message);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
