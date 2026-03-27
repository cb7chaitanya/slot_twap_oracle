import { spawn, ChildProcess } from "child_process";
import { expect } from "chai";
import { AnchorProvider, BN, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createInitializeMint2Instruction,
  getMintLen,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  SlotTwapOracleClient,
  PROGRAM_ID,
  OracleUpdateEvent,
} from "@slot-twap-oracle/sdk";

const RPC_URL = "http://127.0.0.1:8899";
const PROGRAM_SO = "target/deploy/slot_twap_oracle.so";

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForNextSlot(conn: Connection): Promise<void> {
  const current = await conn.getSlot();
  while ((await conn.getSlot()) <= current) {
    await sleep(200);
  }
}

async function waitForValidator(conn: Connection, maxWait = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      await conn.getSlot();
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error("Validator did not start in time");
}

async function airdrop(conn: Connection, pubkey: PublicKey, sol: number): Promise<void> {
  const sig = await conn.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
}

async function createMint(conn: Connection, payer: Keypair): Promise<PublicKey> {
  const mint = Keypair.generate();
  const space = getMintLen([]);
  const rent = await conn.getMinimumBalanceForRentExemption(space);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space,
      lamports: rent,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(
      mint.publicKey, 6, payer.publicKey, null, TOKEN_2022_PROGRAM_ID
    )
  );

  await sendAndConfirmTransaction(conn, tx, [payer, mint]);
  return mint.publicKey;
}

// ── Test suite ──

describe("Slot TWAP Oracle SDK", function () {
  this.timeout(120_000);

  let validator: ChildProcess;
  let conn: Connection;
  let payer: Keypair;
  let client: SlotTwapOracleClient;
  let baseMint: PublicKey;
  let quoteMint: PublicKey;
  let oraclePda: PublicKey;

  before(async () => {
    validator = spawn("solana-test-validator", [
      "--bpf-program", PROGRAM_ID.toBase58(), PROGRAM_SO,
      "--reset",
      "--quiet",
    ], { stdio: "ignore" });

    conn = new Connection(RPC_URL, "confirmed");
    await waitForValidator(conn);

    payer = Keypair.generate();
    await airdrop(conn, payer.publicKey, 20);

    const provider = new AnchorProvider(conn, new Wallet(payer), { commitment: "confirmed" });
    client = new SlotTwapOracleClient(provider);

    baseMint = await createMint(conn, payer);
    quoteMint = await createMint(conn, payer);
  });

  after(() => {
    if (validator) validator.kill("SIGTERM");
  });

  // ── initializeOracle ──

  describe("initializeOracle", () => {
    it("creates oracle and observation buffer", async () => {
      const sig = await client.initializeOracle(baseMint, quoteMint, 32, payer);
      expect(sig).to.be.a("string");

      [oraclePda] = client.findOraclePda(baseMint, quoteMint);
      const oracle = await client.fetchOracle(oraclePda);

      expect(oracle.baseMint.toBase58()).to.equal(baseMint.toBase58());
      expect(oracle.quoteMint.toBase58()).to.equal(quoteMint.toBase58());
      expect(oracle.lastPrice.toNumber()).to.equal(0);
      expect(oracle.cumulativePrice.toNumber()).to.equal(0);
      expect(oracle.owner.toBase58()).to.equal(payer.publicKey.toBase58());
      expect(oracle.paused).to.equal(false);
      expect(oracle.maxDeviationBps).to.equal(1000);

      const [bufferPda] = client.findObservationBufferPda(oraclePda);
      const buffer = await client.fetchObservationBuffer(bufferPda);

      expect(buffer.capacity).to.equal(32);
      expect(buffer.len).to.equal(0);
      expect(buffer.observations).to.have.lengthOf(32); // pre-allocated
    });

    it("rejects duplicate initialization", async () => {
      try {
        await client.initializeOracle(baseMint, quoteMint, 32, payer);
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as Error).message).to.include("already in use");
      }
    });
  });

  // ── updatePrice ──

  describe("updatePrice", () => {
    it("updates price and tracks cumulative", async () => {
      await waitForNextSlot(conn);
      const sig = await client.updatePrice(oraclePda, new BN(1_000_000_000), payer);
      expect(sig).to.be.a("string");

      const oracle = await client.fetchOracle(oraclePda);
      expect(oracle.lastPrice.toNumber()).to.equal(1_000_000_000);
      expect(oracle.lastUpdater.toBase58()).to.equal(payer.publicKey.toBase58());
    });

    it("allows a different signer (permissionless)", async () => {
      const otherPayer = Keypair.generate();
      await airdrop(conn, otherPayer.publicKey, 2);

      await waitForNextSlot(conn);
      const sig = await client.updatePrice(oraclePda, new BN(1_050_000_000), otherPayer);
      expect(sig).to.be.a("string");

      const oracle = await client.fetchOracle(oraclePda);
      expect(oracle.lastPrice.toNumber()).to.equal(1_050_000_000);
      expect(oracle.lastUpdater.toBase58()).to.equal(otherPayer.publicKey.toBase58());
    });

    it("rejects stale slot (same slot update)", async () => {
      // Don't advance slot — should fail with StaleSlot
      try {
        await client.updatePrice(oraclePda, new BN(1_060_000_000), payer);
        expect.fail("Should have thrown StaleSlot");
      } catch (err) {
        expect((err as Error).message).to.include("StaleSlot");
      }
    });

    it("rejects price deviation beyond threshold", async () => {
      await waitForNextSlot(conn);
      // Current price is ~1.05B, try 2B (>10% deviation)
      try {
        await client.updatePrice(oraclePda, new BN(2_000_000_000), payer);
        expect.fail("Should have thrown PriceDeviationTooLarge");
      } catch (err) {
        expect((err as Error).message).to.include("PriceDeviationTooLarge");
      }
    });

    it("rejects update when paused", async () => {
      await client.setPaused(oraclePda, true, payer);

      await waitForNextSlot(conn);
      try {
        await client.updatePrice(oraclePda, new BN(1_060_000_000), payer);
        expect.fail("Should have thrown OraclePaused");
      } catch (err) {
        expect((err as Error).message).to.include("OraclePaused");
      }

      // Unpause for subsequent tests
      await client.setPaused(oraclePda, false, payer);
    });
  });

  // ── getSwap / computeSwapFromChain ──

  describe("getSwap", () => {
    it("computes TWAP off-chain from observations", async () => {
      // Add a few more price updates to build history
      await waitForNextSlot(conn);
      await client.updatePrice(oraclePda, new BN(1_100_000_000), payer);
      await waitForNextSlot(conn);
      await client.updatePrice(oraclePda, new BN(1_050_000_000), payer);

      const [bufferPda] = client.findObservationBufferPda(oraclePda);
      const buffer = await client.fetchObservationBuffer(bufferPda);
      expect(buffer.observations.length).to.be.greaterThanOrEqual(3);

      // Use a small window that fits within our observation history
      const firstObs = buffer.observations[0];
      const currentSlot = await conn.getSlot();
      const window = currentSlot - firstObs.slot.toNumber() - 1;

      if (window > 0) {
        const twap = await client.computeSwapFromChain(baseMint, quoteMint, window);
        expect(twap.toNumber()).to.be.greaterThan(0);
      }
    });

    it("throws on insufficient history", async () => {
      // Create a fresh oracle with no observations, then try to query
      const freshBase = await createMint(conn, payer);
      const freshQuote = await createMint(conn, payer);
      await client.initializeOracle(freshBase, freshQuote, 8, payer);

      try {
        await client.computeSwapFromChain(freshBase, freshQuote, 100);
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as Error).message).to.include("Insufficient observations");
      }
    });

    it("rejects via simulate when oracle is stale beyond threshold", async () => {
      // Use the program's get_swap with max_staleness=1 after advancing slots
      await waitForNextSlot(conn);
      await waitForNextSlot(conn);

      const [bufferPda] = client.findObservationBufferPda(oraclePda);
      try {
        await client.program.methods
          .getSwap(new BN(3), new BN(1))
          .accounts({ oracle: oraclePda, observationBuffer: bufferPda })
          .rpc();
        expect.fail("Should have thrown StaleOracle");
      } catch (err) {
        expect((err as Error).message).to.include("StaleOracle");
      }
    });

    it("rejects get_swap when paused", async () => {
      await client.setPaused(oraclePda, true, payer);

      const [bufferPda] = client.findObservationBufferPda(oraclePda);
      try {
        await client.program.methods
          .getSwap(new BN(3), new BN(1000))
          .accounts({ oracle: oraclePda, observationBuffer: bufferPda })
          .rpc();
        expect.fail("Should have thrown OraclePaused");
      } catch (err) {
        expect((err as Error).message).to.include("OraclePaused");
      }

      await client.setPaused(oraclePda, false, payer);
    });
  });

  // ── parseOracleUpdateEvents ──

  describe("parseOracleUpdateEvents", () => {
    it("parses event from a real transaction", async () => {
      await waitForNextSlot(conn);
      const sig = await client.updatePrice(oraclePda, new BN(1_000_000_000), payer);

      // Wait for tx to be confirmed and available
      await sleep(1000);

      const events = await client.parseOracleUpdateEvents(sig);
      expect(events).to.have.lengthOf(1);

      const e = events[0];
      expect(e.oracle.toBase58()).to.equal(oraclePda.toBase58());
      expect(e.price.toNumber()).to.equal(1_000_000_000);
      expect(e.slot.toNumber()).to.be.greaterThan(0);
      expect(e.updater.toBase58()).to.equal(payer.publicKey.toBase58());
      expect(e.cumulativePrice.toNumber()).to.be.greaterThanOrEqual(0);
    });

    it("returns empty for non-oracle transaction", async () => {
      // A plain SOL transfer has no oracle events
      const other = Keypair.generate();
      await airdrop(conn, other.publicKey, 1);

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: other.publicKey,
          lamports: 1000,
        })
      );
      const sig = await sendAndConfirmTransaction(conn, tx, [payer]);
      await sleep(1000);

      const events = await client.parseOracleUpdateEvents(sig);
      expect(events).to.have.lengthOf(0);
    });
  });

  // ── decodeOracleUpdateLogs (pure unit tests, no validator needed) ──

  describe("decodeOracleUpdateLogs", () => {
    it("decodes a valid event log line", () => {
      // Build a synthetic event payload:
      // discriminator (8) + oracle (32) + price (16) + cumulative_price (16) + slot (8) + updater (32)
      const discriminator = Buffer.from([237, 176, 133, 150, 0, 131, 48, 15]);
      const oracleKey = Keypair.generate().publicKey;
      const updaterKey = Keypair.generate().publicKey;

      const payload = Buffer.alloc(104);
      oracleKey.toBuffer().copy(payload, 0);
      // price = 42 as u128 LE
      const priceBuf = Buffer.alloc(16);
      priceBuf.writeUInt32LE(42, 0);
      priceBuf.copy(payload, 32);
      // cumulative_price = 100 as u128 LE
      const cumulBuf = Buffer.alloc(16);
      cumulBuf.writeUInt32LE(100, 0);
      cumulBuf.copy(payload, 48);
      // slot = 99 as u64 LE
      const slotBuf = Buffer.alloc(8);
      slotBuf.writeUInt32LE(99, 0);
      slotBuf.copy(payload, 64);
      updaterKey.toBuffer().copy(payload, 72);

      const full = Buffer.concat([discriminator, payload]);
      const b64 = full.toString("base64");

      const logs = [
        "Program 7LKj9Yk62ddRjtTHvvV6fmquD9h7XbcvKKa7yGtocdsT invoke [1]",
        `Program data: ${b64}`,
        "Program 7LKj9Yk62ddRjtTHvvV6fmquD9h7XbcvKKa7yGtocdsT success",
      ];

      const events = SlotTwapOracleClient.decodeOracleUpdateLogs(logs);
      expect(events).to.have.lengthOf(1);
      expect(events[0].oracle.toBase58()).to.equal(oracleKey.toBase58());
      expect(events[0].price.toNumber()).to.equal(42);
      expect(events[0].cumulativePrice.toNumber()).to.equal(100);
      expect(events[0].slot.toNumber()).to.equal(99);
      expect(events[0].updater.toBase58()).to.equal(updaterKey.toBase58());
    });

    it("ignores non-event log lines", () => {
      const logs = [
        "Program 7LKj invoke [1]",
        "Program log: Instruction: UpdatePrice",
        "Program 7LKj success",
      ];
      const events = SlotTwapOracleClient.decodeOracleUpdateLogs(logs);
      expect(events).to.have.lengthOf(0);
    });

    it("ignores events with wrong discriminator", () => {
      const wrongDisc = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]);
      const payload = Buffer.alloc(104);
      const full = Buffer.concat([wrongDisc, payload]);
      const logs = [`Program data: ${full.toString("base64")}`];

      const events = SlotTwapOracleClient.decodeOracleUpdateLogs(logs);
      expect(events).to.have.lengthOf(0);
    });

    it("ignores truncated payloads", () => {
      const discriminator = Buffer.from([237, 176, 133, 150, 0, 131, 48, 15]);
      const short = Buffer.alloc(20); // too short
      const full = Buffer.concat([discriminator, short]);
      const logs = [`Program data: ${full.toString("base64")}`];

      const events = SlotTwapOracleClient.decodeOracleUpdateLogs(logs);
      expect(events).to.have.lengthOf(0);
    });

    it("handles empty log array", () => {
      const events = SlotTwapOracleClient.decodeOracleUpdateLogs([]);
      expect(events).to.have.lengthOf(0);
    });
  });
});
