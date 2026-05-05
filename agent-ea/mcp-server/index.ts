import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

// --- Configuration from environment ---
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;           // http://postgrest:3001
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const AGENT_ID = Deno.env.get("AGENT_ID") || "unknown";
const GLOBAL_BRAIN_ACCESS = Deno.env.get("GLOBAL_BRAIN_ACCESS") === "true";

// Local services
const OLLAMA_URL = Deno.env.get("OLLAMA_URL") || "http://ollama:11434";
const OLLAMA_EMBED_MODEL = Deno.env.get("OLLAMA_EMBED_MODEL") || "qwen3-embedding:8b";
const LM_STUDIO_URL = Deno.env.get("LM_STUDIO_URL") || "http://host.docker.internal:1234";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- Remote MCP Helper (SSE) ---
async function callRemoteMcp(url: string, method: string, params: any) {
  const r = await fetch(url, { headers: { "Accept": "text/event-stream" } });
  if (!r.ok) throw new Error(`Failed to connect to remote MCP: ${r.status}`);
  
  const reader = r.body?.getReader();
  if (!reader) throw new Error("No body in remote MCP response");

  let postUrl = "";
  let buf = "";
  
  // Wait for endpoint event
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    
    const lines = buf.split("\n");
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      if (line.startsWith("event: endpoint")) {
        const nextLine = lines[i+1];
        if (nextLine.startsWith("data: ")) {
          postUrl = nextLine.substring(6).trim();
          break;
        }
      }
    }
    if (postUrl) break;
    if (buf.length > 5000) break; // sanity
  }

  if (!postUrl) throw new Error("Could not find POST endpoint in remote MCP stream");
  
  // Convert relative to absolute if needed
  if (!postUrl.startsWith("http")) {
    const base = new URL(url);
    postUrl = `${base.protocol}//${base.host}${postUrl}`;
  }

  const res = await fetch(postUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: Date.now() })
  });

  if (!res.ok) throw new Error(`Remote MCP tool call failed: ${res.status}`);
  const data = await res.json();
  return data;
}

// --- Embedding via Ollama ---
async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OLLAMA_URL}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: text }),
  });
  if (!r.ok) throw new Error(`Ollama embeddings failed: ${r.status}`);
  const d = await r.json();
  return d.data[0].embedding;
}

// --- Metadata extraction ---
async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  let systemPrompt = "Extract metadata from the user's captured thought. Return ONLY valid JSON.";
  try {
    systemPrompt = Deno.readTextFileSync("/app/metadata-prompt.txt");
  } catch (e) {
    try {
      systemPrompt = Deno.readTextFileSync("metadata-prompt.txt");
    } catch(e2) {}
  }

  const r = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "local-model",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: text }],
    }),
  });
  if (!r.ok) return { topics: ["uncategorized"], type: "observation" };
  const d = await r.json();
  try {
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

// --- MCP Server Setup ---

const server = new McpServer({
  name: "open-brain",
  version: "1.0.0",
});

// Tool 1: Hybrid Search
server.registerTool(
  "search_thoughts",
  {
    title: "Search Thoughts",
    description: "Search captured thoughts using hybrid search.",
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5),
      ...(GLOBAL_BRAIN_ACCESS ? { owner: z.string().optional().describe("Filter by agent ID. Leave empty for global search.") } : {})
    },
  },
  async ({ query, limit, threshold, owner }: any) => {
    try {
      const filter = GLOBAL_BRAIN_ACCESS && owner ? { owner } : (!GLOBAL_BRAIN_ACCESS ? { owner: AGENT_ID } : {});
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("hybrid_search_thoughts", {
        query_embedding: qEmb,
        query_text: query,
        match_threshold: threshold,
        match_count: limit,
        filter: filter,
      });

      if (error) return { content: [{ type: "text" as const, text: `Search error: ${error.message}` }], isError: true };
      if (!data || data.length === 0) return { content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }] };

      const results = data.map((t: any, i: number) => {
          const m = t.metadata || {};
          const matchLabel = t.similarity !== null ? `${(t.similarity * 100).toFixed(1)}% match` : "keyword match";
          const parts = [`--- Result ${i + 1} (${matchLabel}) ---`, `Captured: ${new Date(t.created_at).toLocaleDateString()}`];
          for (const [key, val] of Object.entries(m)) {
            if (key === "source" || key === "owner") continue;
            if (Array.isArray(val) && val.length > 0) parts.push(`${key}: ${val.join(", ")}`);
            else if (typeof val === "string" || typeof val === "number") parts.push(`${key}: ${val}`);
          }
          parts.push(`\n${t.content}`);
          return parts.join("\n");
      });

      return { content: [{ type: "text" as const, text: `Found ${data.length} thought(s):\n\n${results.join("\n\n")}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Tool 1b: Keyword Search
server.registerTool(
  "search_thoughts_keyword",
  {
    title: "Search Thoughts (Keyword)",
    description: "Search captured thoughts using exact keyword matching.",
    inputSchema: {
      query: z.string().describe("The exact keyword or pattern (use % as wildcard)"),
      limit: z.number().optional().default(10),
      ...(GLOBAL_BRAIN_ACCESS ? { owner: z.string().optional().describe("Filter by agent ID.") } : {})
    },
  },
  async ({ query, limit, owner }: any) => {
    try {
      const filter = GLOBAL_BRAIN_ACCESS && owner ? { owner } : (!GLOBAL_BRAIN_ACCESS ? { owner: AGENT_ID } : {});
      const { data, error } = await supabase.rpc("search_thoughts_keyword", { query_text: query, match_count: limit, filter: filter });
      if (error) return { content: [{ type: "text" as const, text: `Search error: ${error.message}` }], isError: true };
      if (!data || data.length === 0) return { content: [{ type: "text" as const, text: `No thoughts found containing "${query}".` }] };

      const results = data.map((t: any, i: number) => {
          const m = t.metadata || {};
          const parts = [`--- Result ${i + 1} ---`, `Captured: ${new Date(t.created_at).toLocaleDateString()}`];
          for (const [key, val] of Object.entries(m)) {
            if (key === "source" || key === "owner") continue;
            if (Array.isArray(val) && val.length > 0) parts.push(`${key}: ${val.join(", ")}`);
            else if (typeof val === "string" || typeof val === "number") parts.push(`${key}: ${val}`);
          }
          parts.push(`\n${t.content}`);
          return parts.join("\n");
      });

      return { content: [{ type: "text" as const, text: `Found ${data.length} thought(s):\n\n${results.join("\n\n")}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Tool 2: List Recent
server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Thoughts",
    description: "List recently captured thoughts with optional filters.",
    inputSchema: {
      limit: z.number().optional().default(10),
      type: z.string().optional().describe("Filter by type"),
      topic: z.string().optional().describe("Filter by topic tag"),
      days: z.number().optional().describe("Only thoughts from the last N days"),
      ...(GLOBAL_BRAIN_ACCESS ? { owner: z.string().optional().describe("Filter by agent ID.") } : {})
    },
  },
  async ({ limit, type, topic, days, owner }: any) => {
    try {
      let q = supabase.from("thoughts").select("content, metadata, created_at").order("created_at", { ascending: false }).limit(limit);
      if (type) q = q.contains("metadata", { type });
      if (topic) q = q.contains("metadata", { topics: [topic] });
      if (days) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        q = q.gte("created_at", since.toISOString());
      }
      const filterOwner = GLOBAL_BRAIN_ACCESS && owner ? owner : (!GLOBAL_BRAIN_ACCESS ? AGENT_ID : null);
      if (filterOwner) q = q.contains("metadata", { owner: filterOwner });

      const { data, error } = await q;
      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
      if (!data || !data.length) return { content: [{ type: "text" as const, text: "No thoughts found." }] };

      const results = data.map((t: any, i: number) => {
          const m = t.metadata || {};
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"})\n   ${t.content}`;
      });

      return { content: [{ type: "text" as const, text: `${data.length} recent thought(s):\n\n${results.join("\n\n")}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Tool 3: Stats
server.registerTool(
  "thought_stats",
  {
    title: "Thought Statistics",
    description: "Get a summary of captured thoughts.",
    inputSchema: {
      ...(GLOBAL_BRAIN_ACCESS ? { owner: z.string().optional().describe("Filter by agent ID.") } : {})
    },
  },
  async ({ owner }: any) => {
    try {
      const filterOwner = GLOBAL_BRAIN_ACCESS && owner ? owner : (!GLOBAL_BRAIN_ACCESS ? AGENT_ID : null);
      let countQuery = supabase.from("thoughts").select("*", { count: "exact", head: true });
      let dataQuery = supabase.from("thoughts").select("metadata, created_at").order("created_at", { ascending: false });
      
      if (filterOwner) {
        countQuery = countQuery.contains("metadata", { owner: filterOwner });
        dataQuery = dataQuery.contains("metadata", { owner: filterOwner });
      }

      const { count } = await countQuery;
      const { data } = await dataQuery;
      const types: Record<string, number> = {};
      for (const r of data || []) {
        const m = (r.metadata || {}) as Record<string, unknown>;
        if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
      }
      const lines = [`Total thoughts: ${count}`, "Types:", ...Object.entries(types).map(([k, v]) => `  ${k}: ${v}`)];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Tool 4: Capture Thought
server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description: "Save a new thought to the Open Brain.",
    inputSchema: { content: z.string().describe("The thought to capture") },
  },
  async ({ content }: any) => {
    try {
      const [embedding, metadata] = await Promise.all([getEmbedding(content), extractMetadata(content)]);
      const { data: upsertResult, error: upsertError } = await supabase.rpc("upsert_thought", {
        p_content: content,
        p_payload: { metadata: { ...metadata, source: "mcp", owner: AGENT_ID } },
      });
      if (upsertError) return { content: [{ type: "text" as const, text: `Failed: ${upsertError.message}` }], isError: true };
      await supabase.from("thoughts").update({ embedding }).eq("id", upsertResult?.id);
      return { content: [{ type: "text" as const, text: `Captured as ${metadata.type || "thought"} (Owner: ${AGENT_ID})` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Tool 5: Delegate
server.registerTool(
  "message_agent",
  {
    title: "Message Another Agent",
    description: "Send a direct message or delegation request to another agent.",
    inputSchema: {
      target_agent: z.string().describe("The ID of the agent (e.g. 'cco' or 'ea')"),
      message: z.string().describe("The message or task"),
    },
  },
  async ({ target_agent, message }: any) => {
    try {
      const r = await fetch("http://nexus-service:7734/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_agent: AGENT_ID, to: target_agent, text: message }),
      });
      if (!r.ok) return { content: [{ type: "text" as const, text: `Failed: ${r.status}` }], isError: true };
      return { content: [{ type: "text" as const, text: `Message sent to ${target_agent}.` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// --- NEW Tool 6: Query xAI Documentation ---
server.registerTool(
  "query_x_docs",
  {
    title: "Query X (xAI) Documentation",
    description: "Search and read the official xAI (Grok/X Dev) API documentation.",
    inputSchema: {
      query: z.string().describe("What to search for in the documentation"),
    },
  },
  async ({ query }: any) => {
    try {
      // First, list tools to discover what we can do
      const toolList = await callRemoteMcp("https://docs.x.ai/api/mcp", "tools/list", {});
      const tools = toolList.result.tools || [];
      
      // Look for a search tool
      const searchTool = tools.find((t: any) => t.name.includes("search") || t.name.includes("query"));
      if (!searchTool) {
        return { content: [{ type: "text" as const, text: `Could not find a search tool on xAI MCP. Available: ${tools.map((t: any) => t.name).join(", ")}` }] };
      }

      // Call the search tool
      const searchResult = await callRemoteMcp("https://docs.x.ai/api/mcp", "tools/call", {
        name: searchTool.name,
        arguments: { query }
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(searchResult.result.content, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `X Docs Error: ${err.message}` }], isError: true };
    }
  }
);

// --- Hono App ---
const app = new Hono();
app.all("*", async (c) => {
  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) return c.json({ error: "Invalid key" }, 401);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

const port = parseInt(Deno.env.get("PORT") || "8787");
console.log(`${AGENT_ID.toUpperCase()} MCP server starting...`);
Deno.serve({ port }, app.fetch);
