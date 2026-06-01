-- Open Brain Local: PTA IBKR Live Account Summary
-- Stores the live account metrics (Cash, Liquidation Value) fetched from Interactive Brokers

SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS pta_ibkr_account_summary (
  account               TEXT PRIMARY KEY,
  total_cash_balance    NUMERIC NOT NULL DEFAULT 0.0,
  net_liquidation       NUMERIC NOT NULL DEFAULT 0.0,
  available_funds       NUMERIC NOT NULL DEFAULT 0.0,
  cash_quote            NUMERIC NOT NULL DEFAULT 0.0,
  portfolio_heat_eur    NUMERIC DEFAULT 0.0,
  core_risk_eur         NUMERIC DEFAULT 0.0,
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Grant privileges so PostgREST and agent services can read/write
GRANT ALL ON TABLE public.pta_ibkr_account_summary TO anon;
GRANT ALL ON TABLE public.pta_ibkr_account_summary TO service_role;
