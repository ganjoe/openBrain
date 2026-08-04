// agent-cco/mcp-server/tools/web.ts
// Web Research MCP Tools for the CCO agent

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase, AGENT_ID, sendTelemetry, getEmbedding, LM_STUDIO_URL } from "./shared.ts";

const WEB_SCRAPER_URL = Deno.env.get("WEB_SCRAPER_URL") || "http://web-scraper:8797";
const POSTGREST_URL = Deno.env.get("POSTGREST_URL") || "http://postgrest:3000";

export function registerWebTools(server: McpServer) {

  // ─── Tool 1: web_scrape ────────────────────────────────────────────
  server.registerTool(
    "web_scrape",
    {
      title: "Web Scrape",
      description: `Scrape a web page to extract headlines, article text, or structured content.
Two modes:
- With selector: Extract matching elements as a list (e.g. headlines from a news site)
- Without selector: Extract the main article content using Readability

Use this when the user asks for news headlines, wants to know what's on a website, or drops a URL in the chat.
Known headline sources: Reuters, Bloomberg, CNBC, Financial Times, MarketWatch, Seeking Alpha.`,
      inputSchema: {
        url: z.string().describe("The URL to scrape"),
        selector: z.string().optional().describe("CSS selector to extract specific elements (e.g. 'h3.headline a'). If omitted, extracts the main article content."),
        max_items: z.number().optional().default(20).describe("Maximum number of items to extract (default: 20)"),
      },
    },
    async ({ url, selector, max_items }: any) => {
      try {
        await sendTelemetry(`[Web] Scraping: ${url}${selector ? ` (selector: ${selector})` : ""}`);

        const res = await fetch(`${WEB_SCRAPER_URL}/scrape`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, selector, max_items: max_items || 20 }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          return { content: [{ type: "text", text: `Fehler beim Scrapen: ${err.error}` }], isError: true };
        }

        const data = await res.json();

        if (data.items && data.items.length > 0) {
          const lines = data.items.map((item: any, i: number) => {
            const link = item.href ? ` → ${item.href}` : "";
            return `${i + 1}. ${item.text}${link}`;
          });
          return {
            content: [{
              type: "text",
              text: `**${data.title}** (${data.items.length} Ergebnisse)\nQuelle: ${url}\nZeitpunkt: ${data.scraped_at}\n\n${lines.join("\n")}`
            }]
          };
        }

        if (data.markdown) {
          return {
            content: [{
              type: "text",
              text: `**${data.title}**\nQuelle: ${url}\nZeitpunkt: ${data.scraped_at}\n\n${data.markdown}`
            }]
          };
        }

        return { content: [{ type: "text", text: `Keine Inhalte auf ${url} gefunden.` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Web-Scrape fehlgeschlagen: ${err.message}` }], isError: true };
      }
    }
  );


  // ─── Tool 2: web_extract_metrics ───────────────────────────────────
  server.registerTool(
    "web_extract_metrics",
    {
      title: "Extract Financial Metrics",
      description: `Extract financial metrics (Market Cap, P/E, EPS, Volume, etc.) for a stock ticker from financial websites.
Automatically tries Yahoo Finance and MarketWatch. You can also provide a custom URL.
Available metrics: market_cap, pe_ratio, eps, dividend_yield, beta, price, change, change_percent, volume, avg_volume, fifty_two_week_high, fifty_two_week_low`,
      inputSchema: {
        ticker: z.string().describe("Stock ticker symbol (e.g. AAPL, MSFT, TSLA)"),
        metrics: z.array(z.string()).optional().describe("Specific metrics to extract. If omitted, extracts all available."),
        url: z.string().optional().describe("Custom financial page URL. If provided, scrapes this URL instead of known sources."),
      },
    },
    async ({ ticker, metrics, url }: any) => {
      try {
        await sendTelemetry(`[Web] Extracting metrics for ${ticker}${url ? ` from ${url}` : ""}`);

        const res = await fetch(`${WEB_SCRAPER_URL}/extract-metrics`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticker, metrics, url }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          return { content: [{ type: "text", text: `Fehler bei Metrik-Extraktion: ${err.error}` }], isError: true };
        }

        const data = await res.json();
        const metricsEntries = Object.entries(data.metrics);

        if (metricsEntries.length === 0) {
          return { content: [{ type: "text", text: `Keine Metriken für ${ticker} gefunden.` }] };
        }

        const lines = metricsEntries.map(([k, v]) => `  ${k}: ${v}`);
        return {
          content: [{
            type: "text",
            text: `**${data.ticker}** (Quelle: ${data.source})\nURL: ${data.url}\nZeitpunkt: ${data.scraped_at}\n\n${lines.join("\n")}`
          }]
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Metrik-Extraktion fehlgeschlagen: ${err.message}` }], isError: true };
      }
    }
  );


  // ─── Tool 3: web_download_report ───────────────────────────────────
  server.registerTool(
    "web_download_report",
    {
      title: "Download Report",
      description: `Download a PDF report (e.g. annual report, 10-K, earnings report) from a URL.
The report is saved locally and text is extracted for analysis.
You can also provide an investor relations page URL to find available PDF links.

For async operations (e.g. finding and downloading reports), use task_context to enable continuation after the download completes.`,
      inputSchema: {
        url: z.string().describe("Direct PDF URL or investor relations page URL"),
        company: z.string().describe("Company name (used for filing and metadata)"),
        report_type: z.enum(["annual_report", "quarterly", "earnings", "10k", "10q", "8k", "other"]).optional().default("other").describe("Type of report"),
        find_pdfs_only: z.boolean().optional().default(false).describe("If true, only lists PDF links on the page without downloading"),
        task_context: z.string().optional().describe("Original user request for async task continuation"),
      },
    },
    async ({ url, company, report_type, find_pdfs_only, task_context }: any) => {
      try {
        // Mode: Find PDFs on a page
        if (find_pdfs_only) {
          await sendTelemetry(`[Web] Searching for PDFs on: ${url}`);
          const res = await fetch(`${WEB_SCRAPER_URL}/find-pdfs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            return { content: [{ type: "text", text: `PDF-Suche fehlgeschlagen: ${err.error}` }], isError: true };
          }

          const data = await res.json();
          if (!data.pdf_links || data.pdf_links.length === 0) {
            return { content: [{ type: "text", text: `Keine PDFs auf ${url} gefunden.` }] };
          }

          const lines = data.pdf_links.map((l: any, i: number) => `${i + 1}. [${l.text}](${l.href})`);
          return {
            content: [{
              type: "text",
              text: `**PDF-Links auf ${url}:**\n\n${lines.join("\n")}\n\nVerwende web_download_report mit der gewünschten PDF-URL zum Herunterladen.`
            }]
          };
        }

        // Mode: Download PDF
        await sendTelemetry(`[Web] Downloading report: ${company} (${report_type}) from ${url}`);

        // Create a task for async continuation if requested
        if (task_context) {
          const taskId = `report_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          try {
            await supabase.from("agent_tasks").insert({
              id: taskId,
              agent_id: AGENT_ID,
              task_type: "web_download",
              status: "running",
              original_request: task_context,
              context: { company, report_type, url },
            });
          } catch (e) {
            console.error("Failed to create task:", e);
          }

          // Fire-and-forget download in background
          (async () => {
            try {
              const res = await fetch(`${WEB_SCRAPER_URL}/download`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url, company, report_type }),
              });

              const data = await res.json();

              // Store in agent_workspace for search
              const embedding = await getEmbedding(`${company} ${report_type} report ${data.text_preview?.slice(0, 200) || ""}`);
              await supabase.from("agent_workspace").insert({
                agent_id: AGENT_ID,
                artifact_type: "web_report",
                content: data.text_preview || "(kein Text extrahiert)",
                metadata: {
                  company,
                  report_type,
                  source_url: url,
                  file_path: data.file_path,
                  file_name: data.file_name,
                  size_bytes: data.size_bytes,
                  pages: data.pages,
                },
                embedding,
              });

              // Update task and notify
              await supabase.from("agent_tasks")
                .update({ status: "completed", result: data, completed_at: new Date().toISOString() })
                .eq("id", taskId);

              await fetch("http://nexus-service:7734/api/send", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  from_agent: "system",
                  to: AGENT_ID,
                  text: `Report-Download abgeschlossen: ${company} (${report_type}), ${data.pages || "?"} Seiten.`,
                  msg_type: "chat",
                  metadata: { task_id: taskId, task_type: "web_download" },
                }),
              });
            } catch (err: any) {
              console.error(`[Download] Failed: ${err.message}`);
              await supabase.from("agent_tasks")
                .update({ status: "failed", result: { error: err.message }, completed_at: new Date().toISOString() })
                .eq("id", taskId);
            }
          })();

          return {
            content: [{
              type: "text",
              text: `Download von ${company} ${report_type} gestartet. Ich informiere dich, sobald der Bericht heruntergeladen und analysiert wurde.`
            }]
          };
        }

        // Synchronous download (no task_context)
        const res = await fetch(`${WEB_SCRAPER_URL}/download`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, company, report_type }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          return { content: [{ type: "text", text: `Download fehlgeschlagen: ${err.error}` }], isError: true };
        }

        const data = await res.json();

        // Store in agent_workspace
        const embedding = await getEmbedding(`${company} ${report_type} report ${data.text_preview?.slice(0, 200) || ""}`);
        await supabase.from("agent_workspace").insert({
          agent_id: AGENT_ID,
          artifact_type: "web_report",
          content: data.text_preview || "(kein Text extrahiert)",
          metadata: {
            company,
            report_type,
            source_url: url,
            file_path: data.file_path,
            file_name: data.file_name,
            size_bytes: data.size_bytes,
            pages: data.pages,
          },
          embedding,
        });

        return {
          content: [{
            type: "text",
            text: `**Report heruntergeladen:**\n- Firma: ${company}\n- Typ: ${report_type}\n- Datei: ${data.file_name}\n- Größe: ${(data.size_bytes / 1024 / 1024).toFixed(2)} MB\n- Seiten: ${data.pages || "?"}\n\n**Text-Vorschau:**\n${data.text_preview?.slice(0, 500) || "(kein Text)"}`
          }]
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Report-Download fehlgeschlagen: ${err.message}` }], isError: true };
      }
    }
  );


  // ─── Tool 4: web_ocr_extract ───────────────────────────────────────
  server.registerTool(
    "web_ocr_extract",
    {
      title: "OCR Extract (Vision)",
      description: `Extract text or data from a web page using a Vision model (OCR).
Takes a screenshot of the URL and sends it to LM Studio's vision model for analysis.
Useful for extracting data from tables, charts, or pages where CSS selectors don't work.

The vision model is selected via the Nexus Dashboard settings.`,
      inputSchema: {
        url: z.string().describe("URL to screenshot and analyze"),
        prompt: z.string().optional().default("Extrahiere alle sichtbaren Zahlen, Kennzahlen und Texte aus diesem Screenshot. Strukturiere das Ergebnis als Tabelle.").describe("Instruction for the vision model"),
        full_page: z.boolean().optional().default(false).describe("If true, captures the full page instead of just the viewport"),
      },
    },
    async ({ url, prompt, full_page }: any) => {
      try {
        await sendTelemetry(`[Web] OCR screenshot: ${url}`);

        // Take screenshot
        const screenshotRes = await fetch(`${WEB_SCRAPER_URL}/screenshot`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, full_page: full_page || false }),
        });

        if (!screenshotRes.ok) {
          const err = await screenshotRes.json().catch(() => ({ error: `HTTP ${screenshotRes.status}` }));
          return { content: [{ type: "text", text: `Screenshot fehlgeschlagen: ${err.error}` }], isError: true };
        }

        const screenshot = await screenshotRes.json();

        // Fetch current vision model config from system_settings
        let visionModel = "default";
        try {
          const { data } = await supabase
            .from("system_settings")
            .select("value")
            .eq("key", "vision_model_config")
            .maybeSingle();

          if (data && data.value?.model) {
            visionModel = data.value.model;
          }
        } catch {
          console.warn("Could not fetch vision model config, using default");
        }

        // Send to LM Studio vision endpoint
        const visionPayload = {
          model: visionModel === "default" ? "local-model" : visionModel,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt || "Beschreibe was du siehst und extrahiere alle Zahlen und Texte." },
                {
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${screenshot.base64}` },
                },
              ],
            },
          ],
          temperature: 0.1,
          max_tokens: 4096,
        };

        const llmRes = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(visionPayload),
        });

        if (!llmRes.ok) {
          const errText = await llmRes.text();
          return {
            content: [{
              type: "text",
              text: `Vision-Modell-Fehler (${llmRes.status}): ${errText}\n\nStelle sicher, dass ein Vision-Modell in LM Studio geladen ist und über das Nexus Dashboard ausgewählt wurde.`
            }],
            isError: true
          };
        }

        const llmData: any = await llmRes.json();
        const extractedText = llmData.choices?.[0]?.message?.content || "(keine Antwort vom Vision-Modell)";

        return {
          content: [{
            type: "text",
            text: `**OCR-Ergebnis für ${url}:**\nVision-Modell: ${visionModel}\n\n${extractedText}`
          }]
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `OCR-Extraktion fehlgeschlagen: ${err.message}` }], isError: true };
      }
    }
  );
}
