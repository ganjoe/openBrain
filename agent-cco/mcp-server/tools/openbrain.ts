import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase, getEmbedding, extractMetadata, AGENT_ID, GLOBAL_BRAIN_ACCESS, sendTelemetry } from "./shared.ts";

async function dumpToChat(title: string, data: any[]) {
  const chatResults = data.map((t: any) => {
    const author = t.metadata?.author || "Unknown";
    const tickers = t.metadata?.tickers?.join(", ") || "None";
    const keywords = t.metadata?.keywords?.join(", ") || "None";
    return `**📅 ${new Date(t.created_at).toLocaleDateString()} | 👤 ${author} | 🏷️ Type: ${t.artifact_type || 'N/A'}**\n${t.content}\n*Keywords: ${keywords}* | *Tickers: ${tickers}*\n---`;
  });
  const fullText = `### Ergebnisse für: ${title}\n\n` + chatResults.join("\n\n");
  
  await fetch("http://nexus-service:7734/api/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from_agent: AGENT_ID, to: "boss", text: fullText, msg_type: "chat" }),
  });
}

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

  // Tool: Semantic Search Workspace
  server.registerTool(
    "semantic_search_workspace",
    {
      title: "Semantic Search Workspace",
      description: "Search for posts based on meaning, topics, or themes using AI embeddings. Do NOT use this for specific tickers or acronyms.",
      inputSchema: {
        query: z.string().describe("What to search for"),
        limit: z.number().optional().default(200).describe("Max results (default: 200). Keep it small to avoid context overload."),
        threshold: z.number().optional().default(0.5).describe("Similarity threshold (0.0 to 1.0, default: 0.5). Use higher values for stricter semantic matches."),
        artifact_type: z.string().optional().describe("Filter by artifact type (e.g., 'x_post')"),
        days_back: z.number().optional().describe("Filter posts from the last X days."),
        dump_to_chat: z.boolean().optional().default(false).describe("If true, results are directly published to the user's chat and NOT returned to you for analysis. Use this when the user says 'list', 'show me all', 'dump', etc."),
        ...(GLOBAL_BRAIN_ACCESS ? { owner: z.string().optional().describe("Filter by agent ID.") } : {})
      },
    },
    async ({ query, limit, threshold, artifact_type, days_back, dump_to_chat, owner }: any) => {
      try {
        console.log(`[semantic_search_workspace] query="${query}" type="${artifact_type}" limit=${limit} days_back=${days_back} dump=${dump_to_chat}`);
        const p_agent_id = GLOBAL_BRAIN_ACCESS ? (owner || null) : AGENT_ID;
        
        const qEmb = await getEmbedding(query);
        const { data, error } = await supabase.rpc("semantic_search_workspace", {
          query_embedding: qEmb,
          match_threshold: threshold,
          match_count: limit,
          p_agent_id: p_agent_id,
          p_artifact_type: artifact_type || null,
          p_days_back: days_back || null
        });

        if (error) {
           console.error("[semantic_search_workspace] DB error:", error);
           throw error;
        }
        
        console.log(`[semantic_search_workspace] Found ${data ? data.length : 0} results.`);
        if (!data || data.length === 0) {
            await sendTelemetry(`[Suche] Semantische Workspace-Suche nach "${query}" ergab 0 Treffer.`);
            return { content: [{ type: "text", text: "No results found in workspace." }] };
        }
        await sendTelemetry(`[Suche] Semantische Workspace-Suche nach "${query}" ergab ${data.length} Treffer.`);

        if (dump_to_chat) {
          await dumpToChat(query, data);
          return { content: [{ type: "text", text: `Success. ${data.length} posts have been published directly to the chat. Do not summarize them. Just output [STOP].` }] };
        }

        const results = data.map((t: any, i: number) => {
            return `[${i + 1}] Agent: ${t.agent_id} | Type: ${t.artifact_type} | Date: ${new Date(t.created_at).toLocaleDateString()}\nContent: ${t.content}\nMetadata: ${JSON.stringify(t.metadata)}`;
        });

        return { content: [{ type: "text", text: results.join("\n\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: Exact Keyword Search
  server.registerTool(
    "exact_keyword_search",
    {
      title: "Exact Keyword Search",
      description: "Search for EXACT text matches, tickers, authors, or specific acronyms (e.g. 'SIVE', 'Auros', '@aleabitoreddit'). This checks structured metadata for the exact word.",
      inputSchema: {
        keyword: z.string().describe("The exact keyword, ticker, or author to find"),
        limit: z.number().optional().default(200).describe("Max results (default: 200)."),
        artifact_type: z.string().optional().describe("Filter by artifact type (e.g., 'x_post')"),
        days_back: z.number().optional().describe("Filter posts from the last X days."),
        dump_to_chat: z.boolean().optional().default(false).describe("If true, results are directly published to the user's chat and NOT returned to you for analysis. Use this when the user says 'list', 'show me all', 'dump', etc."),
        ...(GLOBAL_BRAIN_ACCESS ? { owner: z.string().optional().describe("Filter by agent ID.") } : {})
      },
    },
    async ({ keyword, limit, artifact_type, days_back, dump_to_chat, owner }: any) => {
      try {
        console.log(`[exact_keyword_search] keyword="${keyword}" type="${artifact_type}" limit=${limit} days_back=${days_back} dump=${dump_to_chat}`);
        const p_agent_id = GLOBAL_BRAIN_ACCESS ? (owner || null) : AGENT_ID;
        
        const { data, error } = await supabase.rpc("exact_search_workspace", {
          p_exact_keyword: keyword,
          match_count: limit,
          p_agent_id: p_agent_id,
          p_artifact_type: artifact_type || null,
          p_days_back: days_back || null
        });

        if (error) {
           console.error("[exact_keyword_search] DB error:", error);
           throw error;
        }
        
        console.log(`[exact_keyword_search] Found ${data ? data.length : 0} results.`);
        if (!data || data.length === 0) {
            await sendTelemetry(`[Suche] Exakte Workspace-Suche nach "${keyword}" ergab 0 Treffer.`);
            return { content: [{ type: "text", text: "No results found in workspace." }] };
        }
        await sendTelemetry(`[Suche] Exakte Workspace-Suche nach "${keyword}" ergab ${data.length} Treffer.`);

        if (dump_to_chat) {
          await dumpToChat(keyword, data);
          return { content: [{ type: "text", text: `Success. ${data.length} posts have been published directly to the chat. Do not summarize them. Just output [STOP].` }] };
        }

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
