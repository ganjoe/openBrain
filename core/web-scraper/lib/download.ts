// core/web-scraper/lib/download.ts
// PDF download and text extraction

import * as fs from "fs";
import * as path from "path";

const REPORTS_DIR = process.env.REPORTS_DIR || "/data/reports";

export interface DownloadResult {
  file_path: string;
  file_name: string;
  size_bytes: number;
  text_preview: string;
  pages?: number;
}

/**
 * Download a PDF from a URL and extract text.
 */
export async function downloadReport(
  url: string,
  company: string,
  reportType: string = "other"
): Promise<DownloadResult> {
  // Sanitize company name for filesystem
  const safeCompany = company.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  const dateStr = new Date().toISOString().slice(0, 10);
  const fileName = `${dateStr}_${reportType}_${safeCompany}.pdf`;
  const dirPath = path.join(REPORTS_DIR, safeCompany);
  const filePath = path.join(dirPath, fileName);

  // Create directory
  fs.mkdirSync(dirPath, { recursive: true });

  // Download the PDF
  console.log(`[Download] Fetching PDF: ${url}`);
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} from ${url}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("pdf") && !url.endsWith(".pdf")) {
    console.warn(`[Download] Warning: Content-Type is '${contentType}', expected PDF`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, buffer);
  console.log(`[Download] Saved: ${filePath} (${buffer.length} bytes)`);

  // Extract text from PDF
  let textPreview = "";
  let pages = 0;
  try {
    const pdfParse = require("pdf-parse");
    const pdfData = await pdfParse(buffer);
    textPreview = pdfData.text?.slice(0, 2000) || "";
    pages = pdfData.numpages || 0;
  } catch (err: any) {
    console.warn(`[Download] PDF text extraction failed: ${err.message}`);
    textPreview = "(PDF-Text konnte nicht extrahiert werden)";
  }

  return {
    file_path: filePath,
    file_name: fileName,
    size_bytes: buffer.length,
    text_preview: textPreview,
    pages,
  };
}

/**
 * Find PDF links on a web page (e.g. investor relations page).
 */
export async function findPdfLinks(url: string): Promise<{ text: string; href: string }[]> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    const links = await page.$$eval("a[href]", (els) => {
      return els
        .filter((el) => {
          const href = (el as HTMLAnchorElement).href || "";
          return href.endsWith(".pdf") || href.includes("/pdf/") || href.includes("filing");
        })
        .map((el) => ({
          text: (el as HTMLElement).innerText?.trim() || "",
          href: (el as HTMLAnchorElement).href,
        }))
        .filter((l) => l.text.length > 0);
    });

    await page.close();
    return links.slice(0, 20);
  } finally {
    await browser.close();
  }
}
