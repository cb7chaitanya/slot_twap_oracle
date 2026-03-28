import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  validatePoolAccount,
  readPubkey,
  readU128LE,
  matchMints,
} from "./pool-utils";

const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey(
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
);

// Orca Whirlpool layout (after 8-byte Anchor discriminator):
//   whirlpools_config: Pubkey    (8-40)
//   whirlpool_bump: [u8;1]       (40-41)
//   tick_spacing: u16             (41-43)
//   tick_spacing_seed: [u8;2]     (43-45)
//   fee_rate: u16                 (45-47)
//   protocol_fee_rate: u16        (47-49)
//   liquidity: u128               (49-65)
//   sqrt_price: u128              (65-81)    ← price source
//   tick_current_index: i32       (81-85)
//   protocol_fee_owed_a: u64      (85-93)
//   protocol_fee_owed_b: u64      (93-101)
//   token_mint_a: Pubkey          (101-133)  ← verified on mainnet
//   token_mint_b: Pubkey          (133-165)  ← verified on mainnet
//
// Using sqrt_price instead of vault balances because:
// 1. Whirlpool is concentrated liquidity — vaults don't reflect spot price
// 2. Many older pool vaults are closed or migrated
// 3. sqrt_price is always current and authoritative

const MIN_SIZE = 165; // need through token_mint_b
const SQRT_PRICE_OFFSET = 65;
const MINT_A_OFFSET = 101;
const MINT_B_OFFSET = 133;

/**
 * Computes price from Whirlpool's sqrt_price_x64 (Q64.64 fixed-point).
 *
 * sqrt_price = sqrt(price) * 2^64
 * price = (sqrt_price / 2^64)^2
 *
 * This gives price of token_b per token_a in raw amounts (no decimal adjustment).
 */
function sqrtPriceToFloat(sqrtPrice: BN): number {
  // Convert to float: sqrtPrice / 2^64
  const sqrtFloat = Number(sqrtPrice.toString()) / 2 ** 64;
  return sqrtFloat * sqrtFloat;
}

export async function fetchPrice(
  connection: Connection,
  poolAddress: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey
): Promise<number> {
  const info = await connection.getAccountInfo(poolAddress);
  const data = validatePoolAccount(info, poolAddress, ORCA_WHIRLPOOL_PROGRAM_ID, MIN_SIZE, "Orca");

  const mintA = readPubkey(data, MINT_A_OFFSET);
  const mintB = readPubkey(data, MINT_B_OFFSET);
  const direction = matchMints(mintA, mintB, baseMint, quoteMint, "Orca");

  const sqrtPrice = readU128LE(data, SQRT_PRICE_OFFSET);
  if (sqrtPrice.isZero()) {
    throw new Error("Orca: sqrt_price is zero — pool may be uninitialized");
  }

  // price = B per A (in raw token amounts)
  const rawPrice = sqrtPriceToFloat(sqrtPrice);
  if (rawPrice === 0 || !isFinite(rawPrice)) {
    throw new Error(`Orca: invalid price derived from sqrt_price: ${rawPrice}`);
  }

  return direction === "reversed" ? 1 / rawPrice : rawPrice;
}
