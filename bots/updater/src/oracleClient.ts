import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";

const UPDATE_PRICE_DISCRIMINATOR = Buffer.from([61, 34, 117, 155, 75, 34, 123, 208]);

export function deriveOraclePda(
  baseMint: PublicKey,
  quoteMint: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("oracle"), baseMint.toBuffer(), quoteMint.toBuffer()],
    programId
  );
}

export function deriveObservationBufferPda(
  oracle: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("observation"), oracle.toBuffer()],
    programId
  );
}

/**
 * Builds the update_price instruction.
 * new_price is encoded as a little-endian u128 (16 bytes).
 */
export function buildUpdatePriceIx(
  oracle: PublicKey,
  observationBuffer: PublicKey,
  programId: PublicKey,
  newPrice: bigint
): TransactionInstruction {
  // Encode u128 as 16 bytes little-endian
  const priceBuf = Buffer.alloc(16);
  let val = newPrice;
  for (let i = 0; i < 16; i++) {
    priceBuf[i] = Number(val & 0xffn);
    val >>= 8n;
  }

  const data = Buffer.concat([UPDATE_PRICE_DISCRIMINATOR, priceBuf]);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: oracle, isSigner: false, isWritable: true },
      { pubkey: observationBuffer, isSigner: false, isWritable: true },
    ],
    data,
  });
}
