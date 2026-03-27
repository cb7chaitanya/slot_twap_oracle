import http from "http";
import app from "./app";
import { config } from "./config";
import { attachWebSocket } from "./ws";

const server = http.createServer(app);
attachWebSocket(server);

server.listen(config.PORT, () => {
  console.log(`${new Date().toISOString()} Oracle API listening on :${config.PORT}`);
  console.log(`  RPC:  ${config.RPC_URL}`);
  console.log(`  Routes:`);
  console.log(`    GET  /price?oracle=<pubkey>`);
  console.log(`    GET  /twap?oracle=<pubkey>&window=<slots>`);
  console.log(`    GET  /history?oracle=<pubkey>&limit=<n>`);
  console.log(`    GET  /health`);
  console.log(`    WS   /ws`);
});
