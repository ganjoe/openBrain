// core/web-scraper/lib/metrics.ts
// Financial metrics extraction from known sites

import { scrape } from "./scrape";
import * as fs from "fs";
import * as yaml from "js-yaml";
import * as path from "path";

interface MetricSource {
  url_template: string;
  selectors: Record<string, string>;
}

let sourcesCache: any = null;

function loadSources() {
  if (!sourcesCache) {
    const raw = fs.readFileSync(path.join(__dirname, "..", "sources.yaml"), "utf-8");
    sourcesCache = yaml.load(raw);
  }
  return sourcesCache;
}

export interface MetricsResult {
  ticker: string;
  source: string;
  url: string;
  metrics: Record<string, string>;
  scraped_at: string;
}

/**
 * Extract financial metrics for a ticker from known sources.
 * Tries Yahoo Finance first, then MarketWatch as fallback.
 */
export async function extractMetrics(
  ticker: string,
  requestedMetrics?: string[],
  customUrl?: string
): Promise<MetricsResult> {
  const sources = loadSources();
  const metricSources: Record<string, MetricSource> = sources.metrics || {};

  // If a custom URL is provided, try to identify the source
  if (customUrl) {
    return await scrapeMetricsFromUrl(customUrl, ticker, requestedMetrics);
  }

  // Try sources in order: yahoo_finance, marketwatch
  const sourceOrder = ["yahoo_finance", "marketwatch"];
  let lastError: Error | null = null;

  for (const sourceName of sourceOrder) {
    const source = metricSources[sourceName];
    if (!source) continue;

    const url = source.url_template.replace("{ticker}", ticker.toUpperCase());
    try {
      const result = await scrapeMetricsFromKnownSource(url, source.selectors, ticker, sourceName, requestedMetrics);
      if (Object.keys(result.metrics).length > 0) return result;
    } catch (err: any) {
      lastError = err;
      console.warn(`[Metrics] ${sourceName} failed for ${ticker}: ${err.message}`);
    }
  }

  throw lastError || new Error(`No metrics found for ${ticker}`);
}

async function scrapeMetricsFromKnownSource(
  url: string,
  selectors: Record<string, string>,
  ticker: string,
  sourceName: string,
  requestedMetrics?: string[]
): Promise<MetricsResult> {
  // Use the scrape function to get the page, then extract specific selectors
  const { chromium } = await import("playwright");
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000); // Wait for dynamic content

    const metrics: Record<string, string> = {};
    const targetSelectors = requestedMetrics
      ? Object.fromEntries(Object.entries(selectors).filter(([k]) => requestedMetrics.includes(k)))
      : selectors;

    for (const [name, sel] of Object.entries(targetSelectors)) {
      try {
        const value = await page.$eval(sel, (el: any) => el.innerText?.trim() || el.textContent?.trim() || "");
        if (value) metrics[name] = value;
      } catch {
        // Selector not found, skip
      }
    }

    await page.close();
    return { ticker: ticker.toUpperCase(), source: sourceName, url, metrics, scraped_at: new Date().toISOString() };
  } finally {
    if (browser) await browser.close();
  }
}

async function scrapeMetricsFromUrl(
  url: string,
  ticker: string,
  requestedMetrics?: string[]
): Promise<MetricsResult> {
  // For custom URLs, do a generic page scrape and try to find financial data
  const result = await scrape(url);
  const metricsText = result.markdown || result.items.map(i => i.text).join("\n");

  return {
    ticker: ticker.toUpperCase(),
    source: "custom",
    url,
    metrics: { raw_content: metricsText.slice(0, 5000) },
    scraped_at: new Date().toISOString(),
  };
}
