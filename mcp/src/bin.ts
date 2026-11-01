#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgentCoinMcpServer } from "./index.ts";

const server = createAgentCoinMcpServer(undefined, { readOnly: process.env.AGENTCOIN_READ_ONLY === "1" });
await server.connect(new StdioServerTransport());
