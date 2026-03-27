import request from "supertest";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

// Mock the SDK client and connection before importing the app
const mockFetchOracle = jest.fn();
const mockComputeSwapFromChain = jest.fn();
const mockGetOracleUpdates = jest.fn();
const mockGetSlot = jest.fn();

jest.mock("../src/client", () => ({
  client: {
    fetchOracle: mockFetchOracle,
    computeSwapFromChain: mockComputeSwapFromChain,
    getOracleUpdates: mockGetOracleUpdates,
  },
  connection: {
    getSlot: mockGetSlot,
  },
}));

import app from "../src/app";

// ── Fixtures ──

const ORACLE_PUBKEY = Keypair.generate().publicKey;
const ORACLE_STR = ORACLE_PUBKEY.toBase58();
const BASE_MINT = Keypair.generate().publicKey;
const QUOTE_MINT = Keypair.generate().publicKey;
const UPDATER = Keypair.generate().publicKey;
const OWNER = Keypair.generate().publicKey;

const mockOracleAccount = {
  owner: OWNER,
  baseMint: BASE_MINT,
  quoteMint: QUOTE_MINT,
  lastPrice: new BN(1_000_000_000),
  cumulativePrice: new BN(50_000_000_000),
  lastSlot: new BN(100),
  lastUpdater: UPDATER,
  paused: false,
  maxDeviationBps: 1000,
};

// ── Tests ──

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /health", () => {
  it("returns ok when RPC is reachable", async () => {
    mockGetSlot.mockResolvedValue(200);

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", slot: 200 });
  });

  it("returns 503 when RPC is down", async () => {
    mockGetSlot.mockRejectedValue(new Error("fetch failed"));

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unhealthy");
    expect(res.body.error).toContain("fetch failed");
  });
});

describe("GET /price", () => {
  it("returns oracle state", async () => {
    mockFetchOracle.mockResolvedValue(mockOracleAccount);
    mockGetSlot.mockResolvedValue(120);

    const res = await request(app).get(`/price?oracle=${ORACLE_STR}`);

    expect(res.status).toBe(200);
    expect(res.body.oracle).toBe(ORACLE_STR);
    expect(res.body.price).toBe("1000000000");
    expect(res.body.cumulativePrice).toBe("50000000000");
    expect(res.body.slot).toBe("100");
    expect(res.body.baseMint).toBe(BASE_MINT.toBase58());
    expect(res.body.quoteMint).toBe(QUOTE_MINT.toBase58());
    expect(res.body.updater).toBe(UPDATER.toBase58());
    expect(res.body.owner).toBe(OWNER.toBase58());
    expect(res.body.paused).toBe(false);
    expect(res.body.maxDeviationBps).toBe(1000);
    expect(res.body.currentSlot).toBe(120);
    expect(res.body.slotsSinceUpdate).toBe(20);
  });

  it("returns 400 when oracle param is missing", async () => {
    const res = await request(app).get("/price");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
  });

  it("returns 400 for invalid pubkey", async () => {
    const res = await request(app).get("/price?oracle=not-a-pubkey");

    expect(res.status).toBe(400);
    expect(res.body.details[0].message).toContain("Invalid Solana pubkey");
  });

  it("returns 500 when fetchOracle fails", async () => {
    mockFetchOracle.mockRejectedValue(new Error("Account not found"));
    mockGetSlot.mockResolvedValue(120);

    const res = await request(app).get(`/price?oracle=${ORACLE_STR}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Account not found");
  });
});

describe("GET /twap", () => {
  it("returns TWAP for valid params", async () => {
    mockFetchOracle.mockResolvedValue(mockOracleAccount);
    mockComputeSwapFromChain.mockResolvedValue(new BN(1_050_000_000));
    mockGetSlot.mockResolvedValue(150);

    const res = await request(app).get(`/twap?oracle=${ORACLE_STR}&window=50`);

    expect(res.status).toBe(200);
    expect(res.body.oracle).toBe(ORACLE_STR);
    expect(res.body.twap).toBe("1050000000");
    expect(res.body.windowSlots).toBe(50);
    expect(res.body.currentSlot).toBe(150);
  });

  it("returns 400 when window is missing", async () => {
    const res = await request(app).get(`/twap?oracle=${ORACLE_STR}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
  });

  it("returns 400 for negative window", async () => {
    const res = await request(app).get(`/twap?oracle=${ORACLE_STR}&window=-5`);

    expect(res.status).toBe(400);
  });

  it("returns 422 for insufficient history", async () => {
    mockFetchOracle.mockResolvedValue(mockOracleAccount);
    mockComputeSwapFromChain.mockRejectedValue(
      new Error("Insufficient observations for the requested window")
    );

    const res = await request(app).get(`/twap?oracle=${ORACLE_STR}&window=10000`);

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Insufficient");
  });
});

describe("GET /history", () => {
  const mockEvent = {
    oracle: ORACLE_PUBKEY,
    price: new BN(1_000_000_000),
    cumulativePrice: new BN(50_000_000_000),
    slot: new BN(100),
    updater: UPDATER,
  };

  it("returns events for valid oracle", async () => {
    mockGetOracleUpdates.mockResolvedValue([mockEvent]);

    const res = await request(app).get(`/history?oracle=${ORACLE_STR}`);

    expect(res.status).toBe(200);
    expect(res.body.oracle).toBe(ORACLE_STR);
    expect(res.body.count).toBe(1);
    expect(res.body.updates).toHaveLength(1);
    expect(res.body.updates[0].price).toBe("1000000000");
    expect(res.body.updates[0].slot).toBe("100");
    expect(res.body.updates[0].updater).toBe(UPDATER.toBase58());
  });

  it("returns empty array when no events", async () => {
    mockGetOracleUpdates.mockResolvedValue([]);

    const res = await request(app).get(`/history?oracle=${ORACLE_STR}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.updates).toHaveLength(0);
  });

  it("uses default limit of 20", async () => {
    mockGetOracleUpdates.mockResolvedValue([]);

    await request(app).get(`/history?oracle=${ORACLE_STR}`);

    expect(mockGetOracleUpdates).toHaveBeenCalledWith(
      expect.any(PublicKey),
      20
    );
  });

  it("respects custom limit", async () => {
    mockGetOracleUpdates.mockResolvedValue([]);

    await request(app).get(`/history?oracle=${ORACLE_STR}&limit=5`);

    expect(mockGetOracleUpdates).toHaveBeenCalledWith(
      expect.any(PublicKey),
      5
    );
  });

  it("returns 400 when limit exceeds 100", async () => {
    const res = await request(app).get(`/history?oracle=${ORACLE_STR}&limit=101`);

    expect(res.status).toBe(400);
  });

  it("returns 400 when oracle is missing", async () => {
    const res = await request(app).get("/history");

    expect(res.status).toBe(400);
  });
});
