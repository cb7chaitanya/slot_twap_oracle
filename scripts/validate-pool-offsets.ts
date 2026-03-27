#!/usr/bin/env npx tsx
/**
 * Validates byte offsets used by the updater bot against live pool accounts.
 *
 * Fetches real Orca Whirlpool, Meteora DLMM, and Raydium AMM accounts from
 * mainnet RPC and verifies that the pubkeys read at hardcoded offsets are
 * valid SPL token mints and token accounts.
 *
 * Usage:
 *   npx tsx scripts/validate-pool-offsets.ts \
 *     --orca <whirlpool_pubkey> \
 *     --meteora <lb_pair_pubkey> \
 *     --raydium <amm_pubkey>
 *
 * Environment:
 *   RPC_URL  - Solana RPC (default: mainnet-beta)
 */

import { Connection, PublicKey } from "@solana/web3.js";

const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

// ── Bot's assumed offsets ──

const ORCA_WHIRLPOOL_PROGRAM = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const ORCA = {
  MIN_SIZE: 229,
  MINT_A: 101,
  MINT_B: 133,
  VAULT_A: 165,
  VAULT_B: 197,
};

const METEORA_DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const METEORA = {
  MIN_SIZE: 216,
  MINT_X: 88,
  MINT_Y: 120,
  RESERVE_X: 152,
  RESERVE_Y: 184,
};

const RAYDIUM_AMM_PROGRAM = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const RAYDIUM = {
  MIN_SIZE: 752,
  BASE_MINT: 400,
  QUOTE_MINT: 432,
  BASE_VAULT: 336,
  QUOTE_VAULT: 368,
};

// ── Helpers ──

function readPubkey(data: Buffer, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}

function ok(msg: string): void {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

function fail(msg: string): void {
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
}

async function isValidMint(conn: Connection, pubkey: PublicKey): Promise<boolean> {
  try {
    const info = await conn.getAccountInfo(pubkey);
    if (!info) return false;
    // SPL Token or Token-2022 mint is owned by one of these programs
    const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const token2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    const owner = info.owner.toBase58();
    return owner === tokenProgram || owner === token2022;
  } catch {
    return false;
  }
}

async function isValidTokenAccount(conn: Connection, pubkey: PublicKey): Promise<boolean> {
  try {
    const info = await conn.getAccountInfo(pubkey);
    if (!info) return false;
    const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const token2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    const owner = info.owner.toBase58();
    // Token accounts are owned by a token program and have 165 bytes (SPL) or more (Token-2022)
    return (owner === tokenProgram || owner === token2022) && info.data.length >= 165;
  } catch {
    return false;
  }
}

// ── Validators ──

async function validateOrca(conn: Connection, poolAddress: string): Promise<boolean> {
  console.log(`\nOrca Whirlpool: ${poolAddress}`);
  const pubkey = new PublicKey(poolAddress);
  const info = await conn.getAccountInfo(pubkey);

  if (!info) { fail("Account not found"); return false; }
  if (!info.owner.equals(ORCA_WHIRLPOOL_PROGRAM)) {
    fail(`Owner mismatch: ${info.owner.toBase58()} (expected Whirlpool program)`);
    return false;
  }
  ok(`Owner: ${info.owner.toBase58()}`);

  if (info.data.length < ORCA.MIN_SIZE) {
    fail(`Data too small: ${info.data.length} < ${ORCA.MIN_SIZE}`);
    return false;
  }
  ok(`Size: ${info.data.length} bytes (min ${ORCA.MIN_SIZE})`);

  const data = info.data;
  let valid = true;

  const mintA = readPubkey(data, ORCA.MINT_A);
  if (await isValidMint(conn, mintA)) {
    ok(`mint_a @ offset ${ORCA.MINT_A}: ${mintA.toBase58()}`);
  } else {
    fail(`mint_a @ offset ${ORCA.MINT_A}: ${mintA.toBase58()} — NOT a valid mint`);
    valid = false;
  }

  const mintB = readPubkey(data, ORCA.MINT_B);
  if (await isValidMint(conn, mintB)) {
    ok(`mint_b @ offset ${ORCA.MINT_B}: ${mintB.toBase58()}`);
  } else {
    fail(`mint_b @ offset ${ORCA.MINT_B}: ${mintB.toBase58()} — NOT a valid mint`);
    valid = false;
  }

  const vaultA = readPubkey(data, ORCA.VAULT_A);
  if (await isValidTokenAccount(conn, vaultA)) {
    ok(`vault_a @ offset ${ORCA.VAULT_A}: ${vaultA.toBase58()}`);
  } else {
    fail(`vault_a @ offset ${ORCA.VAULT_A}: ${vaultA.toBase58()} — NOT a valid token account`);
    valid = false;
  }

  const vaultB = readPubkey(data, ORCA.VAULT_B);
  if (await isValidTokenAccount(conn, vaultB)) {
    ok(`vault_b @ offset ${ORCA.VAULT_B}: ${vaultB.toBase58()}`);
  } else {
    fail(`vault_b @ offset ${ORCA.VAULT_B}: ${vaultB.toBase58()} — NOT a valid token account`);
    valid = false;
  }

  return valid;
}

async function validateMeteora(conn: Connection, poolAddress: string): Promise<boolean> {
  console.log(`\nMeteora DLMM: ${poolAddress}`);
  const pubkey = new PublicKey(poolAddress);
  const info = await conn.getAccountInfo(pubkey);

  if (!info) { fail("Account not found"); return false; }
  if (!info.owner.equals(METEORA_DLMM_PROGRAM)) {
    fail(`Owner mismatch: ${info.owner.toBase58()} (expected DLMM program)`);
    return false;
  }
  ok(`Owner: ${info.owner.toBase58()}`);

  if (info.data.length < METEORA.MIN_SIZE) {
    fail(`Data too small: ${info.data.length} < ${METEORA.MIN_SIZE}`);
    return false;
  }
  ok(`Size: ${info.data.length} bytes (min ${METEORA.MIN_SIZE})`);

  const data = info.data;
  let valid = true;

  const mintX = readPubkey(data, METEORA.MINT_X);
  if (await isValidMint(conn, mintX)) {
    ok(`mint_x @ offset ${METEORA.MINT_X}: ${mintX.toBase58()}`);
  } else {
    fail(`mint_x @ offset ${METEORA.MINT_X}: ${mintX.toBase58()} — NOT a valid mint`);
    valid = false;
  }

  const mintY = readPubkey(data, METEORA.MINT_Y);
  if (await isValidMint(conn, mintY)) {
    ok(`mint_y @ offset ${METEORA.MINT_Y}: ${mintY.toBase58()}`);
  } else {
    fail(`mint_y @ offset ${METEORA.MINT_Y}: ${mintY.toBase58()} — NOT a valid mint`);
    valid = false;
  }

  const reserveX = readPubkey(data, METEORA.RESERVE_X);
  if (await isValidTokenAccount(conn, reserveX)) {
    ok(`reserve_x @ offset ${METEORA.RESERVE_X}: ${reserveX.toBase58()}`);
  } else {
    fail(`reserve_x @ offset ${METEORA.RESERVE_X}: ${reserveX.toBase58()} — NOT a valid token account`);
    valid = false;
  }

  const reserveY = readPubkey(data, METEORA.RESERVE_Y);
  if (await isValidTokenAccount(conn, reserveY)) {
    ok(`reserve_y @ offset ${METEORA.RESERVE_Y}: ${reserveY.toBase58()}`);
  } else {
    fail(`reserve_y @ offset ${METEORA.RESERVE_Y}: ${reserveY.toBase58()} — NOT a valid token account`);
    valid = false;
  }

  return valid;
}

async function validateRaydium(conn: Connection, poolAddress: string): Promise<boolean> {
  console.log(`\nRaydium AMM: ${poolAddress}`);
  const pubkey = new PublicKey(poolAddress);
  const info = await conn.getAccountInfo(pubkey);

  if (!info) { fail("Account not found"); return false; }
  if (!info.owner.equals(RAYDIUM_AMM_PROGRAM)) {
    fail(`Owner mismatch: ${info.owner.toBase58()} (expected Raydium AMM program)`);
    return false;
  }
  ok(`Owner: ${info.owner.toBase58()}`);

  if (info.data.length < RAYDIUM.MIN_SIZE) {
    fail(`Data too small: ${info.data.length} < ${RAYDIUM.MIN_SIZE}`);
    return false;
  }
  ok(`Size: ${info.data.length} bytes (min ${RAYDIUM.MIN_SIZE})`);

  const data = info.data;
  let valid = true;

  for (const [name, offset] of [["base_mint", RAYDIUM.BASE_MINT], ["quote_mint", RAYDIUM.QUOTE_MINT]] as const) {
    const pk = readPubkey(data, offset);
    if (await isValidMint(conn, pk)) {
      ok(`${name} @ offset ${offset}: ${pk.toBase58()}`);
    } else {
      fail(`${name} @ offset ${offset}: ${pk.toBase58()} — NOT a valid mint`);
      valid = false;
    }
  }

  for (const [name, offset] of [["base_vault", RAYDIUM.BASE_VAULT], ["quote_vault", RAYDIUM.QUOTE_VAULT]] as const) {
    const pk = readPubkey(data, offset);
    if (await isValidTokenAccount(conn, pk)) {
      ok(`${name} @ offset ${offset}: ${pk.toBase58()}`);
    } else {
      fail(`${name} @ offset ${offset}: ${pk.toBase58()} — NOT a valid token account`);
      valid = false;
    }
  }

  return valid;
}

// ── Main ──

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  let orca: string | undefined;
  let meteora: string | undefined;
  let raydium: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--orca": orca = args[++i]; break;
      case "--meteora": meteora = args[++i]; break;
      case "--raydium": raydium = args[++i]; break;
    }
  }

  if (!orca && !meteora && !raydium) {
    console.error("Usage: npx tsx scripts/validate-pool-offsets.ts --orca <pubkey> --meteora <pubkey> --raydium <pubkey>");
    console.error("Provide at least one pool address.");
    process.exit(1);
  }

  const conn = new Connection(RPC_URL, "confirmed");
  console.log(`RPC: ${RPC_URL}\n`);

  let allValid = true;

  if (orca) allValid = (await validateOrca(conn, orca)) && allValid;
  if (meteora) allValid = (await validateMeteora(conn, meteora)) && allValid;
  if (raydium) allValid = (await validateRaydium(conn, raydium)) && allValid;

  console.log(allValid
    ? "\n\x1b[32mAll offsets validated.\x1b[0m"
    : "\n\x1b[31mSome offsets failed validation.\x1b[0m"
  );

  process.exit(allValid ? 0 : 1);
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
