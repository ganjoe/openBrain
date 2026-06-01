import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerNexusTools } from "./tools/nexus.ts";
import { registerPcaTools } from "./tools/pca.ts";

const server = new McpServer({
  name: "open-brain-pca-stdio",
  version: "1.0.0",
});

registerNexusTools(server);
registerPcaTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
