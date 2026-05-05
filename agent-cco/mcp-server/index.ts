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

// --- Embedding via Ollama (local, CPU-only) ---
async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OLLAMA_URL}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_EMBED_MODEL,
      input: text,
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`Ollama embeddings failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.data[0].embedding;
}

// --- Metadata extraction via LM Studio (local, GPU) ---
async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  let systemPrompt = "Extract metadata from the user's captured thought. Return ONLY valid JSON with no markdown formatting or other text. The JSON must have exactly these keys: 'type', 'topics', 'action_items', 'people', 'dates_mentioned'.";
  try {
    systemPrompt = Deno.readTextFileSync("/app/metadata-prompt.txt");
  } catch (e) {
    try {
      systemPrompt = Deno.readTextFileSync("metadata-prompt.txt");
    } catch(e2) {
      console.warn("⚠️ metadata-prompt.txt not found. Using generic fallback.");
    }
  }

  const r = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "local-model",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
    }),
  });
  if (!r.ok) {
    console.error(`LM Studio metadata extraction failed: ${r.status}`);
    return { topics: ["uncategorized"], type: "observation" };
  }
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
    description: "Search captured thoughts using hybrid search (semantic vector + keyword matching).",
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5),
      ...(GLOBAL_BRAIN_ACCESS ? { owner: z.string().optional().describe("Filter by agent ID (e.g. 'cco'). Leave empty for global search.") } : {})
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

      if (error) {
        return { content: [{ type: "text" as const, text: `Search error: ${error.message}` }], isError: true };
      }

      if (!data || data.length === 0) {
        return { content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }] };
      }

      const results = data.map((t: any, i: number) => {
          const m = t.metadata || {};
          const matchLabel = t.similarity !== null && t.similarity !== undefined
            ? `${(t.similarity * 100).toFixed(1)}% semantic match`
            : "keyword match";
          const parts = [
            `--- Result ${i + 1} (${matchLabel}) ---`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
          ];
          for (const [key, val] of Object.entries(m)) {
            if (key === "source") continue;
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
      query: z.string().describe("The exact keyword or pattern to search for (use % as wildcard)"),
      limit: z.number().optional().default(10),
      ...(GLOBAL_BRAIN_ACCESS ? { owner: z.string().optional().describe("Filter by agent ID (e.g. 'cco'). Leave empty for global search.") } : {})
    },
  },
  async ({ query, limit, owner }: any) => {
    try {
      const filter = GLOBAL_BRAIN_ACCESS && owner ? { owner } : (!GLOBAL_BRAIN_ACCESS ? { owner: AGENT_ID } : {});
      const { data, error } = await supabase.rpc("search_thoughts_keyword", {
        query_text: query,
        match_count: limit,
        filter: filter,
      });

      if (error) {
        return { content: [{ type: "text" as const, text: `Search error: ${error.message}` }], isError: true };
      }

      if (!data || data.length === 0) {
        return { content: [{ type: "text" as const, text: `No thoughts found containing "${query}".` }] };
      }

      const results = data.map((t: any, i: number) => {
          const m = t.metadata || {};
          const parts = [
            `--- Result ${i + 1} ---`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
          ];
          for (const [key, val] of Object.entries(m)) {
            if (key === "source") continue;
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
      person: z.string().optional().describe("Filter by person mentioned"),
      days: z.number().optional().describe("Only thoughts from the last N days"),
      ...(GLOBAL_BRAIN_ACCESS ? { owner: z.string().optional().describe("Filter by agent ID (e.g. 'cco'). Leave empty for global search.") } : {})
    },
  },
  async ({ limit, type, topic, person, days, owner }: any) => {
    try {
      let q = supabase
        .from("thoughts")
        .select("content, metadata, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (type) q = q.contains("metadata", { type });
      if (topic) q = q.contains("metadata", { topics: [topic] });
      if (person) q = q.contains("metadata", { people: [person] });
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
          const extras = [];
          for (const [k, v] of Object.entries(m)) {
            if (k === "source" || k === "type") continue;
            if (Array.isArray(v) && v.length > 0) extras.push(`${k}: ${v.join(",")}`);
            else if (typeof v === "string" || typeof v === "number") extras.push(`${k}: ${v}`);
          }
          const extraStr = extras.length > 0 ? " - " + extras.join(" | ") : "";
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${extraStr})\n   ${t.content}`;
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
      ...(GLOBAL_BRAIN_ACCESS ? { owner: z.string().optional().describe("Filter by agent ID (e.g. 'cco'). Leave empty for global stats.") } : {})
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
      const topics: Record<string, number> = {};
      const people: Record<string, number> = {};

      for (const r of data || []) {
        const m = (r.metadata || {}) as Record<string, unknown>;
        if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
        if (Array.isArray(m.topics))
          for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
        if (Array.isArray(m.people))
          for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
      }

      const sort = (o: Record<string, number>): [string, number][] => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10);

      const lines: string[] = [
        `Total thoughts: ${count}`,
        `Date range: ${data?.length ? new Date(data[data.length - 1].created_at).toLocaleDateString() + " → " + new Date(data[0].created_at).toLocaleDateString() : "N/A"}`,
        "",
        "Types:",
        ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
      ];

      if (Object.keys(topics).length) {
        lines.push("", "Top topics:");
        for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
      }

      if (Object.keys(people).length) {
        lines.push("", "People mentioned:");
        for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`);
      }

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
    inputSchema: {
      content: z.string().describe("The thought to capture"),
    },
  },
  async ({ content }: any) => {
    try {
      const [embedding, metadata] = await Promise.all([
        getEmbedding(content),
        extractMetadata(content),
      ]);

      const { data: upsertResult, error: upsertError } = await supabase.rpc("upsert_thought", {
        p_content: content,
        p_payload: { metadata: { ...metadata, source: "mcp", owner: AGENT_ID } },
      });

      if (upsertError) return { content: [{ type: "text" as const, text: `Failed to capture: ${upsertError.message}` }], isError: true };

      const thoughtId = upsertResult?.id;
      const { error: embError } = await supabase.from("thoughts").update({ embedding }).eq("id", thoughtId);

      if (embError) return { content: [{ type: "text" as const, text: `Failed to save embedding: ${embError.message}` }], isError: true };

      const meta = metadata as Record<string, unknown>;
      let confirmation = `Captured as ${meta.type || "thought"} (Owner: ${AGENT_ID})`;
      const extras = [];
      for (const [k, v] of Object.entries(meta)) {
        if (k === "source" || k === "type") continue;
        if (Array.isArray(v) && v.length > 0) extras.push(`${k}: ${v.join(", ")}`);
        else if (typeof v === "string" || typeof v === "number") extras.push(`${k}: ${v}`);
      }
      if (extras.length > 0) confirmation += ` | ${extras.join(" | ")}`;

      return { content: [{ type: "text" as const, text: confirmation }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Tool 5: Delegate / Ask Agent
server.registerTool(
  "message_agent",
  {
    title: "Message Another Agent",
    description: "Send a direct message or delegation request to another agent.",
    inputSchema: {
      target_agent: z.string().describe("The ID of the agent to message (e.g. 'cco' or 'ea')"),
      message: z.string().describe("The message or task to send"),
    },
  },
  async ({ target_agent, message }: any) => {
    try {
      const r = await fetch("http://nexus-service:7734/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_agent: AGENT_ID,
          to: target_agent,
          text: message
        }),
      });

      if (!r.ok) return { content: [{ type: "text" as const, text: `Failed to message agent: ${r.status}` }], isError: true };

      return { content: [{ type: "text" as const, text: `Message successfully sent to ${target_agent}. You do not need to do anything else right now.` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// --- Hono App with Auth + CORS ---

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-brain-key, accept, mcp-session-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

const app = new Hono();

app.options("*", (c) => c.text("ok", 200, corsHeaders));

app.all("*", async (c) => {
  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Invalid or missing access key" }, 401, corsHeaders);
  }

  if (!c.req.header("accept")?.includes("text/event-stream")) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-ignore
      duplex: "half",
    });
    Object.defineProperty(c.req, "raw", { value: patched, writable: true });
  }

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

const port = parseInt(Deno.env.get("PORT") || "8787");
console.log(`${AGENT_ID.toUpperCase()} MCP server starting on port ${port}...`);
Deno.serve({ port }, app.fetch);
