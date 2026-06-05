import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase, getEmbeddingsBatch, extractMetadata, sendTelemetry, X_BEARER_TOKEN, AGENT_ID } from "./shared.ts";

export const activeSyncControllers = new Map<string, AbortController>();

// --- X API Helpers ---
async function getXUserId(username: string): Promise<{id: string, name: string}> {
  const cleanName = username.startsWith("@") ? username.substring(1) : username;
  
  // 1. Check Cache in Supabase
  const { data: cachedUser } = await supabase
    .from("x_users")
    .select("x_id, screen_name")
    .eq("username", cleanName)
    .single();

  if (cachedUser?.x_id && cachedUser?.screen_name) return { id: cachedUser.x_id, name: cachedUser.screen_name };

  // 2. Fetch from X API if not cached or missing name
  const res = await fetch(`https://api.twitter.com/2/users/by/username/${cleanName}`, {
    headers: { "Authorization": `Bearer ${X_BEARER_TOKEN}` }
  });
  if (!res.ok) throw new Error(`X API failed to resolve user: ${res.status}`);
  const data = await res.json();
  if (!data.data?.id) throw new Error(`User ${username} not found on X.`);
  
  const userId = data.data.id;
  const screenName = data.data.name;
  
  // 3. Store in Cache
  await supabase.from("x_users").upsert({ username: cleanName, x_id: userId, screen_name: screenName });
  
  return { id: userId, name: screenName };
}

async function runBackgroundSync(cleanName: string, username: string, limit: number, start_time?: string, signal?: AbortSignal) {
  console.log(`[X Sync] Background job started for ${cleanName}`);
  try {
    await sendTelemetry(`[System] Hintergrund-Sync für ${cleanName} startet...`);
    const { id: userId } = await getXUserId(username);

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
        if (signal?.aborted) throw new Error("Sync wurde vom Benutzer abgebrochen.");
        const content = tweet.text;
        const tickers = (tweet.entities?.cashtags || []).map((c: any) => c.tag.toUpperCase());
        
        const finalMetadata = {
          author: cleanName,
          external_id: tweet.id,
          published_at: tweet.created_at,
          tickers: Array.from(new Set(tickers)),
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
        const tickersStr = tickers.length > 0 ? tickers.join(', ') : 'Keine';

        await sendTelemetry(
          `[X-Post] 📅 ${dateStr}\n` +
          `📝 "${content}"\n` +
          `🔑 Tickers: ${tickersStr}`
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
            text: `Der Hintergrund-Sync für ${cleanName} ist soeben mit ${totalSaved} verarbeiteten Posts abgeschlossen worden. Bitte erstelle jetzt die versprochene Zusammenfassung für den Boss. Nutze deine Such-Tools (WICHTIG: Setze den Parameter 'limit' strikt auf ${totalSaved} und suche AUSSCHLIESSLICH nach ${cleanName}, nach keinen anderen Accounts!) um diese neuesten Posts abzurufen, analysiere sie und schreibe die Zusammenfassung an 'boss'.`,
            msg_type: "chat"
          }),
        });
      } catch (e) {
        console.error("Failed to trigger CCO summary:", e);
      }
    }
  } catch (err: any) {
    if (err.name === 'AbortError' || err.message.includes('abgebrochen')) {
      await sendTelemetry(`[System] Sync ${cleanName} wurde vom Benutzer abgebrochen.`);
    } else {
      console.error(`Background sync failed for ${cleanName}:`, err);
      await sendTelemetry(`[System] Sync ${cleanName} abgebrochen: ${err.message}`);
    }
  } finally {
    // Release in-memory lock
    activeSyncControllers.delete(cleanName);
  }
}

export function registerXTools(server: McpServer) {
  server.registerTool(
    "manage_background_sync",
    {
      title: "Manage Background Sync",
      description: "Start or cancel background syncs for influencer news.",
      inputSchema: {
        action: z.enum(["START", "CANCEL"]).describe("The action to perform"),
        username: z.string().describe("The X username (e.g. @elonmusk) or 'all'"),
        limit: z.number().optional().default(100).describe("Max tweets to fetch (for START)"),
        start_time: z.string().optional().describe("ISO 8601 date string for historical backfill (for START)"),
      },
    },
    async ({ action, username, limit, start_time }: any) => {
      if (action === "START") {
          if (!X_BEARER_TOKEN || X_BEARER_TOKEN.includes("YOUR_X_BEARER_TOKEN")) {
            return { content: [{ type: "text", text: "Error: X_BEARER_TOKEN is not configured in .env" }], isError: true };
          }

          if (username.toLowerCase() === "all") {
            const { data: influencers, error } = await supabase.from("x_users").select("username").eq("is_active", true);
            if (error || !influencers || influencers.length === 0) {
               return { content: [{ type: "text", text: "Es wurden keine aktiven Influencer in der Datenbank gefunden." }] };
            }
            
            // Start sequential background sync
            (async () => {
               for (const inf of influencers) {
                  const cleanName = `@${inf.username}`;
                  if (activeSyncControllers.has(cleanName)) continue;
                  const controller = new AbortController();
                  activeSyncControllers.set(cleanName, controller);
                  await runBackgroundSync(cleanName, inf.username, limit, start_time, controller.signal);
               }
            })();
            
            return { content: [{ type: "text", text: `Massen-Sync für ${influencers.length} Influencer gestartet. Dies geschieht nacheinander im Hintergrund.` }] };
          }

          let cleanName = (username.startsWith("@") ? username : `@${username}`).toLowerCase();
          let targetUsername = username.startsWith("@") ? username.substring(1).toLowerCase() : username.toLowerCase();

          // If not explicitly @ handle, try fuzzy search
          if (!username.startsWith("@")) {
             const queryEmbedding = (await getEmbeddingsBatch([username]))[0];
             const { data: searchResults, error: searchError } = await supabase.rpc("search_influencers", {
               query_embedding: queryEmbedding,
               query_text: username,
               match_threshold: 0.5,
               match_count: 5
             });

             if (!searchError && searchResults && searchResults.length > 0) {
                if (searchResults.length === 1 || searchResults[0].similarity > 0.8 || searchResults[0].username === targetUsername) {
                   targetUsername = searchResults[0].username;
                   cleanName = `@${targetUsername}`;
                } else {
                   const listStr = searchResults.map((r: any) => `- @${r.username} (${r.screen_name})`).join("\n");
                   return { content: [{ type: "text", text: `Ich habe mehrere mögliche Influencer gefunden für '${username}'. Bitte sei spezifischer (z.B. mit @handle):\n${listStr}` }] };
                }
             }
          }

          // In-Memory Lock Check Check
          if (activeSyncControllers.has(cleanName)) {
             return { content: [{ type: "text", text: `Ein Hintergrund-Sync für ${cleanName} läuft bereits.` }] };
          }

          const controller = new AbortController();
          activeSyncControllers.set(cleanName, controller);

          console.log(`[X Sync] Starting background sync for ${cleanName}...`);
          runBackgroundSync(cleanName, targetUsername, limit, start_time, controller.signal);

          return { content: [{ type: "text", text: `Hintergrund-Sync für ${cleanName} erfolgreich gestartet. Ich informiere dich via Chat über den Fortschritt.` }] };
      } else if (action === "CANCEL") {
          const cleanName = (username.startsWith("@") ? username : `@${username}`).toLowerCase();
          const controller = activeSyncControllers.get(cleanName);
          if (!controller) {
            return { content: [{ type: "text", text: `Es läuft aktuell kein Sync für ${cleanName}.` }] };
          }
          controller.abort();
          return { content: [{ type: "text", text: `Abbruch-Signal für den Sync von ${cleanName} wurde gesendet.` }] };
      }
      return { content: [{ type: "text", text: `Invalid action` }], isError: true };
    }
  );

  server.registerTool(
    "manage_influencers",
    {
      title: "Manage Influencers",
      description: "List, add, or remove influencers from the database.",
      inputSchema: {
        action: z.enum(["LIST", "ADD", "REMOVE"]).describe("The action to perform"),
        username: z.string().optional().describe("The X username (for ADD or REMOVE)"),
        notes: z.string().optional().describe("Optional notes about this influencer (for ADD)"),
      },
    },
    async ({ action, username, notes }: any) => {
      try {
        if (action === "LIST") {
            const { data, error } = await supabase.from("x_users").select("username, screen_name, notes").eq("is_active", true).order("username");
            if (error) throw error;
            if (!data || data.length === 0) return { content: [{ type: "text", text: `Keine aktiven Influencer in der Datenbank gefunden.` }] };
            const formatted = data.map((i: any, idx: number) => `${idx + 1}. @${i.username} (${i.screen_name || 'N/A'}) - ${i.notes || ''}`).join("\n");
            return { content: [{ type: "text", text: `Hier sind alle überwachten Influencer:\n\n${formatted}` }] };
        } else if (action === "ADD") {
            if (!username) throw new Error("username is required for ADD");
            const cleanName = username.startsWith("@") ? username.substring(1).toLowerCase() : username.toLowerCase();
            const res = await fetch(`https://api.twitter.com/2/users/by/username/${cleanName}`, {
              headers: { "Authorization": `Bearer ${X_BEARER_TOKEN}` }
            });
            if (!res.ok) throw new Error(`X API failed to resolve user: ${res.status}`);
            const data = await res.json();
            if (!data.data?.id) throw new Error(`User ${username} not found on X.`);
            const userId = data.data.id;
            const screenName = data.data.name;
            const embedText = `username: ${cleanName} screen_name: ${screenName} notes: ${notes || ''}`;
            const embedding = (await getEmbeddingsBatch([embedText]))[0];
            const { error } = await supabase.from("x_users").upsert({
              username: cleanName,
              x_id: userId,
              screen_name: screenName,
              notes: notes || null,
              embedding: embedding,
              is_active: true
            });
            if (error) throw error;
            return { content: [{ type: "text", text: `Influencer @${cleanName} (${screenName}) wurde erfolgreich zur Datenbank hinzugefügt.` }] };
        } else if (action === "REMOVE") {
            if (!username) throw new Error("username is required for REMOVE");
            const cleanName = username.startsWith("@") ? username.substring(1).toLowerCase() : username.toLowerCase();
            const { error } = await supabase.from("x_users").delete().eq("username", cleanName);
            if (error) throw error;
            return { content: [{ type: "text", text: `Influencer @${cleanName} wurde erfolgreich aus der Datenbank entfernt.` }] };
        }
        throw new Error("Invalid action");
      } catch (err: any) {
        return { content: [{ type: "text", text: `Fehler: ${err.message}` }], isError: true };
      }
    }
  );
}

