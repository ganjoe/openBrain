-- Open Brain Local: CDA Master Universe Schema
-- Holds the master list of tickers discovered/downloaded by the stock-data-node (agent-cda).
-- Contains flags (like has_parquet) and fundamental data (eps, capitalisation, etc.)

SET search_path = public, extensions;

-- ─────────────────────────────────────────────────────────────
-- TABLE: cda_master_universe
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cda_master_universe (
    ticker             TEXT PRIMARY KEY,
    utime              TIMESTAMPTZ DEFAULT NOW(),
    currency           TEXT,
    shares_outstanding NUMERIC,
    eps                NUMERIC,
    revenue            NUMERIC,
    earnings           TIMESTAMPTZ,
    next_earnings      TIMESTAMPTZ,
    next_earnings_source TEXT,
    has_parquet        BOOLEAN DEFAULT TRUE,
    last_updated       TIMESTAMPTZ DEFAULT NOW(),
    created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- Index for quickly finding active tickers
CREATE INDEX IF NOT EXISTS idx_cda_universe_has_parquet ON cda_master_universe (has_parquet);

-- Auto-update last_updated on row change
CREATE OR REPLACE FUNCTION cda_master_universe_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.last_updated = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cda_master_universe_updated_at ON cda_master_universe;
CREATE TRIGGER trg_cda_master_universe_updated_at
    BEFORE UPDATE ON cda_master_universe
    FOR EACH ROW EXECUTE FUNCTION cda_master_universe_set_updated_at();

-- ─────────────────────────────────────────────────────────────
-- TABLE: cda_earnings_history (siehe QJM/migrations/036_earnings_calendar.sql)
-- VERGANGENE Earnings-Termine je Ticker (1 Zeile je Ticker + Termin).
-- Die Zukunft steht in cda_master_universe.next_earnings, der letzte Termin in .earnings.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cda_earnings_history (
    id                 BIGSERIAL PRIMARY KEY,
    ticker             TEXT NOT NULL REFERENCES cda_master_universe(ticker) ON DELETE CASCADE,
    report_date        TIMESTAMPTZ NOT NULL,
    fiscal_quarter_end DATE,
    fiscal_year        INTEGER,
    fiscal_quarter     SMALLINT,
    eps_actual         NUMERIC,
    eps_estimate       NUMERIC,
    eps_surprise_pct   NUMERIC,
    revenue_actual     NUMERIC,
    revenue_estimate   NUMERIC,
    source             TEXT NOT NULL DEFAULT 'nasdaq',
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    last_updated       TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT cda_earnings_history_ticker_report_date_key UNIQUE (ticker, report_date),
    CONSTRAINT cda_earnings_history_fiscal_quarter_check
        CHECK (fiscal_quarter IS NULL OR fiscal_quarter BETWEEN 1 AND 4)
);

CREATE INDEX IF NOT EXISTS cda_earnings_history_ticker_date_idx
    ON cda_earnings_history (ticker, report_date DESC);
CREATE INDEX IF NOT EXISTS cda_earnings_history_report_date_idx
    ON cda_earnings_history (report_date DESC);

CREATE OR REPLACE FUNCTION cda_earnings_history_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.last_updated = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cda_earnings_history_updated_at ON cda_earnings_history;
CREATE TRIGGER trg_cda_earnings_history_updated_at
    BEFORE UPDATE ON cda_earnings_history
    FOR EACH ROW EXECUTE FUNCTION cda_earnings_history_set_updated_at();

-- ─────────────────────────────────────────────────────────────
-- GRANTS
-- ─────────────────────────────────────────────────────────────
GRANT ALL ON TABLE public.cda_master_universe TO anon, service_role;
GRANT EXECUTE ON FUNCTION cda_master_universe_set_updated_at TO anon, service_role;

GRANT ALL ON TABLE public.cda_earnings_history TO anon, service_role;
GRANT ALL ON SEQUENCE public.cda_earnings_history_id_seq TO anon, service_role;
GRANT EXECUTE ON FUNCTION cda_earnings_history_set_updated_at TO anon, service_role;
