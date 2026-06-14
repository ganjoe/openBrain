import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AGENT_ID } from "./shared.ts";

export function registerNexusTools(server: McpServer) {
  server.registerTool(
    "message_agent",
    {
      title: "Message Another Agent",
      description: "Send a direct message or delegation request to another agent via the Nexus.",
      inputSchema: {
        target_agent: z.string().describe("The ID of the target agent (e.g. 'pta', 'cco', 'ea')"),
        message: z.string().describe("The message or task description"),
      },
    },
    async ({ target_agent, message }: any) => {
      try {
        const r = await fetch("http://nexus-service:7734/api/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from_agent: AGENT_ID, to: target_agent, text: message }),
        });
        if (!r.ok) throw new Error(`Nexus send failed: ${r.status}`);
        return { content: [{ type: "text", text: `Message sent to ${target_agent}.` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
