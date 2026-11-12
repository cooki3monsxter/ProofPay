#!/usr/bin/env node
// Local MCP server for Claude Desktop / Cursor. Talks to a running ProofPay API.
//   PROOFPAY_URL=https://your-app.onrender.com npm run mcp
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer, restApi } from "./tools.js";

const base = process.env.PROOFPAY_URL ?? "http://localhost:8080";
const server = buildMcpServer(restApi(base.replace(/\/$/, "")));
await server.connect(new StdioServerTransport());
console.error(`[proofpay-mcp] connected over stdio → ${base}`);
