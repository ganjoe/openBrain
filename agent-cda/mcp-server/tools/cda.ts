import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import mqtt from "npm:mqtt";

const STOCK_DATA_NODE_URL = "http://host.docker.internal:8002";

export function registerCdaTools(server: McpServer) {

  server.registerTool(
    "get_staleness_report",
    {
      title: "Get Staleness Report",
      description: "Returns a distribution of how old the stock data in the system is.",
      inputSchema: {},
    },
    async () => {
        try {
            const res = await fetch(`${STOCK_DATA_NODE_URL}/staleness/report`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (err: any) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    }
  );

  server.registerTool(
    "get_queue_status",
    {
      title: "Get Queue Status",
      description: "Returns the current download queue size in the stock-data-node.",
      inputSchema: {},
    },
    async () => {
        try {
            const res = await fetch(`${STOCK_DATA_NODE_URL}/status`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (err: any) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    }
  );

  server.registerTool(
    "check_ticker_data",
    {
      title: "Check Ticker Data",
      description: "Checks if a parquet folder exists for a ticker, if it contains data, and the date of the last candle.",
      inputSchema: {
        ticker: z.string().describe("The ticker symbol to check"),
      },
    },
    async ({ ticker }: any) => {
        try {
            const res = await fetch(`${STOCK_DATA_NODE_URL}/data/status/${ticker.toUpperCase()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (err: any) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    }
  );

  server.registerTool(
    "request_ibkr_download",
    {
      title: "Request IBKR Download via MQTT",
      description: "Prüft die Verfügbarkeit bei IBKR und reiht den Ticker bei Erfolg für den Download ein. Löst asynchron ein download_complete Event aus.",
      inputSchema: {
        ticker: z.string().describe("The ticker symbol to request"),
      },
    },
    async ({ ticker }: any) => {
        try {
            const brokerUrl = Deno.env.get("MQTT_BROKER_URL") || "mqtt://nexus-broker:1883";
            const client = await mqtt.connectAsync(brokerUrl);
            const payload = JSON.stringify({ action: "request_download", ticker: ticker.toUpperCase() });
            await client.publishAsync("agents/stock-data/commands", payload, { qos: 1 });
            await client.endAsync();
            
            return { content: [{ type: "text", text: `Der Download-Request für Ticker ${ticker.toUpperCase()} wurde via MQTT gesendet. Du erhältst eine Benachrichtigung im Chat, sobald der Vorgang abgeschlossen oder fehlgeschlagen ist.` }] };
        } catch (err: any) {
            return { content: [{ type: "text", text: `Error sending MQTT command: ${err.message}` }], isError: true };
        }
    }
  );

  server.registerTool(
    "set_data_provider",
    {
      title: "Set Data Provider",
      description: "Sets the data provider for a specific ticker (e.g. 'YFINANCE' or 'IBKR'). Also deletes existing chart data for that ticker to ensure consistency.",
      inputSchema: {
        ticker: z.string().describe("The ticker symbol"),
        provider: z.enum(["IBKR", "YFINANCE"]).describe("The provider to use"),
      },
    },
    async ({ ticker, provider }: any) => {
        try {
            const res = await fetch(`${STOCK_DATA_NODE_URL}/config/provider/${ticker.toUpperCase()}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ provider })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return { content: [{ type: "text", text: `Provider für ${ticker.toUpperCase()} erfolgreich auf ${provider} gesetzt. Alte Chartdaten wurden ${data.data_deleted ? 'gelöscht' : 'nicht gefunden/gelöscht'}.` }] };
        } catch (err: any) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    }
  );

  server.registerTool(
    "check_yfinance_availability",
    {
      title: "Check YFinance Availability",
      description: "Check if a ticker is available in the fallback data provider (Yahoo Finance).",
      inputSchema: {
        ticker: z.string().describe("The ticker symbol to check"),
      },
    },
    async ({ ticker }: any) => {
        try {
            const res = await fetch(`${STOCK_DATA_NODE_URL}/fallback/check/${ticker.toUpperCase()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (err: any) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    }
  );

  server.registerTool(
    "get_connection_status",
    {
      title: "Get Connection Status",
      description: "Returns the IBKR Gateway connection status.",
      inputSchema: {},
    },
    async () => {
        try {
            const res = await fetch(`${STOCK_DATA_NODE_URL}/status/connection`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (err: any) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    }
  );

}
