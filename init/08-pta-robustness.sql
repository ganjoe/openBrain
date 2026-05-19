-- Open Brain Local: PTA Robustness & Idempotency
-- Ensures that re-syncing from Broker doesn't duplicate data.

SET search_path = public, extensions;

-- 1. Add broker_exec_id for specific execution tracking (Fills)
ALTER TABLE pta_execution_log ADD COLUMN IF NOT EXISTS broker_exec_id TEXT;

-- 2. Ensure we never log the same Fill twice (Idempotency)
-- We use a partial unique index: only active for FILL events.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pta_unique_fill 
ON pta_execution_log (broker_exec_id) 
WHERE event_type = 'FILL' AND broker_exec_id IS NOT NULL;

-- 3. Add order_ref explicitly (often maps to trade_id, but good for broker-side lookup)
ALTER TABLE pta_execution_log ADD COLUMN IF NOT EXISTS order_ref TEXT;

-- Update pta_log_event function to handle the new fields
CREATE OR REPLACE FUNCTION pta_log_event(
  p_trade_id TEXT,
  p_ticker TEXT,
  p_event_type TEXT,
  p_action TEXT,
  p_quantity NUMERIC DEFAULT NULL,
  p_price NUMERIC DEFAULT NULL,
  p_stop_price NUMERIC DEFAULT NULL,
  p_broker_order_id TEXT DEFAULT NULL,
  p_commission NUMERIC DEFAULT 0.0,
  p_currency TEXT DEFAULT 'USD',
  p_exchange TEXT DEFAULT NULL,
  p_slippage NUMERIC DEFAULT 0.0,
  p_notes TEXT DEFAULT NULL,
  p_broker_exec_id TEXT DEFAULT NULL,
  p_order_ref TEXT DEFAULT NULL
)
RETURNS BIGINT AS $$
DECLARE
  v_id BIGINT;
BEGIN
  INSERT INTO pta_execution_log (
    trade_id, ticker, event_type, action, quantity, price, stop_price, 
    broker_order_id, commission, currency, exchange, slippage, notes,
    broker_exec_id, order_ref
  ) VALUES (
    p_trade_id, p_ticker, p_event_type, p_action, p_quantity, p_price, p_stop_price, 
    p_broker_order_id, p_commission, p_currency, p_exchange, p_slippage, p_notes,
    p_broker_exec_id, COALESCE(p_order_ref, p_trade_id)
  ) 
  ON CONFLICT (broker_exec_id) WHERE event_type = 'FILL' DO NOTHING
  RETURNING id INTO v_id;
  
  -- If v_id is NULL (because of DO NOTHING), we still want to return a valid result or handle it.
  -- For robustness, we can try to find the existing ID or just return 0.
  IF v_id IS NULL THEN
     SELECT id INTO v_id FROM pta_execution_log WHERE broker_exec_id = p_broker_exec_id LIMIT 1;
  END IF;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql;
