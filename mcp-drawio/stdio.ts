import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerDrawioTools } from "./tools.ts";

const server = new McpServer({
  name: "drawio-mcp-stdio",
  version: "1.0.0",
});

registerDrawioTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
