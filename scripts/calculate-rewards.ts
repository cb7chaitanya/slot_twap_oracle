#!/usr/bin/env npx tsx
/**
 * Off-chain reward calculator — aggregates OracleUpdate events per updater.
 *
 * Modes:
 *   1. From PostgreSQL (if POSTGRES_URL set): reads indexed events
 *   2. From RPC: fetches recent events via SDK
 *
 * Usage:
 *   npx tsx scripts/calculate-rewards.ts --oracle <pubkey> [--limit 100] [--reward-per-update 1000000]
 *
 *   POSTGRES_URL=postgres://... npx tsx scripts/calculate-rewards.ts --oracle <pubkey>
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { SlotTwapOracleClient, PROGRAM_ID } from "@slot-twap-oracle/sdk";

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8899";
const POSTGRES_URL = process.env.POSTGRES_URL;

interface UpdaterStats {
  updater: string;
  updateCount: number;
  firstSlot: number;
  lastSlot: number;
  reward: number;
}

function parseArgs(): { oracle: string; limit: number; rewardPerUpdate: number } {
  const args = process.argv.slice(2);
  let oracle = "";
  let limit = 100;
  let rewardPerUpdate = 1_000_000; // default: 1 token with 6 decimals

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--oracle": oracle = args[++i]; break;
      case "--limit": limit = parseInt(args[++i], 10); break;
      case "--reward-per-update": rewardPerUpdate = parseInt(args[++i], 10); break;
    }
  }

  if (!oracle) {
    console.error("Error: --oracle <pubkey> is required");
    process.exit(1);
  }

  return { oracle, limit, rewardPerUpdate };
}

async function fetchEventsFromRpc(
  oraclePubkey: PublicKey,
  limit: number
): Promise<Array<{ updater: string; slot: number }>> {
  const conn = new Connection(RPC_URL, "confirmed");
  const provider = new AnchorProvider(conn, new Wallet(Keypair.generate()), { commitment: "confirmed" });
  const client = new SlotTwapOracleClient(provider);
  const events = await client.getOracleUpdates(oraclePubkey, limit);

  return events.map((e) => ({
    updater: e.updater.toBase58(),
    slot: e.slot.toNumber(),
  }));
}

async function fetchEventsFromPostgres(
  oracleStr: string,
  limit: number
): Promise<Array<{ updater: string; slot: number }>> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: POSTGRES_URL });

  const result = await pool.query(
    `SELECT updater, slot FROM oracle_updates
     WHERE oracle_pubkey = $1
     ORDER BY slot DESC
     LIMIT $2`,
    [oracleStr, limit]
  );

  await pool.end();
  return result.rows.map((r: any) => ({ updater: r.updater, slot: Number(r.slot) }));
}

function calculateDistribution(
  events: Array<{ updater: string; slot: number }>,
  rewardPerUpdate: number
): UpdaterStats[] {
  const stats = new Map<string, UpdaterStats>();

  for (const e of events) {
    let s = stats.get(e.updater);
    if (!s) {
      s = {
        updater: e.updater,
        updateCount: 0,
        firstSlot: e.slot,
        lastSlot: e.slot,
        reward: 0,
      };
      stats.set(e.updater, s);
    }
    s.updateCount++;
    s.firstSlot = Math.min(s.firstSlot, e.slot);
    s.lastSlot = Math.max(s.lastSlot, e.slot);
    s.reward = s.updateCount * rewardPerUpdate;
  }

  return Array.from(stats.values()).sort((a, b) => b.updateCount - a.updateCount);
}

async function run(): Promise<void> {
  const { oracle, limit, rewardPerUpdate } = parseArgs();
  const oraclePubkey = new PublicKey(oracle);

  console.log(`Oracle:           ${oracle}`);
  console.log(`Reward per update: ${rewardPerUpdate}`);
  console.log(`Source:           ${POSTGRES_URL ? "PostgreSQL" : "RPC"}`);
  console.log(`Limit:            ${limit}\n`);

  const events = POSTGRES_URL
    ? await fetchEventsFromPostgres(oracle, limit)
    : await fetchEventsFromRpc(oraclePubkey, limit);

  console.log(`Total events: ${events.length}\n`);

  if (events.length === 0) {
    console.log("No events found.");
    return;
  }

  const distribution = calculateDistribution(events, rewardPerUpdate);

  const totalReward = distribution.reduce((sum, s) => sum + s.reward, 0);

  console.log("Updater Rewards:");
  console.log("─".repeat(90));
  console.log(
    "Updater".padEnd(46) +
    "Updates".padStart(8) +
    "Reward".padStart(14) +
    "First Slot".padStart(12) +
    "Last Slot".padStart(12)
  );
  console.log("─".repeat(90));

  for (const s of distribution) {
    console.log(
      s.updater.padEnd(46) +
      s.updateCount.toString().padStart(8) +
      s.reward.toString().padStart(14) +
      s.firstSlot.toString().padStart(12) +
      s.lastSlot.toString().padStart(12)
    );
  }

  console.log("─".repeat(90));
  console.log(
    "TOTAL".padEnd(46) +
    events.length.toString().padStart(8) +
    totalReward.toString().padStart(14)
  );

  // Output JSON for piping
  console.log(`\nJSON:\n${JSON.stringify(distribution, null, 2)}`);
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
