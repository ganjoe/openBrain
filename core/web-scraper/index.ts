// core/web-scraper/index.ts
// HTTP API for the web scraper service

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { scrape, closeBrowser } from "./lib/scrape";
import { extractMetrics } from "./lib/metrics";
import { downloadReport, findPdfLinks } from "./lib/download";
import { takeScreenshot } from "./lib/screenshot";

const app = new Hono();
const PORT = parseInt(process.env.PORT || "8797");

// Health check
app.get("/health", (c) => c.json({ status: "ok", service: "web-scraper" }));

// --- Scrape endpoint ---
app.post("/scrape", async (c) => {
  try {
    const body = await c.req.json();
    const { url, selector, max_items } = body;
    if (!url) return c.json({ error: "url is required" }, 400);

    const result = await scrape(url, selector, max_items || 20);
    return c.json(result);
  } catch (err: any) {
    console.error("[/scrape] Error:", err.message);
    return c.json({ error: err.message }, 500);
  }
});

// --- Extract metrics endpoint ---
app.post("/extract-metrics", async (c) => {
  try {
    const body = await c.req.json();
    const { ticker, metrics, url } = body;
    if (!ticker) return c.json({ error: "ticker is required" }, 400);

    const result = await extractMetrics(ticker, metrics, url);
    return c.json(result);
  } catch (err: any) {
    console.error("[/extract-metrics] Error:", err.message);
    return c.json({ error: err.message }, 500);
  }
});

// --- Download report endpoint ---
app.post("/download", async (c) => {
  try {
    const body = await c.req.json();
    const { url, company, report_type } = body;
    if (!url || !company) return c.json({ error: "url and company are required" }, 400);

    const result = await downloadReport(url, company, report_type || "other");
    return c.json(result);
  } catch (err: any) {
    console.error("[/download] Error:", err.message);
    return c.json({ error: err.message }, 500);
  }
});

// --- Find PDF links endpoint ---
app.post("/find-pdfs", async (c) => {
  try {
    const body = await c.req.json();
    const { url } = body;
    if (!url) return c.json({ error: "url is required" }, 400);

    const links = await findPdfLinks(url);
    return c.json({ url, pdf_links: links });
  } catch (err: any) {
    console.error("[/find-pdfs] Error:", err.message);
    return c.json({ error: err.message }, 500);
  }
});

// --- Screenshot endpoint ---
app.post("/screenshot", async (c) => {
  try {
    const body = await c.req.json();
    const { url, full_page } = body;
    if (!url) return c.json({ error: "url is required" }, 400);

    const result = await takeScreenshot(url, full_page || false);
    return c.json(result);
  } catch (err: any) {
    console.error("[/screenshot] Error:", err.message);
    return c.json({ error: err.message }, 500);
  }
});

// Cleanup on shutdown
process.on("SIGTERM", async () => {
  console.log("Shutting down web-scraper...");
  await closeBrowser();
  process.exit(0);
});

console.log(`🌐 Web Scraper Service starting on port ${PORT}...`);
serve({ fetch: app.fetch, port: PORT });
console.log(`✅ Web Scraper Service running on http://0.0.0.0:${PORT}`);
