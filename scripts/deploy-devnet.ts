#!/usr/bin/env npx tsx
/**
 * Deploy Slot TWAP Oracle to devnet and optionally initialize an oracle pair.
 *
 * Prerequisites:
 *   - `anchor build` has been run
 *   - Deployer keypair has devnet SOL (use `solana airdrop 2 --url devnet`)
 *   - Program keypair exists at target/deploy/slot_twap_oracle-keypair.json
 *
 * Usage:
 *   npx tsx scripts/deploy-devnet.ts
 *   npx tsx scripts/deploy-devnet.ts --init-pair \
 *     --base-mint <pubkey> --quote-mint <pubkey> --capacity 64
 *
 * Environment:
 *   DEPLOYER_KEYPAIR  - Path to deployer wallet (default: ~/.config/solana/id.json)
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { AnchorProvider, BN, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { SlotTwapOracleClient, PROGRAM_ID } from "@slot-twap-oracle/sdk";

const DEVNET_URL = "https://api.devnet.solana.com";
const PROGRAM_SO = "target/deploy/slot_twap_oracle.so";
const PROGRAM_KEYPAIR = "target/deploy/slot_twap_oracle-keypair.json";

// ── Helpers ──

function ts(): string {
  return new Date().toISOString();
}

function loadKeypair(filePath: string): Keypair {
  const resolved = filePath.replace("~", process.env.HOME || "");
  const raw = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function parseArgs(): {
  initPair: boolean;
  baseMint?: string;
  quoteMint?: string;
  capacity: number;
} {
  const args = process.argv.slice(2);
  let initPair = false;
  let baseMint: string | undefined;
  let quoteMint: string | undefined;
  let capacity = 32;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--init-pair":
        initPair = true;
        break;
      case "--base-mint":
        baseMint = args[++i];
        break;
      case "--quote-mint":
        quoteMint = args[++i];
        break;
      case "--capacity":
        capacity = parseInt(args[++i], 10);
        break;
    }
  }

  if (initPair && (!baseMint || !quoteMint)) {
    console.error("Error: --init-pair requires --base-mint and --quote-mint");
    process.exit(1);
  }

  return { initPair, baseMint, quoteMint, capacity };
}

// ── Deploy ──

async function deploy(deployer: Keypair, conn: Connection): Promise<PublicKey> {
  // Verify files exist
  if (!fs.existsSync(PROGRAM_SO)) {
    console.error(`Error: ${PROGRAM_SO} not found. Run 'anchor build' first.`);
    process.exit(1);
  }
  if (!fs.existsSync(PROGRAM_KEYPAIR)) {
    console.error(`Error: ${PROGRAM_KEYPAIR} not found.`);
    process.exit(1);
  }

  const programKeypair = loadKeypair(PROGRAM_KEYPAIR);
  const programId = programKeypair.publicKey;

  console.log(`${ts()} [deploy] Program ID: ${programId.toBase58()}`);
  console.log(`${ts()} [deploy] Deployer:   ${deployer.publicKey.toBase58()}`);

  // Check deployer balance
  const balance = await conn.getBalance(deployer.publicKey);
  const solBalance = balance / LAMPORTS_PER_SOL;
  console.log(`${ts()} [deploy] Balance:    ${solBalance.toFixed(4)} SOL`);

  if (solBalance < 1) {
    console.error(
      `Error: Deployer has ${solBalance} SOL. Need >= 1 SOL for deployment.`
    );
    console.error(`Run: solana airdrop 2 ${deployer.publicKey.toBase58()} --url devnet`);
    process.exit(1);
  }

  // Check if already deployed
  const existingAccount = await conn.getAccountInfo(programId);
  if (existingAccount) {
    console.log(`${ts()} [deploy] Program already deployed. Upgrading...`);
    execSync(
      `solana program deploy ${PROGRAM_SO} ` +
        `--program-id ${PROGRAM_KEYPAIR} ` +
        `--url ${DEVNET_URL} ` +
        `--keypair ${process.env.DEPLOYER_KEYPAIR || "~/.config/solana/id.json"}`,
      { stdio: "inherit" }
    );
  } else {
    console.log(`${ts()} [deploy] Deploying program...`);
    execSync(
      `solana program deploy ${PROGRAM_SO} ` +
        `--program-id ${PROGRAM_KEYPAIR} ` +
        `--url ${DEVNET_URL} ` +
        `--keypair ${process.env.DEPLOYER_KEYPAIR || "~/.config/solana/id.json"}`,
      { stdio: "inherit" }
    );
  }

  // Verify deployment
  const deployed = await conn.getAccountInfo(programId);
  if (!deployed || !deployed.executable) {
    console.error("Error: Deployment verification failed.");
    process.exit(1);
  }

  console.log(`${ts()} [deploy] Program deployed and verified.`);
  return programId;
}

// ── Initialize pair ──

async function initPair(
  client: SlotTwapOracleClient,
  deployer: Keypair,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  capacity: number
): Promise<void> {
  const [oraclePda] = client.findOraclePda(baseMint, quoteMint);
  const [bufferPda] = client.findObservationBufferPda(oraclePda);

  console.log(`${ts()} [init] Base mint:  ${baseMint.toBase58()}`);
  console.log(`${ts()} [init] Quote mint: ${quoteMint.toBase58()}`);
  console.log(`${ts()} [init] Oracle PDA: ${oraclePda.toBase58()}`);
  console.log(`${ts()} [init] Buffer PDA: ${bufferPda.toBase58()}`);
  console.log(`${ts()} [init] Capacity:   ${capacity}`);

  const sig = await client.initializeOracle(baseMint, quoteMint, capacity, deployer);
  console.log(`${ts()} [init] Transaction: ${sig}`);

  // Verify
  const oracle = await client.fetchOracle(oraclePda);
  console.log(`${ts()} [init] Oracle created:`);
  console.log(`  owner:           ${oracle.owner.toBase58()}`);
  console.log(`  baseMint:        ${oracle.baseMint.toBase58()}`);
  console.log(`  quoteMint:       ${oracle.quoteMint.toBase58()}`);
  console.log(`  lastSlot:        ${oracle.lastSlot.toString()}`);
  console.log(`  maxDeviationBps: ${oracle.maxDeviationBps}`);
  console.log(`  paused:          ${oracle.paused}`);
}

// ── Main ──

async function run(): Promise<void> {
  const opts = parseArgs();
  const keypairPath = process.env.DEPLOYER_KEYPAIR || "~/.config/solana/id.json";
  const deployer = loadKeypair(keypairPath);
  const conn = new Connection(DEVNET_URL, "confirmed");

  console.log(`\n${"═".repeat(50)}`);
  console.log(`  Slot TWAP Oracle — Devnet Deployment`);
  console.log(`${"═".repeat(50)}\n`);

  // Deploy
  const programId = await deploy(deployer, conn);

  // Optionally initialize a pair
  if (opts.initPair) {
    console.log(`\n${ts()} [init] Initializing oracle pair...`);
    const provider = new AnchorProvider(conn, new Wallet(deployer), {
      commitment: "confirmed",
    });
    const client = new SlotTwapOracleClient(provider, programId);

    await initPair(
      client,
      deployer,
      new PublicKey(opts.baseMint!),
      new PublicKey(opts.quoteMint!),
      opts.capacity
    );
  }

  console.log(`\n${"═".repeat(50)}`);
  console.log(`  Deployment complete.`);
  console.log(`  Program ID: ${programId.toBase58()}`);
  console.log(`  Explorer:   https://explorer.solana.com/address/${programId.toBase58()}?cluster=devnet`);
  console.log(`${"═".repeat(50)}\n`);
}

run().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
