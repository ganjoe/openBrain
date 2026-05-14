import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase, getEmbedding, extractMetadata, AGENT_ID, GLOBAL_BRAIN_ACCESS, sendTelemetry } from "./shared.ts";

export function registerOpenBrainTools(server: McpServer) {
  // Tool: Search
  server.registerTool(
    "search_thoughts",
    {
      title: "Search Thoughts",
      description: "Search captured thoughts using hybrid search.",
      inputSchema: {
        query: z.string().describe("What to search for"),
        limit: z.number().optional().default(200).describe("Max results (default: 200). Keep it small to avoid context overload."),
        threshold: z.number().optional().default(0.5).describe("Similarity threshold (0.0 to 1.0, default: 0.5). Use higher values for stricter semantic matches."),
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
        if (!data || data.length === 0) {
          await sendTelemetry(`[Suche] Gedanken-Suche nach "${query}" ergab 0 Treffer.`);
          return { content: [{ type: "text", text: "No results." }] };
        }
        await sendTelemetry(`[Suche] Gedanken-Suche nach "${query}" ergab ${data.length} Treffer.`);

        const results = data.map((t: any, i: number) => {
            return `[${i + 1}] Agent: ${t.agent_id} | Type: ${t.thought_type} | Date: ${new Date(t.created_at).toLocaleDateString()}\nContent: ${t.content}`;
        });

        return { content: [{ type: "text", text: results.join("\n\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: Search Workspace
  server.registerTool(
    "search_workspace",
    {
      title: "Search Workspace",
      description: "Search raw artifacts (like X-Posts) and their metadata (e.g. tickers, authors, topics) in the agent workspace. Use this tool when asked to find or analyze posts matching specific tickers or keywords.",
      inputSchema: {
        query: z.string().describe("What to search for"),
        limit: z.number().optional().default(200).describe("Max results (default: 200). Keep it small to avoid context overload."),
        threshold: z.number().optional().default(0.5).describe("Similarity threshold (0.0 to 1.0, default: 0.5). Use higher values for stricter semantic matches."),
        artifact_type: z.string().optional().describe("Filter by artifact type (e.g., 'x_post')"),
        ...(GLOBAL_BRAIN_ACCESS ? { owner: z.string().optional().describe("Filter by agent ID.") } : {})
      },
    },
    async ({ query, limit, threshold, artifact_type, owner }: any) => {
      try {
        console.log(`[search_workspace] query="${query}" type="${artifact_type}" limit=${limit} threshold=${threshold}`);
        const p_agent_id = GLOBAL_BRAIN_ACCESS ? (owner || null) : AGENT_ID;
        
        const qEmb = await getEmbedding(query);
        const { data, error } = await supabase.rpc("hybrid_search_workspace", {
          query_embedding: qEmb,
          query_text: query,
          match_threshold: threshold,
          match_count: limit,
          p_agent_id: p_agent_id,
          p_artifact_type: artifact_type || null
        });

        if (error) {
           console.error("[search_workspace] DB error:", error);
           throw error;
        }
        
        console.log(`[search_workspace] Found ${data ? data.length : 0} results.`);
        if (!data || data.length === 0) {
            await sendTelemetry(`[Suche] Workspace-Suche nach "${query}" ergab 0 Treffer.`);
            return { content: [{ type: "text", text: "No results found in workspace." }] };
        }
        await sendTelemetry(`[Suche] Workspace-Suche nach "${query}" ergab ${data.length} Treffer.`);

        const results = data.map((t: any, i: number) => {
            return `[${i + 1}] Agent: ${t.agent_id} | Type: ${t.artifact_type} | Date: ${new Date(t.created_at).toLocaleDateString()}\nContent: ${t.content}\nMetadata: ${JSON.stringify(t.metadata)}`;
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
}
