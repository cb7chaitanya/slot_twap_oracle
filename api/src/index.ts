import express from "express";
import { config } from "./config";
import { requestLogger, errorHandler } from "./middleware";
import priceRouter from "./routes/price";
import twapRouter from "./routes/twap";
import historyRouter from "./routes/history";
import healthRouter from "./routes/health";

const app = express();

app.use(requestLogger);

app.use("/price", priceRouter);
app.use("/twap", twapRouter);
app.use("/history", historyRouter);
app.use("/health", healthRouter);

app.use(errorHandler);

app.listen(config.PORT, () => {
  console.log(`${new Date().toISOString()} Oracle API listening on :${config.PORT}`);
  console.log(`  RPC:  ${config.RPC_URL}`);
  console.log(`  Routes:`);
  console.log(`    GET /price?oracle=<pubkey>`);
  console.log(`    GET /twap?oracle=<pubkey>&window=<slots>`);
  console.log(`    GET /history?oracle=<pubkey>&limit=<n>`);
  console.log(`    GET /health`);
});
