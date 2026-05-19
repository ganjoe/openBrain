import { IBApi, EventName, Order, Contract, OrderState, Execution } from "@stoqey/ib";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";

dotenv.config({ path: "/app/config.yaml" }); // Just for any local .env testing if needed

// --- Configuration ---
const IB_HOST = process.env.IB_GATEWAY_HOST || "ib-gateway";
const IB_PORT = parseInt(process.env.IB_GATEWAY_PORT || "4002", 10);

// Use the internal network URL for Supabase since we are inside the Bot container
const SUPABASE_URL = process.env.POSTGREST_URL || "http://postgrest:3000"; 
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY || "missing";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log(`[IBKR Sync] Starting. IBKR: ${IB_HOST}:${IB_PORT}`);

const ib = new IBApi({
  host: IB_HOST,
  port: IB_PORT,
  clientId: 99, // Unique client ID for the sync service
});

// --- State ---
let isConnected = false;
let orderIdCounter = -1;

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
      p_broker_order_id: execution.orderId.toString(),
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
         secType: "STK",
         exchange: "SMART",
         currency: po.currency || "USD"
       };

       // Build Order
       const order: Order = {
         orderId: currentOrderId,
         action: po.action === "BUY" ? "BUY" : "SELL",
         totalQuantity: po.quantity,
         orderType: po.price ? "LMT" : "MKT",
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
        ib.reqExecutions(1, { clientId: 99 }); 
    }
}, 3000);
