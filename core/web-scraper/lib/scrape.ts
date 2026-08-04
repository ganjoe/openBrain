// core/web-scraper/lib/scrape.ts
// Playwright-based web scraping with Readability fallback

import { chromium, type Browser, type Page } from "playwright";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { dismissCookieBanner } from "./cookies";

let browser: Browser | null = null;

// Adaptive backoff state per domain
const domainBackoff = new Map<string, { retryAfter: number; lastError: number }>();

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
  }
  return browser;
}

function getDomain(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

async function checkBackoff(url: string): Promise<void> {
  const domain = getDomain(url);
  const state = domainBackoff.get(domain);
  if (state && Date.now() < state.lastError + state.retryAfter) {
    const waitMs = state.lastError + state.retryAfter - Date.now();
    console.log(`[Backoff] Waiting ${Math.ceil(waitMs / 1000)}s for ${domain}`);
    await new Promise(r => setTimeout(r, waitMs));
  }
}

function handleRateLimit(url: string, status: number) {
  if (status === 429 || status === 503) {
    const domain = getDomain(url);
    const current = domainBackoff.get(domain);
    const backoffMs = current ? Math.min(current.retryAfter * 2, 60000) : 5000;
    domainBackoff.set(domain, { retryAfter: backoffMs, lastError: Date.now() });
    console.warn(`[Backoff] ${domain}: ${status} → backing off ${backoffMs / 1000}s`);
    throw new Error(`Rate limited by ${domain} (HTTP ${status}). Retry in ${backoffMs / 1000}s.`);
  }
}

export interface ScrapeResult {
  title: string;
  items: { text: string; href?: string }[];
  markdown?: string;
  url: string;
  scraped_at: string;
}

/**
 * Scrape a web page. Two modes:
 * - With `selector`: extract matching elements as a list
 * - Without `selector`: use Readability to extract main article content
 */
export async function scrape(url: string, selector?: string, maxItems: number = 20): Promise<ScrapeResult> {
  await checkBackoff(url);

  const b = await getBrowser();
  const page = await b.newPage({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const status = response?.status() || 0;
    handleRateLimit(url, status);

    // Wait a moment for JS rendering
    await page.waitForTimeout(2000);

    // Dismiss cookie/GDPR banners before extracting content
    await dismissCookieBanner(page);

    const title = await page.title();

    if (selector) {
      // Mode A: Selector extraction
      const elements = await page.$$eval(selector, (els, max) => {
        return els.slice(0, max).map(el => ({
          text: (el as HTMLElement).innerText?.trim() || el.textContent?.trim() || "",
          href: (el as HTMLAnchorElement).href || (el.closest("a") as HTMLAnchorElement)?.href || undefined,
        }));
      }, maxItems);

      return {
        title,
        items: elements.filter(e => e.text.length > 0),
        url,
        scraped_at: new Date().toISOString(),
      };
    } else {
      // Mode B: Readability extraction
      const html = await page.content();
      const dom = new JSDOM(html, { url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (!article) {
        // Fallback: just get the body text
        const bodyText = await page.evaluate(() => document.body.innerText);
        return {
          title,
          items: [],
          markdown: bodyText.slice(0, 10000),
          url,
          scraped_at: new Date().toISOString(),
        };
      }

      return {
        title: article.title || title,
        items: [],
        markdown: article.textContent?.slice(0, 10000) || "",
        url,
        scraped_at: new Date().toISOString(),
      };
    }
  } finally {
    await page.close();
  }
}

export async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}
