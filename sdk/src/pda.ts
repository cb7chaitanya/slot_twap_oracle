import { PublicKey } from "@solana/web3.js";

/** Default on-chain program ID for the Slot TWAP Oracle. */
export const PROGRAM_ID = new PublicKey(
  "7LKj9Yk62ddRjtTHvvV6fmquD9h7XbcvKKa7yGtocdsT"
);

/**
 * Derive the Oracle PDA for a given base/quote mint pair.
 *
 * @param baseMint  - SPL mint address of the base token.
 * @param quoteMint - SPL mint address of the quote token.
 * @param programId - Oracle program ID. Defaults to {@link PROGRAM_ID}.
 * @returns Tuple of `[pda, bump]`.
 */
export function findOraclePda(
  baseMint: PublicKey,
  quoteMint: PublicKey,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("oracle"), baseMint.toBuffer(), quoteMint.toBuffer()],
    programId
  );
}

/**
 * Derive the ObservationBuffer PDA for a given oracle.
 *
 * @param oracle    - The oracle account address.
 * @param programId - Oracle program ID. Defaults to {@link PROGRAM_ID}.
 * @returns Tuple of `[pda, bump]`.
 */
export function findObservationBufferPda(
  oracle: PublicKey,
  programId: PublicKey = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("observation"), oracle.toBuffer()],
    programId
  );
}
