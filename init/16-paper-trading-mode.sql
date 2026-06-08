-- 16-paper-trading-mode.sql
-- Adds trading mode isolation across all PTA tables.
-- Paper trading acts as a staging environment — same schema, separate data.
-- Existing rows default to 'live' — no data loss.

-- ── Mode column on all trading tables ──────────────────────────────────────────

ALTER TABLE pta_execution_log
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'live'
  CHECK (mode IN ('live', 'paper'));

ALTER TABLE pta_ibkr_positions
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'live'
  CHECK (mode IN ('live', 'paper'));

ALTER TABLE pta_ibkr_account_summary
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'live'
  CHECK (mode IN ('live', 'paper'));

ALTER TABLE pta_ibkr_open_orders
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'live'
  CHECK (mode IN ('live', 'paper'));

-- ── Indexes for fast mode filtering ────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_execution_log_mode    ON pta_execution_log(mode);
CREATE INDEX IF NOT EXISTS idx_ibkr_positions_mode   ON pta_ibkr_positions(mode);
CREATE INDEX IF NOT EXISTS idx_ibkr_account_mode     ON pta_ibkr_account_summary(mode);
CREATE INDEX IF NOT EXISTS idx_ibkr_open_orders_mode ON pta_ibkr_open_orders(mode);

-- ── Gateway configuration in system_settings ───────────────────────────────────

INSERT INTO system_settings (key, value)
VALUES ('ib_gateway_config', '{
  "active_mode": "live",
  "live": {
    "container_name": "ib-gateway_live-ib-gateway-1",
    "port": 4002,
    "host": "10.20.0.23"
  },
  "paper": {
    "container_name": "ib-gateway_paper",
    "port": 4001,
    "host": "10.20.0.23"
  }
}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── Grants ─────────────────────────────────────────────────────────────────────

GRANT ALL ON TABLE public.pta_execution_log       TO anon;
GRANT ALL ON TABLE public.pta_ibkr_positions      TO anon;
GRANT ALL ON TABLE public.pta_ibkr_account_summary TO anon;
GRANT ALL ON TABLE public.pta_ibkr_open_orders    TO anon;
GRANT ALL ON TABLE public.pta_execution_log       TO service_role;
GRANT ALL ON TABLE public.pta_ibkr_positions      TO service_role;
GRANT ALL ON TABLE public.pta_ibkr_account_summary TO service_role;
GRANT ALL ON TABLE public.pta_ibkr_open_orders    TO service_role;
