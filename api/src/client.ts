import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { SlotTwapOracleClient, PROGRAM_ID } from "@slot-twap-oracle/sdk";
import { config } from "./config";

const connection = new Connection(config.RPC_URL, "confirmed");
const provider = new AnchorProvider(
  connection,
  new Wallet(Keypair.generate()),
  { commitment: "confirmed" }
);

const programId = config.PROGRAM_ID
  ? new PublicKey(config.PROGRAM_ID)
  : PROGRAM_ID;

export const client = new SlotTwapOracleClient(provider, programId);
export { connection };
