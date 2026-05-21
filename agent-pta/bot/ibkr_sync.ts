import { IBApi, EventName, Order, Contract, OrderState, Execution } from "@stoqey/ib";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";

dotenv.config({ path: "/app/config.yaml" }); // Just for any local .env testing if needed

// --- Configuration ---
const IB_HOST = process.env.IB_GATEWAY_HOST || "ib-gateway";
const IB_PORT = parseInt(process.env.IB_GATEWAY_PORT || "4002", 10);

// Use the Gateway URL for Supabase JS client since it appends /rest/v1 automatically
const SUPABASE_URL = process.env.SUPABASE_URL || "http://gateway:80"; 
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY || "missing";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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
    }
  } catch (err) {
    console.error("[IBKR Sync] Exception during gateway status update:", err);
  }
}

console.log(`[IBKR Sync] Starting. IBKR: ${IB_HOST}:${IB_PORT}`);

const ib = new IBApi({
  host: IB_HOST,
  port: IB_PORT,
  clientId: 10001, // Unique client ID (10001) to prevent collisions with stock-data-node (1-9999)
});

// --- State ---
let isConnected = false;
let orderIdCounter = -1;
let isSyncingPositions = false;
let activePositionsTemp: Array<{ account: string; ticker: string; currency: string; pos: number; avgCost: number; marketPrice: number; marketValue: number; unrealizedPNL: number; realizedPNL: number }> = [];
let activeAccountMetrics: Record<string, { totalCashBalance: number; netLiquidation: number; availableFunds: number }> = {};
let isSyncingOrders = false;
let activeOpenOrdersTemp: Array<{ account: string; permId: number; orderId: number; ticker: string; action: string; quantity: number; orderType: string; limitPrice?: number; stopPrice?: number; status: string }> = [];

// --- IBKR Connection Handlers ---
ib.on(EventName.connected, () => {
  console.log("[IBKR Sync] Connected to IB Gateway.");
  isConnected = true;
  updateGatewayStatus(true).catch(err => console.error("Error in connected status update:", err));
  // Request next valid ID to start placing orders
  ib.reqIds(-1);
});

ib.on(EventName.disconnected, () => {
  console.log("[IBKR Sync] Disconnected from IB Gateway. Reconnecting in 5s...");
  isConnected = false;
  updateGatewayStatus(false).catch(err => console.error("Error in disconnected status update:", err));
  setTimeout(() => ib.connect(), 5000);
});

ib.on(EventName.error, (err: Error, code: number, reqId: number) => {
  console.error(`[IBKR Error] Code: ${code}, ReqId: ${reqId}, Msg: ${err.message}`);
});

ib.on(EventName.nextValidId, (orderId: number) => {
  orderIdCounter = orderId;
  console.log(`[IBKR Sync] Next Valid Order ID: ${orderIdCounter}`);
});

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
  
  if (currency === "EUR") {
    const numVal = parseFloat(value) || 0;
    if (key === "TotalCashBalance") {
      activeAccountMetrics[account].totalCashBalance = numVal;
    } else if (key === "NetLiquidation") {
      activeAccountMetrics[account].netLiquidation = numVal;
    } else if (key === "AvailableFunds") {
      activeAccountMetrics[account].availableFunds = numVal;
    }
  }
});

ib.on(EventName.accountDownloadEnd, async (accountName: string) => {
  if (!isSyncingPositions) return;
  isSyncingPositions = false;
  ib.reqAccountUpdates(false, accountName); // Stop active streaming immediately
  console.log(`[IBKR Sync] Finished processing live positions. Saving rich snapshot of ${activePositionsTemp.length} positions...`);

  try {
    // 1. Delete all old records in pta_ibkr_positions
    await supabase.from("pta_ibkr_positions").delete().neq("account", "LTM_DUMMY"); // clears all rows

    // 2. Insert new positions
    if (activePositionsTemp.length > 0) {
      const inserts = activePositionsTemp.map(p => {
        const netLiq = activeAccountMetrics[p.account]?.netLiquidation || 0;
        const positionPct = netLiq > 0 ? (p.marketValue / netLiq) * 100 : 0;
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
      const { error: accErr } = await supabase.from("pta_ibkr_account_summary").upsert({
        account: account,
        total_cash_balance: metrics.totalCashBalance,
        net_liquidation: metrics.netLiquidation,
        available_funds: metrics.availableFunds,
        cash_quote: cashQuote,
        updated_at: new Date().toISOString()
      }, { onConflict: "account" });
      if (accErr) {
        console.error(`[IBKR Sync] Error upserting account summary for ${account}:`, accErr.message);
      }
    }
  } catch (err) {
    console.error("[IBKR Sync] Exception during position snapshot write:", err);
  } finally {
    activePositionsTemp = [];
    activeAccountMetrics = {};
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
    // Delete all old records in pta_ibkr_open_orders
    await supabase.from("pta_ibkr_open_orders").delete().neq("account", "LTM_DUMMY");
    
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
    } else if (refreshReqs && refreshReqs.length > 0) {
      console.log(`[IBKR Sync] Received ${refreshReqs.length} refresh request(s). Triggering reqAccountUpdates() snapshot...`);
      isSyncingPositions = true;
      isSyncingOrders = true;
      activePositionsTemp = [];
      activeOpenOrdersTemp = [];
      ib.reqAccountUpdates(true, "");
      ib.reqAllOpenOrders();
      
      // Delete the processed refresh requests
      const { error: deleteErr } = await supabase
        .from("pta_execution_log")
        .delete()
        .eq("event_type", "REFRESH_REQUESTED");

      if (deleteErr) {
        console.error("[IBKR Sync] Failed to delete processed refresh requests:", deleteErr.message);
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

       // Build Contract
       const contract: Contract = {
         symbol: po.ticker,
         secType: "STK" as any,
         exchange: "SMART",
         currency: po.currency || "USD"
       };

       // Build Order
       const order: Order = {
         orderId: currentOrderId,
         action: orderAction as any,
         totalQuantity: po.quantity,
         orderType: orderType as any,
         lmtPrice,
         auxPrice,
         orderRef: po.trade_id, // Link to STM's intention
         tif: 'GTC',
         transmit: true
       };

       console.log(`[IBKR Sync] Placing ${orderType} ${orderAction} order for ${po.quantity} ${po.ticker} (Limit: ${lmtPrice || 'N/A'}, Stop: ${auxPrice || 'N/A'})`);

       // Submit
       ib.placeOrder(currentOrderId, contract, order);

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

// Start
updateGatewayStatus(false).then(() => {
  ib.connect();
}).catch(err => {
  console.error("Initial status update failed:", err);
  ib.connect();
});
setInterval(syncLoop, 2000); // Check DB every 2 seconds

// Request executions of today to catch up on startup
setTimeout(() => {
    if (isConnected) {
        console.log("[IBKR Sync] Requesting historical executions for today to catch up...");
        ib.reqExecutions(1, { clientId: "10001" }); 
    }
}, 3000);
