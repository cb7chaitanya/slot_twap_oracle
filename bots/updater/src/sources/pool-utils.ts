import { Connection, PublicKey, AccountInfo } from "@solana/web3.js";
import BN from "bn.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

export function readPubkey(data: Buffer, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}

export function readU128LE(data: Buffer, offset: number): BN {
  return new BN(data.subarray(offset, offset + 16), "le");
}

export function readU64LE(data: Buffer, offset: number): BN {
  return new BN(data.subarray(offset, offset + 8), "le");
}

export function readI32LE(data: Buffer, offset: number): number {
  return data.readInt32LE(offset);
}

export function validatePoolAccount(
  info: AccountInfo<Buffer> | null,
  poolAddress: PublicKey,
  expectedOwner: PublicKey,
  minSize: number,
  dexName: string
): Buffer {
  if (!info) {
    throw new Error(`${dexName}: account not found: ${poolAddress.toBase58()}`);
  }
  if (!info.owner.equals(expectedOwner)) {
    throw new Error(
      `${dexName}: account ${poolAddress.toBase58()} owner mismatch: ` +
        `expected ${expectedOwner.toBase58()}, got ${info.owner.toBase58()}`
    );
  }
  if (info.data.length < minSize) {
    throw new Error(
      `${dexName}: account data too small: ${info.data.length} < ${minSize}`
    );
  }
  return info.data;
}

export function matchMints(
  poolMintA: PublicKey,
  poolMintB: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  dexName: string
): "forward" | "reversed" {
  if (poolMintA.equals(baseMint) && poolMintB.equals(quoteMint)) return "forward";
  if (poolMintA.equals(quoteMint) && poolMintB.equals(baseMint)) return "reversed";
  throw new Error(
    `${dexName}: pool mints (${poolMintA.toBase58()}, ${poolMintB.toBase58()}) ` +
      `do not match oracle mints (${baseMint.toBase58()}, ${quoteMint.toBase58()})`
  );
}

export async function fetchVaultBalances(
  connection: Connection,
  vaultA: PublicKey,
  vaultB: PublicKey,
  dexName: string
): Promise<{ amountA: BN; amountB: BN }> {
  const [balA, balB] = await Promise.all([
    connection.getTokenAccountBalance(vaultA).catch(() => null),
    connection.getTokenAccountBalance(vaultB).catch(() => null),
  ]);

  if (!balA || !balB) {
    throw new Error(
      `${dexName}: vault account(s) not found or closed ` +
        `(${vaultA.toBase58().slice(0, 8)}..., ${vaultB.toBase58().slice(0, 8)}...)`
    );
  }

  return {
    amountA: new BN(balA.value.amount),
    amountB: new BN(balB.value.amount),
  };
}

export function computePriceFromBalances(
  numerator: BN,
  denominator: BN,
  dexName: string
): number {
  if (denominator.isZero()) {
    throw new Error(`${dexName}: denominator reserve is zero`);
  }
  const SCALE = new BN(10).pow(new BN(18));
  const scaled = numerator.mul(SCALE).div(denominator);
  return Number(scaled.toString()) / 1e18;
}
