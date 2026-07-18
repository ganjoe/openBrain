import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase, getEmbeddingsBatch, sendTelemetry, LM_STUDIO_URL, AGENT_ID } from "./shared.ts";

// --- Constants ---
const YT_COOKIES_PATH = "/app/cookies.txt";

// --- In-Memory Sync Lock (like activeSyncControllers in x.ts) ---
export const activeYtSyncControllers = new Map<string, AbortController>();

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
interface YtSegmentationResult {
  global_context: string;
  blocks: Array<{
    content: string;
    start_time: string;
    end_time: string;
    tickers: string[];
    topic: string;
  }>;
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

  const cmd = new Deno.Command("yt-dlp", {
    args: [
      "--cookies", YT_COOKIES_PATH,
      "--dump-json",
      "--playlist-items", "1",
      "--skip-download",
      target,
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const output = await cmd.output();
  if (!output.success) {
    const errText = new TextDecoder().decode(output.stderr);
    throw new Error(`yt-dlp channel resolve failed: ${errText.substring(0, 200)}`);
  }

  const jsonStr = new TextDecoder().decode(output.stdout).trim().split("\n")[0]; // Take first line only
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
 * Uses yt-dlp to list videos from a channel.
 * Returns array of { videoId, title, duration, publishedAt, targetLang }.
 */
async function getChannelVideos(channelUrl: string, limit?: number): Promise<Array<{
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
  args.push(target);

  const cmd = new Deno.Command("yt-dlp", {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  const output = await cmd.output();
  if (!output.success) {
    const errText = new TextDecoder().decode(output.stderr);
    throw new Error(`yt-dlp video list failed: ${errText.substring(0, 200)}`);
  }

  const lines = new TextDecoder().decode(output.stdout).trim().split("\n");
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
async function downloadVtt(videoId: string, targetLang: string): Promise<string | null> {
  const outputDir = "/data/yt/vtt";

  // Ensure directory exists
  try {
    await Deno.mkdir(outputDir, { recursive: true });
  } catch { /* already exists */ }

  const outputTemplate = `${outputDir}/${videoId}`;

  const cmd = new Deno.Command("yt-dlp", {
    args: [
      "--cookies", YT_COOKIES_PATH,
      "--write-auto-sub",
      "--sub-lang", targetLang,
      "--skip-download",
      "--sub-format", "vtt",
      "--output", outputTemplate,
      `https://www.youtube.com/watch?v=${videoId}`,
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const output = await cmd.output();
  if (!output.success) {
    const errText = new TextDecoder().decode(output.stderr);
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
 * Sends the full transcript to LM Studio for semantic segmentation.
 * Uses the same LM Studio call pattern as runLlmCategorizationLoop in x.ts.
 */
async function segmentTranscript(plaintext: string, targetLang: string, signal?: AbortSignal): Promise<{
  result: YtSegmentationResult;
  duration: number;
  tokens: number;
  ts: string;
}> {
  // Load segmentation prompt based on targetLang
  let promptText = "";
  const promptFile = targetLang === "de" ? "yt-segmentation-prompt-de.txt" : "yt-segmentation-prompt-en.txt";
  try {
    promptText = Deno.readTextFileSync(`/app/${promptFile}`);
  } catch {
    try {
      promptText = Deno.readTextFileSync(promptFile);
    } catch {
      promptText = targetLang === "de"
        ? "Extrahiere semantische Blöcke aus diesem Transkript. Gib ein JSON mit global_context und blocks-Array zurück."
        : "Extract semantic blocks from this transcript. Return JSON with global_context and blocks array.";
    }
  }

  const start = Date.now();

  const res = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "local-model",
      messages: [
        { role: "system", content: promptText },
        { role: "user", content: plaintext },
      ],
      temperature: 0.1,
    }),
    signal: signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LM Studio segmentation failed (${res.status}): ${errText.substring(0, 200)}`);
  }

  const d = await res.json();
  const duration = (Date.now() - start) / 1000;
  const tokens = d.usage?.total_tokens || 0;
  const ts = duration > 0 ? (tokens / duration).toFixed(1) : "0.0";

  // Parse JSON from LLM response (same pattern as x.ts line 380-390)
  const content = d.choices?.[0]?.message?.content || "";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("LLM returned no valid JSON for segmentation");
  }

  const parsed = JSON.parse(jsonMatch[0]) as YtSegmentationResult;

  if (!parsed.global_context || !Array.isArray(parsed.blocks)) {
    throw new Error("LLM JSON missing required fields (global_context, blocks)");
  }

  return { result: parsed, duration, tokens, ts };
}

// --- Background Worker ---

/**
 * Processes a single video: download VTT → plaintext → LLM segmentation → embedding → DB insert.
 * Returns the number of chunks saved.
 */
async function processVideo(
  videoId: string,
  channel: string,
  videoTitle: string,
  publishedAt: string,
  targetLang: string,
  videoIndex: number,
  totalVideos: number,
  signal?: AbortSignal
): Promise<string[]> {
  const savedChunkIds: string[] = [];

  // 1. Update status to processing
  await supabase.from("yt_videos").update({ status: "processing" }).eq("video_id", videoId);

  // 2. Fetch transcript and language from DB
  const { data: videoData, error: dbError } = await supabase
    .from("yt_videos")
    .select("transcript, language")
    .eq("video_id", videoId)
    .single();

  let plaintext = videoData?.transcript;
  let detectedLang = videoData?.language || targetLang || "en";

  if (dbError || !plaintext) {
    // Fallback: Download VTT and convert
    await sendTelemetry(`📥 [${videoIndex}/${totalVideos}] Transkript nicht in DB für "${videoTitle}". Lade VTT...`);
    const vttContent = await downloadVtt(videoId, detectedLang);
    if (!vttContent) {
      await supabase.from("yt_videos").update({
        status: "failed",
        error_msg: "Keine Auto-Captions verfügbar",
      }).eq("video_id", videoId);
      await sendTelemetry(`⚠️ [${videoIndex}/${totalVideos}] Keine Untertitel für "${videoTitle}" — übersprungen.`);
      return [];
    }
    plaintext = vttToPlaintext(vttContent);
    // save to DB for future reference
    await supabase.from("yt_videos").update({ transcript: plaintext, language: detectedLang }).eq("video_id", videoId);
  }

  if (signal?.aborted) throw new Error("Sync abgebrochen.");

  await sendTelemetry(`📥 [${videoIndex}/${totalVideos}] Transkript geladen: ${plaintext.length} Zeichen (Sprache: ${detectedLang}) → LLM-Segmentierung...`);

  // 4. LLM Segmentation
  await sendTelemetry(`🧠 [${videoIndex}/${totalVideos}] Segmentiere Transkript via LM Studio für "${videoTitle}"...`);
  const { result: segmentation, duration: segDuration, tokens: segTokens, ts: segSpeed } = await segmentTranscript(plaintext, detectedLang, signal);
  await sendTelemetry(`🧠 [${videoIndex}/${totalVideos}] Segmentierung abgeschlossen: ${segmentation.blocks.length} Blöcke extrahiert (Dauer: ${segDuration.toFixed(1)}s | Speed: ${segSpeed} t/s).`);

  if (signal?.aborted) throw new Error("Sync abgebrochen.");

  // 5. Contextual Augmentation + Embedding
  const augmentedTexts: string[] = [];
  const batchToInsert: any[] = [];

  for (let i = 0; i < segmentation.blocks.length; i++) {
    const block = segmentation.blocks[i];

    // Augment: prepend global context to each block
    const blockContent = block.content || (block as any).text || (block as any).block_content || (block as any).summary || (block as any).description || "";
    if (!blockContent) {
      console.warn(`[YT] Warnung: Block ${i} hat keinen Inhalt! Keys:`, Object.keys(block));
    }
    const augmentedContent = `[Kontext] ${segmentation.global_context}\n\n[Inhalt] ${blockContent}`;
    augmentedTexts.push(augmentedContent);

    batchToInsert.push({
      agent_id: AGENT_ID,
      artifact_type: "yt_chunk",
      content: augmentedContent,
      metadata: {
        channel: channel,
        video_id: videoId,
        video_title: videoTitle,
        block_index: i,
        start_time: block.start_time,
        end_time: block.end_time,
        topic: block.topic || (block as any).title || (block as any).subject || "General Discussion",
        tickers: block.tickers || [],
        published_at: publishedAt,
      },
    });
  }

  // 6. Batch Embedding via Ollama
  await sendTelemetry(`⚡ [${videoIndex}/${totalVideos}] Generiere ${augmentedTexts.length} Vektoren (Embeddings) via Ollama...`);
  const embedStart = Date.now();
  const embeddings = await getEmbeddingsBatch(augmentedTexts);
  const embedDuration = (Date.now() - embedStart) / 1000;
  batchToInsert.forEach((item, idx) => {
    item.embedding = embeddings[idx];
  });
  await sendTelemetry(`⚡ [${videoIndex}/${totalVideos}] Vektoren generiert in ${embedDuration.toFixed(1)}s (${(embedDuration / augmentedTexts.length).toFixed(2)}s pro Block).`);

  // 7. Insert into agent_workspace
  await sendTelemetry(`💾 [${videoIndex}/${totalVideos}] Speichere ${augmentedTexts.length} Blöcke in der Datenbank...`);
  const { data: upsertedRows, error: upsertError } = await supabase
    .from("agent_workspace")
    .insert(batchToInsert)
    .select("id");

  if (upsertError) {
    throw new Error(`Supabase insert failed: [${upsertError.code}] ${upsertError.message}`);
  }

  if (upsertedRows) {
    for (const row of upsertedRows) {
      if (row?.id) savedChunkIds.push(row.id);
    }
  }

  // 8. Update yt_videos status
  const { error: statusError } = await supabase.from("yt_videos").update({
    status: "embedded",
    chunk_count: segmentation.blocks.length,
    error_msg: null,
  }).eq("video_id", videoId);
  if (statusError) console.error(`[YT] yt_videos status update failed:`, statusError);

  await sendTelemetry(`✅ [${videoIndex}/${totalVideos}] "${videoTitle}" erfolgreich verarbeitet (${segmentation.blocks.length} Blöcke).`);

  return savedChunkIds;
}

/**
 * Main background sync function. Processes all new videos for a channel.
 * Mirrors runBackgroundSync() in x.ts.
 */
/**
 * Phase 1: Proactively discover new videos and download their transcripts (fast).
 */
export async function runYtDiscovery(
  channelInput: string,
  limit: number,
  videoUrl: string | undefined,
  signal?: AbortSignal,
) {
  let channel = channelInput;
  let videosToProcess: Array<{ videoId: string; title: string; duration: number; publishedAt: string; targetLang: string }> = [];

  try {
    if (videoUrl) {
      // Single video mode
      const videoIdMatch = videoUrl.match(/(?:v=|youtu\.be\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
      if (!videoIdMatch) throw new Error(`Ungültige YouTube-URL: ${videoUrl}`);
      const videoId = videoIdMatch[1];

      const cmd = new Deno.Command("yt-dlp", {
        args: ["--cookies", YT_COOKIES_PATH, "--dump-json", "--skip-download", videoUrl],
        stdout: "piped",
        stderr: "piped",
      });
      const output = await cmd.output();
      if (!output.success) throw new Error("yt-dlp metadata fetch failed");
      const meta = JSON.parse(new TextDecoder().decode(output.stdout));

      videosToProcess = [{
        videoId,
        title: meta.title || "Unknown",
        duration: meta.duration || 0,
        publishedAt: meta.upload_date
          ? `${meta.upload_date.substring(0, 4)}-${meta.upload_date.substring(4, 6)}-${meta.upload_date.substring(6, 8)}T00:00:00Z`
          : new Date().toISOString(),
        targetLang: determineTargetLang(meta),
      }];

      const channelHandle = meta.channel?.startsWith("@") ? meta.channel.toLowerCase() : `@${(meta.channel || meta.uploader || "unknown").toLowerCase()}`;
      channel = channelHandle;

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
    } else {
      // Channel mode
      const { data: channelData } = await supabase
        .from("yt_channels")
        .select("handle, channel_id")
        .eq("handle", channel)
        .single();

      if (!channelData) throw new Error(`Channel ${channel} nicht in der Datenbank gefunden.`);

      const channelUrl = `https://www.youtube.com/${channelData.handle}`;
      videosToProcess = await getChannelVideos(channelUrl, limit);
    }

    const videoIds = videosToProcess.map(v => v.videoId);
    const { data: existingVideos } = await supabase
      .from("yt_videos")
      .select("video_id, status")
      .in("video_id", videoIds);

    const existingStatusMap = new Map<string, string>((existingVideos || []).map(v => [v.video_id, v.status]));

    const newVideos = videosToProcess.filter(v => {
      const status = existingStatusMap.get(v.videoId);
      return !status || (status !== "downloaded" && status !== "embedded" && status !== "processing");
    });

    if (newVideos.length === 0) {
      return;
    }

    for (const video of newVideos) {
      if (signal?.aborted) throw new Error("Sync abgebrochen.");

      // Upsert as pending
      await supabase.from("yt_videos").upsert({
        video_id: video.videoId,
        channel: channel,
        title: video.title,
        duration: video.duration,
        published_at: video.publishedAt,
        status: "pending",
        language: video.targetLang || "en",
      }, { onConflict: "video_id" });

      try {
        await sendTelemetry(`[YT Discovery] Lade Transkript für "${video.title}"...`);
        const vttContent = await downloadVtt(video.videoId, video.targetLang || "en");
        if (!vttContent) {
          await supabase.from("yt_videos").update({
            status: "failed",
            error_msg: "Keine Auto-Captions verfügbar",
          }).eq("video_id", video.videoId);
          ytDiscoveryStats.failedCount++;
          continue;
        }

        const plaintext = vttToPlaintext(vttContent);
        await supabase.from("yt_videos").update({
          transcript: plaintext,
          status: "downloaded",
          error_msg: null,
        }).eq("video_id", video.videoId);

        ytDiscoveryStats.processedCount++;
      } catch (err: any) {
        if (err.message.includes("abgebrochen")) throw err;
        console.error(`[YT Discovery] Fehler bei ${video.videoId}:`, err);
        await supabase.from("yt_videos").update({
          status: "failed",
          error_msg: err.message?.substring(0, 500),
        }).eq("video_id", video.videoId);
        ytDiscoveryStats.failedCount++;
      }
    }
  } catch (err: any) {
    console.error(`[YT Discovery] Fehler bei Channel ${channel}:`, err);
  }
}

/**
 * Periodically runs Phase 1 for all active channels in the database.
 */
export async function runYtDiscoveryLoop() {
  ytDiscoveryStats.isRunning = true;
  ytDiscoveryStats.startTime = Date.now();
  ytDiscoveryStats.processedCount = 0;
  ytDiscoveryStats.failedCount = 0;
  ytDiscoveryStats.lastError = "";

  while (ytDiscoveryAbortController && !ytDiscoveryAbortController.signal.aborted) {
    try {
      const { data: channels, error } = await supabase
        .from("yt_channels")
        .select("handle")
        .eq("is_active", true);

      if (error) throw error;

      if (channels && channels.length > 0) {
        for (const ch of channels) {
          if (!ytDiscoveryAbortController || ytDiscoveryAbortController.signal.aborted) break;
          await runYtDiscovery(ch.handle, 10, undefined, ytDiscoveryAbortController.signal);
        }
      }

      ytDiscoveryStats.lastRunTime = Date.now();

      // Wait 60 minutes
      const delay = 60 * 60 * 1000;
      const step = 10000;
      let waited = 0;
      while (waited < delay && ytDiscoveryAbortController && !ytDiscoveryAbortController.signal.aborted) {
        await new Promise(r => setTimeout(r, step));
        waited += step;
      }
    } catch (err: any) {
      if (err.name === 'AbortError') break;
      console.error("YT Discovery Loop Error:", err.message);
      ytDiscoveryStats.lastError = err.message;
      await new Promise(r => setTimeout(r, 60000));
    }
  }

  ytDiscoveryStats.isRunning = false;
}

/**
 * Main background sync function. Processes all new videos for a channel.
 * Mirrors runBackgroundSync() in x.ts.
 */
export async function runYtSync(
  channelInput: string,
  limit: number,
  videoUrl: string | undefined,
  signal?: AbortSignal,
) {
  let channel = channelInput; // may be overwritten in single-video mode
  const sessionId = `yt_sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const allSavedChunkIds: string[] = [];

  try {
    await sendTelemetry(`[YT Sync] Hintergrund-Sync für ${channel} startet...`);

    let videosToProcess: Array<{ videoId: string; title: string; duration: number; publishedAt: string; targetLang: string }> = [];

    if (videoUrl) {
      // Single video mode: extract video ID from URL
      const videoIdMatch = videoUrl.match(/(?:v=|youtu\.be\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
      if (!videoIdMatch) throw new Error(`Ungültige YouTube-URL: ${videoUrl}`);
      const videoId = videoIdMatch[1];

      // Get video metadata via yt-dlp
      const cmd = new Deno.Command("yt-dlp", {
        args: ["--cookies", YT_COOKIES_PATH, "--dump-json", "--skip-download", videoUrl],
        stdout: "piped",
        stderr: "piped",
      });
      const output = await cmd.output();
      if (!output.success) throw new Error("yt-dlp metadata fetch failed");
      const meta = JSON.parse(new TextDecoder().decode(output.stdout));

      const channelHandle = meta.channel?.startsWith("@") ? meta.channel.toLowerCase() : `@${(meta.channel || meta.uploader || "unknown").toLowerCase()}`;
      channel = channelHandle;

      videosToProcess = [{
        videoId,
        title: meta.title || "Unknown",
        duration: meta.duration || 0,
        publishedAt: meta.upload_date
          ? `${meta.upload_date.substring(0, 4)}-${meta.upload_date.substring(4, 6)}-${meta.upload_date.substring(6, 8)}T00:00:00Z`
          : new Date().toISOString(),
        targetLang: determineTargetLang(meta),
      }];

      // Ensure the channel entry exists for single video mode
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

      // Ensure the video entry exists in DB
      await supabase.from("yt_videos").upsert({
        video_id: videoId,
        channel: channelHandle,
        title: meta.title || "Unknown",
        status: "downloaded",
        duration: meta.duration || 0,
        published_at: videosToProcess[0].publishedAt,
        language: videosToProcess[0].targetLang,
      });
    } else {
      // Channel mode: get downloaded videos from DB instead of scraping YouTube
      const { data: channelData } = await supabase
        .from("yt_channels")
        .select("handle, channel_id")
        .eq("handle", channel)
        .single();

      if (!channelData) throw new Error(`Channel ${channel} nicht in der Datenbank gefunden.`);

      const { data: downloadedVideos, error: dbError } = await supabase
        .from("yt_videos")
        .select("video_id, title, duration, published_at, language")
        .eq("channel", channel)
        .eq("status", "downloaded")
        .order("published_at", { ascending: false })
        .limit(limit);

      if (dbError) throw dbError;

      videosToProcess = (downloadedVideos || []).map(v => ({
        videoId: v.video_id,
        title: v.title,
        duration: v.duration || 0,
        publishedAt: v.published_at || new Date().toISOString(),
        targetLang: v.language || "en",
      }));
    }

    // Filter out already processed videos
    const videoIds = videosToProcess.map(v => v.videoId);
    const { data: existingVideos } = await supabase
      .from("yt_videos")
      .select("video_id")
      .in("video_id", videoIds)
      .in("status", ["embedded", "processing"]);

    const existingIds = new Set((existingVideos || []).map(v => v.video_id));
    const newVideos = videosToProcess.filter(v => !existingIds.has(v.videoId));

    if (newVideos.length === 0) {
      await sendTelemetry(`[YT Sync] Keine ausstehenden Videos zu verarbeiten für ${channel}.`);
      return;
    }

    await sendTelemetry(`[YT Sync] ${newVideos.length} Videos werden segmentiert & eingebettet.`);

    // Process each video sequentially
    let processed = 0;
    for (const video of newVideos) {
      if (signal?.aborted) throw new Error("Sync abgebrochen.");

      try {
        const chunkIds = await processVideo(
          video.videoId,
          channel,
          video.title,
          video.publishedAt,
          video.targetLang || "en",
          processed + 1,
          newVideos.length,
          signal,
        );
        allSavedChunkIds.push(...chunkIds);
        processed++;
      } catch (err: any) {
        if (err.message.includes("abgebrochen")) throw err;
        console.error(`[YT] Failed to process video ${video.videoId}:`, err);
        await supabase.from("yt_videos").update({
          status: "failed",
          error_msg: err.message?.substring(0, 500),
        }).eq("video_id", video.videoId);
        await sendTelemetry(`[YT] ⚠️ Fehler bei "${video.title}": ${err.message?.substring(0, 100)}`);
      }
    }

    await sendTelemetry(`[YT Sync] Sync ${channel} abgeschlossen: ${processed} Videos, ${allSavedChunkIds.length} Blöcke gespeichert.`);

    // Trigger CCO summary (same pattern as X sync completion)
    if (allSavedChunkIds.length > 0) {
      try {
        await fetch("http://nexus-service:7734/api/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from_agent: "system",
            to: "cco",
            text: `Der YouTube-Sync für ${channel} ist abgeschlossen. ${processed} Videos verarbeitet, ${allSavedChunkIds.length} semantische Blöcke gespeichert. Analysiere die neuen Inhalte und schreibe die Zusammenfassung an 'boss'.`,
            msg_type: "chat",
            metadata: {
              sync_session_id: sessionId,
              sync_channel: channel,
              sync_chunk_ids: allSavedChunkIds,
              sync_chunk_count: allSavedChunkIds.length,
              sync_type: "youtube",
            },
          }),
        });
      } catch (e) {
        console.error("Failed to trigger CCO summary:", e);
      }
    }
  } catch (err: any) {
    if (err.name === "AbortError" || err.message?.includes("abgebrochen")) {
      await sendTelemetry(`[YT Sync] Sync ${channel} wurde abgebrochen.`);
    } else {
      console.error(`[YT Sync] Failed for ${channel}:`, err);
      await sendTelemetry(`[YT Sync] Sync ${channel} fehlgeschlagen: ${err.message}`);
    }
  } finally {
    activeYtSyncControllers.delete(channelInput);
  }
}

// --- Channel Resolution Helper ---
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

// --- Tool Registration ---

export function registerYouTubeTools(server: McpServer) {
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
          return {
            content: [{
              type: "text",
              text: `YouTube-Channel ${resolved.handle} (${resolved.title}) wurde erfolgreich zur Datenbank hinzugefügt.`,
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

  // Tool 2: manage_yt_sync (mirrors manage_background_sync)
  server.registerTool(
    "manage_yt_sync",
    {
      title: "Manage YouTube Sync",
      description: "Start or cancel background sync for YouTube transcripts.",
      inputSchema: {
        action: z.enum(["START", "CANCEL"]).describe("The action to perform"),
        channel: z.string().describe("YouTube Handle, fuzzy name, or 'all'"),
        limit: z.number().optional().describe("Max videos to process (default: 20, newest first)"),
        video_url: z.string().optional().describe("Optional: process a single video URL instead of a channel"),
      },
    },
    async ({ action, channel, limit, video_url }: any) => {
      try {
        if (action === "START") {
          const targetLimit = limit || 20;

          // Single video mode
          if (video_url) {
            const syncKey = `video:${video_url}`;
            if (activeYtSyncControllers.has(syncKey)) {
              return { content: [{ type: "text", text: `Dieses Video wird bereits verarbeitet.` }] };
            }
            const controller = new AbortController();
            activeYtSyncControllers.set(syncKey, controller);
            runYtSync(syncKey, 1, video_url, controller.signal);
            return { content: [{ type: "text", text: `Hintergrund-Sync für einzelnes Video gestartet. Ich informiere dich via Chat über den Fortschritt.` }] };
          }

          // "all" mode
          if (channel.toLowerCase() === "all") {
            const { data: channels, error } = await supabase
              .from("yt_channels")
              .select("handle")
              .eq("is_active", true);

            if (error || !channels || channels.length === 0) {
              return { content: [{ type: "text", text: "Keine aktiven YouTube-Channels in der Datenbank gefunden." }] };
            }

            // Start sequential background sync
            (async () => {
              for (const ch of channels) {
                if (activeYtSyncControllers.has(ch.handle)) continue;
                const controller = new AbortController();
                activeYtSyncControllers.set(ch.handle, controller);
                await runYtSync(ch.handle, targetLimit, undefined, controller.signal);
              }
            })();

            return {
              content: [{
                type: "text",
                text: `Massen-Sync für ${channels.length} YouTube-Channels gestartet. Dies geschieht nacheinander im Hintergrund.`,
              }],
            };
          }

          // Single channel mode
          const targetHandle = await resolveChannelHandle(channel);

          // Check in-memory lock
          if (activeYtSyncControllers.has(targetHandle)) {
            return { content: [{ type: "text", text: `Ein Sync für ${targetHandle} läuft bereits.` }] };
          }

          const controller = new AbortController();
          activeYtSyncControllers.set(targetHandle, controller);
          runYtSync(targetHandle, targetLimit, undefined, controller.signal);

          return {
            content: [{
              type: "text",
              text: `Hintergrund-Sync für ${targetHandle} gestartet (max ${targetLimit} Videos). Ich informiere dich via Chat über den Fortschritt.`,
            }],
          };
        } else if (action === "CANCEL") {
          const cleanHandle = channel.startsWith("@") ? channel.toLowerCase() : `@${channel.toLowerCase()}`;
          const controller = activeYtSyncControllers.get(cleanHandle);
          if (!controller) {
            return { content: [{ type: "text", text: `Es läuft aktuell kein Sync für ${cleanHandle}.` }] };
          }
          controller.abort();
          return { content: [{ type: "text", text: `Abbruch-Signal für den Sync von ${cleanHandle} wurde gesendet.` }] };
        }
        return { content: [{ type: "text", text: "Invalid action" }], isError: true };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Fehler: ${err.message}` }], isError: true };
      }
    },
  );

  // Tool 2.5: list_yt_videos
  server.registerTool(
    "list_yt_videos",
    {
      title: "List YouTube Videos",
      description: "List videos for a channel from the database, sorted by date.",
      inputSchema: {
        channel: z.string().describe("YouTube Handle or fuzzy channel name"),
        limit: z.number().optional().default(10).describe("Max videos to return (default: 10, max: 50)"),
      },
    },
    async ({ channel, limit }: any) => {
      try {
        const targetHandle = await resolveChannelHandle(channel);

        const { data: videos, error } = await supabase
          .from("yt_videos")
          .select("video_id, title, duration, published_at, status, error_msg")
          .eq("channel", targetHandle)
          .order("published_at", { ascending: false })
          .limit(Math.min(limit, 50));

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

        return { content: [{ type: "text", text: `Übersicht der Videos für ${targetHandle}:\n\n${formatted}` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Fehler: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool 2.5b: list_online_yt_videos
  server.registerTool(
    "list_online_yt_videos",
    {
      title: "List Online YouTube Videos",
      description: "List available videos directly from a YouTube channel online using yt-dlp, without downloading or importing them.",
      inputSchema: {
        channel: z.string().describe("YouTube Handle or fuzzy channel name"),
        limit: z.number().optional().describe("Max videos to return (if not specified, all videos will be listed)"),
      },
    },
    async ({ channel, limit }: any) => {
      try {
        const targetHandle = await resolveChannelHandle(channel);
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

        return { content: [{ type: "text", text: `Verfügbare Online-Videos für ${targetHandle}:\n\n${formatted}` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Fehler: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool 2.6: manage_yt_discovery
  server.registerTool(
    "manage_yt_discovery",
    {
      title: "Manage YouTube Discovery Loop",
      description: "Controls the background proactive transcript discovery loop.",
      inputSchema: {
        action: z.enum(["START", "STOP", "STATUS"]).describe("Action to perform"),
      },
    },
    async ({ action }: any) => {
      try {
        if (action === "START") {
          if (ytDiscoveryStats.isRunning) {
            return { content: [{ type: "text", text: "Der YouTube Discovery-Loop läuft bereits im Hintergrund." }] };
          }
          ytDiscoveryAbortController = new AbortController();
          runYtDiscoveryLoop().catch(console.error);
          return { content: [{ type: "text", text: "Background YouTube Discovery Loop erfolgreich gestartet." }] };
        } else if (action === "STOP") {
          if (!ytDiscoveryStats.isRunning || !ytDiscoveryAbortController) {
            return { content: [{ type: "text", text: "Der Discovery-Loop läuft derzeit nicht." }] };
          }
          ytDiscoveryAbortController.abort();
          ytDiscoveryAbortController = null;
          return { content: [{ type: "text", text: "Abbruchsignal wurde an den Discovery-Loop gesendet." }] };
        } else if (action === "STATUS") {
          const statusText = `YouTube Discovery Loop Status:
- Läuft: ${ytDiscoveryStats.isRunning ? "Ja" : "Nein"}
- Gestartet: ${ytDiscoveryStats.startTime > 0 ? new Date(ytDiscoveryStats.startTime).toLocaleString("de-DE") : "N/A"}
- Letzter Lauf: ${ytDiscoveryStats.lastRunTime > 0 ? new Date(ytDiscoveryStats.lastRunTime).toLocaleString("de-DE") : "N/A"}
- Erfolgreich geladen: ${ytDiscoveryStats.processedCount}
- Fehlgeschlagen: ${ytDiscoveryStats.failedCount}
- Letzter Fehler: ${ytDiscoveryStats.lastError || "Keiner"}`;
          return { content: [{ type: "text", text: statusText }] };
        }
        throw new Error("Ungültige Aktion");
      } catch (err: any) {
        return { content: [{ type: "text", text: `Fehler: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool 3: search_yt_content (mirrors search_influencer_posts)
  server.registerTool(
    "search_yt_content",
    {
      title: "Search YouTube Content",
      description: "Search through processed YouTube transcript blocks using semantic, exact, context, or transcript methods.",
      inputSchema: {
        action: z.enum(["SEMANTIC", "EXACT", "CONTEXT", "TRANSCRIPT", "TICKERS"]).describe("The type of search"),
        query: z.string().optional().describe("Search query for SEMANTIC or EXACT"),
        channel_filter: z.string().optional().describe("Limit search to a specific channel handle"),
        limit: z.number().optional().default(10).describe("Max results (default: 10)"),
        threshold: z.number().optional().default(0.4).describe("Similarity threshold for SEMANTIC (default: 0.4)"),
        video_id: z.string().optional().describe("Video ID for CONTEXT and TRANSCRIPT"),
        block_index: z.number().optional().describe("Block index for CONTEXT (shows surrounding blocks)"),
        days_back: z.number().optional().describe("Filter blocks from the last X days"),
        return_mode: z.enum(["snippets", "full_text", "ids_only"]).optional().default("snippets").describe("Return format"),
        dump_to_chat: z.boolean().optional().default(false).describe("If true, dump results to chat instead of returning text"),
      },
    },
    async ({ action, query, channel_filter, limit, threshold, video_id, block_index, days_back, return_mode, dump_to_chat }: any) => {
      try {
        if (action === "SEMANTIC") {
          const actualQuery = query || "";
          const qEmb = (await getEmbeddingsBatch([actualQuery]))[0];
          const { data, error } = await supabase.rpc("semantic_search_workspace", {
            query_embedding: qEmb,
            match_threshold: threshold,
            match_count: limit,
            p_agent_id: AGENT_ID,
            p_artifact_type: "yt_chunk",
            p_days_back: days_back || null,
          });
          if (error) throw error;
          if (!data || data.length === 0) return { content: [{ type: "text", text: "Keine Ergebnisse gefunden." }] };

          // Apply channel_filter client-side if specified
          let filtered = data;
          if (channel_filter) {
            const filterHandle = channel_filter.startsWith("@") ? channel_filter.toLowerCase() : `@${channel_filter.toLowerCase()}`;
            filtered = data.filter((r: any) => r.metadata?.channel === filterHandle);
          }

          if (dump_to_chat) {
            await dumpYtResults("YouTube SEMANTIC: " + actualQuery, filtered);
            return { content: [{ type: "text", text: `${filtered.length} Blöcke an Chat gesendet. [STOP]` }] };
          }
          return { content: [{ type: "text", text: formatYtResults(filtered, return_mode) }] };

        } else if (action === "EXACT") {
          const actualQuery = query || "";
          const { data, error } = await supabase.rpc("exact_search_workspace", {
            p_exact_keyword: actualQuery === "" ? null : actualQuery,
            match_count: limit,
            p_agent_id: AGENT_ID,
            p_artifact_type: "yt_chunk",
            p_days_back: days_back || null,
          });
          if (error) throw error;
          if (!data || data.length === 0) return { content: [{ type: "text", text: "Keine Ergebnisse gefunden." }] };

          let filtered = data;
          if (channel_filter) {
            const filterHandle = channel_filter.startsWith("@") ? channel_filter.toLowerCase() : `@${channel_filter.toLowerCase()}`;
            filtered = data.filter((r: any) => r.metadata?.channel === filterHandle);
          }

          if (dump_to_chat) {
            await dumpYtResults("YouTube EXACT: " + (actualQuery || "Letzte Blöcke"), filtered);
            return { content: [{ type: "text", text: `${filtered.length} Blöcke an Chat gesendet. [STOP]` }] };
          }
          return { content: [{ type: "text", text: formatYtResults(filtered, return_mode) }] };

        } else if (action === "CONTEXT") {
          if (!video_id) return { content: [{ type: "text", text: "video_id ist für CONTEXT erforderlich." }], isError: true };
          const centerIndex = block_index ?? 0;

          const { data, error } = await supabase
            .from("agent_workspace")
            .select("id, content, metadata, created_at")
            .eq("agent_id", AGENT_ID)
            .eq("artifact_type", "yt_chunk")
            .contains("metadata", { video_id: video_id })
            .order("metadata->block_index", { ascending: true });

          if (error) throw error;
          if (!data || data.length === 0) return { content: [{ type: "text", text: `Keine Blöcke für Video ${video_id} gefunden.` }] };

          // Get surrounding blocks (±2)
          const contextBlocks = data.filter((d: any) => {
            const idx = d.metadata?.block_index ?? 0;
            return idx >= centerIndex - 2 && idx <= centerIndex + 2;
          });

          return { content: [{ type: "text", text: formatYtResults(contextBlocks, "full_text") }] };

        } else if (action === "TRANSCRIPT") {
          if (!video_id) return { content: [{ type: "text", text: "video_id ist für TRANSCRIPT erforderlich." }], isError: true };

          const { data, error } = await supabase
            .from("agent_workspace")
            .select("id, content, metadata, created_at")
            .eq("agent_id", AGENT_ID)
            .eq("artifact_type", "yt_chunk")
            .contains("metadata", { video_id: video_id })
            .order("metadata->block_index", { ascending: true });

          if (error) throw error;
          if (!data || data.length === 0) return { content: [{ type: "text", text: `Keine Blöcke für Video ${video_id} gefunden.` }] };

          // Estimate tokens (rough: 1 token ≈ 4 chars)
          const totalChars = data.reduce((sum: number, d: any) => sum + (d.content?.length || 0), 0);
          const estimatedTokens = Math.round(totalChars / 4);
          const videoTitle = data[0]?.metadata?.video_title || video_id;

          let resultText = `=== Transkript: ${videoTitle} (${data.length} Blöcke, ~${estimatedTokens} Tokens) ===\n\n`;

          if (estimatedTokens > 8000) {
            resultText += `⚠️ WARNUNG: Dieses Transkript hat ~${estimatedTokens} Tokens. Lade niemals mehrere Transkripte hintereinander.\n\n`;
          }

          for (const block of data) {
            const meta = block.metadata || {};
            resultText += `--- [${meta.start_time || "?"} - ${meta.end_time || "?"}] ${meta.topic || ""} ---\n`;
            // Strip the [Kontext] prefix for transcript view (it repeats every block)
            const contentWithoutContext = block.content?.replace(/^\[Kontext\].*?\n\n\[Inhalt\] /s, "") || block.content;
            resultText += `${contentWithoutContext}\n\n`;
          }

          return { content: [{ type: "text", text: resultText }] };
        } else if (action === "TICKERS") {
          const filterHandle = channel_filter
            ? (channel_filter.startsWith("@") ? channel_filter.toLowerCase() : `@${channel_filter.toLowerCase()}`)
            : null;

          await sendTelemetry(`🔍 [TICKERS] Rufe Chunks mit Tickern ab (Channel: ${filterHandle || "alle"}, Tage: ${days_back || "alle"}, Limit: ${limit || 500})...`);

          const { data, error } = await supabase.rpc("get_yt_chunks_with_tickers", {
            p_agent_id: AGENT_ID,
            p_channel_filter: filterHandle,
            p_days_back: days_back || null,
            p_limit: limit || 500,
          });

          if (error) throw error;
          const count = data?.length || 0;
          await sendTelemetry(`✅ [TICKERS] ${count} Chunks mit Tickern geladen.`);

          if (!data || data.length === 0) {
            return { content: [{ type: "text", text: "Keine Ergebnisse gefunden." }] };
          }

          if (dump_to_chat) {
            await dumpYtResults("YouTube TICKERS search", data);
            return { content: [{ type: "text", text: `${data.length} Blöcke an Chat gesendet. [STOP]` }] };
          }

          // TICKERS default should be full_text since we need to analyze tickers in context
          const mode = return_mode === "snippets" ? "full_text" : return_mode;
          return { content: [{ type: "text", text: formatYtResults(data, mode) }] };
        }

        throw new Error("Invalid action");
      } catch (err: any) {
        return { content: [{ type: "text", text: `Fehler: ${err.message}` }], isError: true };
      }
    },
  );
}

// --- Formatting Helpers ---

function formatYtResults(data: any[], returnMode: string): string {
  if (!data || data.length === 0) return "Keine Ergebnisse.";

  if (returnMode === "ids_only") {
    return data.map((d: any, i: number) => {
      const meta = d.metadata || {};
      return `[${i + 1}] ID: ${d.id} | Video: ${meta.video_title || "?"} | ${meta.start_time || "?"}-${meta.end_time || "?"}`;
    }).join("\n");
  } else if (returnMode === "full_text") {
    return data.map((d: any, i: number) => {
      const meta = d.metadata || {};
      return `[${i + 1}] ID: ${d.id} | Channel: ${meta.channel || "?"} | Video: ${meta.video_title || "?"} | ${meta.start_time || "?"}-${meta.end_time || "?"} | Topic: ${meta.topic || "?"}\nContent: ${d.content}\nTickers: ${(meta.tickers || []).join(", ") || "None"}`;
    }).join("\n\n");
  } else {
    // snippets (default)
    return data.map((d: any, i: number) => {
      const meta = d.metadata || {};
      let content = d.content || "";
      // Strip context prefix for snippet view
      content = content.replace(/^\[Kontext\].*?\n\n\[Inhalt\] /s, "");
      const tickersStr = meta.tickers?.length ? meta.tickers.join(", ") : "None";
      return `[${i + 1}] Channel: ${meta.channel || "?"} | Video: ${meta.video_title || "?"} | ${meta.start_time || "?"}-${meta.end_time || "?"}\nTopic: ${meta.topic || "?"}\nTickers: ${tickersStr}\nContent: ${content}`;
    }).join("\n\n");
  }
}

async function dumpYtResults(title: string, data: any[]) {
  if (!data || data.length === 0) {
    await fetch("http://nexus-service:7734/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_agent: AGENT_ID, to: "boss", text: `*Keine Ergebnisse für: ${title}*`, msg_type: "chat" }),
    });
    return;
  }

  await fetch("http://nexus-service:7734/api/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from_agent: AGENT_ID, to: "boss", text: `*Ergebnisse für: ${title} (${data.length} Blöcke)*`, msg_type: "chat" }),
  });

  for (const d of data) {
    const meta = d.metadata || {};
    const tickers = meta.tickers?.length ? meta.tickers.join(", ") : "None";
    const contentWithoutContext = (d.content || "").replace(/^\[Kontext\].*?\n\n\[Inhalt\] /s, "");
    const safeContent = contentWithoutContext.replace(/^(#+)/gm, "\\$1");

    const postText = `**[${meta.start_time || "?"}-${meta.end_time || "?"}] ${meta.channel || "?"}** — *${meta.video_title || "?"}*\n📌 ${meta.topic || "?"} *(Tickers: ${tickers})*\n${safeContent}`;

    await fetch("http://nexus-service:7734/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_agent: AGENT_ID, to: "boss", text: postText, msg_type: "chat" }),
    });

    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
