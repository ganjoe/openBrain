// core/web-scraper/lib/cookies.ts
// Automatic GDPR/Cookie consent banner dismissal for EU browsing

import { type Page } from "playwright";

/**
 * Common cookie consent button selectors — ordered by specificity.
 * Covers the most widespread EU consent frameworks:
 *   - CookieBot, OneTrust, TrustArc, Quantcast, Didomi
 *   - Generic "Accept" / "Agree" / "Akzeptieren" buttons
 *   - Yahoo-specific, Google consent, etc.
 */
const CONSENT_BUTTON_SELECTORS = [
  // ── Consent Management Platforms ──
  '[id*="cookiebanner"] button[id*="accept"]',
  '#onetrust-accept-btn-handler',
  '.onetrust-close-btn-handler',
  '#truste-consent-button',
  '[class*="qc-cmp2-summary-buttons"] button:first-child',
  '#didomi-notice-agree-button',
  '.fc-cta-consent',                    // Funding Choices (Google)
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',

  // ── Yahoo / Oath specific ──
  '[name="agree"]',                     // Yahoo GDPR form
  'button[name="agree"]',
  '.consent-overlay .accept-all',
  'form[action*="consent"] button',

  // ── Google consent ──
  'button[aria-label="Accept all"]',
  'button[aria-label="Alle akzeptieren"]',

  // ── Generic text-based (German) ──
  'button:has-text("Alle akzeptieren")',
  'button:has-text("Akzeptieren")',
  'button:has-text("Alle Cookies akzeptieren")',
  'button:has-text("Zustimmen")',
  'button:has-text("Einverstanden")',

  // ── Generic text-based (English) ──
  'button:has-text("Accept All")',
  'button:has-text("Accept all cookies")',
  'button:has-text("Accept Cookies")',
  'button:has-text("I Accept")',
  'button:has-text("I Agree")',
  'button:has-text("Agree")',
  'button:has-text("Allow All")',
  'button:has-text("Allow all")',
  'button:has-text("Got it")',
  'button:has-text("OK")',

  // ── Broad attribute selectors ──
  '[class*="cookie"] button[class*="accept"]',
  '[class*="cookie"] button[class*="agree"]',
  '[class*="consent"] button[class*="accept"]',
  '[class*="consent"] button[class*="agree"]',
  '[id*="cookie"] button[id*="accept"]',
  '[data-testid*="accept"]',
  '[data-testid*="consent"]',
];

/**
 * Selectors for common cookie banner overlay containers.
 * If click-dismissal fails, we remove them from the DOM.
 */
const CONSENT_OVERLAY_SELECTORS = [
  '#onetrust-consent-sdk',
  '#CybotCookiebotDialog',
  '#truste-consent-track',
  '.qc-cmp2-container',
  '#didomi-host',
  '.fc-consent-root',
  '[class*="cookie-banner"]',
  '[class*="cookiebanner"]',
  '[class*="cookie-consent"]',
  '[class*="consent-banner"]',
  '[class*="consent-overlay"]',
  '[id*="cookie-banner"]',
  '[id*="consent-banner"]',
  '[class*="gdpr"]',
  '[id*="gdpr"]',
];

/**
 * Attempt to dismiss cookie consent banners on a page.
 * Strategy:
 *   1. Try clicking known "Accept All" buttons
 *   2. If that fails, remove overlay elements from DOM
 *   3. Brief wait for animations to complete
 *
 * @returns true if a banner was found and dismissed
 */
export async function dismissCookieBanner(page: Page): Promise<boolean> {
  let dismissed = false;

  // Strategy 1: Click an accept button
  for (const selector of CONSENT_BUTTON_SELECTORS) {
    try {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 300 })) {
        await btn.click({ timeout: 2000 });
        console.log(`[Cookies] Clicked consent button: ${selector}`);
        dismissed = true;
        // Brief wait for banner animation to fade
        await page.waitForTimeout(1000);
        break;
      }
    } catch {
      // Selector didn't match or wasn't clickable — try next
    }
  }

  // Strategy 2: If no button was clicked, try removing overlays from DOM
  if (!dismissed) {
    try {
      const removed = await page.evaluate((selectors) => {
        let count = 0;
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach(el => {
            el.remove();
            count++;
          });
        }
        // Also remove any position:fixed overlays with high z-index
        // that are likely consent banners
        document.querySelectorAll('[style*="position: fixed"]').forEach(el => {
          const style = window.getComputedStyle(el);
          const zIndex = parseInt(style.zIndex) || 0;
          const height = el.getBoundingClientRect().height;
          // Fixed elements with z-index > 1000 and covering > 30% of viewport
          if (zIndex > 1000 && height > window.innerHeight * 0.3) {
            el.remove();
            count++;
          }
        });
        return count;
      }, CONSENT_OVERLAY_SELECTORS);

      if (removed > 0) {
        console.log(`[Cookies] Removed ${removed} overlay element(s) from DOM`);
        dismissed = true;
        await page.waitForTimeout(500);
      }
    } catch (err) {
      console.warn("[Cookies] DOM removal failed:", err);
    }
  }

  return dismissed;
}
