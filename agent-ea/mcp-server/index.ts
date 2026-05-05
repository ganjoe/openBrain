import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

// --- Configuration from environment ---
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const AGENT_ID = Deno.env.get("AGENT_ID") || "unknown";
const GLOBAL_BRAIN_ACCESS = Deno.env.get("GLOBAL_BRAIN_ACCESS") === "true";
const X_BEARER_TOKEN = Deno.env.get("X_BEARER_TOKEN");

// Local services
const OLLAMA_URL = Deno.env.get("OLLAMA_URL") || "http://ollama:11434";
const OLLAMA_EMBED_MODEL = Deno.env.get("OLLAMA_EMBED_MODEL") || "qwen3-embedding:8b";
const LM_STUDIO_URL = Deno.env.get("LM_STUDIO_URL") || "http://host.docker.internal:1234";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Cache for User ID mapping (username -> id)
const userIdCache = new Map<string, string>();

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

// --- Metadata extraction (LLM based) ---
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
    const content = d.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

// --- X API Helpers ---
async function getXUserId(username: string): Promise<string> {
  const cleanName = username.startsWith("@") ? username.substring(1) : username;
  if (userIdCache.has(cleanName)) return userIdCache.get(cleanName)!;

  const res = await fetch(`https://api.twitter.com/2/users/by/username/${cleanName}`, {
    headers: { "Authorization": `Bearer ${X_BEARER_TOKEN}` }
  });
  if (!res.ok) throw new Error(`X API failed to resolve user: ${res.status}`);
  const data = await res.json();
  if (!data.data?.id) throw new Error(`User ${username} not found on X.`);
  
  userIdCache.set(cleanName, data.data.id);
  return data.data.id;
}

// --- MCP Server Setup ---

const server = new McpServer({
  name: "open-brain",
  version: "1.0.0",
});

// Tool: Search
server.registerTool(
  "search_thoughts",
  {
    title: "Search Thoughts",
    description: "Search captured thoughts using hybrid search.",
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5),
      ...(GLOBAL_BRAIN_ACCESS ? { owner: z.string().optional().describe("Filter by agent ID.") } : {})
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

      if (error) throw error;
      if (!data || data.length === 0) return { content: [{ type: "text", text: "No results." }] };

      const results = data.map((t: any, i: number) => {
          const m = t.metadata || {};
          const parts = [`[${i + 1}] Author: ${m.author || "Unknown"} | Date: ${new Date(t.created_at).toLocaleDateString()}`];
          if (m.tickers) parts.push(`Tickers: ${m.tickers.join(", ")}`);
          parts.push(`Content: ${t.content}`);
          return parts.join("\n");
      });

      return { content: [{ type: "text", text: results.join("\n\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Tool: Capture
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
      if (upsertError) throw upsertError;
      await supabase.from("thoughts").update({ embedding }).eq("id", upsertResult?.id);
      return { content: [{ type: "text", text: `Captured as ${metadata.type || "thought"} (Owner: ${AGENT_ID})` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Tool: Sync Influencer News (NEW)
server.registerTool(
  "sync_influencer_news",
  {
    title: "Sync Influencer News",
    description: "Fetch latest posts from an X influencer and store them in the Brain.",
    inputSchema: {
      username: z.string().describe("The X username (e.g. @elonmusk)"),
      limit: z.number().optional().default(5).describe("Max tweets to fetch"),
    },
  },
  async ({ username, limit }: any) => {
    if (!X_BEARER_TOKEN || X_BEARER_TOKEN.includes("YOUR_X_BEARER_TOKEN")) {
      return { content: [{ type: "text", text: "Error: X_BEARER_TOKEN is not configured in .env" }], isError: true };
    }

    try {
      const userId = await getXUserId(username);
      const cleanName = username.startsWith("@") ? username : `@${username}`;

      // 1. Find latest since_id in DB
      const { data: latestRecord } = await supabase
        .from("thoughts")
        .select("metadata")
        .contains("metadata", { author: cleanName, source: "x-api" })
        .order("created_at", { ascending: false })
        .limit(1);

      let sinceId = "";
      if (latestRecord && latestRecord.length > 0) {
        sinceId = (latestRecord[0].metadata as any).external_id;
      }

      // 2. Fetch from X API
      let url = `https://api.twitter.com/2/users/${userId}/tweets?max_results=${limit}&tweet.fields=created_at,entities`;
      if (sinceId) url += `&since_id=${sinceId}`;

      const res = await fetch(url, { headers: { "Authorization": `Bearer ${X_BEARER_TOKEN}` } });
      if (!res.ok) throw new Error(`X API fetch failed: ${res.status}`);
      const data = await res.json();

      if (!data.data || data.data.length === 0) {
        return { content: [{ type: "text", text: `No new tweets found for ${cleanName} since ID ${sinceId || "start"}.` }] };
      }

      let count = 0;
      for (const tweet of data.data) {
        const content = tweet.text;
        const tickers = (tweet.entities?.cashtags || []).map((c: any) => c.tag.toUpperCase());
        
        // Use LLM to refine metadata but force key fields
        const baseMetadata = await extractMetadata(content);
        const finalMetadata = {
          ...baseMetadata,
          type: "news",
          author: cleanName,
          source: "x-api",
          external_id: tweet.id,
          published_at: tweet.created_at,
          tickers: Array.from(new Set([...tickers, ...(baseMetadata.tickers as string[] || [])])),
          owner: AGENT_ID
        };

        const embedding = await getEmbedding(content);
        const { data: upsertResult, error: upsertError } = await supabase.rpc("upsert_thought", {
          p_content: content,
          p_payload: { metadata: finalMetadata },
        });

        if (!upsertError && upsertResult) {
          await supabase.from("thoughts").update({ embedding }).eq("id", upsertResult.id);
          count++;
        }
      }

      return { content: [{ type: "text", text: `Successfully synced ${count} new post(s) from ${cleanName}.` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Sync Error: ${err.message}` }], isError: true };
    }
  }
);

// Tool: Delegate
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
      if (!r.ok) throw new Error(`Nexus send failed: ${r.status}`);
      return { content: [{ type: "text", text: `Message sent to ${target_agent}.` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
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
