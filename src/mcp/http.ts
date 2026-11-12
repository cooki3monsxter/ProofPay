import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "../config.js";
import { buildMcpServer, restApi } from "./tools.js";

/** Remote MCP endpoint (Streamable HTTP, stateless). Connect any MCP client to <host>/mcp. */
export async function handleMcpRequest(req: Request, res: Response) {
  const token = process.env.MCP_TOKEN;
  if (token && req.header("authorization") !== `Bearer ${token}`) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
    return;
  }
  // Call our own REST API on the port this request actually arrived on.
  const port = req.socket.localPort ?? config.port;
  const server = buildMcpServer(restApi(`http://127.0.0.1:${port}`));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
