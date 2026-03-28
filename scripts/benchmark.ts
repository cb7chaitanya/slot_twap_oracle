#!/usr/bin/env npx tsx
/**
 * Performance benchmarks for the Slot TWAP Oracle.
 *
 * Measures compute units and latency for on-chain instructions,
 * and response times for the API server.
 *
 * Usage:
 *   npx tsx scripts/benchmark.ts
 *
 * Spins up solana-test-validator automatically.
 */

import { spawn, ChildProcess } from "child_process";
import { AnchorProvider, BN, Wallet } from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, LAMPORTS_PER_SOL,
  sendAndConfirmTransaction, SystemProgram, Transaction,
} from "@solana/web3.js";
import {
  createInitializeMint2Instruction, getMintLen,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { SlotTwapOracleClient, PROGRAM_ID } from "@slot-twap-oracle/sdk";
import http from "http";

const RPC_URL = "http://127.0.0.1:8899";
const PROGRAM_SO = "target/deploy/slot_twap_oracle.so";

interface BenchResult {
  name: string;
  iterations: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  avgCU?: number;
}

const results: BenchResult[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForValidator(conn: Connection): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    try { await conn.getSlot(); return; } catch { await sleep(500); }
  }
  throw new Error("Validator timeout");
}

async function waitForNextSlot(conn: Connection): Promise<void> {
  const current = await conn.getSlot();
  while ((await conn.getSlot()) <= current) await sleep(100);
}

async function airdrop(conn: Connection, pk: PublicKey, sol: number): Promise<void> {
  const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
}

async function createMint(conn: Connection, payer: Keypair): Promise<PublicKey> {
  const mint = Keypair.generate();
  const space = getMintLen([]);
  const rent = await conn.getMinimumBalanceForRentExemption(space);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey,
      space, lamports: rent, programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(mint.publicKey, 6, payer.publicKey, null, TOKEN_2022_PROGRAM_ID)
  );
  await sendAndConfirmTransaction(conn, tx, [payer, mint]);
  return mint.publicKey;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

function summarize(name: string, times: number[], cus?: number[]): BenchResult {
  const sorted = [...times].sort((a, b) => a - b);
  const result: BenchResult = {
    name,
    iterations: times.length,
    avgMs: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
  };
  if (cus && cus.length > 0) {
    result.avgCU = Math.round(cus.reduce((a, b) => a + b, 0) / cus.length);
  }
  results.push(result);
  return result;
}

function printResult(r: BenchResult): void {
  console.log(`  ${r.name}:`);
  console.log(`    iterations: ${r.iterations}`);
  console.log(`    avg: ${r.avgMs}ms, min: ${r.minMs}ms, max: ${r.maxMs}ms`);
  console.log(`    p50: ${r.p50Ms}ms, p95: ${r.p95Ms}ms`);
  if (r.avgCU) console.log(`    compute units: ~${r.avgCU} CU`);
}

async function run(): Promise<void> {
  console.log("\n=== Slot TWAP Oracle — Performance Benchmarks ===\n");

  // Start validator
  console.log("Starting validator...");
  const validator = spawn("solana-test-validator", [
    "--bpf-program", PROGRAM_ID.toBase58(), PROGRAM_SO, "--reset", "--quiet",
  ], { stdio: "ignore" });

  const conn = new Connection(RPC_URL, "confirmed");
  await waitForValidator(conn);

  const payer = Keypair.generate();
  await airdrop(conn, payer.publicKey, 20);
  const provider = new AnchorProvider(conn, new Wallet(payer), { commitment: "confirmed" });
  const client = new SlotTwapOracleClient(provider);

  const baseMint = await createMint(conn, payer);
  const quoteMint = await createMint(conn, payer);

  // ── Benchmark: initialize_oracle ──
  console.log("Benchmarking initialize_oracle...");
  {
    const times: number[] = [];
    // Can only init once per pair, so create multiple pairs
    for (let i = 0; i < 5; i++) {
      const bm = await createMint(conn, payer);
      const qm = await createMint(conn, payer);
      const start = Date.now();
      await client.initializeOracle(bm, qm, 32, payer);
      times.push(Date.now() - start);
    }
    printResult(summarize("initialize_oracle", times));
  }

  // Init the main oracle for subsequent benchmarks
  await client.initializeOracle(baseMint, quoteMint, 64, payer);
  const [oraclePda] = client.findOraclePda(baseMint, quoteMint);

  // ── Benchmark: update_price ──
  // Use raw instruction to pass optional account placeholders (SDK doesn't yet)
  console.log("\nBenchmarking update_price (20 iterations)...");
  {
    const times: number[] = [];
    const cus: number[] = [];
    let price = 1_000_000_000;
    const [obsBuf] = client.findObservationBufferPda(oraclePda);
    const pid = PROGRAM_ID;

    for (let i = 0; i < 20; i++) {
      await waitForNextSlot(conn);
      price += (i % 2 === 0 ? 50_000_000 : -50_000_000);
      const data = client.program.coder.instruction.encode("updatePrice", { newPrice: new BN(price) });
      const ix = {
        programId: pid,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          { pubkey: oraclePda, isSigner: false, isWritable: true },
          { pubkey: obsBuf, isSigner: false, isWritable: true },
          { pubkey: pid, isSigner: false, isWritable: false }, // reward_vault (None)
          { pubkey: pid, isSigner: false, isWritable: false }, // vault_token_account (None)
          { pubkey: pid, isSigner: false, isWritable: false }, // reward_mint (None)
          { pubkey: pid, isSigner: false, isWritable: false }, // previous_updater_token_account (None)
          { pubkey: pid, isSigner: false, isWritable: false }, // token_program (None)
        ],
        data,
      };
      const tx = new Transaction().add(ix);
      const start = Date.now();
      const sig = await sendAndConfirmTransaction(conn, tx, [payer]);
      times.push(Date.now() - start);

      await sleep(300);
      const txMeta = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
      if (txMeta?.meta?.computeUnitsConsumed) {
        cus.push(Number(txMeta.meta.computeUnitsConsumed));
      }
    }
    printResult(summarize("update_price", times, cus));
  }

  // ── Benchmark: get_swap (via simulate) ──
  console.log("\nBenchmarking get_swap simulate (10 iterations)...");
  {
    const times: number[] = [];
    const cus: number[] = [];
    const [bufferPda] = client.findObservationBufferPda(oraclePda);
    for (let i = 0; i < 10; i++) {
      const start = Date.now();
      try {
        const result = await client.program.methods
          .getSwap(new BN(5), new BN(1_000_000))
          .accounts({ oracle: oraclePda, observationBuffer: bufferPda })
          .simulate();
        times.push(Date.now() - start);
        if ((result as any).raw?.meta?.computeUnitsConsumed) {
          cus.push(Number((result as any).raw.meta.computeUnitsConsumed));
        }
      } catch {
        times.push(Date.now() - start);
      }
    }
    printResult(summarize("get_swap (simulate)", times, cus));
  }

  // ── Benchmark: computeSwapFromChain (off-chain) ──
  console.log("\nBenchmarking computeSwapFromChain (10 iterations)...");
  {
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const start = Date.now();
      await client.computeSwapFromChain(baseMint, quoteMint, 5);
      times.push(Date.now() - start);
    }
    printResult(summarize("computeSwapFromChain (off-chain)", times));
  }

  // ── Benchmark: fetchOracle ──
  console.log("\nBenchmarking fetchOracle (20 iterations)...");
  {
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = Date.now();
      await client.fetchOracle(oraclePda);
      times.push(Date.now() - start);
    }
    printResult(summarize("fetchOracle", times));
  }

  // ── Benchmark: parseOracleUpdateEvents ──
  console.log("\nBenchmarking parseOracleUpdateEvents (10 iterations)...");
  {
    // Use last tx sig from update_price benchmark
    await waitForNextSlot(conn);
    const data2 = client.program.coder.instruction.encode("updatePrice", { newPrice: new BN(1_000_000_000) });
    const [obsBuf2] = client.findObservationBufferPda(oraclePda);
    const pid2 = PROGRAM_ID;
    const ix2 = {
      programId: pid2,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: oraclePda, isSigner: false, isWritable: true },
        { pubkey: obsBuf2, isSigner: false, isWritable: true },
        { pubkey: pid2, isSigner: false, isWritable: false },
        { pubkey: pid2, isSigner: false, isWritable: false },
        { pubkey: pid2, isSigner: false, isWritable: false },
        { pubkey: pid2, isSigner: false, isWritable: false },
        { pubkey: pid2, isSigner: false, isWritable: false },
      ],
      data: data2,
    };
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix2), [payer]);
    await sleep(1000);
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const start = Date.now();
      await client.parseOracleUpdateEvents(sig);
      times.push(Date.now() - start);
    }
    printResult(summarize("parseOracleUpdateEvents", times));
  }

  // ── Generate report ──
  validator.kill("SIGTERM");

  console.log("\n\n=== BENCHMARK RESULTS ===\n");
  console.log("| Benchmark | Iterations | Avg (ms) | p50 (ms) | p95 (ms) | Min (ms) | Max (ms) | Avg CU |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    console.log(
      `| ${r.name} | ${r.iterations} | ${r.avgMs} | ${r.p50Ms} | ${r.p95Ms} | ${r.minMs} | ${r.maxMs} | ${r.avgCU ?? "—"} |`
    );
  }

  // Write markdown
  const fs = await import("fs");
  const lines = [
    "# Slot TWAP Oracle — Performance Benchmarks",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Environment: solana-test-validator (localhost)`,
    "",
    "## Results",
    "",
    "| Benchmark | Iterations | Avg (ms) | p50 (ms) | p95 (ms) | Min (ms) | Max (ms) | Avg CU |",
    "|---|---|---|---|---|---|---|---|",
    ...results.map((r) =>
      `| ${r.name} | ${r.iterations} | ${r.avgMs} | ${r.p50Ms} | ${r.p95Ms} | ${r.minMs} | ${r.maxMs} | ${r.avgCU ?? "—"} |`
    ),
    "",
    "## Notes",
    "",
    "- All benchmarks run against local solana-test-validator (not representative of mainnet latency)",
    "- Compute units measured from confirmed transaction metadata",
    "- update_price oscillates ±5% to stay within deviation guard",
    "- get_swap uses simulate (not view) due to WS limitation in test-validator",
    "- Off-chain computeSwapFromChain includes 3 RPC calls (oracle + buffer + slot)",
    "",
  ];
  fs.writeFileSync("docs/benchmark.md", lines.join("\n"));
  console.log("\nResults written to docs/benchmark.md");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
