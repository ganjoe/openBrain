-- Open Brain Local: PTA IBKR Live Positions
-- Stores the live positions fetched from Interactive Brokers (IBKR)

SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS pta_ibkr_positions (
  id              BIGSERIAL PRIMARY KEY,
  account         TEXT NOT NULL,
  ticker          TEXT NOT NULL,
  quantity        NUMERIC NOT NULL,
  avg_cost        NUMERIC NOT NULL,
  market_price    NUMERIC,
  market_value    NUMERIC,
  unrealized_pnl  NUMERIC,
  realized_pnl    NUMERIC,
  position_pct    NUMERIC,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_account_ticker UNIQUE (account, ticker)
);

-- Grant privileges so PostgREST and agent services can read/write
GRANT ALL ON TABLE public.pta_ibkr_positions TO anon;
GRANT ALL ON TABLE public.pta_ibkr_positions TO service_role;
GRANT ALL ON SEQUENCE pta_ibkr_positions_id_seq TO anon;
GRANT ALL ON SEQUENCE pta_ibkr_positions_id_seq TO service_role;
