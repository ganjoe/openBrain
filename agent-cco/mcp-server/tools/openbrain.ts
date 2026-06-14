import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase, getEmbedding, extractMetadata, AGENT_ID, GLOBAL_BRAIN_ACCESS, sendTelemetry } from "./shared.ts";

async function dumpToChat(title: string, data: any[]) {
  if (!data || data.length === 0) {
    await fetch("http://nexus-service:7734/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_agent: AGENT_ID, to: "boss", text: `*Keine Ergebnisse für: ${title}*`, msg_type: "chat" }),
    });
    return;
  }

  // Header message
  await fetch("http://nexus-service:7734/api/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from_agent: AGENT_ID, to: "boss", text: `*Ergebnisse für: ${title} (${data.length} Posts)*`, msg_type: "chat" }),
  });

  // Individual post messages
  for (const t of data) {
    const author = t.metadata?.author || "Unknown";
    const tickers = t.metadata?.tickers?.length ? t.metadata.tickers.join(", ") : "None";
    // Escape markdown headers (hashtags at the start of a line)
    const safeContent = t.content.replace(/^(#+)/gm, '\\$1');
    const dateStr = new Date(t.created_at).toLocaleString('de-DE', { 
      day: '2-digit', month: '2-digit', year: 'numeric', 
      hour: '2-digit', minute: '2-digit' 
    });
    
    const postText = `**[${dateStr}] @${author}** *(Tickers: ${tickers})*\n${safeContent}`;
    
    await fetch("http://nexus-service:7734/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_agent: AGENT_ID, to: "boss", text: postText, msg_type: "chat" }),
    });

    // Small delay to maintain chronological ordering in the UI/MQTT
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function sendSearchTelemetry(keyword: string, data: any[]) {
  if (!data || data.length === 0) {
    await sendTelemetry(`[Suche] Suche nach "${keyword}" ergab 0 Treffer.`);
    return;
  }
  
  const countsByDay: Record<string, number> = {};
  for (const t of data) {
    const dateStr = new Date(t.created_at).toISOString().split('T')[0];
    countsByDay[dateStr] = (countsByDay[dateStr] || 0) + 1;
  }
  
  const sortedDays = Object.keys(countsByDay).sort();
  await sendTelemetry(`[Suche] Suche nach "${keyword}" ergab ${data.length} Treffer.`);
  for (const day of sortedDays) {
    await sendTelemetry(` - ${day}: ${countsByDay[day]} Treffer`);
  }
}

function formatSearchResults(data: any[], returnMode: string) {
  if (returnMode === "ids_only") {
    return data.map((t: any, i: number) => `[${i + 1}] ID: ${t.id} | Date: ${new Date(t.created_at).toLocaleDateString()}`).join("\n");
  } else if (returnMode === "full_text") {
    return data.map((t: any, i: number) => `[${i + 1}] ID: ${t.id} | Agent: ${t.agent_id} | Type: ${t.artifact_type} | Date: ${new Date(t.created_at).toLocaleDateString()}\nContent: ${t.content}\nMetadata: ${JSON.stringify(t.metadata)}`).join("\n\n");
  } else {
    return data.map((t: any, i: number) => {
      let snippet = t.content || "";
      if (snippet.length > 150) {
        snippet = snippet.substring(0, 150) + "...";
      }
      const author = t.metadata?.author || "Unknown";
      return `[${i + 1}] ID: ${t.id} | Date: ${new Date(t.created_at).toLocaleDateString()} | Author: ${author}\nSnippet: ${snippet}`;
    }).join("\n\n");
  }
}

export function registerOpenBrainTools(server: McpServer) {
  // Tool: Search Thoughts
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
        await sendSearchTelemetry(query, data || []);
        if (!data || data.length === 0) {
          return { content: [{ type: "text", text: "No results." }] };
        }

        const results = data.map((t: any, i: number) => {
            return `[${i + 1}] ID: ${t.id} | Agent: ${t.agent_id} | Type: ${t.thought_type} | Date: ${new Date(t.created_at).toLocaleDateString()}\nContent: ${t.content}`;
        });

        return { content: [{ type: "text", text: results.join("\n\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: Search Influencer Posts
  server.registerTool(
    "search_influencer_posts",
    {
      title: "Search Influencer Posts",
      description: "Search the workspace for influencer posts using semantic, exact, or ID-based methods, or find first mentions.",
      inputSchema: {
        action: z.enum(["SEMANTIC", "EXACT", "READ_IDS", "FIRST_MENTIONS_AND_DISCOVERY"]).describe("The type of search"),
        query: z.string().optional().describe("Search query for SEMANTIC or EXACT. Leave empty for EXACT to list recent posts."),
        limit: z.number().optional().default(200).describe("Max results (default: 200)"),
        threshold: z.number().optional().default(0.5).describe("Similarity threshold for SEMANTIC (default: 0.5)"),
        artifact_type: z.string().optional().describe("Filter by artifact type (default: 'x_post')"),
        days_back: z.number().optional().describe("Filter posts from the last X days"),
        dump_to_chat: z.boolean().optional().default(false).describe("If true, dump results to chat instead of returning text"),
        return_mode: z.enum(["ids_only", "snippets", "full_text"]).optional().default("snippets").describe("Return format"),
        ids: z.array(z.string()).optional().describe("Array of post IDs (for READ_IDS)"),
        keywords: z.array(z.string()).optional().describe("Keywords for FIRST_MENTIONS_AND_DISCOVERY. If empty, searches for completely new tickers globally."),
        authors: z.array(z.string()).optional().describe("CRITICAL: If the user asks for a specific influencer/author (like 'von serenity'), you MUST pass their name here! Do not perform a global search if an author is requested."),
        start_date: z.string().optional().describe("Optional start date (ISO format) for FIRST_MENTIONS_AND_DISCOVERY"),
        ...(GLOBAL_BRAIN_ACCESS ? { owner: z.string().optional().describe("Filter by agent ID.") } : {})
      },
    },
    async ({ action, query, limit, threshold, artifact_type, days_back, dump_to_chat, return_mode, ids, keywords, authors, start_date, owner }: any) => {
      try {
        const p_agent_id = GLOBAL_BRAIN_ACCESS ? (owner || null) : AGENT_ID;
        
        if (action === "SEMANTIC") {
            const actual_query = query || "";
            const qEmb = await getEmbedding(actual_query);
            const { data, error } = await supabase.rpc("semantic_search_workspace", {
              query_embedding: qEmb, match_threshold: threshold, match_count: limit,
              p_agent_id: p_agent_id, p_artifact_type: artifact_type || null, p_days_back: days_back || null
            });
            if (error) throw error;
            await sendSearchTelemetry(actual_query, data || []);
            if (!data || data.length === 0) return { content: [{ type: "text", text: "No results found." }] };
            if (dump_to_chat) {
              await dumpToChat(actual_query, data);
              return { content: [{ type: "text", text: `Success. ${data.length} posts dumped to chat. [STOP]` }] };
            }
            return { content: [{ type: "text", text: formatSearchResults(data, return_mode) }] };
        } else if (action === "EXACT") {
            const actual_keyword = query || "";
            const { data, error } = await supabase.rpc("exact_search_workspace", {
              p_exact_keyword: actual_keyword === "" ? null : actual_keyword,
              match_count: limit, p_agent_id: p_agent_id, p_artifact_type: artifact_type || null, p_days_back: days_back || null
            });
            if (error) throw error;
            await sendSearchTelemetry(actual_keyword === "" ? "Letzte Posts" : actual_keyword, data || []);
            if (!data || data.length === 0) return { content: [{ type: "text", text: "No results found." }] };
            if (dump_to_chat) {
              await dumpToChat(actual_keyword === "" ? "Letzte Posts" : actual_keyword, data);
              return { content: [{ type: "text", text: `Success. ${data.length} posts dumped to chat. [STOP]` }] };
            }
            return { content: [{ type: "text", text: formatSearchResults(data, return_mode) }] };
        } else if (action === "READ_IDS") {
            if (!ids || ids.length === 0) return { content: [{ type: "text", text: "No IDs provided." }] };
            const { data, error } = await supabase.from("agent_workspace").select("*").in("id", ids);
            if (error) throw error;
            if (!data || data.length === 0) return { content: [{ type: "text", text: "No posts found for IDs." }] };
            const results = data.map((t: any, i: number) => `[${i + 1}] ID: ${t.id} | Date: ${new Date(t.created_at).toLocaleDateString()}\nContent: ${t.content}\nMetadata: ${JSON.stringify(t.metadata)}`);
            return { content: [{ type: "text", text: results.join("\n\n") }] };
        } else if (action === "FIRST_MENTIONS_AND_DISCOVERY") {
            const targetAuthors = authors && authors.length > 0 ? authors.map((a: string) => a.toLowerCase().startsWith("@") ? a.toLowerCase() : `@${a.toLowerCase()}`) : null;
            const targetKeywords = keywords && keywords.length > 0 ? keywords : null;
            
            const { data, error } = await supabase.rpc("discover_first_mentions", { 
                p_keywords: targetKeywords, 
                p_authors: targetAuthors, 
                p_start_date: start_date || null,
                p_limit: limit 
            });
            if (error) throw error;
            if (!data || data.length === 0) return { content: [{ type: "text", text: "Keine ersten Erwähnungen gefunden." }] };
            
            const title = targetKeywords ? `Erste Erwähnungen für: ${targetKeywords.join(', ')}` : (targetAuthors ? `Zuletzt entdeckte Ticker von ${targetAuthors.join(', ')}` : "Zuletzt entdeckte (neue) Ticker");
            
            if (dump_to_chat) {
              let dumpText = `**${title}**\n\n`;
              data.forEach((r: any) => {
                const dateStr = r.first_mentioned_at ? new Date(r.first_mentioned_at).toLocaleString('de-DE') : 'Unbekanntes Datum';
                dumpText += `### Ticker/Keyword: ${r.keyword}\n📅 ${dateStr} | 👤 ${r.author} | 🔗 ID: ${r.post_id}\n📝 "${r.post_content}"\n\n---\n\n`;
              });
              await sendTelemetry(dumpText);
              return { content: [{ type: "text", text: `Success. ${data.length} records have been published directly to the chat via telemetry. Do not summarize them. Just output [STOP].` }] };
            } else {
              const results = data.map((r: any) => `Ticker: ${r.keyword} | First Mentioned: ${new Date(r.first_mentioned_at).toLocaleString('de-DE')} | Author: ${r.author} | Content: ${r.post_content}`);
              return { content: [{ type: "text", text: `Hier sind die Daten:\n${results.join('\n\n')}` }] };
            }
        }
        throw new Error("Invalid action");
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: Capture Thought
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
