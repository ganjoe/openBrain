-- Add take_profit column
ALTER TABLE public.pta_execution_log ADD COLUMN IF NOT EXISTS take_profit NUMERIC;

-- Update the helper function to include p_take_profit
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
  p_take_profit NUMERIC DEFAULT NULL
)
RETURNS BIGINT AS $$
DECLARE
  v_id BIGINT;
BEGIN
  INSERT INTO pta_execution_log (
    trade_id, ticker, event_type, action, quantity, price, stop_price, 
    broker_order_id, commission, currency, exchange, slippage, notes, take_profit
  ) VALUES (
    p_trade_id, p_ticker, p_event_type, p_action, p_quantity, p_price, p_stop_price, 
    p_broker_order_id, p_commission, p_currency, p_exchange, p_slippage, p_notes, p_take_profit
  ) RETURNING id INTO v_id;
  
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;
