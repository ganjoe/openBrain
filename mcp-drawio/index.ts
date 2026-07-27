import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { registerDrawioTools } from "./tools.ts";

const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") || "";
const PORT = parseInt(Deno.env.get("PORT") || "8796");

const server = new McpServer({
  name: "drawio-mcp",
  version: "1.0.0",
});

// Register modular tools
registerDrawioTools(server);

// ─────────────────────────────────────────────────────────────
// HTTP App Server via Hono & StreamableHTTPTransport
// ─────────────────────────────────────────────────────────────
const app = new Hono();

app.all("*", async (c) => {
  const provided =
    c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");

  if (MCP_ACCESS_KEY && provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Invalid MCP access key" }, 401);
  }

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

console.log(`🎨 draw.io MCP Server starting on port ${PORT}...`);
Deno.serve({ port: PORT }, app.fetch);
