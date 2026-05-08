import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase, getEmbeddingsBatch, extractMetadata, sendTelemetry, X_BEARER_TOKEN, AGENT_ID } from "./shared.ts";

// --- X API Helpers ---
async function getXUserId(username: string): Promise<string> {
  const cleanName = username.startsWith("@") ? username.substring(1) : username;
  
  // 1. Check Cache in Supabase
  const { data: cachedUser } = await supabase
    .from("x_users")
    .select("x_id")
    .eq("username", cleanName)
    .single();

  if (cachedUser?.x_id) return cachedUser.x_id;

  // 2. Fetch from X API if not cached
  const res = await fetch(`https://api.twitter.com/2/users/by/username/${cleanName}`, {
    headers: { "Authorization": `Bearer ${X_BEARER_TOKEN}` }
  });
  if (!res.ok) throw new Error(`X API failed to resolve user: ${res.status}`);
  const data = await res.json();
  if (!data.data?.id) throw new Error(`User ${username} not found on X.`);
  
  const userId = data.data.id;
  
  // 3. Store in Cache
  await supabase.from("x_users").upsert({ username: cleanName, x_id: userId });
  
  return userId;
}

async function runBackgroundSync(cleanName: string, username: string, limit: number, start_time?: string) {
  console.log(`[X Sync] Background job started for ${cleanName}`);
  try {
    await sendTelemetry(`[System] Hintergrund-Sync für ${cleanName} startet...`);
    const userId = await getXUserId(username);

    // 1. Determine since_id or until_id based on DB state
    let sinceId = "";
    let untilId = "";
    
    // Find newest post for since_id
    const { data: latestRecord } = await supabase
      .from("agent_workspace")
      .select("metadata")
      .eq("agent_id", AGENT_ID)
      .eq("artifact_type", "x_post")
      .contains("metadata", { author: cleanName })
      .order("x_external_id", { ascending: false }) // Order by Snowflake ID
      .limit(1);

    if (latestRecord && latestRecord.length > 0) {
      sinceId = (latestRecord[0].metadata as any).external_id;
    }

    if (start_time) {
       // Check if we need to backfill (get tweets older than our oldest post, but after start_time)
       const { data: oldestRecord } = await supabase
        .from("agent_workspace")
        .select("metadata")
        .eq("agent_id", AGENT_ID)
        .eq("artifact_type", "x_post")
        .contains("metadata", { author: cleanName })
        .order("x_external_id", { ascending: true }) // Order by Snowflake ID (asc = oldest first)
        .limit(1);
        
       if (oldestRecord && oldestRecord.length > 0) {
          const oldestDateStr = (oldestRecord[0].metadata as any).published_at;
          if (!oldestDateStr || new Date(start_time) < new Date(oldestDateStr)) {
            untilId = (oldestRecord[0].metadata as any).external_id;
          } else {
            // start_time is newer than our oldest record. Ignore it to prevent an impossible time window
            // and allow the script to naturally fall back to sinceId for a forward-sync.
            start_time = undefined;
          }
       }
    }

    // 2. Fetch from X API with pagination
    let nextToken = "";
    let totalSaved = 0;
    let totalFetched = 0;
    const targetLimit = Math.min(Math.max(1, limit), 3200);
    
    // If we have a sinceId, we ignore the limit to close the gap
    const isUpdateSync = !!sinceId;
    const isTimeWindow = !!start_time;

    while (true) {
      const batchSize = Math.min(100, (isUpdateSync || isTimeWindow) ? 100 : (targetLimit - totalFetched));
      if (batchSize <= 0 && !isUpdateSync && !isTimeWindow) break;

      let url = `https://api.twitter.com/2/users/${userId}/tweets?max_results=${batchSize}&tweet.fields=created_at,entities`;
      
      if (untilId && start_time) {
        url += `&until_id=${untilId}&start_time=${start_time}`;
      } else if (sinceId) {
        url += `&since_id=${sinceId}`;
      } else if (untilId) {
        url += `&until_id=${untilId}`;
      } else if (start_time) {
        url += `&start_time=${start_time}`;
      }

      if (nextToken) url += `&pagination_token=${nextToken}`;

      await sendTelemetry(`[X API] Request: ${url.replace(X_BEARER_TOKEN, "***")}`);
      const res = await fetch(url, { headers: { "Authorization": `Bearer ${X_BEARER_TOKEN}` } });
      
      if (!res.ok) {
         if (res.status === 429) {
             const resetEpoch = Number(res.headers.get("x-rate-limit-reset"));
             const sleepMs = Math.max(1000, (resetEpoch * 1000) - Date.now() + 1000);
             await sendTelemetry(`[X API] Rate Limit (429). Pausiere für ${Math.round(sleepMs/1000)}s...`);
             await new Promise(r => setTimeout(r, sleepMs));
             continue; // Retry same request
         }
         const errText = await res.text();
         console.error(`[X API] Error ${res.status}: ${errText}`);
         throw new Error(`X API fetch failed (${res.status}): ${errText}`);
      }
      
      const data = await res.json();
      if (!data.data || data.data.length === 0) break;

      totalFetched += data.data.length;
      
      // 3. Bulk Processing
      const batchToInsert: any[] = [];
      const textsForEmbedding: string[] = [];
      
      for (const tweet of data.data) {
        const content = tweet.text;
        const tickers = (tweet.entities?.cashtags || []).map((c: any) => c.tag.toUpperCase());
        
        // Metadata extraction (batched later if possible, but extractMetadata is LLM based)
        // For now, we still call extractMetadata individually as it's complex, 
        // but we batch embeddings.
        const baseMetadata = await extractMetadata(content);
        const finalMetadata = {
          ...baseMetadata,
          author: cleanName,
          external_id: tweet.id,
          published_at: tweet.created_at,
          tickers: Array.from(new Set([...tickers, ...(baseMetadata.tickers as string[] || [])])),
        };

        textsForEmbedding.push(content);
        batchToInsert.push({
          agent_id: AGENT_ID,
          artifact_type: "x_post",
          content: content,
          metadata: finalMetadata,
          // embedding will be added after batch call
        });

        // Inform user via system channel (human readable)
        const dateStr = tweet.created_at ? new Date(tweet.created_at).toLocaleString('de-DE') : 'Unbekanntes Datum';
        const topics = Array.isArray(baseMetadata.topics) ? baseMetadata.topics.join(', ') : 'Keine';
        
        // Extract keywords or fallback to tickers if keywords don't exist
        let keywords = 'Keine';
        if (Array.isArray(baseMetadata.keywords)) {
          keywords = baseMetadata.keywords.join(', ');
        } else if (tickers && tickers.length > 0) {
          keywords = tickers.join(', ');
        }

        await sendTelemetry(
          `[X-Post] 📅 ${dateStr}\n` +
          `📝 "${content.substring(0, 100).replace(/\n/g, ' ')}..."\n` +
          `🏷️ Topics: ${topics} | 🔑 Keywords: ${keywords}`
        );
      }

      // Batch Embeddings
      const embeddings = await getEmbeddingsBatch(textsForEmbedding);
      batchToInsert.forEach((item, idx) => {
        item.embedding = embeddings[idx];
      });

      // Bulk Upsert to Supabase
      const { error: upsertError } = await supabase
        .from("agent_workspace")
        .upsert(batchToInsert, { onConflict: "x_external_id" });

      if (upsertError) {
        console.error("Upsert error details:", upsertError);
        throw new Error(`Supabase Upsert failed: [${upsertError.code}] ${upsertError.message}`);
      }

      totalSaved += batchToInsert.length;
      await sendTelemetry(`[System] Sync ${cleanName}: ${totalSaved} Posts verarbeitet (Batch: ${batchToInsert.length})...`);
      
      nextToken = data.meta?.next_token;
      if (!nextToken) break;
      
      // If we are just filling up to a limit and not closing a gap
      if (!isUpdateSync && !isTimeWindow && totalFetched >= targetLimit) break;
    }

    await sendTelemetry(`[System] Sync ${cleanName} abgeschlossen: ${totalSaved} neu/aktualisiert gespeichert.`);
    
    // Trigger CCO to generate the promised summary
    if (totalSaved > 0) {
      try {
        await fetch("http://nexus-service:7734/api/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from_agent: "system",
            to: "cco",
            text: `Der Hintergrund-Sync für ${cleanName} ist soeben mit ${totalSaved} verarbeiteten Posts abgeschlossen worden. Bitte erstelle jetzt die versprochene Zusammenfassung für den Boss. Nutze deine Such-Tools um die neuesten ${cleanName} Posts abzurufen, analysiere sie und schreibe die Zusammenfassung an 'boss'.`,
            message_type: "chat"
          }),
        });
      } catch (e) {
        console.error("Failed to trigger CCO summary:", e);
      }
    }
  } catch (err: any) {
    console.error(`Background sync failed for ${cleanName}:`, err);
    await sendTelemetry(`[System] Sync ${cleanName} abgebrochen: ${err.message}`);
  } finally {
    // Release persistent lock
    await supabase.from("x_sync_locks").delete().eq("username", cleanName);
  }
}

export function registerXTools(server: McpServer) {
  server.registerTool(
    "sync_influencer_news",
    {
      title: "Sync Influencer News",
      description: "Fetch latest posts from an X influencer and store them in the Workspace.",
      inputSchema: {
        username: z.string().describe("The X username (e.g. @elonmusk)"),
        limit: z.number().optional().default(100).describe("Max tweets to fetch (1-3200)"),
        start_time: z.string().optional().describe("ISO 8601 date string (e.g. 2024-05-01T00:00:00Z). Use this to fetch historical posts (Backfill) or for the first-time sync of an influencer."),
      },
    },
    async ({ username, limit, start_time }: any) => {
      if (!X_BEARER_TOKEN || X_BEARER_TOKEN.includes("YOUR_X_BEARER_TOKEN")) {
        return { content: [{ type: "text", text: "Error: X_BEARER_TOKEN is not configured in .env" }], isError: true };
      }

      const cleanName = (username.startsWith("@") ? username : `@${username}`).toLowerCase();

      // Check persistent lock in Supabase
      const { data: lock } = await supabase.from("x_sync_locks").select("*").eq("username", cleanName).single();
      if (lock) {
         return { content: [{ type: "text", text: `Ein Hintergrund-Sync für ${cleanName} läuft bereits (seit ${lock.locked_at}).` }] };
      }

      // Set persistent lock
      const { error: lockError } = await supabase.from("x_sync_locks").insert({ username: cleanName });
      if (lockError) {
         return { content: [{ type: "text", text: `Fehler beim Setzen des Locks: ${lockError.message}` }], isError: true };
      }

      console.log(`[X Sync] Starting background sync for ${cleanName}...`);
      // Start background job (do not await)
      runBackgroundSync(cleanName, username, limit, start_time);

      return { content: [{ type: "text", text: `Hintergrund-Sync für ${cleanName} erfolgreich gestartet. Ich informiere dich via Chat über den Fortschritt.` }] };
    }
  );
}
