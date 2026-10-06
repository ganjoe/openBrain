import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase, log, STOCK_DATA_NODE_URL } from "./shared.ts";

function triggerBackgroundDownload(tickers: string[]) {
  if (!tickers || tickers.length === 0) return;
  fetch(`${STOCK_DATA_NODE_URL}/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tickers }),
  }).catch((err: any) => {
    log.warn(`[pca] Background download queue trigger failed: ${err.message}`);
  });
}

export function registerPcaTools(server: McpServer) {

  // ── manage_watchlist ──────────────────────────────────────────
  server.registerTool(
    "manage_watchlist",
    {
      title: "Manage Watchlists (CRUD)",
      description: "Standard watchlist management in Supabase (`pca_watchlists`).\n\n" +
        "ACTIONS:\n" +
        "- LIST: List all existing watchlist names (if `list_name` is omitted) or show tickers in a specific list.\n" +
        "- LOAD: Load all tickers of a specific watchlist (returns formatted text + JSON ticker array).\n" +
        "- ADD: Add single `ticker` or array of `tickers` to a watchlist.\n" +
        "- REMOVE: Remove a ticker from a watchlist.\n" +
        "- CREATE: Create a new watchlist with an array of `tickers`.\n" +
        "- DELETE: Delete an entire watchlist and all its tickers.\n" +
        "- CLEAR: Remove all tickers from a list while keeping the watchlist name.\n" +
        "- RENAME: Rename a watchlist from `list_name` to `new_list_name`.\n\n" +
        "WHEN TO USE: Use for standard operations: viewing available lists, loading tickers from a watchlist (like 'current_positions'), or adding/removing tickers.\n" +
        "WHEN NOT TO USE: When importing raw text or files with verification of local Parquet data, use `import_watchlist`.",
      inputSchema: {
        action: z.enum(["LIST", "LOAD", "ADD", "REMOVE", "DELETE", "CLEAR", "CREATE", "RENAME", "CLUSTER"]).describe("The action to perform"),
        list_name: z.string().optional().describe("Watchlist name (required for LOAD, ADD, REMOVE, CREATE, DELETE, CLEAR, RENAME)"),
        new_list_name: z.string().optional().describe("New name for watchlist (required for RENAME)"),
        ticker: z.string().optional().describe("Single ticker symbol (for ADD, REMOVE)"),
        tickers: z.array(z.string()).optional().describe("Array of tickers (for CREATE or bulk ADD)"),
        position: z.number().optional().describe("Sort position in list (for ADD)"),
        layout_name: z.string().optional().describe("Optional layout name (for compatibility)"),
      },
    },
    async ({ action, list_name, new_list_name, ticker, tickers, position }: any) => {
      try {
        if (action === "LIST" || action === "LOAD") {
          if (list_name) {
            const { data, error } = await supabase
              .from("pca_watchlists")
              .select("ticker, position")
              .eq("list_name", list_name)
              .order("position");
            if (error) throw error;
            const tickerList = data.map((r: any) => r.ticker);
            const resultTickers = tickerList.join(", ");
            const verb = action === "LOAD" ? "loaded" : "listed";
            return {
              content: [{
                type: "text",
                text: `Watchlist '${list_name}' ${verb} (${tickerList.length} Ticker): ${resultTickers || "leer"}\n\nJSON: ${JSON.stringify({ list_name, count: tickerList.length, tickers: tickerList })}`,
              }],
            };
          } else {
            const { data, error } = await supabase
              .from("pca_watchlists")
              .select("list_name, ticker")
              .order("list_name");
            if (error) throw error;
            const counts: Record<string, number> = {};
            for (const r of data ?? []) {
              if (r.list_name) {
                counts[r.list_name] = (counts[r.list_name] || 0) + 1;
              }
            }
            const names = Object.keys(counts);
            const lines = names.map((name) => `• ${name} (${counts[name]} Einträge)`);
            return {
              content: [{
                type: "text",
                text: `Verfügbare Watchlisten (${names.length}):\n${lines.join("\n") || "keine vorhanden"}\n\nJSON: ${JSON.stringify(counts)}`,
              }],
            };
          }
        } else if (action === "ADD") {
          if (!list_name) throw new Error("list_name ist für ADD erforderlich");
          if (tickers && tickers.length > 0) {
            const cleanTickers = tickers.map((t: string) => t.trim().toUpperCase()).filter(Boolean);
            const rows = cleanTickers.map((t: string, idx: number) => ({
              list_name,
              ticker: t,
              position: (position ?? 0) + idx,
            }));
            const { error } = await supabase.from("pca_watchlists").upsert(rows, { onConflict: "list_name,ticker" });
            if (error) throw error;
            triggerBackgroundDownload(cleanTickers);
            return { content: [{ type: "text", text: `${cleanTickers.length} Ticker zu '${list_name}' hinzugefügt (Download-Queue im Hintergrund aktiviert).` }] };
          } else if (ticker) {
            const clean = ticker.trim().toUpperCase();
            const { error } = await supabase.from("pca_watchlists").insert({
              list_name,
              ticker: clean,
              position: position ?? 999,
            });
            if (error) throw error;
            triggerBackgroundDownload([clean]);
            return { content: [{ type: "text", text: `${clean} zu '${list_name}' hinzugefügt (Download-Queue im Hintergrund aktiviert).` }] };
          }
          throw new Error("ticker oder tickers ist für ADD erforderlich");
        } else if (action === "REMOVE") {
          if (!list_name || !ticker) throw new Error("list_name und ticker sind für REMOVE erforderlich");
          const { error } = await supabase
            .from("pca_watchlists")
            .delete()
            .eq("list_name", list_name)
            .eq("ticker", ticker.toUpperCase());
          if (error) throw error;
          return { content: [{ type: "text", text: `${ticker.toUpperCase()} aus '${list_name}' entfernt.` }] };
        } else if (action === "CREATE") {
          if (!list_name) throw new Error("list_name ist für CREATE erforderlich");
          if (tickers && tickers.length > 0) {
            const cleanTickers = tickers.map((t: string) => t.trim().toUpperCase()).filter(Boolean);
            const rows = cleanTickers.map((t: string, idx: number) => ({
              list_name,
              ticker: t,
              position: idx,
            }));
            const { error } = await supabase.from("pca_watchlists").upsert(rows, { onConflict: "list_name,ticker" });
            if (error) throw error;
            triggerBackgroundDownload(cleanTickers);
            return { content: [{ type: "text", text: `Watchlist '${list_name}' mit ${cleanTickers.length} Tickern erstellt (Download-Queue im Hintergrund aktiviert).` }] };
          }
          return { content: [{ type: "text", text: `Watchlist '${list_name}' registriert.` }] };
        } else if (action === "RENAME") {
          if (!list_name || !new_list_name) throw new Error("list_name und new_list_name sind für RENAME erforderlich");
          const { error } = await supabase
            .from("pca_watchlists")
            .update({ list_name: new_list_name })
            .eq("list_name", list_name);
          if (error) throw error;
          return { content: [{ type: "text", text: `Watchlist '${list_name}' erfolgreich in '${new_list_name}' umbenannt.` }] };
        } else if (action === "DELETE") {
          if (!list_name) throw new Error("list_name ist für DELETE erforderlich");
          const { error } = await supabase.from("pca_watchlists").delete().eq("list_name", list_name);
          if (error) throw error;
          return { content: [{ type: "text", text: `Watchlist '${list_name}' gelöscht.` }] };
        } else if (action === "CLEAR") {
          if (!list_name) throw new Error("list_name ist für CLEAR erforderlich");
          const { error } = await supabase.from("pca_watchlists").delete().eq("list_name", list_name);
          if (error) throw error;
          return { content: [{ type: "text", text: `Watchlist '${list_name}' geleert.` }] };
        } else if (action === "CLUSTER") {
          return { content: [{ type: "text", text: `Cluster-Berechnung für Watchlisten wird über features-service gesteuert.` }] };
        }
        throw new Error("Ungültige Aktion");
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );


  // ── import_watchlist (Feature 7 als MCP-Tool) ───────────────────
  server.registerTool(
    "import_watchlist",
    {
      title: "Import Watchlist (With Parquet Data Verification)",
      description: "Imports a batch watchlist from an array of tickers, raw comma/newline-separated text, or a local text file. Normalizes ticker symbols, saves them into Supabase (`pca_watchlists`), and checks the local storage (`/parquet/<TICKER>/1D.parquet`) to report which tickers have local chart data available vs. missing.\n\n" +
        "WHEN TO USE: Use when bulk-importing new ticker lists from text/files or when you need verification of local historical Parquet data availability.\n" +
        "WHEN NOT TO USE: For simple CRUD operations (viewing lists, loading tickers, adding a single ticker), use `manage_watchlist`.",
      inputSchema: {
        list_name: z.string().describe("Target watchlist name in Supabase"),
        tickers: z.array(z.string()).optional().describe("Array of ticker symbols (e.g. ['AAPL', 'MSFT'])"),
        raw_text: z.string().optional().describe("Raw text containing comma-, space- or newline-separated tickers"),
        file_path: z.string().optional().describe("Optional path to a text file containing tickers (e.g. /watchlists/list.txt)"),
        replace_existing: z.boolean().optional().default(true).describe("Whether to clear existing tickers in this watchlist first (Default: true)"),
      },
    },
    async ({ list_name, tickers, raw_text, file_path, replace_existing }: any) => {
      try {
        let extractedTickers: string[] = [];

        if (file_path) {
          try {
            const content = await Deno.readTextFile(file_path);
            const tokens = content.split(/[,\s\r\n]+/);
            extractedTickers.push(...tokens.map((t: string) => t.trim().toUpperCase()).filter(Boolean));
          } catch (readErr: any) {
            throw new Error(`Konnte Datei ${file_path} nicht lesen: ${readErr.message}`);
          }
        }

        if (raw_text) {
          const tokens = raw_text.split(/[,\s\r\n]+/);
          extractedTickers.push(...tokens.map((t: string) => t.trim().toUpperCase()).filter(Boolean));
        }

        if (tickers && Array.isArray(tickers)) {
          extractedTickers.push(...tickers.map((t: string) => String(t).trim().toUpperCase()).filter(Boolean));
        }

        // Duplikate entfernen unter Beibehaltung der Reihenfolge
        const uniqueTickers = [...new Set(extractedTickers)];

        if (uniqueTickers.length === 0) {
          return { content: [{ type: "text", text: "Keine gültigen Ticker zum Importieren gefunden." }], isError: true };
        }

        // Supabase Operation
        if (replace_existing !== false) {
          await supabase.from("pca_watchlists").delete().eq("list_name", list_name);
        }

        const rows = uniqueTickers.map((ticker, idx) => ({
          list_name,
          ticker,
          position: idx,
        }));

        const { error: insertErr } = await supabase.from("pca_watchlists").upsert(rows, { onConflict: "list_name,ticker" });
        if (insertErr) throw insertErr;

        // Parquet-Datenprüfung
        const parquetBasePath = Deno.env.get("PARQUET_BASE_PATH") || "/parquet";
        const withData: string[] = [];
        const missingData: string[] = [];

        for (const t of uniqueTickers) {
          try {
            const pPath = `${parquetBasePath}/${t}/1D.parquet`;
            const stat = await Deno.stat(pPath);
            if (stat.isFile) {
              withData.push(t);
            } else {
              missingData.push(t);
            }
          } catch {
            missingData.push(t);
          }
        }

        // Automatisch fehlende Ticker in die Download-Queue von stock-data-node einreihen
        let autoEnqueued = 0;
        if (missingData.length > 0) {
          try {
            await fetch(`${STOCK_DATA_NODE_URL}/add`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ tickers: missingData }),
            });
            autoEnqueued = missingData.length;
            log.info(`[import_watchlist] Automatically enqueued ${autoEnqueued} missing tickers for download.`);
          } catch (e: any) {
            log.warn(`[import_watchlist] Failed to enqueue missing tickers: ${e.message}`);
          }
        }

        const report = {
          status: "success",
          list_name,
          total_imported: uniqueTickers.length,
          with_parquet_data: withData.length,
          missing_parquet_data: missingData.length,
          auto_download_queued: autoEnqueued,
          missing_tickers: missingData,
        };

        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
      } catch (err: any) {
        log.error(`import_watchlist error: ${err.message}`);
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

}
