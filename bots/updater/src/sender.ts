import {
  Connection,
  Keypair,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

/**
 * Signs and sends a transaction with retry logic.
 * Returns the transaction signature on success.
 */
export async function sendTransaction(
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[],
  maxRetries = 3
): Promise<string> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const tx = new Transaction().add(...instructions);
      const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
        commitment: "confirmed",
      });
      return sig;
    } catch (err) {
      lastError = err as Error;
      console.error(
        `[sender] attempt ${attempt}/${maxRetries} failed: ${lastError.message}`
      );
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  throw lastError;
}
