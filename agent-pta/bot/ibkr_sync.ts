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
let activePositionsTemp: Array<{ account: string; ticker: string; pos: number; avgCost: number }> = [];

// --- IBKR Connection Handlers ---
ib.on(EventName.connected, () => {
  console.log("[IBKR Sync] Connected to IB Gateway.");
  isConnected = true;
  // Request next valid ID to start placing orders
  ib.reqIds(-1);
});

ib.on(EventName.disconnected, () => {
  console.log("[IBKR Sync] Disconnected from IB Gateway. Reconnecting in 5s...");
  isConnected = false;
  setTimeout(() => ib.connect(), 5000);
});

ib.on(EventName.error, (err: Error, code: number, reqId: number) => {
  console.error(`[IBKR Error] Code: ${code}, ReqId: ${reqId}, Msg: ${err.message}`);
});

ib.on(EventName.nextValidId, (orderId: number) => {
  orderIdCounter = orderId;
  console.log(`[IBKR Sync] Next Valid Order ID: ${orderIdCounter}`);
});

// --- Position Handling (Live Portfolio Snapshot) ---
ib.on(EventName.position, (account: string, contract: Contract, pos: number, avgCost?: number) => {
  if (!isSyncingPositions) return;
  if (!contract.symbol) return;
  console.log(`[IBKR Sync] Live Position Snapshot: ${contract.symbol} | Qty: ${pos} @ ${avgCost} (Account: ${account})`);
  activePositionsTemp.push({
    account,
    ticker: contract.symbol,
    pos,
    avgCost: avgCost || 0
  });
});

ib.on(EventName.positionEnd, async () => {
  if (!isSyncingPositions) return;
  isSyncingPositions = false;
  ib.cancelPositions(); // Stop active streaming immediately
  console.log(`[IBKR Sync] Finished processing live positions. Saving snapshot of ${activePositionsTemp.length} positions...`);

  try {
    // 1. Delete all old records in pta_ibkr_positions
    await supabase.from("pta_ibkr_positions").delete().neq("account", "LTM_DUMMY"); // clears all rows

    // 2. Insert new positions
    if (activePositionsTemp.length > 0) {
      const inserts = activePositionsTemp.map(p => ({
        account: p.account,
        ticker: p.ticker,
        quantity: p.pos,
        avg_cost: p.avgCost,
        updated_at: new Date().toISOString()
      }));
      const { error } = await supabase.from("pta_ibkr_positions").insert(inserts);
      if (error) {
        console.error("[IBKR Sync] Error inserting snapshot positions:", error.message);
      }
    }
  } catch (err) {
    console.error("[IBKR Sync] Exception during position snapshot write:", err);
  } finally {
    activePositionsTemp = [];
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
      console.log(`[IBKR Sync] Received ${refreshReqs.length} refresh request(s). Triggering reqPositions() snapshot...`);
      isSyncingPositions = true;
      activePositionsTemp = [];
      ib.reqPositions();
      
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

       const currentOrderId = orderIdCounter++;
       console.log(`[IBKR Sync] Submitting Pending Order: DB-ID ${po.id} -> Broker-ID ${currentOrderId}`);

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
         action: (po.action === "BUY" ? "BUY" : "SELL") as any,
         totalQuantity: po.quantity,
         orderType: (po.price ? "LMT" : "MKT") as any,
         lmtPrice: po.price ? po.price : undefined,
         orderRef: po.trade_id, // Link to STM's intention
         transmit: true
       };

       // Submit
       ib.placeOrder(currentOrderId, contract, order);

       // Update DB with the new broker_order_id
       const { error: updateErr } = await supabase
         .from("pta_execution_log")
         .update({ broker_order_id: currentOrderId.toString() })
         .eq("id", po.id);

       if (updateErr) {
           console.error(`[IBKR Sync] Critical: Order sent but failed to update DB for ID ${po.id}:`, updateErr);
           // Note: In a perfect world, we'd pause or alert here.
       }
    }

  } catch (err) {
    console.error("[IBKR Sync] Error in sync loop:", err);
  }
}

// Start
ib.connect();
setInterval(syncLoop, 2000); // Check DB every 2 seconds

// Request executions of today to catch up on startup
setTimeout(() => {
    if (isConnected) {
        console.log("[IBKR Sync] Requesting historical executions for today to catch up...");
        ib.reqExecutions(1, { clientId: "10001" }); 
    }
}, 3000);
