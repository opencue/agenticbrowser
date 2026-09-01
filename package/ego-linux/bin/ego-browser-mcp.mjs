#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createEgoBrowserMcpServer } from "../src/mcp-server.mjs";

const handle = serveStdio(() => createEgoBrowserMcpServer(), {
  legacy: "serve",
  onerror: (error) => {
    process.stderr.write(`ego-browser MCP error: ${error?.stack || error}\n`);
  },
});

async function shutdown() {
  await handle.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
