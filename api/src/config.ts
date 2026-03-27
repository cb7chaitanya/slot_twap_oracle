import { z } from "zod";

const envSchema = z.object({
  RPC_URL: z.string().url().default("http://127.0.0.1:8899"),
  PORT: z.coerce.number().int().positive().default(3000),
  PROGRAM_ID: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
