// core/web-scraper/lib/screenshot.ts
// Screenshot capture for Vision-OCR

import { chromium } from "playwright";
import { dismissCookieBanner } from "./cookies";

export interface ScreenshotResult {
  base64: string;
  width: number;
  height: number;
  url: string;
  cookie_banner_dismissed: boolean;
}

/**
 * Take a screenshot of a web page and return as base64 PNG.
 * Automatically dismisses GDPR/cookie consent banners before capturing.
 */
export async function takeScreenshot(url: string, fullPage: boolean = false): Promise<ScreenshotResult> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000); // Wait for JS rendering

    // Dismiss cookie/GDPR banners
    const bannerDismissed = await dismissCookieBanner(page);
    if (bannerDismissed) {
      // Extra wait for content behind the banner to render
      await page.waitForTimeout(1000);
    }

    const screenshot = await page.screenshot({
      type: "png",
      fullPage,
    });

    const viewport = page.viewportSize()!;
    await page.close();

    return {
      base64: screenshot.toString("base64"),
      width: viewport.width,
      height: fullPage ? 0 : viewport.height,
      url,
      cookie_banner_dismissed: bannerDismissed,
    };
  } finally {
    await browser.close();
  }
}
