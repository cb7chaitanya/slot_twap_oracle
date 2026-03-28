import { Connection, PublicKey } from "@solana/web3.js";
import {
  validatePoolAccount,
  readPubkey,
  matchMints,
  fetchVaultBalances,
  computePriceFromBalances,
} from "./pool-utils";

const METEORA_DLMM_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
);

// Meteora DLMM LbPair layout (after 8-byte Anchor discriminator):
//   StaticParameters: 30 bytes    (8-38)
//   VariableParameters: 32 bytes  (38-70)
//   bump_seed: [u8;1]             (70)
//   bin_step_seed: [u8;2]         (71-73)
//   pair_type: u8                 (73)
//   active_id: i32                (74-78)
//   bin_step: u16                 (78-80)
//   status: u8                    (80)
//   _pad: ...                     (81-88)
//   token_x_mint: Pubkey          (88-120)   ← verified on mainnet
//   token_y_mint: Pubkey          (120-152)  ← verified on mainnet
//   reserve_x: Pubkey             (152-184)  ← verified as TOKEN account
//   reserve_y: Pubkey             (184-216)  ← verified as TOKEN account
const MIN_SIZE = 216;
const ACTIVE_ID_OFFSET = 74;
const BIN_STEP_OFFSET = 78;
const MINT_X_OFFSET = 88;
const MINT_Y_OFFSET = 120;
const RESERVE_X_OFFSET = 152;
const RESERVE_Y_OFFSET = 184;

export async function fetchPrice(
  connection: Connection,
  poolAddress: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey
): Promise<number> {
  const info = await connection.getAccountInfo(poolAddress);
  const data = validatePoolAccount(info, poolAddress, METEORA_DLMM_PROGRAM_ID, MIN_SIZE, "Meteora");

  const mintX = readPubkey(data, MINT_X_OFFSET);
  const mintY = readPubkey(data, MINT_Y_OFFSET);
  const direction = matchMints(mintX, mintY, baseMint, quoteMint, "Meteora");

  const reserveX = readPubkey(data, RESERVE_X_OFFSET);
  const reserveY = readPubkey(data, RESERVE_Y_OFFSET);

  const { amountA, amountB } = await fetchVaultBalances(
    connection, reserveX, reserveY, "Meteora"
  );

  const rawPrice = computePriceFromBalances(amountB, amountA, "Meteora");
  if (!isFinite(rawPrice) || rawPrice === 0) {
    throw new Error(`Meteora: invalid price: ${rawPrice}`);
  }

  return direction === "reversed" ? 1 / rawPrice : rawPrice;
}
