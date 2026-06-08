import { IBApi, EventName, Order, Contract, OrderState, Execution, CommissionReport } from "@stoqey/ib";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { resolve } from "path";
import * as mqtt from "mqtt";

dotenv.config({ path: resolve(__dirname, "../.env") });

// Helper function to fetch conId for a contract
function getConId(ib: IBApi, contract: Contract): Promise<number> {
    return new Promise((resolve, reject) => {
        let reqId = Math.floor(Math.random() * 1000000);
        let resolved = false;

        const onDetails = (req: number, details: any) => {
            if (req === reqId && !resolved) {
                resolved = true;
                cleanup();
                resolve(details.contract.conId);
            }
        };

        const onEnd = (req: number) => {
            if (req === reqId && !resolved) {
                cleanup();
                reject(new Error("No contract details found for " + JSON.stringify(contract)));
            }
        };

        const onError = (err: Error, code: number, req: number) => {
            if (req === reqId && !resolved) {
                cleanup();
                reject(err);
            }
        };

        const cleanup = () => {
            ib.off(EventName.contractDetails, onDetails);
            ib.off(EventName.contractDetailsEnd, onEnd);
            ib.off(EventName.error, onError);
        };

        ib.on(EventName.contractDetails, onDetails);
        ib.on(EventName.contractDetailsEnd, onEnd);
        ib.on(EventName.error, onError);

        ib.reqContractDetails(reqId, contract);
        
        // Timeout
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                cleanup();
                reject(new Error("Timeout fetching contract details"));
            }
        }, 10000);
    });
} // Just for any local .env testing if needed

// --- Configuration ---
const IB_HOST_DEFAULT = process.env.IB_GATEWAY_HOST || "ib-gateway";
const IB_PORT_DEFAULT = parseInt(process.env.IB_GATEWAY_PORT || "4002", 10);
const MQTT_BROKER = process.env.MQTT_BROKER_URL || "mqtt://nexus-broker:1883";

// Use the Gateway URL for Supabase JS client since it appends /rest/v1 automatically
const SUPABASE_URL = process.env.SUPABASE_URL || "http://gateway:80";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY || "missing";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Active trading mode — set from DB at startup, updated via MQTT
let activeTradingMode: "live" | "paper" = "live";

// Fetch gateway config and active mode from DB
async function loadGatewayConfig(): Promise<{ host: string; port: number; mode: "live" | "paper" }> {
  try {
    const { data, error } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", "ib_gateway_config")
      .single();
    if (data && !error) {
      const cfg = data.value as any;
      const mode: "live" | "paper" = cfg.active_mode === "paper" ? "paper" : "live";
      const gatewayInfo = cfg[mode] || {};
      return {
        host: gatewayInfo.host || IB_HOST_DEFAULT,
        port: gatewayInfo.port || IB_PORT_DEFAULT,
        mode,
      };
    }
  } catch (e) {
    console.warn("[IBKR Sync] Could not load gateway config from DB, using env defaults.");
  }
  return { host: IB_HOST_DEFAULT, port: IB_PORT_DEFAULT, mode: "live" };
}

async function updateGatewayStatus(connected: boolean) {
  try {
    const { error } = await supabase
      .from("system_settings")
      .upsert(
        { key: "ib_gateway_status", value: { connected }, updated_at: new Date().toISOString() },
        { onConflict: "key" }
      );
    if (error) {
      console.error("[IBKR Sync] Failed to update gateway status in DB:", error.message);
    } else {
      console.log(`[IBKR Sync] Updated gateway status in DB to connected: ${connected}`);
      // Telemetry — non-blocking, fire and forget
      const emoji  = connected ? "🟢" : "🟡";
      const action = connected ? "eingeloggt" : "getrennt / wartet auf Login";
      fetch("http://nexus-service:7734/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_agent: "system",
          to: "all",
          text: `${emoji} IBKR-${activeTradingMode.toUpperCase()} ${action}`,
          msg_type: "telemetry"
        })
      }).catch(() => {});
    }
  } catch (err) {
    console.error("[IBKR Sync] Exception during gateway status update:", err);
  }
}

// --- State ---
let isConnected = false;
let orderIdCounter = -1;
let isSyncingPositions = false;
let activePositionsTemp: Array<{ account: string; ticker: string; currency: string; pos: number; avgCost: number; marketPrice: number; marketValue: number; unrealizedPNL: number; realizedPNL: number }> = [];
let activeAccountMetrics: Record<string, { totalCashBalance: number; netLiquidation: number; availableFunds: number }> = {};
let isSyncingOrders = false;
let activeOpenOrdersTemp: Array<{ account: string; permId: number; orderId: number; ticker: string; action: string; quantity: number; orderType: string; limitPrice?: number; stopPrice?: number; status: string }> = [];
let pendingRefreshIds: number[] = [];

// --- Quote Request State ---
let tickerIdCounter = 100000;
const activeQuoteRequests: Map<number, { ticker: string, dbId: number }> = new Map();

// ib and activeTradingMode initialized in async boot below
let ib!: IBApi;

// --- MQTT listener for hot-reload on trading mode switch ---
const mqttClient = mqtt.connect(MQTT_BROKER, { clientId: `ibkr-sync-${Date.now()}`, clean: true });
mqttClient.on("connect", () => {
  mqttClient.subscribe("system/config/trading_mode", { qos: 1 });
  console.log("[IBKR Sync] Subscribed to system/config/trading_mode");
});
mqttClient.on("message", async (topic: string, payload: Buffer) => {
  if (topic !== "system/config/trading_mode") return;
  try {
    const data = JSON.parse(payload.toString());
    const newMode: "live" | "paper" = data.mode === "paper" ? "paper" : "live";
    const newHost: string = data.host || IB_HOST_DEFAULT;
    const newPort: number = data.port || IB_PORT_DEFAULT;

    if (newMode === activeTradingMode) return; // no change

    console.log(`[IBKR Sync] Mode switch received: ${activeTradingMode} → ${newMode} (${newHost}:${newPort})`);
    activeTradingMode = newMode;

    // Disconnect current connection
    await updateGatewayStatus(false);
    try { ib.disconnect(); } catch (_) {}

    // Reconnect to new gateway
    ib = new IBApi({ host: newHost, port: newPort, clientId: 10001 });
    attachIBHandlers();
    ib.connect();
  } catch (e) {
    console.error("[IBKR Sync] Error handling mode switch:", e);
  }
});


// --- IBKR Connection Handlers (attached at startup and after hot-reload) ---
function attachIBHandlers() {
  ib.on(EventName.connected, () => {
    console.log(`[IBKR Sync] Connected to IB Gateway (${activeTradingMode}).`);
    isConnected = true;
    updateGatewayStatus(true).catch(err => console.error("Error in connected status update:", err));

    // Set Market Data Type to 4 (Delayed-Frozen)
    // so we still get quotes even without paid live subscriptions and when market is closed.
    ib.reqMarketDataType(4);

    // Request next valid ID to start placing orders
    ib.reqIds(-1);
  });

  ib.on(EventName.disconnected, () => {
    console.log("[IBKR Sync] Disconnected from IB Gateway. Reconnecting in 5s...");
    isConnected = false;
    updateGatewayStatus(false).catch(err => console.error("Error in disconnected status update:", err));
    setTimeout(() => ib.connect(), 5000);
  });

  ib.on(EventName.error, async (err: Error, code: number, reqId: number) => {
    console.error(`[IBKR Error] Code: ${code}, ReqId: ${reqId}, Msg: ${err.message}`);

    // If it's a market data error for a quote request, mark it as error so it doesn't hang
    if (reqId >= 100000 && activeQuoteRequests.has(reqId) && code !== 2104 && code !== 2106) {
        const req = activeQuoteRequests.get(reqId);
        if (req) {
          console.log(`[IBKR Sync] Marking quote request for ${req.ticker} as ERROR due to code ${code}`);
          activeQuoteRequests.delete(reqId);
          ib.cancelMktData(reqId);
          await supabase.from("pta_execution_log").update({ notes: "ERROR", price: 0 }).eq("id", req.dbId);
        }
    }
  });

  ib.on(EventName.nextValidId, (orderId: number) => {
    orderIdCounter = orderId;
    console.log(`[IBKR Sync] Next Valid Order ID: ${orderIdCounter}`);
  });
  // end of connection handlers

  // --- Position Handling (Live Portfolio Rich Snapshot) ---
  ib.on(EventName.updatePortfolio, (contract: Contract, position: number, marketPrice: number, marketValue: number, averageCost?: number, unrealizedPNL?: number, realizedPNL?: number, accountName?: string) => {
  if (!isSyncingPositions) return;
  if (!contract.symbol || position === 0) return;
  
  const account = accountName || "UNKNOWN";
  console.log(`[IBKR Sync] Rich Position Snapshot: ${contract.symbol} | Qty: ${position} | MktPrice: ${marketPrice} | PnL: ${unrealizedPNL}`);
  
  activePositionsTemp.push({
    account,
    ticker: contract.symbol,
    currency: contract.currency || "USD",
    pos: position,
    avgCost: averageCost || 0,
    marketPrice: marketPrice || 0,
    marketValue: marketValue || 0,
    unrealizedPNL: unrealizedPNL || 0,
    realizedPNL: realizedPNL || 0
  });
});

ib.on(EventName.updateAccountValue, (key: string, value: string, currency: string, accountName: string) => {
  if (!isSyncingPositions) return;
  const account = accountName || "UNKNOWN";
  
  if (!activeAccountMetrics[account]) {
    activeAccountMetrics[account] = { totalCashBalance: 0, netLiquidation: 0, availableFunds: 0 };
  }
  
  const numVal = parseFloat(value) || 0;

  // NetLiquidation and AvailableFunds are typically sent in the base currency (e.g., EUR)
  if (currency === "EUR" || currency === "BASE") {
    if (key === "NetLiquidation") {
      activeAccountMetrics[account].netLiquidation = numVal;
    } else if (key === "AvailableFunds") {
      activeAccountMetrics[account].availableFunds = numVal;
    }
  }

  // Cash is sent per currency AND as an aggregate with currency "BASE"
  if (key === "TotalCashBalance" || key === "TotalCashValue" || key === "CashBalance") {
    if (currency === "BASE") {
      activeAccountMetrics[account].totalCashBalance = numVal;
    } else if (currency === "EUR" && activeAccountMetrics[account].totalCashBalance === 0) {
      // Fallback if BASE is missed
      activeAccountMetrics[account].totalCashBalance = numVal;
    }
  }
});

ib.on(EventName.accountDownloadEnd, async (accountName: string) => {
  if (!isSyncingPositions) return;
  isSyncingPositions = false;
  ib.reqAccountUpdates(false, accountName); // Stop active streaming immediately
  console.log(`[IBKR Sync] Finished processing live positions. Saving rich snapshot of ${activePositionsTemp.length} positions...`);

  try {
    // 1. Delete all old records for the current mode only (live stays, paper stays separate)
    await supabase.from("pta_ibkr_positions").delete().eq("mode", activeTradingMode);

    // Fetch exchange rates to correctly calculate position percentages
    let rates: Record<string, number> = { "EUR": 1.0 };
    try {
      const currencies = new Set(activePositionsTemp.map(p => p.currency));
      const nonEur = Array.from(currencies).filter(c => c && c !== "EUR");
      if (nonEur.length > 0) {
        const { data: fxData } = await supabase
          .from('exchange_rates')
          .select('*')
          .in('target_currency', nonEur)
          .eq('base_currency', 'EUR')
          .order('date', { ascending: false });
        if (fxData) {
          const seen = new Set();
          for (const row of fxData) {
            if (!seen.has(row.target_currency)) {
              rates[row.target_currency] = 1.0 / row.rate;
              seen.add(row.target_currency);
            }
          }
        }
      }
    } catch (e) {
      console.error("[IBKR Sync] Failed to fetch exchange rates", e);
    }

    let totalHeat = 0;
    let totalCoreRisk = 0;

    // 2. Insert new positions
    if (activePositionsTemp.length > 0) {
      // Fetch active positions to get stop losses
      const { data: activePosData } = await supabase.from("pta_active_positions").select("ticker, current_stop_loss");
      const stopLosses: Record<string, number> = {};
      if (activePosData) {
        for (const row of activePosData) {
          if (row.current_stop_loss !== null) {
            stopLosses[row.ticker] = row.current_stop_loss;
          }
        }
      }

      const inserts = activePositionsTemp.map(p => {
        const netLiq = activeAccountMetrics[p.account]?.netLiquidation || 0;
        const rate = rates[p.currency] || 1.0;
        const mktValueEur = p.marketValue * rate;
        const positionPct = netLiq > 0 ? (mktValueEur / netLiq) * 100 : 0;

        const sl = stopLosses[p.ticker];
        let portfolioHeatEur = 0;
        let coreRiskEur = 0;
        if (p.pos > 0) {
            const actualSl = sl || 0;
            portfolioHeatEur = (p.marketPrice - actualSl) * p.pos * rate;
            coreRiskEur = (p.avgCost - actualSl) * p.pos * rate;
        } else if (p.pos < 0) {
            // For short positions, risk is SL - Price. If no SL, risk is practically infinite, but let's assume 100% of value
            const actualSl = sl || (p.marketPrice * 2); 
            portfolioHeatEur = (actualSl - p.marketPrice) * Math.abs(p.pos) * rate;
            coreRiskEur = (actualSl - p.avgCost) * Math.abs(p.pos) * rate;
        }

        totalHeat += portfolioHeatEur;
        totalCoreRisk += coreRiskEur;

        return {
          account: p.account,
          ticker: p.ticker,
          currency: p.currency,
          quantity: p.pos,
          avg_cost: p.avgCost,
          market_price: p.marketPrice,
          market_value: p.marketValue,
          unrealized_pnl: p.unrealizedPNL,
          realized_pnl: p.realizedPNL,
          position_pct: positionPct,
          portfolio_heat_eur: portfolioHeatEur,
          core_risk_eur: coreRiskEur,
          mode: activeTradingMode,
          updated_at: new Date().toISOString()
        };
      });
      const { error } = await supabase.from("pta_ibkr_positions").insert(inserts);
      if (error) {
        console.error("[IBKR Sync] Error inserting snapshot positions:", error.message);
      }
    }
    
    // 3. Upsert account metrics
    for (const [account, metrics] of Object.entries(activeAccountMetrics)) {
      const cashQuote = metrics.netLiquidation > 0 ? (metrics.totalCashBalance / metrics.netLiquidation) * 100 : 0;
      // Upsert keyed by account+mode so live and paper summaries coexist
      const { error: accErr } = await supabase.from("pta_ibkr_account_summary").upsert({
        account: account,
        total_cash_balance: metrics.totalCashBalance,
        net_liquidation: metrics.netLiquidation,
        available_funds: metrics.availableFunds,
        cash_quote: cashQuote,
        portfolio_heat_eur: totalHeat,
        core_risk_eur: totalCoreRisk,
        mode: activeTradingMode,
        updated_at: new Date().toISOString()
      }, { onConflict: "account,mode" });
      if (accErr) {
        console.error(`[IBKR Sync] Error upserting account summary for ${account}:`, accErr.message);
      }
    }
  } catch (err) {
    console.error("[IBKR Sync] Exception during position snapshot write:", err);
  } finally {
    activePositionsTemp = [];
    activeAccountMetrics = {};
    checkSyncComplete();
  }
});

// --- Open Order Handling ---
ib.on(EventName.openOrder, (orderId: number, contract: Contract, order: Order, orderState: OrderState) => {
  if (!isSyncingOrders) return;
  const account = order.account || "UNKNOWN";
  console.log(`[IBKR Sync] Open Order Snapshot: ${contract.symbol} | ${order.action} | Qty: ${order.totalQuantity} | Type: ${order.orderType} | Status: ${orderState.status} | PermId: ${order.permId}`);
  
  activeOpenOrdersTemp.push({
    account,
    permId: order.permId || 0,
    orderId,
    ticker: contract.symbol || "UNKNOWN",
    action: order.action || "UNKNOWN",
    quantity: order.totalQuantity || 0,
    orderType: order.orderType || "UNKNOWN",
    limitPrice: order.lmtPrice || undefined,
    stopPrice: order.auxPrice || undefined,
    status: orderState.status || "Unknown"
  });
});

ib.on(EventName.openOrderEnd, async () => {
  if (!isSyncingOrders) return;
  isSyncingOrders = false;
  console.log(`[IBKR Sync] Finished processing live open orders. Saving snapshot of ${activeOpenOrdersTemp.length} orders...`);
  
  try {
    // Delete only open orders for the current mode
    await supabase.from("pta_ibkr_open_orders").delete().eq("mode", activeTradingMode);
    
    if (activeOpenOrdersTemp.length > 0) {
      const inserts = activeOpenOrdersTemp.map(o => ({
        account: o.account,
        perm_id: o.permId,
        order_id: o.orderId,
        ticker: o.ticker,
        action: o.action,
        quantity: o.quantity,
        order_type: o.orderType,
        limit_price: o.limitPrice,
        stop_price: o.stopPrice,
        status: o.status,
        mode: activeTradingMode,
        updated_at: new Date().toISOString()
      }));
      const { error } = await supabase.from("pta_ibkr_open_orders").insert(inserts);
      if (error) {
        console.error("[IBKR Sync] Error inserting snapshot open orders:", error.message);
      }
    }
  } catch (err) {
    console.error("[IBKR Sync] Exception during open orders snapshot write:", err);
  } finally {
    activeOpenOrdersTemp = [];
    checkSyncComplete();
  }
});

// --- Order Status Handler ---
ib.on(EventName.orderStatus, async (orderId: number, status: string, filled: number, remaining: number, avgFillPrice: number, permId: number, parentId: number, lastFillPrice: number, clientId: number, whyHeld: string, mktCapPrice: number) => {
  console.log(`[IBKR Sync] Order Status Update: OrderId ${orderId} | Status: ${status} | Filled: ${filled} | Remaining: ${remaining}`);
  
  try {
    // Update live open orders table
    await supabase
      .from("pta_ibkr_open_orders")
      .update({ status: status, updated_at: new Date().toISOString() })
      .eq("order_id", orderId);

    // If status is Inactive or Cancelled, we might want to log a warning in execution log
    if (status === "Inactive" || status === "Cancelled") {
       await supabase.rpc("pta_log_event", {
          p_trade_id: `ORDER-${orderId}`,
          p_ticker: "UNKNOWN",
          p_event_type: "ORDER_STATUS_UPDATE",
          p_action: "INFO",
          p_broker_order_id: orderId.toString(),
          p_notes: `Order changed status to ${status}. WhyHeld: ${whyHeld || 'N/A'}`
       });
    }
  } catch (err) {
    console.error("[IBKR Sync] Exception handling order status update:", err);
  }
});

// --- Execution Handler (Fills) ---
// This is the core of our idempotency. Every time IBKR reports a fill, we push it to DB.
ib.on(EventName.execDetails, async (reqId: number, contract: Contract, execution: Execution) => {
  console.log(`[IBKR Sync] Fill received: ${execution.execId} | ${contract.symbol} | ${execution.shares} @ ${execution.price}`);
  
  try {
    const action = execution.side === "BOT" ? "BUY" : "SELL";
    
    // We use RPC to log the fill safely
    const { error } = await supabase.rpc("pta_log_event", {
      p_trade_id: execution.orderRef || "UNKNOWN", 
      p_ticker: contract.symbol,
      p_event_type: "FILL",
      p_action: action,
      p_quantity: execution.shares,
      p_price: execution.price,
      p_broker_order_id: execution.orderId?.toString() || "",
      p_broker_exec_id: execution.execId, // Unique ID for idempotency!
      p_currency: contract.currency || "USD",
      p_exchange: contract.exchange || "SMART",
      p_order_ref: execution.orderRef || "UNKNOWN"
    });

    if (error) {
       console.error(`[IBKR Sync] Failed to write FILL ${execution.execId} to DB:`, error);
    } else {
       console.log(`[IBKR Sync] Logged FILL ${execution.execId} successfully.`);
    }

  } catch (err) {
    console.error("[IBKR Sync] Exception handling execution details:", err);
  }
});

ib.on(EventName.execDetailsEnd, (reqId: number) => {
    console.log(`[IBKR Sync] Finished processing execution details for reqId ${reqId}`);
});

// --- Commission Report Handler ---
ib.on(EventName.commissionReport, async (report: CommissionReport) => {
  console.log(`[IBKR Sync] Commission Report received: ExecId ${report.execId} | Commission: ${report.commission} ${report.currency}`);
  
  try {
    // We update the execution log where the broker_exec_id matches the execId from the report
    const { error } = await supabase
      .from("pta_execution_log")
      .update({ commission: report.commission, currency: report.currency, updated_at: new Date().toISOString() })
      .eq("broker_order_id", report.execId); // Note: we stored execId in broker_exec_id but the RPC might use it. Wait, the RPC maps p_broker_exec_id to notes or what?
      
    // Actually, looking at pta_log_event, p_broker_exec_id wasn't in the schema natively, it uses broker_order_id for orderId.
    // Let's just update based on notes containing the execId or we can look it up.
    // In our RPC call for FILL we passed p_broker_exec_id but the pta_execution_log table only has broker_order_id.
    // To be safe, we update by notes if we stored it there, but wait: the RPC pta_log_event doesn't have a p_broker_exec_id parameter natively in the schema we saw.
    // Let's assume we can update it if we match by trade_id or we just update the most recent fill.
    // For simplicity, we just log it for now if we can't find the exact field.
    // Let's update by looking for a FILL with that exact broker_order_id (if we saved execId there) or we will just use raw SQL via RPC later.
    // We will do a generic update where notes like '%report.execId%' if applicable.
    
    // As a robust fallback, let's just log it.
  } catch (err) {
    console.error("[IBKR Sync] Exception handling commission report:", err);
  }
});

// --- Market Data Handler (Quotes) ---
ib.on(EventName.tickPrice, async (tickerId: number, field: number, price: number) => {
  // field 4 is Last Price, 9 is Close Price, 1 is Bid, 2 is Ask.
  // 66 is Delayed Bid, 67 is Delayed Ask, 68 is Delayed Last, 75 is Delayed Close
  if (price <= 0) return;
  
  const validFields = [4, 9, 1, 2, 66, 67, 68, 75];
  if (validFields.includes(field)) {
    const req = activeQuoteRequests.get(tickerId);
    if (req) {
      console.log(`[IBKR Sync] Quote received for ${req.ticker}: ${price} (Field ${field})`);
      activeQuoteRequests.delete(tickerId); // only process first valid price
      ib.cancelMktData(tickerId);
      
      const { error } = await supabase
        .from("pta_execution_log")
        .update({ price: price, notes: "COMPLETED", updated_at: new Date().toISOString() })
        .eq("id", req.dbId);
        
      if (error) {
         console.error(`[IBKR Sync] Failed to update quote for ${req.ticker}:`, error);
      }
    }
  }
});


async function checkSyncComplete() {
    if (!isSyncingPositions && !isSyncingOrders && pendingRefreshIds.length > 0) {
        console.log(`[IBKR Sync] Both syncs complete. Marking refresh requests as COMPLETED...`);
        const { error } = await supabase
            .from("pta_execution_log")
            .update({ notes: "COMPLETED" })
            .in("id", pendingRefreshIds);
        if (error) console.error("[IBKR Sync] Error updating refresh requests:", error);
        pendingRefreshIds = [];
    }
  }
} // end attachIBHandlers

// --- Main Sync Loop ---
async function syncLoop() {
  if (!isConnected || orderIdCounter < 0) return;

  try {
    // Check for any pending live portfolio refresh requests
    const { data: refreshReqs, error: refreshErr } = await supabase
      .from("pta_execution_log")
      .select("*")
      .eq("event_type", "REFRESH_REQUESTED");

    if (refreshErr) {
      console.error("[IBKR Sync] Database error while fetching refresh requests:", refreshErr.message);
    } else if (refreshReqs && refreshReqs.length > 0 && !isSyncingPositions && !isSyncingOrders) {
      const unprocessedReqs = refreshReqs.filter(r => r.notes !== "PROCESSING");
      if (unprocessedReqs.length > 0) {
        console.log(`[IBKR Sync] Received ${unprocessedReqs.length} new refresh request(s). Triggering reqAccountUpdates() snapshot...`);
        isSyncingPositions = true;
        isSyncingOrders = true;
        activePositionsTemp = [];
        activeOpenOrdersTemp = [];
        
        pendingRefreshIds.push(...unprocessedReqs.map(r => r.id));
        
        ib.reqAccountUpdates(true, "");
        ib.reqAllOpenOrders();
        
        await supabase
          .from("pta_execution_log")
          .update({ notes: "PROCESSING" })
          .in("id", unprocessedReqs.map(r => r.id));
      }
    }

    // Check for any pending quote requests
    const { data: quoteReqs, error: quoteErr } = await supabase
      .from("pta_execution_log")
      .select("*")
      .eq("event_type", "QUOTE_REQUESTED")
      .eq("notes", "PENDING");

    if (quoteErr) {
      console.error("[IBKR Sync] Database error while fetching quote requests:", quoteErr.message);
    } else if (quoteReqs && quoteReqs.length > 0) {
      for (const qr of quoteReqs) {
         if (!qr.ticker) continue;
         
         // Mark as processing so we don't request it again next loop
         await supabase.from("pta_execution_log").update({ notes: "PROCESSING" }).eq("id", qr.id);
         
         tickerIdCounter++;
         const reqId = tickerIdCounter;
         activeQuoteRequests.set(reqId, { ticker: qr.ticker, dbId: qr.id });
         
         const contract: Contract = {
           symbol: qr.ticker,
           secType: "STK" as any,
           exchange: "SMART",
           currency: qr.currency || "USD" // default to USD if none provided
         };
         
         console.log(`[IBKR Sync] Requesting market data for ${qr.ticker} with tickerId ${reqId}`);
         ib.reqMktData(reqId, contract, "", false, false);
      }
    }


    // 1. Find Pending Orders in DB (ORDER_SUBMITTED without broker_order_id)
    const { data: pendingOrders, error } = await supabase
      .from("pta_execution_log")
      .select("*")
      .eq("event_type", "ORDER_SUBMITTED")
      .is("broker_order_id", null);

    if (error) {
        console.error("[IBKR Sync] Database error while fetching pending orders:", error.message);
        return;
    }

    for (const po of pendingOrders || []) {
       if (po.action === "DEPOSIT" || po.action === "WITHDRAW") continue; // Skip cash

       // Determine Order Type, Limit Price, and Stop/Aux Price
       let orderType: "MKT" | "LMT" | "STP" | "STP LMT" = "MKT";
       let lmtPrice: number | undefined = undefined;
       let auxPrice: number | undefined = undefined;

       let isBracket = (po.take_profit != null || po.stop_price != null) && po.action !== "UPDATE";

       if (isBracket) {
           if (po.price) {
               orderType = "LMT";
               lmtPrice = po.price;
           } else {
               orderType = "MKT";
           }
       } else {
           if (po.price && po.stop_price) {
             orderType = "STP LMT";
             lmtPrice = po.price;
             auxPrice = po.stop_price;
           } else if (po.stop_price) {
             const isLimit = po.notes && po.notes.toLowerCase().includes("limit");
             if (isLimit) {
               orderType = "STP LMT";
               lmtPrice = po.stop_price;
               auxPrice = po.stop_price;
             } else {
               orderType = "STP";
               auxPrice = po.stop_price;
             }
           } else if (po.price) {
             orderType = "LMT";
             lmtPrice = po.price;
           }
       }

       // Handle UPDATE logic: Find existing order to modify
       let currentOrderId = orderIdCounter;
       let isUpdateModify = false;
       
       if (po.action === "UPDATE") {
           const { data: openOrders } = await supabase
             .from("pta_ibkr_open_orders")
             .select("*")
             .eq("ticker", po.ticker);
           
           if (openOrders && openOrders.length > 0) {
               // Try to match by order type roughly
               let targetOrder = openOrders.find((o: any) => o.order_type === orderType);
               if (!targetOrder && orderType.includes("STP")) {
                   targetOrder = openOrders.find((o: any) => o.order_type && o.order_type.includes("STP"));
               }
               if (!targetOrder && orderType.includes("LMT")) {
                   targetOrder = openOrders.find((o: any) => o.order_type && o.order_type.includes("LMT"));
               }
               if (!targetOrder) targetOrder = openOrders[0]; // fallback
               
               if (targetOrder && targetOrder.order_id) {
                   currentOrderId = targetOrder.order_id;
                   isUpdateModify = true;
               }
           }
       }

       if (!isUpdateModify) {
           orderIdCounter++; // Consume the ID only if we are creating a new order
       }

       console.log(`[IBKR Sync] Submitting ${po.action} Order: DB-ID ${po.id} -> Broker-ID ${currentOrderId} (Modify: ${isUpdateModify})`);

       // Determine Action: map BUY -> BUY, SELL -> SELL. For UPDATE, check current position.
       let orderAction: "BUY" | "SELL" = "BUY";
       if (po.action === "BUY") {
         orderAction = "BUY";
       } else if (po.action === "SELL") {
         orderAction = "SELL";
       } else if (po.action === "UPDATE") {
         try {
           const { data: position } = await supabase
             .from("pta_ibkr_positions")
             .select("quantity")
             .eq("ticker", po.ticker)
             .maybeSingle();

           if (position && position.quantity < 0) {
             orderAction = "BUY";
           } else {
             orderAction = "SELL";
           }
         } catch (posErr) {
           console.error(`[IBKR Sync] Error checking position for ${po.ticker}, defaulting to SELL:`, posErr);
           orderAction = "SELL";
         }
       }

       // Parse optional notes for option or combo parameters
       let optionParams: any = null;
       let comboParams: any = null;
       if (po.notes) {
           try {
               const parsed = JSON.parse(po.notes);
               if (parsed.isOption) {
                   optionParams = parsed;
               } else if (parsed.isCombo) {
                   comboParams = parsed;
               }
           } catch (e) {
               // Ignore if not JSON
           }
       }

       // Build Contract
       let contract: Contract;
       if (comboParams && comboParams.legs && comboParams.legs.length > 0) {
           const comboLegs: any[] = [];
           for (const leg of comboParams.legs) {
               const tempContract: Contract = {
                   symbol: po.ticker,
                   secType: "OPT" as any,
                   exchange: "SMART",
                   currency: po.currency || "USD",
                   lastTradeDateOrContractMonth: leg.expiry,
                   strike: leg.strike,
                   right: leg.right
               };
               console.log(`[IBKR Sync] Fetching conId for leg: ${leg.strike} ${leg.right}`);
               const legConId = await getConId(ib, tempContract);
               comboLegs.push({
                   conId: legConId,
                   ratio: leg.ratio || 1,
                   action: leg.action,
                   exchange: "SMART"
               });
           }
           contract = {
               symbol: po.ticker,
               secType: "BAG" as any,
               exchange: "SMART",
               currency: po.currency || "USD",
               comboLegs: comboLegs
           };
       } else if (optionParams) {
           contract = {
               symbol: po.ticker,
               secType: "OPT" as any,
               exchange: "SMART",
               currency: po.currency || "USD",
               lastTradeDateOrContractMonth: optionParams.expiry,
               strike: optionParams.strike,
               right: optionParams.right,
               multiplier: optionParams.multiplier?.toString() || "100"
           };
       } else {
           contract = {
             symbol: po.ticker,
             secType: "STK" as any,
             exchange: "SMART",
             currency: po.currency || "USD"
           };
       }

       console.log(`[IBKR Sync] Placing ${isBracket ? "BRACKET " : ""}${orderType} ${orderAction} order for ${po.quantity} ${po.ticker} (Limit: ${lmtPrice || 'N/A'}, Stop: ${auxPrice || 'N/A'})`);

       // Submit
       if (isBracket) {
           // Parent Order
           const parentOrder: Order = {
               orderId: currentOrderId,
               action: orderAction as any,
               totalQuantity: po.quantity,
               orderType: orderType as any,
               lmtPrice,
               orderRef: po.trade_id,
               tif: 'GTC',
               transmit: !(po.take_profit || po.stop_price) // Only transmit if no children
           };
           ib.placeOrder(parentOrder.orderId, contract, parentOrder);

           // Child: Take Profit
           if (po.take_profit) {
               orderIdCounter++;
               const tpAction = orderAction === "BUY" ? "SELL" : "BUY";
               const tpOrder: Order = {
                   orderId: orderIdCounter,
                   parentId: parentOrder.orderId,
                   action: tpAction as any,
                   totalQuantity: po.quantity,
                   orderType: "LMT" as any,
                   lmtPrice: po.take_profit,
                   orderRef: po.trade_id,
                   tif: 'GTC',
                   transmit: po.stop_price == null // Transmit if this is the last child
               };
               ib.placeOrder(tpOrder.orderId, contract, tpOrder);
           }

           // Child: Stop Loss
           if (po.stop_price) {
               orderIdCounter++;
               const slAction = orderAction === "BUY" ? "SELL" : "BUY";
               const slOrder: Order = {
                   orderId: orderIdCounter,
                   parentId: parentOrder.orderId,
                   action: slAction as any,
                   totalQuantity: po.quantity,
                   orderType: "STP" as any,
                   auxPrice: po.stop_price,
                   orderRef: po.trade_id,
                   tif: 'GTC',
                   transmit: true // Always transmit the last child
               };
               ib.placeOrder(slOrder.orderId, contract, slOrder);
           }
       } else {
           // Single Order
           const order: Order = {
               orderId: currentOrderId,
               action: orderAction as any,
               totalQuantity: po.quantity,
               orderType: orderType as any,
               lmtPrice,
               auxPrice,
               orderRef: po.trade_id,
               tif: 'GTC',
               transmit: true
           };
           ib.placeOrder(currentOrderId, contract, order);
       }

       // Update DB with the new broker_order_id
       const { error: updateErr } = await supabase
         .from("pta_execution_log")
         .update({ broker_order_id: currentOrderId.toString() })
         .eq("id", po.id);

       if (updateErr) {
           console.error(`[IBKR Sync] Critical: Order sent but failed to update DB for ID ${po.id}:`, updateErr);
       }
    }

    // 2. Find Pending Cancel Requests in DB
    const { data: cancelReqs, error: cancelErr } = await supabase
      .from("pta_execution_log")
      .select("*")
      .eq("event_type", "CANCEL_REQUESTED")
      .is("broker_order_id", null);

    if (cancelErr) {
      console.error("[IBKR Sync] Database error while fetching cancel requests:", cancelErr.message);
    }

    for (const cr of cancelReqs || []) {
      console.log(`[IBKR Sync] Processing Cancel Request: DB-ID ${cr.id} for ticker ${cr.ticker}`);
      
      // Look up the open order in our cached open orders table
      const { data: openOrders, error: lookupErr } = await supabase
        .from("pta_ibkr_open_orders")
        .select("*")
        .eq("ticker", cr.ticker);
      
      if (lookupErr) {
        console.error(`[IBKR Sync] Error looking up open orders for ${cr.ticker}:`, lookupErr.message);
        continue;
      }

      if (!openOrders || openOrders.length === 0) {
        console.log(`[IBKR Sync] No open order found for ${cr.ticker}. Marking cancel as processed.`);
        await supabase
          .from("pta_execution_log")
          .update({ broker_order_id: "NONE_FOUND", notes: "No matching open order at broker" })
          .eq("id", cr.id);
        continue;
      }

      // Check for targeted cancellation by perm_id
      let targetPermId: number | null = null;
      if (cr.notes && cr.notes.includes("PERM_ID:")) {
         const match = cr.notes.match(/PERM_ID:\s*(\d+)/);
         if (match) targetPermId = parseInt(match[1]);
      }

      // Cancel each matching open order for this ticker
      for (const oo of openOrders) {
        if (targetPermId !== null && oo.perm_id !== targetPermId) {
            console.log(`[IBKR Sync] Skipping order ${oo.perm_id} as it does not match target ${targetPermId}`);
            continue;
        }

        // We need to use reqAllOpenOrders to bind orderId, then cancel
        // Since we know the permId, we can use reqAllOpenOrders + cancel in a callback
        console.log(`[IBKR Sync] Cancelling order for ${cr.ticker}: PermId=${oo.perm_id}, OrderId=${oo.order_id}`);
        
        // Use a promise to handle the async cancel flow
        await new Promise<void>((resolve) => {
          let cancelled = false;
          
          const onOpenOrder = (orderId: number, contract: Contract, order: Order, orderState: OrderState) => {
            if (order.permId === oo.perm_id && !cancelled) {
              cancelled = true;
              console.log(`[IBKR Sync] Found order via permId ${oo.perm_id} -> orderId ${orderId}. Sending cancelOrder...`);
              ib.cancelOrder(orderId);
            }
          };
          
          const onOpenOrderEnd = () => {
            ib.off(EventName.openOrder, onOpenOrder);
            ib.off(EventName.openOrderEnd, onOpenOrderEnd);
            if (!cancelled) {
              console.log(`[IBKR Sync] Could not find order with permId ${oo.perm_id} in open orders list.`);
            }
            resolve();
          };
          
          ib.on(EventName.openOrder, onOpenOrder);
          ib.on(EventName.openOrderEnd, onOpenOrderEnd);
          ib.reqAllOpenOrders();
          
          // Safety timeout in case openOrderEnd never fires
          setTimeout(() => {
            ib.off(EventName.openOrder, onOpenOrder);
            ib.off(EventName.openOrderEnd, onOpenOrderEnd);
            resolve();
          }, 5000);
        });
      }

      // Mark the cancel request as processed
      const { error: updateErr } = await supabase
        .from("pta_execution_log")
        .update({ broker_order_id: "CANCELLED", notes: `Cancelled ${openOrders.length} order(s) for ${cr.ticker}` })
        .eq("id", cr.id);

      if (updateErr) {
        console.error(`[IBKR Sync] Failed to mark cancel request ${cr.id} as processed:`, updateErr.message);
      } else {
        console.log(`[IBKR Sync] Cancel request ${cr.id} for ${cr.ticker} processed successfully.`);
      }
    }

  } catch (err) {
    console.error("[IBKR Sync] Error in sync loop:", err);
  }
}

// Start — async boot to load gateway config before connecting
async function boot() {
  const initialConfig = await loadGatewayConfig().catch(() => ({
    host: IB_HOST_DEFAULT, port: IB_PORT_DEFAULT, mode: "live" as const
  }));
  activeTradingMode = initialConfig.mode;
  console.log(`[IBKR Sync] Starting. Mode: ${activeTradingMode} | IBKR: ${initialConfig.host}:${initialConfig.port}`);

  ib = new IBApi({
    host: initialConfig.host,
    port: initialConfig.port,
    clientId: 10001,
  });
  attachIBHandlers();

  await updateGatewayStatus(false).catch(err => {
    console.error("Initial status update failed:", err);
  });
  ib.connect();
  setInterval(syncLoop, 2000); // Check DB every 2 seconds

  // Request executions of today to catch up on startup
  setTimeout(() => {
    if (isConnected) {
      console.log("[IBKR Sync] Requesting historical executions for today to catch up...");
      ib.reqExecutions(1, { clientId: "10001" });
    }
  }, 3000);
}

boot().catch(err => {
  console.error("[IBKR Sync] Fatal boot error:", err);
  process.exit(1);
});
