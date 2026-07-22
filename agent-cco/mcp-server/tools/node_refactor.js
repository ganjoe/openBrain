const fs = require('fs');

const show_yt_content_new = `  // Tool 2.5: show_yt_content
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
            .limit(Math.min(limit, 50));

          if (error) throw error;
          if (!videos || videos.length === 0) {
            return { content: [{ type: "text", text: \`Keine Videos in der Datenbank für \${targetHandle} gefunden.\` }] };
          }

          const formatted = videos.map((v: any, idx: number) => {
            const durationMin = Math.floor(v.duration / 60);
            const durationSec = v.duration % 60;
            const durationStr = \`\${durationMin}:\${String(durationSec).padStart(2, "0")}\`;
            const dateStr = v.published_at ? new Date(v.published_at).toLocaleDateString("de-DE") : "Unbekannt";
            let statusText = \`[Status: \${v.status}]\`;
            if (v.status === "embedded") statusText = "✅ embedded";
            else if (v.status === "downloaded") statusText = "📥 downloaded (ready for sync)";
            else if (v.status === "processing") statusText = "⏳ processing";
            else if (v.status === "failed") statusText = \`❌ failed (\${v.error_msg || "Unknown error"})\`;
            else if (v.status === "pending") statusText = "⏱️ pending";

            return \`\${idx + 1}. \${dateStr} - **\${v.title}** (\${durationStr}) - \${statusText} (ID: \${v.video_id})\`;
          }).join("\\n");

          return { content: [{ type: "text", text: \`Übersicht der Videos für \${targetHandle} (DATABASE):\\n\\n\${formatted}\` }] };
        } else if (action === "ONLINE") {
          const channelUrl = targetHandle.startsWith("http") ? targetHandle : \`https://www.youtube.com/\${targetHandle}\`;

          await sendTelemetry(\`[YT] Rufe Live-Video-Liste für \${targetHandle} ab...\`);
          const videos = await getChannelVideos(channelUrl, limit);

          if (!videos || videos.length === 0) {
            return { content: [{ type: "text", text: \`Keine Online-Videos für \${targetHandle} gefunden.\` }] };
          }

          const formatted = videos.map((v: any, idx: number) => {
            const durationMin = Math.floor(v.duration / 60);
            const durationSec = v.duration % 60;
            const durationStr = \`\${durationMin}:\${String(durationSec).padStart(2, "0")}\`;
            const dateStr = v.publishedAt ? new Date(v.publishedAt).toLocaleDateString("de-DE") : "Unbekannt";
            return \`\${idx + 1}. [\${dateStr}] - **\${v.title}** (\${durationStr}) - URL: https://www.youtube.com/watch?v=\${v.videoId}\`;
          }).join("\\n");

          const urlList = JSON.stringify(
            videos.map((v: any) => \`https://www.youtube.com/watch?v=\${v.videoId}\`),
          );
          const anchor = \`\\n\\nURLs: \${urlList}\`;
          const hint =
            \`\\n\\n💡 Um diese \${videos.length} Videos zu importieren, rufe \` +
            \`manage_yt_sync(action="START", video_urls=<URLs-Array oben>) auf.\`;

          return { content: [{ type: "text", text: \`Verfügbare Online-Videos für \${targetHandle} (ONLINE):\\n\\n\${formatted}\${anchor}\${hint}\` }] };
        }

        return { content: [{ type: "text", text: "Invalid action" }], isError: true };
      } catch (err: any) {
        return { content: [{ type: "text", text: \`Fehler: \${err.message}\` }], isError: true };
      }
    }
  );\n`;

const content = fs.readFileSync("/home/daniel/openBrain/agent-cco/mcp-server/tools/youtube.ts", "utf-8");

const startIdx = content.indexOf("  // Tool 2.5: list_yt_videos");
const endIdx = content.indexOf("  // Tool 3: search_yt_content");

if (startIdx !== -1 && endIdx !== -1) {
    const newContent = content.substring(0, startIdx) + show_yt_content_new + content.substring(endIdx);
    fs.writeFileSync("/home/daniel/openBrain/agent-cco/mcp-server/tools/youtube.ts", newContent, "utf-8");
    console.log("Replaced successfully");
} else {
    console.log("Indexes not found", startIdx, endIdx);
}
