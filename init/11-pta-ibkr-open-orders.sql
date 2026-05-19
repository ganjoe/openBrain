-- Open Brain Local: PTA IBKR Open Orders
-- Stores active unexecuted orders from IBKR

SET search_path = public, extensions;

DROP TABLE IF EXISTS public.pta_ibkr_open_orders;

CREATE TABLE IF NOT EXISTS pta_ibkr_open_orders (
  id              BIGSERIAL PRIMARY KEY,
  account         TEXT NOT NULL,
  perm_id         BIGINT NOT NULL,
  order_id        INTEGER NOT NULL,
  ticker          TEXT NOT NULL,
  action          TEXT NOT NULL,
  quantity        NUMERIC NOT NULL,
  order_type      TEXT NOT NULL,
  limit_price     NUMERIC,
  stop_price      NUMERIC,
  status          TEXT NOT NULL,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_account_perm UNIQUE (account, perm_id)
);

-- Grant privileges so PostgREST and agent services can read/write
GRANT ALL ON TABLE public.pta_ibkr_open_orders TO anon;
GRANT ALL ON TABLE public.pta_ibkr_open_orders TO service_role;
GRANT ALL ON SEQUENCE pta_ibkr_open_orders_id_seq TO anon;
GRANT ALL ON SEQUENCE pta_ibkr_open_orders_id_seq TO service_role;
