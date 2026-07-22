with open("/home/daniel/openBrain/agent-cco/mcp-server/tools/youtube.ts", "r", encoding="utf-8") as f:
    content = f.read()

start_idx_1 = content.find("async function segmentTranscript")
if start_idx_1 == -1:
    print("Error: segmentTranscript not found")
    exit(1)

end_idx_1 = content.find("export async function prepareVideoFromUrl")
if end_idx_1 == -1:
    print("Error: prepareVideoFromUrl not found")
    exit(1)

process_video_new = """async function processVideo(
  videoId: string,
  channel: string,
  videoTitle: string,
  publishedAt: string,
  targetLang: string,
  signal?: AbortSignal,
): Promise<void> {
  await supabase.from("yt_sync_logs").insert({
    action_type: "info",
    channel: channel,
    message: `[YT] Starte Download für "${videoTitle}"...`
  });

  const { data: videoData } = await supabase.from("yt_videos").select("transcript").eq("video_id", videoId).single();
  let plaintext = videoData?.transcript;

  if (!plaintext) {
    const vttContent = await downloadVtt(videoId, targetLang);
    if (!vttContent) {
      await supabase.from("yt_videos").update({ status: "failed", error_msg: "Keine Auto-Captions verfügbar" }).eq("video_id", videoId);
      await supabase.from("yt_sync_logs").insert({ action_type: "error", channel, message: `Keine Untertitel für "${videoTitle}"` });
      return;
    }
    plaintext = vttToPlaintext(vttContent);
    await supabase.from("yt_videos").update({ transcript: plaintext, language: targetLang, status: "downloaded", error_msg: null }).eq("video_id", videoId);
    await supabase.from("yt_sync_logs").insert({ action_type: "info", channel, message: `Transkript gespeichert für "${videoTitle}" (${plaintext.length} Zeichen)` });
  }
}

"""

content = content[:start_idx_1] + process_video_new + content[end_idx_1:]

start_idx_2 = content.find("export async function runYtDiscovery")
if start_idx_2 == -1:
    print("Error: runYtDiscovery not found")
    exit(1)

end_idx_2 = content.find("async function resolveChannelHandle")
if end_idx_2 == -1:
    print("Error: resolveChannelHandle not found")
    exit(1)

sync_loop_new = """export async function runYtDiscoveryLoop() {
  ytDiscoveryStats.isRunning = true;
  ytDiscoveryStats.startTime = Date.now();
  
  await supabase.from("yt_sync_logs").insert({ action_type: "started", message: "Background YT Sync Loop gestartet" });

  while (ytDiscoveryAbortController && !ytDiscoveryAbortController.signal.aborted) {
    try {
      const { data: channels } = await supabase.from("yt_channels").select("handle").eq("is_active", true);
      if (channels && channels.length > 0) {
        for (const ch of channels) {
          if (!ytDiscoveryAbortController || ytDiscoveryAbortController.signal.aborted) break;
          
          const channelUrl = `https://www.youtube.com/${ch.handle}`;
          const videosToProcess = await getChannelVideos(channelUrl, 10);
          
          if (videosToProcess.length === 0) continue;
          
          const videoIds = videosToProcess.map(v => v.videoId);
          const { data: existingVideos } = await supabase.from("yt_videos").select("video_id").in("video_id", videoIds);
          const existingIds = new Set((existingVideos || []).map(v => v.video_id));
          
          const newVideos = videosToProcess.filter(v => !existingIds.has(v.videoId));
          if (newVideos.length === 0) continue;
          
          for (const video of newVideos.reverse()) {
            if (!ytDiscoveryAbortController || ytDiscoveryAbortController.signal.aborted) break;
            
            await supabase.from("yt_videos").upsert({
              video_id: video.videoId,
              channel: ch.handle,
              title: video.title,
              duration: video.duration,
              published_at: video.publishedAt,
              status: "pending",
              language: video.targetLang || "en",
            }, { onConflict: "video_id" });
            
            await processVideo(video.videoId, ch.handle, video.title, video.publishedAt, video.targetLang || "en", ytDiscoveryAbortController.signal);
          }
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
      await supabase.from("yt_sync_logs").insert({ action_type: "error", message: `Loop Error: ${err.message}` });
      await new Promise(r => setTimeout(r, 60000));
    }
  }
  
  ytDiscoveryStats.isRunning = false;
  await supabase.from("yt_sync_logs").insert({ action_type: "stopped", message: "Background YT Sync Loop beendet" });
}

"""

content = content[:start_idx_2] + sync_loop_new + content[end_idx_2:]

start_idx_3 = content.find("  // Tool 2: manage_yt_sync")
if start_idx_3 == -1:
    print("Error: manage_yt_sync tool not found")
    exit(1)

end_idx_3 = content.find("  // Tool 2.5: show_yt_content")
if end_idx_3 == -1:
    print("Error: show_yt_content tool not found")
    exit(1)

manage_yt_sync_new = """  // Tool 2: manage_yt_sync
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
          return { content: [{ type: "text", text: "Background YouTube Sync-Loop erfolgreich gestartet." }] };
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
          
          let statusText = `YouTube Sync Status:\\n- Läuft: ${ytDiscoveryStats.isRunning ? "Ja" : "Nein"}\\n\\nLetzte Aktionen (max 50, letzte ${hours_back} Stunden):\\n`;
          if (!logs || logs.length === 0) {
            statusText += "Keine Logs in diesem Zeitraum.";
          } else {
            statusText += logs.map((l: any) => `[${new Date(l.created_at).toLocaleString("de-DE")}] [${l.action_type}] ${l.channel ? `(${l.channel}) ` : ''}${l.message}`).join("\\n");
          }
          return { content: [{ type: "text", text: statusText }] };
        }
        return { content: [{ type: "text", text: "Invalid action" }], isError: true };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Fehler: ${err.message}` }], isError: true };
      }
    },
  );

"""

content = content[:start_idx_3] + manage_yt_sync_new + content[end_idx_3:]

content = content.replace(
    '💡 Um diese ${videos.length} Videos zu importieren, rufe manage_yt_sync(action="START", video_urls=<URLs-Array oben>) auf.',
    '💡 Um diese Videos zu importieren, füge den Channel mit manage_yt_channels(action="ADD") hinzu.'
)

with open("/home/daniel/openBrain/agent-cco/mcp-server/tools/youtube.ts", "w", encoding="utf-8") as f:
    f.write(content)

print("Successfully applied phase 2 refactoring.")
