import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase, getEmbeddingsBatch, extractMetadata, sendTelemetry, X_BEARER_TOKEN, AGENT_ID, resolveAuthorHandles } from "./shared.ts";

export const activeSyncControllers = new Map<string, AbortController>();

// --- Global X API Rate Limiter ---
const X_MIN_REQUEST_DELAY_MS = parseInt(Deno.env.get("X_MIN_REQUEST_DELAY_MS") || "2500");
let lastXApiFetchTime = 0;
const xRateLimitStats = {
  requestsInWindow: 0,
  windowStart: Date.now(),
  remaining: -1,      // from x-rate-limit-remaining header (-1 = unknown)
  resetEpoch: 0,      // from x-rate-limit-reset header
  totalRequests: 0,
  totalNewPosts: 0,
};

async function throttledXFetch(url: string, init?: RequestInit): Promise<Response> {
  // Enforce minimum delay between X API requests
  const now = Date.now();
  const elapsed = now - lastXApiFetchTime;
  if (elapsed < X_MIN_REQUEST_DELAY_MS) {
    await new Promise(r => setTimeout(r, X_MIN_REQUEST_DELAY_MS - elapsed));
  }

  // Pre-check: if we know remaining is very low, sleep until reset
  if (xRateLimitStats.remaining >= 0 && xRateLimitStats.remaining <= 2 && xRateLimitStats.resetEpoch > 0) {
    const sleepMs = Math.max(1000, (xRateLimitStats.resetEpoch * 1000) - Date.now() + 1000);
    console.log(`[X Rate Limiter] Proaktive Pause: remaining=${xRateLimitStats.remaining}, warte ${Math.round(sleepMs/1000)}s bis Reset...`);
    await new Promise(r => setTimeout(r, sleepMs));
  }

  lastXApiFetchTime = Date.now();
  xRateLimitStats.totalRequests++;
  xRateLimitStats.requestsInWindow++;

  // Reset window counter every 15 minutes
  if (Date.now() - xRateLimitStats.windowStart > 15 * 60 * 1000) {
    xRateLimitStats.requestsInWindow = 0;
    xRateLimitStats.windowStart = Date.now();
  }

  const res = await fetch(url, init);

  // Read rate limit headers from response
  const remainingHeader = res.headers.get("x-rate-limit-remaining");
  const resetHeader = res.headers.get("x-rate-limit-reset");
  if (remainingHeader !== null) xRateLimitStats.remaining = Number(remainingHeader);
  if (resetHeader !== null) xRateLimitStats.resetEpoch = Number(resetHeader);

  return res;
}

// --- Sync Log Helper ---
async function syncLog(actionType: string, username: string | null, message: string) {
  console.log(`[X Sync Log] [${actionType}] ${username || 'system'}: ${message}`);
  try {
    await supabase.from("x_sync_logs").insert({ action_type: actionType, username, message });
  } catch (e) {
    console.error("Failed to write sync log:", e);
  }
}

// --- Ticker Validator ---
export function isValidTicker(ticker: string): boolean {
  if (!ticker) return false;
  const t = ticker.trim().toUpperCase().replace(/^[$#]/, "");
  if (!t) return false;

  // Reject pure numbers, decimals, or common prices/years
  if (/^\d+(\.\d+)?$/.test(t)) {
    // Reject 1-3 digit numbers (e.g. 50, 635, 120) and decimal numbers (e.g. 2.24, 49.17)
    if (/^\d{1,3}$/.test(t) || t.includes(".")) return false;
    // Reject obvious years (e.g. 2024, 2025, 2026, 2027)
    if (t === "2024" || t === "2025" || t === "2026" || t === "2027") return false;
  }

  // Reject monetary amounts & multipliers (e.g. "1K", "15K", "100K", "400M", "2B", "9.8B", "1T")
  if (/^\d+(\.\d+)?[KkMmBbTt]$/.test(t)) return false;

  // Reject percentage or multiplier formats (e.g. "50%", "5X")
  if (/^\d+[%xX]$/.test(t)) return false;

  // Must contain letters OR be a valid 4-6 digit numeric exchange code (e.g. Japanese TSE 4-digit code)
  const isAlphaSymbol = /^[A-Z0-9.\-\s]+$/.test(t) && /[A-Z]/.test(t);
  const isExchangeNumericCode = /^\d{4,6}(\.[A-Z]+)?$/.test(t);

  return isAlphaSymbol || isExchangeNumericCode;
}

// --- First Mention Helper ---
export async function updateFirstMentions(author: string, tickers: string[], publishedAt: string, postId: string) {
  if (!tickers || tickers.length === 0 || !publishedAt || !postId) return;
  const cleanAuthor = author.toLowerCase().startsWith("@") ? author.toLowerCase() : `@${author.toLowerCase()}`;
  for (const ticker of tickers) {
    const cleanTicker = ticker.toUpperCase().replace(/^[$#]/, "").trim();
    if (!cleanTicker || !isValidTicker(cleanTicker)) continue;
    try {
      await supabase.from("x_first_mentions").upsert({
        ticker: cleanTicker,
        author: cleanAuthor,
        first_mentioned_at: publishedAt,
        post_id: postId
      }, { onConflict: "ticker,author" });
    } catch (e) {
      console.error(`Failed to update first mention for ${cleanTicker}:`, e);
    }
  }
}

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

export async function runBackgroundSync(cleanName: string, username: string, limit?: number, start_time?: string, signal?: AbortSignal, taskId?: string, taskAgentId?: string, onlyForward?: boolean) {
  console.log(`[X Sync] Background job started for ${cleanName}`);
  // Generate a unique session id for this sync run so the CCO can analyze
  // exactly the posts saved in this run, not whatever the DB happens to contain.
  const sessionId = taskId || `sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const savedPostIds: string[] = [];
  try {
    await sendTelemetry(`[System] Hintergrund-Sync für ${cleanName} startet...`);
    const { id: userId } = await getXUserId(username);

    // 1. Determine since_id, until_id, oldestDateStr, and existing count based on DB state
    let sinceId = "";
    let untilId = "";
    let oldestDateStr = "";
    
    // Find newest post for since_id
    const { data: latestRecord } = await supabase
      .from("agent_workspace")
      .select("metadata")
      .eq("agent_id", AGENT_ID)
      .eq("artifact_type", "x_post")
      .contains("metadata", { author: cleanName })
      .order("x_external_id", { ascending: false }) // Order by Snowflake ID (desc = newest first)
      .limit(1);

    if (latestRecord && latestRecord.length > 0) {
      sinceId = (latestRecord[0].metadata as any).external_id;
    }

    // Find oldest post for until_id
    const { data: oldestRecord } = await supabase
      .from("agent_workspace")
      .select("metadata")
      .eq("agent_id", AGENT_ID)
      .eq("artifact_type", "x_post")
      .contains("metadata", { author: cleanName })
      .order("x_external_id", { ascending: true }) // Order by Snowflake ID (asc = oldest first)
      .limit(1);

    if (oldestRecord && oldestRecord.length > 0) {
      untilId = (oldestRecord[0].metadata as any).external_id;
      oldestDateStr = (oldestRecord[0].metadata as any).published_at;
    }

    // Count existing posts in DB
    const { count: postsCount } = await supabase
      .from("agent_workspace")
      .select("*", { count: "exact", head: true })
      .eq("agent_id", AGENT_ID)
      .eq("artifact_type", "x_post")
      .contains("metadata", { author: cleanName });

    const dbCount = postsCount || 0;

    // Set target limit
    const targetLimit = limit !== undefined ? Math.min(Math.max(1, limit), 3200) : 3200;
    const hasExplicitLimit = limit !== undefined;
    
    let totalSaved = 0;

    // Helper function to sync a range of tweets
    async function syncTweets(params: { sinceId?: string, untilId?: string, startTime?: string, targetLimit?: number }) {
      let nextToken = "";
      let totalFetched = 0;

      while (true) {
        let batchSize = 100;
        if (params.targetLimit !== undefined) {
          const remaining = params.targetLimit - totalFetched;
          if (remaining <= 0) break;
          batchSize = Math.min(100, remaining);
        }

        let url = `https://api.twitter.com/2/users/${userId}/tweets?max_results=${batchSize}&tweet.fields=created_at,entities`;
        
        if (params.sinceId) {
          url += `&since_id=${params.sinceId}`;
        } else {
          if (params.untilId) {
            url += `&until_id=${params.untilId}`;
          }
          if (params.startTime) {
            url += `&start_time=${params.startTime}`;
          }
        }

        if (nextToken) url += `&pagination_token=${nextToken}`;

        await sendTelemetry(`[X API] Request: ${url.replace(X_BEARER_TOKEN || "", "***")}`);
        const res = await throttledXFetch(url, { headers: { "Authorization": `Bearer ${X_BEARER_TOKEN}` }, signal });
        
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
        
        // Processing
        const batchToInsert: any[] = [];
        
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

          // Discovery phase: save as 'pending' WITHOUT embedding
          batchToInsert.push({
            agent_id: AGENT_ID,
            artifact_type: "x_post",
            content: content,
            metadata: finalMetadata,
            status: "pending",
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

        // Bulk Upsert to Supabase
        const { data: upsertedRows, error: upsertError } = await supabase
          .from("agent_workspace")
          .upsert(batchToInsert, { onConflict: "x_external_id" })
          .select("id, metadata");

        if (upsertError) {
          console.error("Upsert error details:", upsertError);
          throw new Error(`Supabase Upsert failed: [${upsertError.code}] ${upsertError.message}`);
        }

        if (upsertedRows) {
          for (const row of upsertedRows) {
            if (row?.id) {
              savedPostIds.push(row.id);
              const meta = row.metadata || {};
              if (meta.author && meta.tickers && meta.published_at) {
                updateFirstMentions(meta.author, meta.tickers, meta.published_at, row.id).catch(console.error);
              }
            }
          }
        }

        totalSaved += batchToInsert.length;
        await sendTelemetry(`[System] Sync ${cleanName}: ${totalSaved} Posts verarbeitet (Batch: ${batchToInsert.length})...`);
        
        nextToken = data.meta?.next_token;
        if (!nextToken) break;
        
        // Cap the page fetching if we have a target limit
        if (params.targetLimit !== undefined && totalFetched >= params.targetLimit) break;
      }
    }

    // --- Phase 1: Forward Sync ---
    if (sinceId) {
      if (!onlyForward) await sendTelemetry(`[System] Phase 1 startet: Vorwärts-Sync ab ${sinceId}...`);
      await syncTweets({ sinceId });
    } else if (onlyForward) {
      // Bootstrap: no since_id yet, fetch newest 20 posts to establish baseline ID
      await sendTelemetry(`[System] Bootstrap für ${cleanName}: Lade die neuesten 20 Posts zum Etablieren der Basis-ID...`);
      await syncTweets({ targetLimit: 20 });
    }

    // --- Phase 2: Backward Sync (SKIP in onlyForward / auto-loop mode) ---
    if (!onlyForward) {
      const isTimeWindow = !!start_time;
      const currentDbCount = dbCount + totalSaved;

      if (isTimeWindow) {
        // Determine if we need to backfill the bottom
        const needBackfill = !oldestDateStr || new Date(start_time) < new Date(oldestDateStr);
        if (needBackfill) {
          await sendTelemetry(`[System] Phase 2 startet: Rückwärts-Sync von ${untilId || "now"} bis ${start_time}...`);
          await syncTweets({ untilId, startTime: start_time });
        }
      } else {
        // Limit backfill (if explicit limit set, or if fresh import)
        const needLimitBackfill = hasExplicitLimit || !sinceId;
        if (needLimitBackfill && currentDbCount < targetLimit) {
          const remainingLimit = targetLimit - currentDbCount;
          await sendTelemetry(`[System] Phase 2 startet: Rückwärts-Sync von ${untilId || "now"} für weitere ${remainingLimit} Posts...`);
          await syncTweets({ untilId, targetLimit: remainingLimit });
        }
      }
    }

    xRateLimitStats.totalNewPosts += totalSaved;
    if (!onlyForward || totalSaved > 0) {
      await syncLog("discovery", username, `Sync abgeschlossen: ${totalSaved} Posts gespeichert (status: pending).`);
      await sendTelemetry(`[System] Sync ${cleanName} abgeschlossen: ${totalSaved} neu/aktualisiert gespeichert (Embeddings werden asynchron generiert).`);
    }

    // Trigger embedding processing for the newly discovered posts
    processXPendingPosts();
    
    // Update task in DB and notify the owning agent (generic — works for any agent, any task type)
    if (taskId && taskAgentId) {
      try {
        await supabase.from("agent_tasks")
          .update({
            status: "completed",
            result: { new_posts: totalSaved, author: cleanName, session_id: sessionId },
            completed_at: new Date().toISOString()
          })
          .eq("id", taskId);
      } catch (e) {
        console.error("Failed to update task status:", e);
      }

      try {
        await fetch("http://nexus-service:7734/api/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from_agent: "system",
            to: taskAgentId,
            text: `Hintergrund-Sync für ${cleanName} abgeschlossen: ${totalSaved} neue Posts.`,
            msg_type: "chat",
            metadata: { task_id: taskId, task_type: "x_sync" }
          }),
        });
      } catch (e) {
        console.error("Failed to notify agent:", e);
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

// --- Embedding Processing Worker (pending -> embedded) ---
let isProcessingPending = false;
export async function processXPendingPosts(): Promise<number> {
  if (isProcessingPending) return 0;
  isProcessingPending = true;
  let totalProcessed = 0;
  
  try {
    while (true) {
      // Fetch batch of posts with status = 'pending' (or null embedding fallback)
      const { data: pendingPosts, error } = await supabase
        .from("agent_workspace")
        .select("id, content")
        .eq("agent_id", AGENT_ID)
        .eq("artifact_type", "x_post")
        .or("status.eq.pending,embedding.is.null")
        .limit(50);

      if (error || !pendingPosts || pendingPosts.length === 0) break;

      const texts = pendingPosts.map((p: any) => p.content);
      const embeddings = await getEmbeddingsBatch(texts);

      for (let i = 0; i < pendingPosts.length; i++) {
        const post = pendingPosts[i];
        const emb = embeddings[i];
        await supabase
          .from("agent_workspace")
          .update({ embedding: emb, status: "embedded" })
          .eq("id", post.id);
      }

      totalProcessed += pendingPosts.length;
      console.log(`[X Processing] Embedded batch of ${pendingPosts.length} posts (Total: ${totalProcessed})`);
    }

    if (totalProcessed > 0) {
      await syncLog("embedding", null, `${totalProcessed} Posts erfolgreich ge-embeddet (status: embedded).`);
    }
  } catch (err: any) {
    console.error(`[X Processing] Failed to process pending embeddings:`, err);
    await syncLog("error", null, `Embedding-Fehler: ${err.message}`);
  } finally {
    isProcessingPending = false;
  }
  return totalProcessed;
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

export async function runLlmCategorizationLoop() {
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
          .update({ metadata: updatedMetadata, status: "categorized" })
          .eq("id", post.id);

        if (updatedMetadata.author && newTickers.length > 0 && updatedMetadata.published_at) {
          updateFirstMentions(updatedMetadata.author, newTickers, updatedMetadata.published_at, post.id).catch(console.error);
        }
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

// --- Periodic High-Frequency Delta-Sync Discovery Loop ---
let xDiscoveryAbortController: AbortController | null = null;
const X_DISCOVERY_INTERVAL_SEC = parseInt(Deno.env.get("X_DISCOVERY_INTERVAL_SEC") || "30");
const xDiscoveryStats = {
  isRunning: false,
  startTime: 0,
  lastRunTime: 0,
  cycleCount: 0,
};

export async function runXDiscoveryLoop() {
  xDiscoveryStats.isRunning = true;
  xDiscoveryStats.startTime = Date.now();
  await syncLog("started", null, `Periodischer Delta-Sync-Loop gestartet (Intervall: ${X_DISCOVERY_INTERVAL_SEC}s, Min-Delay: ${X_MIN_REQUEST_DELAY_MS}ms)`);

  const intervalMs = X_DISCOVERY_INTERVAL_SEC * 1000;

  while (xDiscoveryAbortController && !xDiscoveryAbortController.signal.aborted) {
    try {
      xDiscoveryStats.lastRunTime = Date.now();
      xDiscoveryStats.cycleCount++;
      
      const { data: influencers } = await supabase
        .from("x_users")
        .select("username")
        .eq("is_active", true);

      let cycleTotalNewPosts = 0;

      if (influencers && influencers.length > 0) {
        for (const inf of influencers) {
          if (!xDiscoveryAbortController || xDiscoveryAbortController.signal.aborted) break;
          const cleanName = `@${inf.username}`;
          if (activeSyncControllers.has(cleanName)) continue;
          
          const controller = new AbortController();
          activeSyncControllers.set(cleanName, controller);
          try {
            // Delta-Sync only: onlyForward=true skips Phase 2 backfill
            await runBackgroundSync(cleanName, inf.username, undefined, undefined, controller.signal, undefined, undefined, true);
          } catch (e: any) {
            console.error(`[X Loop Error] Failed for ${cleanName}:`, e.message);
          }
        }
      }

      // Process any pending embeddings after discovery
      await processXPendingPosts();

      // Sleep until next cycle (interruptible in 5s chunks)
      let waited = 0;
      while (waited < intervalMs && xDiscoveryAbortController && !xDiscoveryAbortController.signal.aborted) {
        const chunk = Math.min(5000, intervalMs - waited);
        await new Promise(r => setTimeout(r, chunk));
        waited += chunk;
      }
    } catch (err: any) {
      if (err.name === 'AbortError') break;
      await syncLog("error", null, `Discovery Loop Fehler: ${err.message}`);
      await new Promise(r => setTimeout(r, 30000));
    }
  }

  xDiscoveryStats.isRunning = false;
  await syncLog("stopped", null, "Periodischer Delta-Sync-Loop gestoppt");
}

export async function runXProcessingLoop() {
  while (xDiscoveryAbortController && !xDiscoveryAbortController.signal.aborted) {
    try {
      const processed = await processXPendingPosts();
      if (processed === 0) {
        let waited = 0;
        while (waited < 10000 && xDiscoveryAbortController && !xDiscoveryAbortController.signal.aborted) {
          await new Promise(r => setTimeout(r, 2000));
          waited += 2000;
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') break;
      await new Promise(r => setTimeout(r, 10000));
    }
  }
}

export function registerXTools(server: McpServer) {
  // Auto-start periodic delta-sync loops on boot
  if (!xDiscoveryStats.isRunning) {
    xDiscoveryAbortController = new AbortController();
    console.log(`[X Sync] Delta-Sync-Loop startet (Intervall: ${X_DISCOVERY_INTERVAL_SEC}s, Min-Delay: ${X_MIN_REQUEST_DELAY_MS}ms)`);
    runXDiscoveryLoop().catch(console.error);
    runXProcessingLoop().catch(console.error);
    runLlmCategorizationLoop().catch(console.error);
  }
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
        const stateStr = (remainingCount === 0 && llmCategorizationStats.isRunning) 
          ? 'WARTET (Kein Backlog) 🟢' 
          : (llmCategorizationStats.isRunning ? 'LÄUFT 🟢' : 'GESTOPPT 🔴');
        statusText += `Status: ${stateStr}\n`;
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

          statusText += `Verarbeitet seit Prozess-Start: ${postsProcessed}\n`;
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
    "manage_x_sync",
    {
      title: "Manage X Sync",
      description: "Start, stop, or check status of background X (Twitter) syncs for influencer posts.",
      inputSchema: {
        action: z.enum(["START", "STOP", "STATUS"]).describe("The action to perform"),
        username: z.string().optional().default("all").describe("The X username (e.g. @elonmusk) or 'all' (default: 'all')"),
        limit: z.number().optional().describe("Max tweets to fetch (for START)"),
        start_time: z.string().optional().describe("ISO 8601 date string for historical backfill (for START)"),
        hours_back: z.number().optional().default(24).describe("Hours of sync history to show (for STATUS, default: 24)"),
        task_context: z.string().optional().describe("Original user request text for async task continuation (e.g. 'Schreibe einen Bericht über die Handelstaktik')"),
      },
    },
    async ({ action, username, limit, start_time, hours_back, task_context }: any) => {
      try {
        if (action === "START") {
          if (!X_BEARER_TOKEN || X_BEARER_TOKEN.includes("YOUR_X_BEARER_TOKEN")) {
            return { content: [{ type: "text", text: "Error: X_BEARER_TOKEN is not configured in .env" }], isError: true };
          }

          const effectiveUsername = username || "all";

          if (effectiveUsername.toLowerCase() === "all") {
            const { data: influencers, error } = await supabase.from("x_users").select("username").eq("is_active", true);
            if (error || !influencers || influencers.length === 0) {
               return { content: [{ type: "text", text: "Es wurden keine aktiven Influencer in der Datenbank gefunden." }] };
            }
            
            // Start sequential background sync WITH batch task tracking
            const batchTaskId = `sync_batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            try {
              await supabase.from("agent_tasks").insert({
                id: batchTaskId,
                agent_id: AGENT_ID,
                task_type: "x_batch_sync",
                status: "running",
                original_request: `Massen-Sync für ${influencers.length} Influencer`,
                context: { count: influencers.length, limit: limit || null },
              });
            } catch (e) {
              console.error("Failed to create batch sync task:", e);
            }

            (async () => {
               let syncedCount = 0;
               let failedCount = 0;
               for (const inf of influencers) {
                  const cleanName = `@${inf.username}`;
                  if (activeSyncControllers.has(cleanName)) continue;
                  const controller = new AbortController();
                  activeSyncControllers.set(cleanName, controller);
                  try {
                    await runBackgroundSync(cleanName, inf.username, limit, start_time, controller.signal);
                    syncedCount++;
                  } catch (err: any) {
                    failedCount++;
                    console.error(`Batch sync failed for ${cleanName}:`, err.message);
                  }
               }

               // Update batch task and notify boss
               try {
                 await supabase.from("agent_tasks").update({
                   status: "completed",
                   result: { synced: syncedCount, failed: failedCount, total: influencers.length },
                   completed_at: new Date().toISOString(),
                 }).eq("id", batchTaskId);

                 await fetch("http://nexus-service:7734/api/send", {
                   method: "POST",
                   headers: { "Content-Type": "application/json" },
                   body: JSON.stringify({
                     from_agent: "system",
                     to: AGENT_ID,
                     text: `Massen-Sync für ${influencers.length} Influencer abgeschlossen. ${syncedCount} erfolgreich, ${failedCount} fehlgeschlagen. Berichte das Ergebnis an 'boss'.`,
                     msg_type: "chat",
                     metadata: { task_id: batchTaskId, task_type: "x_batch_sync" },
                   }),
                 });
               } catch (e) {
                 console.error("Failed to update batch task:", e);
               }
            })();
            
            return { content: [{ type: "text", text: `Massen-Sync für ${influencers.length} Influencer gestartet. Dies geschieht nacheinander im Hintergrund. Du wirst benachrichtigt, sobald alle Syncs abgeschlossen sind.` }] };
          }

          const { primaryUsername, allHandles } = await resolveAuthorHandles(effectiveUsername);
          let targetUsername = primaryUsername;
          let cleanName = `@${targetUsername}`;

          // If resolution did not change handle and name didn't start with @, try fuzzy search
          if (!effectiveUsername.startsWith("@") && targetUsername === effectiveUsername.toLowerCase()) {
             const queryEmbedding = (await getEmbeddingsBatch([effectiveUsername]))[0];
             const { data: searchResults, error: searchError } = await supabase.rpc("search_influencers", {
               query_embedding: queryEmbedding,
               query_text: effectiveUsername,
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
                   return { content: [{ type: "text", text: `Ich habe mehrere mögliche Influencer gefunden für '${effectiveUsername}'. Bitte sei spezifischer (z.B. mit @handle):\n${listStr}` }] };
                }
             }
          }

          const { data: latestRecord, error: latestError } = await supabase
            .from("agent_workspace")
            .select("id")
            .eq("agent_id", AGENT_ID)
            .eq("artifact_type", "x_post")
            .in("metadata->>author", allHandles)
            .limit(1);

          if (latestError) {
             return { content: [{ type: "text", text: `Fehler beim Prüfen des bestehenden Bestands für ${cleanName}: ${latestError.message}` }], isError: true };
          }

          const hasExistingPosts = !!(latestRecord && latestRecord.length > 0);

          if (!hasExistingPosts && !start_time && limit === undefined) {
             return {
               content: [{
                 type: "text",
                 text: `${cleanName} hat noch keine Posts in der Datenbank. Für einen Erstimport musst du ein Startdatum (start_time) oder eine maximale Anzahl Posts (limit) angeben. Hinweis: Die X-API liefert pro User maximal ca. 3200 Posts zurück.`
               }]
             };
          }

          // In-Memory Lock Check
          if (activeSyncControllers.has(cleanName)) {
             return { content: [{ type: "text", text: `Ein Hintergrund-Sync für ${cleanName} läuft bereits.` }] };
          }

          const controller = new AbortController();
          activeSyncControllers.set(cleanName, controller);

          // Create a persistent task in DB so the agent can resume after sync
          const taskId = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          if (task_context) {
            try {
              await supabase.from("agent_tasks").insert({
                id: taskId,
                agent_id: AGENT_ID,
                task_type: "x_sync",
                status: "running",
                original_request: task_context,
                context: { author: cleanName, limit: limit || null, requested_by: "boss" }
              });
            } catch (e) {
              console.error("Failed to create task:", e);
            }
          }

          console.log(`[X Sync] Starting background sync for ${cleanName}...`);
          runBackgroundSync(cleanName, targetUsername, limit, start_time, controller.signal, task_context ? taskId : undefined, task_context ? AGENT_ID : undefined);

          return { content: [{ type: "text", text: `Hintergrund-Sync für ${cleanName} erfolgreich gestartet. Ich informiere dich via Chat über den Fortschritt.` }] };

      } else if (action === "STOP") {
          const effectiveUsername = username || "all";
          if (effectiveUsername.toLowerCase() === "all") {
            const stopped: string[] = [];
            for (const [name, controller] of activeSyncControllers.entries()) {
              controller.abort();
              stopped.push(name);
            }
            if (stopped.length === 0) return { content: [{ type: "text", text: "Es laufen aktuell keine Syncs." }] };
            return { content: [{ type: "text", text: `Abbruch-Signal für ${stopped.length} laufende Syncs gesendet: ${stopped.join(", ")}` }] };
          }
          const cleanName = (effectiveUsername.startsWith("@") ? effectiveUsername : `@${effectiveUsername}`).toLowerCase();
          const controller = activeSyncControllers.get(cleanName);
          if (!controller) {
            return { content: [{ type: "text", text: `Es läuft aktuell kein Sync für ${cleanName}.` }] };
          }
          controller.abort();
          return { content: [{ type: "text", text: `Abbruch-Signal für den Sync von ${cleanName} wurde gesendet.` }] };

      } else if (action === "STATUS") {
          let statusText = `=== X Sync Status ===\n\n`;

          // 1. Periodic Delta-Sync Discovery Loop Status
          const loopState = xDiscoveryStats.isRunning ? `LÄUFT 🟢 (alle ${X_DISCOVERY_INTERVAL_SEC}s)` : "GESTOPPT 🔴";
          const lastRunStr = xDiscoveryStats.lastRunTime ? new Date(xDiscoveryStats.lastRunTime).toLocaleTimeString('de-DE') : "Noch nie";
          statusText += `🔄 Delta-Sync Loop: ${loopState}\n`;
          statusText += `  Abgeschlossene Zyklen: ${xDiscoveryStats.cycleCount}\n`;
          statusText += `  Letzter Zyklus-Start: ${lastRunStr}\n`;
          statusText += `  Min-Delay zwischen Requests: ${X_MIN_REQUEST_DELAY_MS}ms\n\n`;

          // 1b. X API Rate Limiter Stats
          statusText += `📡 X API Rate Limiter:\n`;
          statusText += `  Requests seit Start: ${xRateLimitStats.totalRequests}\n`;
          statusText += `  Neue Posts seit Start: ${xRateLimitStats.totalNewPosts}\n`;
          statusText += `  Requests im aktuellen 15-Min-Fenster: ${xRateLimitStats.requestsInWindow} / 450\n`;
          if (xRateLimitStats.remaining >= 0) {
            statusText += `  X-Header remaining: ${xRateLimitStats.remaining}\n`;
            if (xRateLimitStats.resetEpoch > 0) {
              const resetIn = Math.max(0, Math.round((xRateLimitStats.resetEpoch * 1000 - Date.now()) / 1000));
              statusText += `  X-Header reset in: ${resetIn}s\n`;
            }
          }
          statusText += `\n`;

          // 2. Active user syncs
          const runningSyncs = Array.from(activeSyncControllers.keys());
          statusText += `⚡ Aktuell aktive User-Syncs: ${runningSyncs.length > 0 ? runningSyncs.join(", ") : "Keine"}\n\n`;

          // 2. Pipeline counts
          const { count: totalPosts } = await supabase
            .from("agent_workspace")
            .select("*", { count: "exact", head: true })
            .eq("agent_id", AGENT_ID)
            .eq("artifact_type", "x_post");

          const { count: pendingPosts } = await supabase
            .from("agent_workspace")
            .select("*", { count: "exact", head: true })
            .eq("agent_id", AGENT_ID)
            .eq("artifact_type", "x_post")
            .eq("status", "pending");

          const { count: embeddedPosts } = await supabase
            .from("agent_workspace")
            .select("*", { count: "exact", head: true })
            .eq("agent_id", AGENT_ID)
            .eq("artifact_type", "x_post")
            .eq("status", "embedded");

          const { count: categorizedPosts } = await supabase
            .from("agent_workspace")
            .select("*", { count: "exact", head: true })
            .eq("agent_id", AGENT_ID)
            .eq("artifact_type", "x_post")
            .eq("status", "categorized");

          statusText += `📊 Pipeline-Übersicht:\n`;
          statusText += `  Total Posts: ${totalPosts || 0}\n`;
          statusText += `  ⏳ Pending (ohne Embedding): ${pendingPosts || 0}\n`;
          statusText += `  🔤 Embedded (ohne LLM): ${embeddedPosts || 0}\n`;
          statusText += `  🏷️ Categorized (vollständig): ${categorizedPosts || 0}\n\n`;

          // 2b. Recent Sync Logs
          const cutoff = new Date(Date.now() - (hours_back || 24) * 60 * 60 * 1000).toISOString();
          const { data: logs } = await supabase
            .from("x_sync_logs")
            .select("action_type, username, message, created_at")
            .gte("created_at", cutoff)
            .order("created_at", { ascending: false })
            .limit(5);

          if (logs && logs.length > 0) {
            statusText += `📜 Letzte Sync-Aktivitäten (letzte ${hours_back || 24}h):\n`;
            for (const log of logs) {
              const dateStr = new Date(log.created_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
              statusText += `  [${dateStr}] [${log.action_type.toUpperCase()}] ${log.username ? '@' + log.username + ': ' : ''}${log.message}\n`;
            }
            statusText += `\n`;
          }

          // 3. LLM Categorization Status
          if (llmCategorizationStats.isRunning) {
            const runTimeSecs = (Date.now() - llmCategorizationStats.startTime) / 1000;
            const postsPerSec = llmCategorizationStats.processedCount / (runTimeSecs || 1);
            statusText += `🤖 LLM-Kategorisierung: LÄUFT 🟢\n`;
            statusText += `  Verarbeitet: ${llmCategorizationStats.processedCount} Posts\n`;
            statusText += `  Speed: ${(postsPerSec * 60).toFixed(1)} Posts/Min\n`;
            if (llmCategorizationStats.lastError) {
              statusText += `  Letzter Fehler: ${llmCategorizationStats.lastError}\n`;
            }
          } else {
            statusText += `🤖 LLM-Kategorisierung: GESTOPPT 🔴\n`;
          }

          // 4. Per-influencer post counts
          const { data: influencers } = await supabase.from("x_users").select("username, screen_name").eq("is_active", true).order("username");
          if (influencers && influencers.length > 0) {
            statusText += `\n👥 Influencer-Übersicht:\n`;
            for (const inf of influencers) {
              const { count: infCount } = await supabase
                .from("agent_workspace")
                .select("*", { count: "exact", head: true })
                .eq("agent_id", AGENT_ID)
                .eq("artifact_type", "x_post")
                .contains("metadata", { author: `@${inf.username}` });
              const syncStatus = activeSyncControllers.has(`@${inf.username}`) ? "🔄" : "⏸️";
              statusText += `  ${syncStatus} @${inf.username} (${inf.screen_name || 'N/A'}): ${infCount || 0} Posts\n`;
            }
          }

          return { content: [{ type: "text", text: statusText }] };
      }
      return { content: [{ type: "text", text: `Invalid action` }], isError: true };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Fehler: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: Show X Content (DATABASE / ONLINE)
  server.registerTool(
    "show_x_content",
    {
      title: "Show X Content",
      description: "View X/Twitter content. DATABASE lists stored posts chronologically. ONLINE fetches a single tweet live from the X API.",
      inputSchema: {
        action: z.enum(["DATABASE", "ONLINE"]).describe("DATABASE = list stored posts. ONLINE = fetch a single tweet live."),
        username: z.string().optional().describe("Filter by influencer handle (for DATABASE, e.g. '@elonmusk')"),
        limit: z.number().optional().default(10).describe("Max posts to show (for DATABASE, default: 10)"),
        days_back: z.number().optional().describe("Filter posts from the last X days (for DATABASE)"),
        tweet_id: z.string().optional().describe("Tweet ID or URL to fetch (for ONLINE)"),
      },
    },
    async ({ action, username, limit, days_back, tweet_id }: any) => {
      try {
        if (action === "DATABASE") {
          let query = supabase
            .from("agent_workspace")
            .select("id, content, metadata, created_at")
            .eq("agent_id", AGENT_ID)
            .eq("artifact_type", "x_post")
            .order("created_at", { ascending: false })
            .limit(limit || 10);

          if (username) {
            const { allHandles } = await resolveAuthorHandles(username);
            query = query.in("metadata->>author", allHandles);
          }

          if (days_back) {
            const cutoff = new Date(Date.now() - days_back * 24 * 60 * 60 * 1000).toISOString();
            query = query.gte("created_at", cutoff);
          }

          const { data, error } = await query;
          if (error) throw error;
          if (!data || data.length === 0) return { content: [{ type: "text", text: "Keine Posts in der Datenbank gefunden." }] };

          const formatted = data.map((p: any, i: number) => {
            const author = p.metadata?.author || "Unknown";
            const dateStr = p.metadata?.published_at ? new Date(p.metadata.published_at).toLocaleString('de-DE') : new Date(p.created_at).toLocaleString('de-DE');
            const tickers = p.metadata?.tickers?.length ? p.metadata.tickers.join(", ") : "Keine";
            return `[${i + 1}] 📅 ${dateStr} | 👤 ${author} | 🔑 ${tickers}\n${p.content}`;
          }).join("\n\n---\n\n");

          return { content: [{ type: "text", text: `${data.length} Posts gefunden:\n\n${formatted}` }] };

        } else if (action === "ONLINE") {
          if (!tweet_id) throw new Error("tweet_id is required for ONLINE action");
          if (!X_BEARER_TOKEN || X_BEARER_TOKEN.includes("YOUR_X_BEARER_TOKEN")) {
            return { content: [{ type: "text", text: "Error: X_BEARER_TOKEN is not configured" }], isError: true };
          }

          // Extract tweet ID from URL if needed
          let id = tweet_id;
          const urlMatch = tweet_id.match(/status\/(\d+)/);
          if (urlMatch) id = urlMatch[1];

          const res = await fetch(`https://api.twitter.com/2/tweets/${id}?tweet.fields=created_at,author_id,entities`, {
            headers: { "Authorization": `Bearer ${X_BEARER_TOKEN}` }
          });
          if (!res.ok) throw new Error(`X API failed: ${res.status}`);
          const data = await res.json();
          if (!data.data) throw new Error("Tweet not found");

          const tweet = data.data;
          const dateStr = tweet.created_at ? new Date(tweet.created_at).toLocaleString('de-DE') : 'Unbekanntes Datum';
          return { content: [{ type: "text", text: `📅 ${dateStr} | Author ID: ${tweet.author_id}\n\n${tweet.text}` }] };
        }

        throw new Error("Invalid action");
      } catch (err: any) {
        return { content: [{ type: "text", text: `Fehler: ${err.message}` }], isError: true };
      }
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

            // Auto-trigger initial sync WITH task tracking + boss notification
            const initialSyncLimit = 200;
            const autoCleanName = `@${cleanName}`;
            if (X_BEARER_TOKEN && !X_BEARER_TOKEN.includes("YOUR_X_BEARER_TOKEN")) {
              if (!activeSyncControllers.has(autoCleanName)) {
                const controller = new AbortController();
                activeSyncControllers.set(autoCleanName, controller);

                // Create persistent task for tracking
                const taskId = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                try {
                  await supabase.from("agent_tasks").insert({
                    id: taskId,
                    agent_id: AGENT_ID,
                    task_type: "x_sync",
                    status: "running",
                    original_request: `Initial-Sync für @${cleanName} (${initialSyncLimit} Posts)`,
                    context: { author: autoCleanName, limit: initialSyncLimit, requested_by: "boss" },
                  });
                } catch (e) {
                  console.error("Failed to create initial sync task:", e);
                }

                console.log(`[X Sync] Auto-starting initial sync for ${autoCleanName} (limit: ${initialSyncLimit})...`);
                runBackgroundSync(autoCleanName, cleanName, initialSyncLimit, undefined, controller.signal, taskId, AGENT_ID);
              }
            }

            return { content: [{ type: "text", text: `Influencer @${cleanName} (${screenName}) wurde erfolgreich hinzugefügt. Initial-Sync für die letzten ${initialSyncLimit} Posts wurde automatisch gestartet. Du wirst benachrichtigt, sobald der Sync abgeschlossen ist.` }] };
        } else if (action === "REMOVE") {
            if (!username) throw new Error("username is required for REMOVE");
            const cleanName = username.startsWith("@") ? username.substring(1).toLowerCase() : username.toLowerCase();
            const { error } = await supabase.from("x_users").update({ is_active: false }).eq("username", cleanName);
            if (error) throw error;
            return { content: [{ type: "text", text: `Influencer @${cleanName} wurde deaktiviert (Soft-Delete). Posts bleiben erhalten.` }] };
        }
        throw new Error("Invalid action");
      } catch (err: any) {
        return { content: [{ type: "text", text: `Fehler: ${err.message}` }], isError: true };
      }
    }
  );
}

