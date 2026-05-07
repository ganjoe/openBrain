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
const activeSyncs = new Set<string>();

// --- Telemetry Helper ---
async function sendTelemetry(text: string) {
  try {
    await fetch("http://nexus-service:7734/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_agent: "system", to: "all", text, message_type: "telemetry" }),
    });
  } catch (e) {
    console.error("Telemetry failed:", e);
  }
}

// --- Embedding via Ollama ---
async function getEmbedding(text: string): Promise<number[]> {
  const start = Date.now();
  const r = await fetch(`${OLLAMA_URL}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: text }),
  });
  if (!r.ok) throw new Error(`Ollama embeddings failed: ${r.status}`);
  const d = await r.json();
  const duration = (Date.now() - start) / 1000;
  await sendTelemetry(`[Ollama] Model: ${OLLAMA_EMBED_MODEL} | Zeit: ${duration.toFixed(2)}s | Aktion: Embedding`);
  return d.data[0].embedding;
}

// --- Metadata extraction (LLM based) ---
async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const start = Date.now();
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
  
  const duration = (Date.now() - start) / 1000;
  const tokens = d.usage?.completion_tokens || 0;
  const ts = duration > 0 ? (tokens / duration).toFixed(1) : "0.0";
  const model = d.model || "local-model";
  
  await sendTelemetry(`[LM Studio] Model: ${model} | Zeit: ${duration.toFixed(2)}s | Speed: ${ts} t/s | Tokens: ${tokens}`);

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
      // Logic for isolation: EA can see everything if owner is NULL. CCO is always filtered.
      const p_agent_id = GLOBAL_BRAIN_ACCESS ? (owner || null) : AGENT_ID;
      
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("hybrid_search_open_brain", {
        query_embedding: qEmb,
        query_text: query,
        match_threshold: threshold,
        match_count: limit,
        p_agent_id: p_agent_id,
      });

      if (error) throw error;
      if (!data || data.length === 0) return { content: [{ type: "text", text: "No results." }] };

      const results = data.map((t: any, i: number) => {
          return `[${i + 1}] Agent: ${t.agent_id} | Type: ${t.thought_type} | Date: ${new Date(t.created_at).toLocaleDateString()}\nContent: ${t.content}`;
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
      const { data: upsertResult, error: upsertError } = await supabase.rpc("upsert_open_brain", {
        p_agent_id: AGENT_ID,
        p_content: content,
        p_thought_type: metadata.type || "observation"
      });
      if (upsertError) throw upsertError;
      
      // Update with embedding
      await supabase.from("open_brain").update({ embedding }).eq("id", upsertResult?.id);
      
      return { content: [{ type: "text", text: `Captured as ${metadata.type || "thought"} (Agent: ${AGENT_ID})` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Background Worker for Sync
async function runBackgroundSync(cleanName: string, username: string, limit: number, start_time: string) {
  try {
    await sendTelemetry(`[System] Hintergrund-Sync für ${cleanName} startet...`);
    const userId = await getXUserId(username);

    // 1. Determine since_id or until_id
    let sinceId = "";
    let untilId = "";
    
    if (start_time) {
       // Historical fetch: find the oldest post we have to use as until_id
       const { data: oldestRecord } = await supabase
        .from("agent_workspace")
        .select("metadata")
        .eq("agent_id", AGENT_ID)
        .eq("artifact_type", "x_post")
        .contains("metadata", { author: cleanName })
        .order("created_at", { ascending: true })
        .limit(1);
        
       if (oldestRecord && oldestRecord.length > 0) {
          untilId = (oldestRecord[0].metadata as any).external_id;
       }
    } else {
       // Normal fetch: find the newest post we have to use as since_id
       const { data: latestRecord } = await supabase
        .from("agent_workspace")
        .select("metadata")
        .eq("agent_id", AGENT_ID)
        .eq("artifact_type", "x_post")
        .contains("metadata", { author: cleanName })
        .order("created_at", { ascending: false })
        .limit(1);

      if (latestRecord && latestRecord.length > 0) {
        sinceId = (latestRecord[0].metadata as any).external_id;
      }
    }

    // 2. Fetch from X API with pagination
    let count = 0;
    let nextToken = "";
    let totalFetched = 0;
    let skipped = 0;
    const targetLimit = Math.min(Math.max(1, limit), 500);
    
    while (totalFetched < targetLimit) {
      const batchSize = Math.min(100, targetLimit - totalFetched);
      let url = `https://api.twitter.com/2/users/${userId}/tweets?max_results=${batchSize}&tweet.fields=created_at,entities`;
      
      if (start_time) url += `&start_time=${start_time}`;
      if (sinceId) url += `&since_id=${sinceId}`;
      if (untilId) url += `&until_id=${untilId}`;
      if (nextToken) url += `&pagination_token=${nextToken}`;

      const res = await fetch(url, { headers: { "Authorization": `Bearer ${X_BEARER_TOKEN}` } });
      if (!res.ok) {
         if (res.status === 429) {
             throw new Error("X-API Rate Limit erreicht (429).");
         }
         const errText = await res.text();
         throw new Error(`X API fetch failed (${res.status}): ${errText}`);
      }
      const data = await res.json();

      if (!data.data || data.data.length === 0) break;

      for (const tweet of data.data) {
        totalFetched++;
        
        // Deduplication Check
        const { count: existCount } = await supabase
          .from("agent_workspace")
          .select("*", { count: 'exact', head: true })
          .eq("agent_id", AGENT_ID)
          .eq("artifact_type", "x_post")
          .contains("metadata", { external_id: tweet.id });
          
        if (existCount && existCount > 0) {
           skipped++;
           continue;
        }

        const content = tweet.text;
        const tickers = (tweet.entities?.cashtags || []).map((c: any) => c.tag.toUpperCase());
        
        const baseMetadata = await extractMetadata(content);
        const finalMetadata = {
          ...baseMetadata,
          author: cleanName,
          external_id: tweet.id,
          published_at: tweet.created_at,
          tickers: Array.from(new Set([...tickers, ...(baseMetadata.tickers as string[] || [])])),
        };

        const embedding = await getEmbedding(content);
        const { error: insertError } = await supabase
          .from("agent_workspace")
          .insert({
            agent_id: AGENT_ID,
            artifact_type: "x_post",
            content: content,
            embedding: embedding,
            metadata: finalMetadata
          });

        if (!insertError) count++;
        
        if (count > 0 && count % 20 === 0) {
            await sendTelemetry(`[System] Sync ${cleanName}: ${count} neue Posts verarbeitet...`);
        }
      }
      
      nextToken = data.meta?.next_token;
      if (!nextToken) break;
    }

    await sendTelemetry(`[System] Sync ${cleanName} abgeschlossen: ${count} neu gespeichert, ${skipped} Duplikate übersprungen. (Insgesamt ${totalFetched} von X geladen)`);
  } catch (err: any) {
    console.error(`Background sync failed for ${cleanName}:`, err);
    await sendTelemetry(`[System] Sync ${cleanName} abgebrochen: ${err.message}`);
  } finally {
    activeSyncs.delete(cleanName);
  }
}

// Tool: Sync Influencer News
server.registerTool(
  "sync_influencer_news",
  {
    title: "Sync Influencer News",
    description: "Fetch latest posts from an X influencer and store them in the Workspace.",
    inputSchema: {
      username: z.string().describe("The X username (e.g. @elonmusk)"),
      limit: z.number().optional().default(100).describe("Max tweets to fetch (1-500)"),
      start_time: z.string().optional().describe("ISO 8601 date string (e.g. '2024-01-01T00:00:00Z'). Used to fetch historical posts if no prior sync exists."),
    },
  },
  async ({ username, limit, start_time }: any) => {
    if (!X_BEARER_TOKEN || X_BEARER_TOKEN.includes("YOUR_X_BEARER_TOKEN")) {
      return { content: [{ type: "text", text: "Error: X_BEARER_TOKEN is not configured in .env" }], isError: true };
    }

    const cleanName = username.startsWith("@") ? username : `@${username}`;

    if (activeSyncs.has(cleanName)) {
       return { content: [{ type: "text", text: `Ein Hintergrund-Sync für ${cleanName} läuft bereits. Bitte warten.` }] };
    }

    activeSyncs.add(cleanName);

    // Start background job (do not await)
    runBackgroundSync(cleanName, username, limit, start_time);

    return { content: [{ type: "text", text: `Hintergrund-Sync für ${cleanName} erfolgreich gestartet. Ich informiere dich via Chat über den Fortschritt.` }] };
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
