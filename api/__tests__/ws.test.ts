import http from "http";
import WebSocket from "ws";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

const ORACLE_PUBKEY = Keypair.generate().publicKey;
const ORACLE_STR = ORACLE_PUBKEY.toBase58();
const BASE_MINT = Keypair.generate().publicKey;
const QUOTE_MINT = Keypair.generate().publicKey;
const UPDATER = Keypair.generate().publicKey;
const OWNER = Keypair.generate().publicKey;

const mockFetchOracle = jest.fn();
const mockComputeSwapFromChain = jest.fn();
const mockGetSlot = jest.fn();

jest.mock("../src/client", () => ({
  client: {
    fetchOracle: mockFetchOracle,
    computeSwapFromChain: mockComputeSwapFromChain,
    getOracleUpdates: jest.fn().mockResolvedValue([]),
  },
  connection: {
    getSlot: mockGetSlot,
  },
}));

import app from "../src/app";
import { attachWebSocket, stopBroadcast } from "../src/ws";

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once("close", resolve);
  });
}

async function closeAndWait(ws: WebSocket): Promise<void> {
  ws.close();
  await waitForClose(ws);
}

describe("WebSocket /ws", () => {
  let server: http.Server;
  let port: number;

  beforeAll((done) => {
    server = http.createServer(app);
    attachWebSocket(server);
    server.listen(0, () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterAll((done) => {
    stopBroadcast();
    server.close(done);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchOracle.mockResolvedValue({
      owner: OWNER,
      baseMint: BASE_MINT,
      quoteMint: QUOTE_MINT,
      lastPrice: new BN(1_000_000_000),
      cumulativePrice: new BN(50_000_000_000),
      lastSlot: new BN(100),
      lastUpdater: UPDATER,
      paused: false,
      maxDeviationBps: 1000,
    });
    mockComputeSwapFromChain.mockResolvedValue(new BN(1_050_000_000));
    mockGetSlot.mockResolvedValue(120);
  });

  it("sends connected message on open", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const msg = await waitForMessage(ws);

    expect(msg.type).toBe("connected");
    await closeAndWait(ws);
  });

  it("subscribes and receives confirmation", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForMessage(ws); // connected

    ws.send(JSON.stringify({ action: "subscribe", oracle: ORACLE_STR, window: 50 }));
    const msg = await waitForMessage(ws);

    expect(msg.type).toBe("subscribed");
    expect(msg.oracle).toBe(ORACLE_STR);
    expect(msg.window).toBe(50);
    await closeAndWait(ws);
  });

  it("rejects subscribe with missing params", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForMessage(ws);

    ws.send(JSON.stringify({ action: "subscribe", oracle: ORACLE_STR }));
    const msg = await waitForMessage(ws);

    expect(msg.error).toContain("requires oracle and window");
    await closeAndWait(ws);
  });

  it("rejects invalid pubkey", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForMessage(ws);

    ws.send(JSON.stringify({ action: "subscribe", oracle: "bad", window: 50 }));
    const msg = await waitForMessage(ws);

    expect(msg.error).toContain("Invalid oracle pubkey");
    await closeAndWait(ws);
  });

  it("rejects invalid window", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForMessage(ws);

    ws.send(JSON.stringify({ action: "subscribe", oracle: ORACLE_STR, window: -1 }));
    const msg = await waitForMessage(ws);

    expect(msg.error).toContain("positive integer");
    await closeAndWait(ws);
  });

  it("rejects invalid JSON", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForMessage(ws);

    ws.send("not json");
    const msg = await waitForMessage(ws);

    expect(msg.error).toBe("Invalid JSON");
    await closeAndWait(ws);
  });

  it("rejects unknown action", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForMessage(ws);

    ws.send(JSON.stringify({ action: "foo" }));
    const msg = await waitForMessage(ws);

    expect(msg.error).toContain("Unknown action");
    await closeAndWait(ws);
  });

  it("receives broadcast update after subscribe", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForMessage(ws); // connected

    ws.send(JSON.stringify({ action: "subscribe", oracle: ORACLE_STR, window: 50 }));
    await waitForMessage(ws); // subscribed

    // Wait for a broadcast cycle (poll interval is 2s)
    const update = await waitForMessage(ws);

    expect(update.type).toBe("update");
    expect(update.oracle).toBe(ORACLE_STR);
    expect(update.window).toBe(50);
    expect(update.twap).toBe("1050000000");
    expect(update.price).toBe("1000000000");
    expect(update.currentSlot).toBe(120);
    expect(update.timestamp).toBeDefined();
    await closeAndWait(ws);
  }, 10_000);

  it("unsubscribes and stops receiving", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForMessage(ws); // connected

    ws.send(JSON.stringify({ action: "subscribe", oracle: ORACLE_STR, window: 50 }));
    await waitForMessage(ws); // subscribed

    ws.send(JSON.stringify({ action: "unsubscribe", oracle: ORACLE_STR, window: 50 }));
    const msg = await waitForMessage(ws);

    expect(msg.type).toBe("unsubscribed");
    await closeAndWait(ws);
  });
});
