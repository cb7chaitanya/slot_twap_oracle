import { Connection, PublicKey } from "@solana/web3.js";
import {
  validatePoolAccount,
  readPubkey,
  matchMints,
  fetchVaultBalances,
  computePriceFromBalances,
} from "./pool-utils";

const RAYDIUM_AMM_PROGRAM_ID = new PublicKey(
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
);

// Raydium AMM v4 layout — verified against mainnet pool 58oQChx4...
// base_vault at 336, quote_vault at 368, base_mint at 400, quote_mint at 432
const MIN_SIZE = 752;
const BASE_VAULT_OFFSET = 336;
const QUOTE_VAULT_OFFSET = 368;
const BASE_MINT_OFFSET = 400;
const QUOTE_MINT_OFFSET = 432;

export async function fetchPrice(
  connection: Connection,
  poolAddress: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey
): Promise<number> {
  const info = await connection.getAccountInfo(poolAddress);
  const data = validatePoolAccount(info, poolAddress, RAYDIUM_AMM_PROGRAM_ID, MIN_SIZE, "Raydium");

  const poolBaseMint = readPubkey(data, BASE_MINT_OFFSET);
  const poolQuoteMint = readPubkey(data, QUOTE_MINT_OFFSET);
  const direction = matchMints(poolBaseMint, poolQuoteMint, baseMint, quoteMint, "Raydium");

  const baseVault = readPubkey(data, BASE_VAULT_OFFSET);
  const quoteVault = readPubkey(data, QUOTE_VAULT_OFFSET);

  const { amountA, amountB } = await fetchVaultBalances(
    connection, baseVault, quoteVault, "Raydium"
  );

  const rawPrice = computePriceFromBalances(amountB, amountA, "Raydium");
  return direction === "reversed" ? 1 / rawPrice : rawPrice;
}
