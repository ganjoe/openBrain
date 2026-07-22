declare const Deno: any;
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase, getEmbeddingsBatch, sendTelemetry, LM_STUDIO_URL, AGENT_ID, getActiveProvider, GEMINI_API_KEY, OLLAMA_EMBED_MODEL } from "./shared.ts";

// --- Constants ---

async function logAndTelemetry(actionType: string, channel: string | null, message: string) {
  try {
    await supabase.from("yt_sync_logs").insert({ action_type: actionType, channel, message });
  } catch (e) {
    console.error("DB Log failed", e);
  }
  const prefix = channel ? `[YT:${channel}] ` : `[YT-Sync] `;
  try {
    await sendTelemetry(`${prefix}${message}`);
  } catch (e) {
    console.error("Telemetry failed", e);
  }
}

const YT_COOKIES_PATH = "/app/cookies.txt";
// Concurrency for video_urls bulk import. Tunable via env.
const YT_BULK_CONCURRENCY = parseInt(Deno.env.get("YT_BULK_CONCURRENCY") || "3");

// --- In-Memory Sync Lock (like activeSyncControllers in x.ts) ---
export const activeYtSyncControllers = new Map<string, AbortController>();


// --- Deterministic Hash for bulk batch keys ---
// djb2 produces a stable, short hex string from the sorted URL list, so
// re-submitting the same set of URLs hits the existing in-memory lock.
async function djb2(input: string): Promise<string> {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  // Convert to unsigned 32-bit hex
  return ("00000000" + (hash >>> 0).toString(16)).slice(-8);
}

// --- In-Memory Discovery Loop State ---
export let ytDiscoveryAbortController: AbortController | null = null;
export const ytDiscoveryStats = {
  isRunning: false,
  startTime: 0,
  lastRunTime: 0,
  processedCount: 0,
  failedCount: 0,
  lastError: "",
};

// --- Types ---

// --- Helper for Deno Command execution with Timeout & AbortSignal ---
async function runCommandWithTimeout(
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  if (signal?.aborted) {
    throw new Error("Command aborted before execution");
  }

  const cmd = new Deno.Command("yt-dlp", {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  const child = cmd.spawn();
  
  let aborted = false;
  let timerId: any = null;

  const cleanup = () => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  };

  const onAbort = () => {
    aborted = true;
    cleanup();
    try {
      child.kill("SIGKILL");
    } catch {}
  };

  if (signal) {
    signal.addEventListener("abort", onAbort);
  }

  timerId = setTimeout(() => {
    aborted = true;
    cleanup();
    try {
      child.kill("SIGKILL");
    } catch {}
  }, timeoutMs);

  try {
    const output = await child.output();
    cleanup();

    if (aborted && signal?.aborted) {
      throw new Error("Command aborted");
    }
    if (aborted) {
      throw new Error(`Command timed out after ${timeoutMs / 1000}s`);
    }

    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    return {
      success: output.success,
      stdout,
      stderr,
    };
  } catch (err: any) {
    cleanup();
    throw err;
  }
}

// --- yt-dlp Helpers ---

/**
 * Resolves a YouTube channel handle or URL to channel_id + title.
 * Uses yt-dlp on the channel's /videos page to grab metadata from the first video.
 * This is faster than --flat-playlist which tries to enumerate all videos.
 */
async function resolveYtChannel(input: string): Promise<{ channelId: string; handle: string; title: string }> {
  // Normalize input: accept @handle, URL, or plain name
  let target = input;
  if (!target.startsWith("http") && !target.startsWith("@")) {
    target = `@${target}`;
  }
  if (target.startsWith("@")) {
    target = `https://www.youtube.com/${target}/videos`;
  }
  // Ensure we're hitting the /videos tab (avoids shorts/streams)
  if (target.includes("youtube.com/") && !target.includes("/videos")) {
    target = target.replace(/\/?$/, "/videos");
  }

  const args = [
    "--cookies", YT_COOKIES_PATH,
    "--dump-json",
    "--playlist-items", "1",
    "--skip-download",
    target,
  ];

  const timeoutMs = parseInt(Deno.env.get("YT_DLP_TIMEOUT_MS") || "300000");
  const output = await runCommandWithTimeout(args, timeoutMs);
  if (!output.success) {
    throw new Error(`yt-dlp channel resolve failed: ${output.stderr.substring(0, 200)}`);
  }

  const jsonStr = output.stdout.trim().split("\n")[0]; // Take first line only
  const data = JSON.parse(jsonStr);

  const channelId = data.channel_id || data.uploader_id || "";
  const handle = data.channel_url?.match(/@[\w.-]+/)?.[0]?.toLowerCase()
    || (data.uploader_id?.startsWith("@") ? data.uploader_id.toLowerCase() : "")
    || `@${(data.channel || data.uploader || input).toLowerCase().replace(/^@/, "")}`;
  const title = data.channel || data.uploader || "";

  if (!channelId) {
    throw new Error(`Could not resolve channel ID for: ${input}`);
  }

  return { channelId, handle, title };
}

/**
 * Helper to determine if we should download the transcript in German or English.
 * Original German or English transcripts are kept in their original language.
 * Other languages (e.g. French, Spanish) are downloaded as English auto-translations.
 */
function determineTargetLang(meta: any): string {
  const rawLang = meta.language || "";
  if (rawLang.startsWith("de")) {
    return "de";
  } else if (rawLang.startsWith("en")) {
    return "en";
  }
  
  // Fallback to checking automatic_captions/subtitles
  const autoKeys = Object.keys(meta.automatic_captions || {});
  const hasDeOrig = autoKeys.includes("de-orig") || autoKeys.some(k => k.startsWith("de-orig"));
  const hasEnOrig = autoKeys.includes("en-orig") || autoKeys.some(k => k.startsWith("en-orig"));
  
  if (hasDeOrig && !hasEnOrig) {
    return "de";
  }
  
  return "en";
}

/**
 * Resolves a channel handle from yt-dlp metadata.
 */
function extractHandleFromMeta(meta: any): string {
  const handle = meta.channel_url?.match(/@[\w.-]+/)?.[0]?.toLowerCase()
    || (meta.uploader_id?.startsWith("@") ? meta.uploader_id.toLowerCase() : "")
    || `@${(meta.channel || meta.uploader || "unknown").toLowerCase().replace(/^@/, "").replace(/\s+/g, "")}`;
  return handle;
}

/**
 * Uses yt-dlp to list videos from a channel.
 * Returns array of { videoId, title, duration, publishedAt, targetLang }.
 */
async function getChannelVideos(
  channelUrl: string,
  limit?: number,
  dateAfter?: string, // ISO YYYY-MM-DD (will be converted to YYYYMMDD for yt-dlp)
  dateBefore?: string, // ISO YYYY-MM-DD
  signal?: AbortSignal,
): Promise<Array<{
  videoId: string;
  title: string;
  duration: number;
  publishedAt: string;
  targetLang: string;
}>> {
  // Ensure we're hitting the /videos tab
  const target = channelUrl.includes("/videos") ? channelUrl : channelUrl.replace(/\/?$/, "/videos");

  const useFlat = limit === undefined || limit > 30;

  const args = [
    "--cookies", YT_COOKIES_PATH,
    "--dump-json",
    "--skip-download",
  ];
  if (useFlat) {
    args.push("--flat-playlist");
  }
  if (limit !== undefined) {
    args.push("--playlist-end", String(limit));
  }
  if (dateAfter) {
    // ISO YYYY-MM-DD → YYYYMMDD for yt-dlp
    args.push("--dateafter", dateAfter.replace(/-/g, ""));
  }
  if (dateBefore) {
    args.push("--datebefore", dateBefore.replace(/-/g, ""));
  }
  args.push(target);

  const timeoutMs = parseInt(Deno.env.get("YT_DLP_TIMEOUT_MS") || "300000");
  const output = await runCommandWithTimeout(args, timeoutMs, signal);
  if (!output.success) {
    throw new Error(`yt-dlp video list failed: ${output.stderr.substring(0, 200)}`);
  }

  const lines = output.stdout.trim().split("\n");
  const videos: Array<{ videoId: string; title: string; duration: number; publishedAt: string; targetLang: string }> = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const data = JSON.parse(line);
      const targetLang = useFlat ? "en" : determineTargetLang(data);
      videos.push({
        videoId: data.id,
        title: data.title || "Unknown",
        duration: data.duration || 0,
        publishedAt: data.upload_date
          ? `${data.upload_date.substring(0, 4)}-${data.upload_date.substring(4, 6)}-${data.upload_date.substring(6, 8)}T00:00:00Z`
          : "", // Leave blank if flat-playlist has no upload_date
        targetLang,
      });
    } catch {
      // Skip unparseable lines
    }
  }

  return videos;
}

/**
 * Downloads the auto-generated subtitle (VTT) for a video.
 * Returns the raw VTT content as string, or null if no subtitles available.
 */
async function downloadVtt(videoId: string, targetLang: string, signal?: AbortSignal): Promise<string | null> {
  const outputDir = "/data/yt/vtt";

  // Ensure directory exists
  try {
    await Deno.mkdir(outputDir, { recursive: true });
  } catch { /* already exists */ }

  const outputTemplate = `${outputDir}/${videoId}`;

  const args = [
    "--cookies", YT_COOKIES_PATH,
    "--write-auto-sub",
    "--sub-lang", targetLang,
    "--skip-download",
    "--sub-format", "vtt",
    "--output", outputTemplate,
    `https://www.youtube.com/watch?v=${videoId}`,
  ];

  const timeoutMs = parseInt(Deno.env.get("YT_DLP_VTT_TIMEOUT_MS") || "600000");
  const output = await runCommandWithTimeout(args, timeoutMs, signal);
  if (!output.success) {
    const errText = output.stderr;
    // Check if it's a "no subtitles" error vs a real error
    if (errText.includes("no subtitles") || errText.includes("Subtitles are disabled")) {
      return null;
    }
    throw new Error(`yt-dlp VTT download failed: ${errText.substring(0, 200)}`);
  }

  // Find the VTT file (could be .en.vtt or .de.vtt)
  for await (const entry of Deno.readDir(outputDir)) {
    if (entry.name.startsWith(videoId) && entry.name.endsWith(".vtt")) {
      const vttContent = await Deno.readTextFile(`${outputDir}/${entry.name}`);
      // Clean up the file after reading
      try { await Deno.remove(`${outputDir}/${entry.name}`); } catch { /* ignore */ }
      return vttContent;
    }
  }

  return null;
}

/**
 * Converts raw VTT content to clean plaintext with timestamps.
 * Removes VTT headers, duplicate lines, and formatting tags.
 */
function vttToPlaintext(vttContent: string): string {
  const lines = vttContent.split("\n");
  const outputLines: string[] = [];
  let lastText = "";

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip VTT header, empty lines, and NOTE lines
    if (trimmed === "WEBVTT" || trimmed === "" || trimmed.startsWith("NOTE") || trimmed.startsWith("Kind:") || trimmed.startsWith("Language:")) {
      continue;
    }

    // Keep timestamp lines (e.g. "00:01:23.456 --> 00:01:27.890")
    if (trimmed.includes("-->")) {
      // Extract simple MM:SS timestamp from the start time
      const match = trimmed.match(/(\d{2}):(\d{2}):(\d{2})\.\d+/);
      if (match) {
        const hours = parseInt(match[1]);
        const minutes = parseInt(match[2]);
        const seconds = parseInt(match[3]);
        const totalMinutes = hours * 60 + minutes;
        outputLines.push(`[${String(totalMinutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}]`);
      }
      continue;
    }

    // Remove HTML/VTT formatting tags
    const cleanText = trimmed
      .replace(/<[^>]+>/g, "")   // HTML tags
      .replace(/\{[^}]+\}/g, "") // VTT styling
      .trim();

    // Skip duplicates (VTT often repeats lines)
    if (cleanText && cleanText !== lastText) {
      outputLines.push(cleanText);
      lastText = cleanText;
    }
  }

  return outputLines.join("\n");
}

/**
 * Downloads and stores the raw video transcript.
 */
async function processVideo(
  videoId: string,
  channel: string,
  videoTitle: string,
  publishedAt: string,
  targetLang: string,
  signal?: AbortSignal,
): Promise<void> {
  await logAndTelemetry("info", channel, `[YT] Starte Download für "${videoTitle}"...`);

  const { data: videoData } = await supabase.from("yt_videos").select("transcript").eq("video_id", videoId).single();
  let plaintext = videoData?.transcript;

  if (!plaintext) {
    const vttContent = await downloadVtt(videoId, targetLang, signal);
    if (!vttContent) {
      await supabase.from("yt_videos").update({ status: "failed", error_msg: "Keine Auto-Captions verfügbar" }).eq("video_id", videoId);
      await logAndTelemetry("error", channel, `Keine Untertitel für "${videoTitle}"`);
      return;
    }
    plaintext = vttToPlaintext(vttContent);
    await supabase.from("yt_videos").update({ transcript: plaintext, language: targetLang, status: "downloaded", error_msg: null }).eq("video_id", videoId);
    await logAndTelemetry("info", channel, `Transkript gespeichert für "${videoTitle}" (${plaintext.length} Zeichen)`);
  } else {
    await supabase.from("yt_videos").update({ status: "downloaded", error_msg: null }).eq("video_id", videoId);
    await logAndTelemetry("info", channel, `Transkript bereits vorhanden für "${videoTitle}". Status auf downloaded aktualisiert.`);
  }
}

export async function prepareVideoFromUrl(
  videoUrl: string,
  signal?: AbortSignal,
): Promise<{
  video: { videoId: string; title: string; duration: number; publishedAt: string; targetLang: string };
  channelHandle: string;
}> {
  if (signal?.aborted) throw new Error("Sync abgebrochen.");
  const videoIdMatch = videoUrl.match(/(?:v=|youtu\.be\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
  if (!videoIdMatch) throw new Error(`Ungültige YouTube-URL: ${videoUrl}`);
  const videoId = videoIdMatch[1];

  const args = ["--cookies", YT_COOKIES_PATH, "--dump-json", "--skip-download", videoUrl];
  const timeoutMs = parseInt(Deno.env.get("YT_DLP_TIMEOUT_MS") || "300000");
  const output = await runCommandWithTimeout(args, timeoutMs, signal);
  if (!output.success) {
    throw new Error(`yt-dlp metadata fetch failed for ${videoUrl}: ${output.stderr.substring(0, 200)}`);
  }
  const meta = JSON.parse(output.stdout);

  const channelHandle = extractHandleFromMeta(meta);
  const publishedAt = meta.upload_date
    ? `${meta.upload_date.substring(0, 4)}-${meta.upload_date.substring(4, 6)}-${meta.upload_date.substring(6, 8)}T00:00:00Z`
    : new Date().toISOString();
  const targetLang = determineTargetLang(meta);

  // Ensure channel row exists
  const { data: existingChannel } = await supabase
    .from("yt_channels")
    .select("handle")
    .eq("handle", channelHandle)
    .single();
  if (!existingChannel) {
    await supabase.from("yt_channels").insert({
      handle: channelHandle,
      channel_id: meta.channel_id || "",
      title: meta.channel || meta.uploader || "",
      is_active: true,
    });
  }

  // Ensure video row exists with status=downloaded
  await supabase.from("yt_videos").upsert({
    video_id: videoId,
    channel: channelHandle,
    title: meta.title || "Unknown",
    status: "downloaded",
    duration: meta.duration || 0,
    published_at: publishedAt,
    language: targetLang,
  });

  return {
    video: {
      videoId,
      title: meta.title || "Unknown",
      duration: meta.duration || 0,
      publishedAt,
      targetLang,
    },
    channelHandle,
  };
}

/**
 * Syncs a single YouTube channel: discover videos and add them to the queue.
 */
export async function syncSingleChannel(handle: string, signal?: AbortSignal) {
  try {
    const channelUrl = `https://www.youtube.com/${handle}`;
    
    // Per user request, we always fetch all videos (no limit parameter).
    const videosToProcess = await getChannelVideos(channelUrl, undefined, undefined, undefined, signal);
    
    if (videosToProcess.length === 0) {
      await logAndTelemetry("info", handle, `Sync abgeschlossen: 0 Videos online gefunden.`);
      return;
    }
    
    const { data: dbVideos, error: dbErr } = await supabase
      .from("yt_videos")
      .select("video_id")
      .eq("channel", handle);
    if (dbErr) throw dbErr;
    const existingIds = new Set((dbVideos || []).map((v: any) => v.video_id));
    
    const newVideos = videosToProcess.filter((v: any) => !existingIds.has(v.videoId));
    if (newVideos.length === 0) {
      await logAndTelemetry("info", handle, `Sync abgeschlossen: ${videosToProcess.length} Videos überprüft, 0 neue Videos gefunden.`);
      return;
    }
    
    await logAndTelemetry("info", handle, `Found ${newVideos.length} new videos to sync (Total available: ${videosToProcess.length})`);
    
    for (const video of newVideos) {
      if (signal?.aborted) break;
      
      try {
        const { error } = await supabase.from("yt_videos").upsert({
          video_id: video.videoId,
          channel: handle,
          title: video.title,
          duration: video.duration,
          published_at: video.publishedAt || null,
          status: "pending",
          language: video.targetLang || "en",
        }, { onConflict: "video_id" });
        if (error) throw error;
      } catch (upsertErr: any) {
        await logAndTelemetry("error", handle, `Upsert failed for ${video.videoId}: ${upsertErr.message}`);
      }
    }
  } catch (chanErr: any) {
    if (chanErr.name === 'AbortError') throw chanErr;
    await logAndTelemetry("error", handle, `Discovery failed for channel: ${chanErr.message}`);
  }
}

/**
 * Phase 1: Proactively discover new videos and download their transcripts (fast).
 */
export async function runYtDiscoveryLoop() {
  ytDiscoveryStats.isRunning = true;
  ytDiscoveryStats.startTime = Date.now();
  
  await logAndTelemetry("started", null, "Background YT Discovery Loop gestartet");

  while (ytDiscoveryAbortController && !ytDiscoveryAbortController.signal.aborted) {
    try {
      const { data: channels } = await supabase.from("yt_channels").select("handle").eq("is_active", true);
      if (channels && channels.length > 0) {
        for (const ch of channels) {
          if (!ytDiscoveryAbortController || ytDiscoveryAbortController.signal.aborted) break;
          await syncSingleChannel(ch.handle, ytDiscoveryAbortController.signal);
        }
      }
      
      const intervalMs = parseInt(Deno.env.get("YT_SYNC_INTERVAL_MS") || "3600000");
      let waited = 0;
      while (waited < intervalMs && ytDiscoveryAbortController && !ytDiscoveryAbortController.signal.aborted) {
        await new Promise(r => setTimeout(r, 10000));
        waited += 10000;
      }
    } catch (err: any) {
      if (err.name === 'AbortError') break;
      await logAndTelemetry("error", null, `Discovery Loop Error: ${err.message}`);
      await new Promise(r => setTimeout(r, 60000));
    }
  }
  
  ytDiscoveryStats.isRunning = false;
  await logAndTelemetry("stopped", null, "Background YT Discovery Loop beendet");
}

export async function runYtProcessingLoop() {
  while (ytDiscoveryAbortController && !ytDiscoveryAbortController.signal.aborted) {
    try {
      const { data: pendingVideos, error } = await supabase
        .from("yt_videos")
        .select("video_id, channel, title, published_at, language")
        .eq("status", "pending")
        .order("published_at", { ascending: false })
        .limit(1);

      if (error) throw error;

      if (!pendingVideos || pendingVideos.length === 0) {
        let waited = 0;
        while (waited < 60000 && ytDiscoveryAbortController && !ytDiscoveryAbortController.signal.aborted) {
          await new Promise(r => setTimeout(r, 5000));
          waited += 5000;
        }
        continue;
      }

      const video = pendingVideos[0];
      
      try {
        await processVideo(video.video_id, video.channel, video.title, video.published_at, video.language || "en", ytDiscoveryAbortController.signal);
        
        // Add a standard delay after successful download to avoid triggering rate limits
        const delayMs = parseInt(Deno.env.get("YT_SYNC_DELAY_MS") || "2000");
        let waited = 0;
        while (waited < delayMs && ytDiscoveryAbortController && !ytDiscoveryAbortController.signal.aborted) {
          await new Promise(r => setTimeout(r, 500));
          waited += 500;
        }
      } catch (err: any) {
        if (err.name === 'AbortError') throw err;

        const isRateLimit = err.message.toLowerCase().includes("rate-limited") || 
                            err.message.toLowerCase().includes("rate limit") || 
                            err.message.includes("429") ||
                            (err.message.toLowerCase().includes("unavailable") && err.message.toLowerCase().includes("try again later"));

        if (isRateLimit) {
          // If rate-limited, keep it pending and pause the loop
          const cooldownMs = parseInt(Deno.env.get("YT_SYNC_RATE_LIMIT_SLEEP_MS") || "900000"); // 15 mins
          const minutes = Math.round(cooldownMs / 60000);
          await logAndTelemetry("error", video.channel, `YouTube Rate-Limit erkannt für "${video.title}". Pausiere Verarbeitungsschleife für ${minutes} Minuten. Fehlermeldung: ${err.message}`);
          
          let waited = 0;
          while (waited < cooldownMs && ytDiscoveryAbortController && !ytDiscoveryAbortController.signal.aborted) {
            await new Promise(r => setTimeout(r, 10000));
            waited += 10000;
          }
        } else {
          // General errors: mark as failed
          await supabase.from("yt_videos").update({ status: "failed", error_msg: err.message }).eq("video_id", video.video_id);
          await logAndTelemetry("error", video.channel, `Download Error: ${err.message}`);
        }
      }
      
    } catch (err: any) {
      if (err.name === 'AbortError') break;
      await logAndTelemetry("error", null, `Processing Loop Error: ${err.message}`);
      await new Promise(r => setTimeout(r, 30000));
    }
  }
}

async function resolveChannelHandle(channel: string): Promise<string> {
  let targetHandle = channel.startsWith("@") ? channel.toLowerCase() : `@${channel.toLowerCase()}`;

  if (!channel.startsWith("@")) {
    const queryEmbedding = (await getEmbeddingsBatch([channel]))[0];
    const { data: searchResults, error: searchError } = await supabase.rpc("search_yt_channels", {
      query_embedding: queryEmbedding,
      query_text: channel,
      match_threshold: 0.5,
      match_count: 5,
    });

    if (!searchError && searchResults && searchResults.length > 0) {
      const top = searchResults[0] as any;
      const hasExactMatch = (top.match_quality ?? 0) >= 100;
      const confident = hasExactMatch || top.similarity > 0.8 || top.handle === targetHandle;
      if (searchResults.length === 1 || confident) {
        targetHandle = top.handle;
      } else {
        const listStr = searchResults.map((r: any) => `- ${r.handle} (${r.title})`).join("\n");
        throw new Error(`Mehrere Channels gefunden für '${channel}'. Bitte sei spezifischer:\n${listStr}`);
      }
    }
  }
  return targetHandle;
}

async function upgradeYtDlp() {
  try {
    console.log("[YT-Sync] Checking for yt-dlp updates...");
    const cmd = new Deno.Command("pipx", {
      args: ["upgrade", "yt-dlp"],
    });
    const output = await cmd.output();
    if (output.success) {
      console.log("[YT-Sync] yt-dlp successfully updated or already up-to-date.");
    } else {
      console.error("[YT-Sync] yt-dlp update failed:", new TextDecoder().decode(output.stderr));
    }
  } catch (err: any) {
    console.error("[YT-Sync] Failed to run yt-dlp auto-update:", err.message);
  }
}

// --- Tool Registration ---

export function registerYouTubeTools(server: McpServer) {
  // Start the background upgrade on server boot
  upgradeYtDlp().catch(console.error);

  // Tool 1: manage_yt_channels (mirrors manage_influencers)
  server.registerTool(
    "manage_yt_channels",
    {
      title: "Manage YouTube Channels",
      description: "List, add, or remove YouTube channels from the database.",
      inputSchema: {
        action: z.enum(["LIST", "ADD", "REMOVE"]).describe("The action to perform"),
        channel: z.string().optional().describe("YouTube Handle (@MarkMinervini) or Channel-URL (for ADD or REMOVE)"),
        notes: z.string().optional().describe("Optional notes about this channel (for ADD)"),
      },
    },
    async ({ action, channel, notes }: any) => {
      try {
        if (action === "LIST") {
          const { data, error } = await supabase
            .from("yt_channels")
            .select("handle, title, notes")
            .eq("is_active", true)
            .order("handle");

          if (error) throw error;
          if (!data || data.length === 0) {
            return { content: [{ type: "text", text: "Keine aktiven YouTube-Channels in der Datenbank gefunden." }] };
          }

          // Get video counts per channel
          const { data: videoCounts } = await supabase
            .from("yt_videos")
            .select("channel, video_id")
            .in("channel", data.map(c => c.handle))
            .eq("status", "embedded");

          const countMap = new Map<string, number>();
          for (const v of (videoCounts || [])) {
            countMap.set(v.channel, (countMap.get(v.channel) || 0) + 1);
          }

          const formatted = data.map((c: any, idx: number) =>
            `${idx + 1}. ${c.handle} (${c.title || "N/A"}) — ${countMap.get(c.handle) || 0} Videos — ${c.notes || ""}`
          ).join("\n");

          return { content: [{ type: "text", text: `Hier sind alle überwachten YouTube-Channels:\n\n${formatted}` }] };
        } else if (action === "ADD") {
          if (!channel) throw new Error("channel ist für ADD erforderlich");

          await sendTelemetry(`[YT] Löse Channel "${channel}" auf...`);
          const resolved = await resolveYtChannel(channel);

          // Generate embedding for fuzzy search
          const embedText = `handle: ${resolved.handle} title: ${resolved.title} notes: ${notes || ""}`;
          const embedding = (await getEmbeddingsBatch([embedText]))[0];

          const { error } = await supabase.from("yt_channels").upsert({
            handle: resolved.handle,
            channel_id: resolved.channelId,
            title: resolved.title,
            notes: notes || null,
            embedding: embedding,
            is_active: true,
          });

          if (error) throw error;

          // Trigger immediate sync in background
          syncSingleChannel(resolved.handle, ytDiscoveryAbortController?.signal).catch((err: any) => {
            console.error(`Immediate sync failed for ${resolved.handle}:`, err);
          });

          return {
            content: [{
              type: "text",
              text: `YouTube-Channel ${resolved.handle} (${resolved.title}) wurde erfolgreich zur Datenbank hinzugefügt und der Initial-Sync wurde im Hintergrund gestartet.`,
            }],
          };
        } else if (action === "REMOVE") {
          if (!channel) throw new Error("channel ist für REMOVE erforderlich");
          const cleanHandle = channel.startsWith("@") ? channel.toLowerCase() : `@${channel.toLowerCase()}`;
          const { error } = await supabase.from("yt_channels").update({ is_active: false }).eq("handle", cleanHandle);
          if (error) throw error;
          return { content: [{ type: "text", text: `YouTube-Channel ${cleanHandle} wurde deaktiviert.` }] };
        }
        throw new Error("Invalid action");
      } catch (err: any) {
        return { content: [{ type: "text", text: `Fehler: ${err.message}` }], isError: true };
      }
    },
  );

  // Tool 2: manage_yt_sync
  server.registerTool(
    "manage_yt_sync",
    {
      title: "Manage YouTube Sync",
      description: "Start or stop the background sync process, or show the current status.",
      inputSchema: {
        action: z.enum(["START", "STOP", "STATUS"]).describe("Action to perform"),
        hours_back: z.number().optional().default(24).describe("For STATUS: how many hours of logs to show"),
      },
    },
    async ({ action, hours_back }: any) => {
      try {
        if (action === "START") {
          if (ytDiscoveryStats.isRunning) {
            return { content: [{ type: "text", text: "Der YouTube Sync-Loop läuft bereits im Hintergrund." }] };
          }
          ytDiscoveryAbortController = new AbortController();
          runYtDiscoveryLoop().catch(console.error);
          runYtProcessingLoop().catch(console.error);

          // Kurz warten, damit der Loop die ersten Logs schreiben kann
          await new Promise(r => setTimeout(r, 2000));
          
          const { data: logs } = await supabase
            .from("yt_sync_logs")
            .select("*")
            .order("created_at", { ascending: false })
            .limit(5);
            
          let logText = "";
          if (logs && logs.length > 0) {
            logText = "\n\nAktuelle Aktionen (aus dem Log):\n" + logs.map((l: any) => `- [${l.action_type}] ${l.channel ? `(${l.channel}) ` : ''}${l.message}`).join("\n");
          }

          return { content: [{ type: "text", text: `Background YouTube Sync-Loop erfolgreich gestartet.${logText}` }] };
        } else if (action === "STOP") {
          if (!ytDiscoveryStats.isRunning || !ytDiscoveryAbortController) {
            return { content: [{ type: "text", text: "Der Sync-Loop läuft derzeit nicht." }] };
          }
          ytDiscoveryAbortController.abort();
          ytDiscoveryAbortController = null;
          return { content: [{ type: "text", text: "Abbruchsignal wurde an den Sync-Loop gesendet." }] };
        } else if (action === "STATUS") {
          const since = new Date(Date.now() - (hours_back * 60 * 60 * 1000)).toISOString();
          const { data: logs, error } = await supabase
            .from("yt_sync_logs")
            .select("*")
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .limit(50);
            
          if (error) throw error;
          
          let statusText = `YouTube Sync Status:\n- Läuft: ${ytDiscoveryStats.isRunning ? "Ja" : "Nein"}\n\nLetzte Aktionen (max 50, letzte ${hours_back} Stunden):\n`;
          if (!logs || logs.length === 0) {
            statusText += "Keine Logs in diesem Zeitraum.";
          } else {
            statusText += logs.map((l: any) => `[${new Date(l.created_at).toLocaleString("de-DE")}] [${l.action_type}] ${l.channel ? `(${l.channel}) ` : ''}${l.message}`).join("\n");
          }
          return { content: [{ type: "text", text: statusText }] };
        }
        return { content: [{ type: "text", text: "Invalid action" }], isError: true };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Fehler: ${err.message}` }], isError: true };
      }
    },
  );

  // Tool 2.5: show_yt_content
  server.registerTool(
    "show_yt_content",
    {
      title: "Show YouTube Content",
      description: "List videos for a channel either from the local database or directly from YouTube online.",
      inputSchema: {
        action: z.enum(["DATABASE", "ONLINE"]).describe("Source of the list: DATABASE (saved locally) or ONLINE (live from YouTube)"),
        channel: z.string().describe("YouTube Handle or fuzzy channel name"),
        limit: z.number().optional().default(10).describe("Max videos to return"),
      },
    },
    async ({ action, channel, limit }: any) => {
      try {
        const targetHandle = await resolveChannelHandle(channel);

        if (action === "DATABASE") {
          const { data: videos, error } = await supabase
            .from("yt_videos")
            .select("video_id, title, duration, published_at, status, error_msg")
            .eq("channel", targetHandle)
            .order("published_at", { ascending: false })
            .limit(limit);

          if (error) throw error;
          if (!videos || videos.length === 0) {
            return { content: [{ type: "text", text: `Keine Videos in der Datenbank für ${targetHandle} gefunden.` }] };
          }

          const formatted = videos.map((v: any, idx: number) => {
            const durationMin = Math.floor(v.duration / 60);
            const durationSec = v.duration % 60;
            const durationStr = `${durationMin}:${String(durationSec).padStart(2, "0")}`;
            const dateStr = v.published_at ? new Date(v.published_at).toLocaleDateString("de-DE") : "Unbekannt";
            let statusText = `[Status: ${v.status}]`;
            if (v.status === "embedded") statusText = "✅ embedded";
            else if (v.status === "downloaded") statusText = "📥 downloaded (ready for sync)";
            else if (v.status === "processing") statusText = "⏳ processing";
            else if (v.status === "failed") statusText = `❌ failed (${v.error_msg || "Unknown error"})`;
            else if (v.status === "pending") statusText = "⏱️ pending";

            return `${idx + 1}. ${dateStr} - **${v.title}** (${durationStr}) - ${statusText} (ID: ${v.video_id})`;
          }).join("\n");

          return { content: [{ type: "text", text: `Übersicht der Videos für ${targetHandle} (DATABASE):\n\n${formatted}` }] };
        } else if (action === "ONLINE") {
          const channelUrl = targetHandle.startsWith("http") ? targetHandle : `https://www.youtube.com/${targetHandle}`;

          await sendTelemetry(`[YT] Rufe Live-Video-Liste für ${targetHandle} ab...`);
          const videos = await getChannelVideos(channelUrl, limit);

          if (!videos || videos.length === 0) {
            return { content: [{ type: "text", text: `Keine Online-Videos für ${targetHandle} gefunden.` }] };
          }

          const formatted = videos.map((v: any, idx: number) => {
            const durationMin = Math.floor(v.duration / 60);
            const durationSec = v.duration % 60;
            const durationStr = `${durationMin}:${String(durationSec).padStart(2, "0")}`;
            const dateStr = v.publishedAt ? new Date(v.publishedAt).toLocaleDateString("de-DE") : "Unbekannt";
            return `${idx + 1}. [${dateStr}] - **${v.title}** (${durationStr}) - URL: https://www.youtube.com/watch?v=${v.videoId}`;
          }).join("\n");

          const urlList = JSON.stringify(
            videos.map((v: any) => `https://www.youtube.com/watch?v=${v.videoId}`),
          );
          const anchor = `\n\nURLs: ${urlList}`;
          const hint =
            `\n\n💡 Um diese ${videos.length} Videos zu importieren, rufe ` +
            `manage_yt_sync(action="START", video_urls=<URLs-Array oben>) auf.`;

          return { content: [{ type: "text", text: `Verfügbare Online-Videos für ${targetHandle} (ONLINE):\n\n${formatted}${anchor}${hint}` }] };
        }

        return { content: [{ type: "text", text: "Invalid action" }], isError: true };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Fehler: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool 3: show_yt_transcript
  server.registerTool(
    "show_yt_transcript",
    {
      title: "Show YouTube Transcript",
      description: "Read the transcript directly or show it in the chat interface via telemetry without loading it into the LLM context.",
      inputSchema: {
        action: z.enum(["READ", "SHOW"]).describe("READ: Returns transcript in response (LLM reads it). SHOW: Sends transcript to UI via telemetry (no LLM context overhead)."),
        video_names: z.array(z.string()).describe("Array of video titles or YouTube Video-IDs."),
        include_timestamps: z.boolean().optional().default(false).describe("If true, includes [MM:SS] timestamps in the output. If false (default), strips them to keep the context size smaller."),
      },
    },
    async ({ action, video_names, include_timestamps }: any) => {
      try {
        if (!video_names || video_names.length === 0) {
          throw new Error("Mindestens ein Videoname/ID ist erforderlich.");
        }

        const results = [];
        for (const name of video_names) {
          // 1. Try exact video ID
          const { data: exactId } = await supabase
            .from("yt_videos")
            .select("video_id, title, transcript")
            .eq("video_id", name)
            .limit(1);
          
          if (exactId && exactId.length > 0) {
            results.push(exactId[0]);
            continue;
          }

          // 2. Try exact title
          const { data: exactTitle } = await supabase
            .from("yt_videos")
            .select("video_id, title, transcript")
            .eq("title", name)
            .limit(1);
          
          if (exactTitle && exactTitle.length > 0) {
            results.push(exactTitle[0]);
            continue;
          }

          // 3. Try fuzzy title match
          const { data: fuzzyTitle } = await supabase
            .from("yt_videos")
            .select("video_id, title, transcript")
            .ilike("title", `%${name}%`)
            .order("published_at", { ascending: false })
            .limit(1);
          
          if (fuzzyTitle && fuzzyTitle.length > 0) {
            results.push(fuzzyTitle[0]);
            continue;
          }

          results.push({ video_id: null, title: name, transcript: null });
        }

        const processTranscriptText = (text: string | null): string => {
          if (!text) return "Kein Transkript vorhanden.";
          if (include_timestamps) return text;
          // Strip lines matching [MM:SS] or [HH:MM:SS] or similar bracketed timestamps
          return text
            .split("\n")
            .filter((line: string) => !line.trim().match(/^\[\d{2,}(:\d{2}){1,2}\]$/))
            .join("\n");
        };

        if (action === "READ") {
          const contents = results.map((r: any) => {
            if (!r.video_id) {
              return `=== "${r.title}" nicht gefunden ===`;
            }
            return `=== TRANSKRIPT FÜR "${r.title}" (ID: ${r.video_id}) ===\n\n${processTranscriptText(r.transcript)}`;
          }).join("\n\n=======================\n\n");
          return { content: [{ type: "text", text: contents }] };
        } else if (action === "SHOW") {
          let summary = "Transkripte wurden per Telemetrie gesendet:\n";
          for (const r of results) {
            if (!r.video_id) {
              summary += `- "${r.title}": Nicht in Datenbank gefunden.\n`;
              continue;
            }
            const header = `=== TRANSKRIPT FÜR "${r.title}" (ID: ${r.video_id}) ===\n\n`;
            const content = processTranscriptText(r.transcript);
            await sendTelemetry(header + content);
            summary += `- "${r.title}" (ID: ${r.video_id}): Gesendet (${content.length} Zeichen).\n`;
          }
          return { content: [{ type: "text", text: summary }] };
        }

        throw new Error("Ungültige Aktion.");
      } catch (err: any) {
        return { content: [{ type: "text", text: `Fehler: ${err.message}` }], isError: true };
      }
    }
  );
}
