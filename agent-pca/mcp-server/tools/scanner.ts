import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pcaCommand, sendTelemetry } from "./shared.ts";

export function registerScannerTools(server: McpServer) {
  server.registerTool(
    "run_scanner",
    {
      title: "Run Breakout Scanner",
      description: "Run a stock scanner (e.g. madbo breakout) over all tickers, update database watchlists, and sync with PCA Master.",
      inputSchema: {
        scanner_type: z.enum(["madbo_breakout"]).default("madbo_breakout").describe("The scanner type to execute"),
        lookback_days: z.number().default(150).describe("Lookback days for breakout calculation"),
        max_wick_pct: z.number().default(0.05).describe("Max wick size ratio (e.g. 0.05 for 5% of daily range)"),
        daily_range_ratio: z.number().default(2.0).describe("Minimum ratio of daily range vs ADR20"),
        history_lookback_days: z.number().optional().default(1).describe("Scan window lookback in trading days (default 1 = latest bar)"),
        start_date: z.string().optional().describe("Optional start date for date range scan (YYYY-MM-DD)"),
        end_date: z.string().optional().describe("Optional end date for date range scan (YYYY-MM-DD)"),
        watchlist_name: z.string().optional().describe("Custom watchlist name. Defaults to 'scanner_madbo_<lookback>_breakout'"),
        stream_telemetry: z.boolean().optional().default(true).describe("If true, streams scanner progress to system telemetry"),
        verbose_telemetry: z.boolean().optional().default(false).describe("If true, streams all ticker matching details to telemetry"),
      },
    },
    async ({
      scanner_type,
      lookback_days,
      max_wick_pct,
      daily_range_ratio,
      history_lookback_days,
      start_date,
      end_date,
      watchlist_name,
      stream_telemetry,
      verbose_telemetry,
    }: any) => {
      try {
        const FEATURES_SCANNER_URL = "http://features-service:8003/scanners/run";

        const requestBody = {
          scanner_type,
          lookback_days,
          max_wick_pct,
          daily_range_ratio,
          history_lookback_days,
          start_date,
          end_date,
          watchlist_name,
          stream_telemetry,
          list_all_tickers: verbose_telemetry,
        };

        const res = await fetch(FEATURES_SCANNER_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        });

        if (!res.ok) {
          const err = await res.text();
          throw new Error(`Features Scanner API error ${res.status}: ${err}`);
        }

        const data = await res.json();
        if (data.status !== "success") {
          throw new Error(data.message || "Scanner execution failed");
        }

        const actualWatchlistName = data.watchlist_name;
        const matches: string[] = data.matches || [];
        const matchCount = data.match_count;
        const matchDetails: Record<string, number[]> = data.match_details || {};

        // Synchronize with PCA Master by switching layout's active watchlist
        let loadMsg = "";
        try {
          await pcaCommand("load_watchlist", {
            list_name: actualWatchlistName,
            layout_name: "desktop",
          });
          loadMsg = `Watchlist '${actualWatchlistName}' loaded and synchronized in PCA Master dashboard.`;
        } catch (e: any) {
          loadMsg = `Warning: Watchlist saved, but failed to load in PCA Master: ${e.message}`;
        }

        // Format ticker list with event dates, cutoff at 20 tickers
        const cutoff = 20;
        const MONTHS_DE = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
        
        const formatTs = (ts: number): string => {
          const d = new Date(ts * 1000);
          return `${d.getDate()}. ${MONTHS_DE[d.getMonth()]} ${d.getFullYear()}`;
        };

        let tickerListStr = "";
        if (matches.length > 0) {
          const displayed = matches.slice(0, cutoff);
          const lines = displayed.map(ticker => {
            const timestamps = matchDetails[ticker] || [];
            const datesStr = timestamps.map(formatTs).join(", ");
            return `   ${ticker} — 📅 ${datesStr}`;
          });
          tickerListStr = `Ergebnisse (erste ${Math.min(matches.length, cutoff)}):\n${lines.join("\n")}`;
          if (matches.length > cutoff) {
            tickerListStr += `\n   ... und ${matches.length - cutoff} weitere Ticker.`;
          }
        } else {
          tickerListStr = "No matching tickers found.";
        }

        const summary = [
          `🔍 **Scan Results:** ${matchCount} match(es) found out of ${data.tickers_scanned} scanned.`,
          `⏱️ **Duration:** ${data.duration_seconds.toFixed(2)}s (${data.tickers_per_second.toFixed(1)} tickers/sec).`,
          `📂 **Watchlist:** Saved to database as \`${actualWatchlistName}\`.`,
          `📺 **PCA Status:** ${loadMsg}`,
          `📋 ${tickerListStr}`
        ].join("\n");

        return { content: [{ type: "text", text: summary }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error running scanner: ${err.message}` }], isError: true };
      }
    }
  );
}
