import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

const RAYDIUM_AMM_PROGRAM_ID = new PublicKey(
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
);

// Raydium AMM v4 account layout offsets for token vault pubkeys.
// The full layout is 752 bytes; we only need the two vault addresses.
const AMM_ACCOUNT_MIN_SIZE = 752;
const BASE_VAULT_OFFSET = 336;
const QUOTE_VAULT_OFFSET = 368;

/**
 * Reads the base and quote token vault addresses from a Raydium AMM account,
 * fetches their token balances, and computes price = quote / base.
 *
 * Returns price scaled to an integer (multiplied by 10^PRICE_DECIMALS)
 * so it can be stored as u128 on-chain.
 */
export const PRICE_DECIMALS = 9;
const SCALE = new BN(10).pow(new BN(PRICE_DECIMALS));

export async function fetchRaydiumPrice(
  connection: Connection,
  ammId: PublicKey
): Promise<bigint> {
  const ammAccount = await connection.getAccountInfo(ammId);
  if (!ammAccount) throw new Error(`AMM account not found: ${ammId.toBase58()}`);

  // Verify the account is owned by the Raydium AMM program. Without this
  // check, an attacker could pass an arbitrary account whose data happens to
  // decode into plausible vault pubkeys, redirecting reads to attacker-
  // controlled token accounts and producing a manipulated price.
  if (!ammAccount.owner.equals(RAYDIUM_AMM_PROGRAM_ID)) {
    throw new Error(
      `AMM account ${ammId.toBase58()} is not owned by Raydium AMM program. ` +
        `Expected owner: ${RAYDIUM_AMM_PROGRAM_ID.toBase58()}, ` +
        `actual owner: ${ammAccount.owner.toBase58()}`
    );
  }

  // Ensure the account data is large enough to contain the full AMM v4
  // struct. A truncated or reallocated account would cause the vault
  // pubkey reads below to silently return garbage bytes.
  if (ammAccount.data.length < AMM_ACCOUNT_MIN_SIZE) {
    throw new Error(
      `AMM account ${ammId.toBase58()} data too small: ` +
        `expected >= ${AMM_ACCOUNT_MIN_SIZE} bytes, got ${ammAccount.data.length}`
    );
  }

  const data = ammAccount.data;

  const baseVault = new PublicKey(data.subarray(BASE_VAULT_OFFSET, BASE_VAULT_OFFSET + 32));
  const quoteVault = new PublicKey(data.subarray(QUOTE_VAULT_OFFSET, QUOTE_VAULT_OFFSET + 32));

  const [baseBalance, quoteBalance] = await Promise.all([
    connection.getTokenAccountBalance(baseVault),
    connection.getTokenAccountBalance(quoteVault),
  ]);

  const baseAmount = new BN(baseBalance.value.amount);
  const quoteAmount = new BN(quoteBalance.value.amount);

  if (baseAmount.isZero()) {
    throw new Error("Base reserve is zero — cannot compute price");
  }

  // price = (quoteAmount * SCALE) / baseAmount
  const scaledPrice = quoteAmount.mul(SCALE).div(baseAmount);

  return BigInt(scaledPrice.toString());
}
