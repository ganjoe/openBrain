// core/agent-runtime/mcp-client.ts
// Stateless MCP HTTP client for LOCAL MCP servers

export class StatelessMcpClient {
  constructor(public url: string, private key: string) {}

  private async request(method: string, params: any) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600000); // 10 minutes timeout for syncs

    try {
      const res = await fetch(`${this.url}?key=${this.key}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream"
        },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: Date.now() }),
        signal: controller.signal,
      });

      const text = await res.text();
      clearTimeout(timeout);
      let jsonStr = text;

      if (text.includes("event: message")) {
        const dataLine = text.split("\n").find(l => l.startsWith("data: "));
        if (dataLine) jsonStr = dataLine.substring(6);
      }

      const data = JSON.parse(jsonStr);
      if (data.error) throw new Error(data.error.message);
      return data.result;
    } catch (err: any) {
      clearTimeout(timeout);
      throw err;
    }
  }

  async listTools()                        { return this.request("tools/list", {}); }
  async callTool(name: string, args: any)  { return this.request("tools/call", { name, arguments: args }); }
}
