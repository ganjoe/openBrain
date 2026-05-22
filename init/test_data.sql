-- Insert a test EUR trade with stop loss
-- Risk: 10 * (150 - 140) = 100 EUR
-- PnL: 10 * (180 - 150) - 10 = 290 EUR
-- R-Multiple: 2.9
INSERT INTO pta_execution_log (trade_id, ticker, event_type, action, quantity, price, stop_price, commission, currency, created_at)
VALUES 
  ('TRD-TEST-1', 'SAP', 'ORDER_SUBMITTED', 'BUY', 10, 150.0, 140.0, 0, 'EUR', '2025-01-01 10:00:00'),
  ('TRD-TEST-1', 'SAP', 'FILL', 'BUY', 10, 150.0, NULL, 5.0, 'EUR', '2025-01-01 10:05:00'),
  ('TRD-TEST-1', 'SAP', 'FILL', 'SELL', 10, 180.0, NULL, 5.0, 'EUR', '2025-01-10 10:00:00');

-- Insert a test USD trade WITHOUT stop loss
-- Risk: cost_basis = 20 * 50 = 1000 USD
-- PnL: 20 * 40 - 1000 - 2 = -202 USD
-- R-Multiple: -202 / 1000 = -0.202
INSERT INTO pta_execution_log (trade_id, ticker, event_type, action, quantity, price, stop_price, commission, currency, created_at)
VALUES 
  ('TRD-TEST-2', 'AAPL', 'ORDER_SUBMITTED', 'BUY', 20, 50.0, NULL, 0, 'USD', '2025-01-15 10:00:00'),
  ('TRD-TEST-2', 'AAPL', 'FILL', 'BUY', 20, 50.0, NULL, 1.0, 'USD', '2025-01-15 10:05:00'),
  ('TRD-TEST-2', 'AAPL', 'FILL', 'SELL', 20, 40.0, NULL, 1.0, 'USD', '2025-01-20 10:00:00');

-- Insert a test exchange rate for USD
INSERT INTO exchange_rates (date, base_currency, target_currency, rate)
VALUES ('2025-01-20', 'EUR', 'USD', 1.10)
ON CONFLICT DO NOTHING;
