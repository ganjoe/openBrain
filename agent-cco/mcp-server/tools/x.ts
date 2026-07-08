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
        const rawCashtags = (tweet.entities?.cashtags || []).map((c: any) => c.tag.toUpperCase());
        
        const customTickers: string[] = [];
        // Catch Asian/Numeric tickers in parentheses or with exchange suffix (e.g. 093370 or 093370.KS)
        const asianMatches = content.match(/(?<=\()\s*\d{4,6}\s*(?=[,)\s])|\b\d{4,6}\.[A-Z]{1,2}\b/g);
        if (asianMatches) {
            asianMatches.forEach((m: string) => customTickers.push(m.trim().toUpperCase()));
        }
        
        // Catch missed standard cashtags ($TICKER)
        const dollarMatches = content.match(/\$[A-Za-z0-9.]{1,10}\b/g);
        if (dollarMatches) {
            dollarMatches.forEach((m: string) => customTickers.push(m.substring(1).toUpperCase()));
        }
        
        const tickers = Array.from(new Set([...rawCashtags, ...customTickers]));
        
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

// --- LLM Categorization Worker ---
let llmCategorizationAbortController: AbortController | null = null;
const llmCategorizationStats = {
  isRunning: false,
  startTime: 0,
  processedCount: 0,
  totalTokens: 0,
  lastError: "",
  totalBacklogAtStart: 0,
};

async function runLlmCategorizationLoop() {
  llmCategorizationStats.isRunning = true;
  llmCategorizationStats.startTime = Date.now();
  llmCategorizationStats.processedCount = 0;
  llmCategorizationStats.totalTokens = 0;
  llmCategorizationStats.lastError = "";

  const { count } = await supabase
    .from("agent_workspace")
    .select("*", { count: "exact", head: true })
    .eq("artifact_type", "x_post")
    .is("metadata->llm_categorized", null);
  llmCategorizationStats.totalBacklogAtStart = count || 0;

  let promptText = "";
  try {
    promptText = Deno.readTextFileSync("/app/ticker-extraction-prompt.txt");
  } catch (e) {
    try {
      promptText = Deno.readTextFileSync("ticker-extraction-prompt.txt");
    } catch(e2) {
      promptText = "Extract tickers into { \"tickers\": [] } JSON.";
    }
  }

  // Import LM_STUDIO_URL from shared.ts using require-like logic or just rely on it being imported at top
  const { LM_STUDIO_URL } = await import("./shared.ts");

  while (llmCategorizationAbortController && !llmCategorizationAbortController.signal.aborted) {
    try {
      const BATCH_SIZE = 50;
      const { data: posts, error } = await supabase
        .from("agent_workspace")
        .select("id, content, metadata")
        .eq("artifact_type", "x_post")
        .is("metadata->llm_categorized", null)
        .order("created_at", { ascending: false })
        .limit(BATCH_SIZE);

      if (error) throw error;

      if (!posts || posts.length === 0) {
        await new Promise(r => setTimeout(r, 60000));
        continue;
      }

      const llmInput = posts.map(p => ({
        id: p.id,
        text: p.content
      }));

      const res = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "local-model",
          messages: [
            { role: "system", content: promptText }, 
            { role: "user", content: JSON.stringify(llmInput) }
          ],
          temperature: 0.1
        }),
        signal: llmCategorizationAbortController.signal
      });

      if (!res.ok) {
        throw new Error(`LM Studio HTTP ${res.status}`);
      }

      const d = await res.json();
      const tokens = d.usage?.total_tokens || 0;
      llmCategorizationStats.totalTokens += tokens;
      
      let parsedResults: any[] = [];
      try {
        const content = d.choices[0].message.content;
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        parsedResults = JSON.parse(jsonMatch ? jsonMatch[0] : content);
      } catch (parseError) {
        console.warn("Failed to parse LM Studio JSON array:", parseError);
        // If it fails to parse the batch, we skip to next loop iteration
        // (but we might get stuck if it keeps failing, so we mark them failed or just wait)
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      if (!Array.isArray(parsedResults)) {
        console.warn("LLM response is not an array");
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      // Map results by id
      const resultMap = new Map<string, string[]>();
      for (const resItem of parsedResults) {
        if (resItem.id && Array.isArray(resItem.tickers)) {
          resultMap.set(resItem.id, resItem.tickers);
        }
      }

      // Update database concurrently for this batch
      await Promise.all(posts.map(async (post) => {
        const newTickers = resultMap.get(post.id) || [];
        const currentMetadata = post.metadata || {};
        const updatedMetadata = {
          ...currentMetadata,
          tickers: newTickers,
          llm_categorized: true
        };

        await supabase
          .from("agent_workspace")
          .update({ metadata: updatedMetadata })
          .eq("id", post.id);
      }));

      llmCategorizationStats.processedCount += posts.length;
      llmCategorizationStats.lastError = "";

      // Small pause between batches
      await new Promise(r => setTimeout(r, 100));
    } catch (err: any) {
      if (err.name === 'AbortError') break;
      console.error("LLM Categorization Error:", err.message);
      llmCategorizationStats.lastError = err.message;
      await new Promise(r => setTimeout(r, 10000));
    }
  }

  llmCategorizationStats.isRunning = false;
}

export function registerXTools(server: McpServer) {
  server.registerTool(
    "manage_llm_categorization",
    {
      title: "Manage LLM Categorization",
      description: "Steuert den Hintergrund-Prozess, der noch nicht kategorisierte Posts an LM Studio sendet.",
      inputSchema: {
        action: z.enum(["START", "STOP", "STATUS"]).describe("Aktion ausführen"),
      },
    },
    async ({ action }: any) => {
      if (action === "START") {
        if (llmCategorizationStats.isRunning) {
          return { content: [{ type: "text", text: "Der Kategorisierungs-Loop läuft bereits im Hintergrund." }] };
        }
        llmCategorizationAbortController = new AbortController();
        runLlmCategorizationLoop().catch(console.error);
        return { content: [{ type: "text", text: "Background LLM Categorization Loop erfolgreich gestartet." }] };
      }
      
      if (action === "STOP") {
        if (!llmCategorizationStats.isRunning || !llmCategorizationAbortController) {
          return { content: [{ type: "text", text: "Der Prozess läuft derzeit nicht." }] };
        }
        llmCategorizationAbortController.abort();
        llmCategorizationAbortController = null;
        return { content: [{ type: "text", text: "Abbruchsignal wurde an den Hintergrund-Loop gesendet." }] };
      }

      if (action === "STATUS") {
        const { count: remainingCount } = await supabase
          .from("agent_workspace")
          .select("*", { count: "exact", head: true })
          .eq("artifact_type", "x_post")
          .is("metadata->llm_categorized", null);

        let statusText = `=== LLM Categorization Status ===\n`;
        statusText += `Status: ${llmCategorizationStats.isRunning ? 'LÄUFT 🟢' : 'GESTOPPT 🔴'}\n`;
        statusText += `Noch im Backlog: ${remainingCount} Posts\n`;
        
        if (llmCategorizationStats.isRunning) {
          const runTimeSecs = (Date.now() - llmCategorizationStats.startTime) / 1000;
          const postsProcessed = llmCategorizationStats.processedCount;
          const tokens = llmCategorizationStats.totalTokens;
          const postsPerSec = postsProcessed / (runTimeSecs || 1);
          const tokensPerSec = tokens / (runTimeSecs || 1);
          
          let estRemainingStr = "Unbekannt";
          if (postsPerSec > 0 && remainingCount) {
             const estRemainingSecs = remainingCount / postsPerSec;
             if (estRemainingSecs < 60) estRemainingStr = `${Math.round(estRemainingSecs)} Sekunden`;
             else if (estRemainingSecs < 3600) estRemainingStr = `${Math.round(estRemainingSecs / 60)} Minuten`;
             else estRemainingStr = `${(estRemainingSecs / 3600).toFixed(1)} Stunden`;
          }

          statusText += `In aktueller Batch verarbeitet: ${postsProcessed}\n`;
          statusText += `Verarbeitete Tokens: ${tokens} (Speed: ${tokensPerSec.toFixed(1)} t/s)\n`;
          statusText += `Durchschnitt: ${(postsPerSec * 60).toFixed(1)} Posts pro Minute\n`;
          statusText += `Geschätzte Restzeit für Backlog: ${estRemainingStr}\n`;
          
          if (llmCategorizationStats.lastError) {
             statusText += `Letzter Fehler: ${llmCategorizationStats.lastError}\n`;
          }
        }
        
        return { content: [{ type: "text", text: statusText }] };
      }
      
      return { content: [{ type: "text", text: "Invalid action" }], isError: true };
    }
  );

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
                const top = searchResults[0] as any;
                const hasIlikeMatch = (top.match_quality ?? 0) >= 100;
                const confident = hasIlikeMatch || top.similarity > 0.8 || top.username === targetUsername;
                if (searchResults.length === 1 || confident) {
                   targetUsername = top.username;
                   cleanName = `@${targetUsername}`;
                } else {
                   const listStr = searchResults.map((r: any) => `- @${r.username} (${r.screen_name})`).join("\n");
                   return { content: [{ type: "text", text: `Ich habe mehrere mögliche Influencer gefunden für '${username}'. Bitte sei spezifischer (z.B. mit @handle):\n${listStr}` }] };
                }
             }
          }

          const { data: latestRecord, error: latestError } = await supabase
            .from("agent_workspace")
            .select("id")
            .eq("agent_id", AGENT_ID)
            .eq("artifact_type", "x_post")
            .contains("metadata", { author: cleanName })
            .limit(1);

          if (latestError) {
             return { content: [{ type: "text", text: `Fehler beim Prüfen des bestehenden Bestands für ${cleanName}: ${latestError.message}` }], isError: true };
          }

          const hasExistingPosts = !!(latestRecord && latestRecord.length > 0);
          const normalizedLimit = typeof limit === "number" ? limit : 100;

          if (!hasExistingPosts && !start_time && normalizedLimit === 100) {
             return {
               content: [{
                 type: "text",
                 text: `${cleanName} hat noch keine Posts in der Datenbank. Für einen Erstimport musst du ein Startdatum (start_time) oder eine maximale Anzahl Posts (limit) angeben. Hinweis: Die X-API liefert pro User maximal ca. 3200 Posts zurück.`
               }]
             };
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

