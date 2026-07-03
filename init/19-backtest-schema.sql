-- Backtest Engine Schema
-- Eigenständige Tabellen für Backtest-Konfigurationen, Simulationsläufe und Trade-Logs.
-- Komplett unabhängig von der SRM-Logik.

SET search_path = public, extensions;

-- ─────────────────────────────────────────────────────────────
-- TABLE: bt_configs
-- Parametersätze für Backtests. Jeder Backtest referenziert eine Config.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bt_configs (
    config_id        SERIAL PRIMARY KEY,
    name             TEXT NOT NULL UNIQUE,
    watchlist        TEXT NOT NULL,             -- pca_watchlists.list_name
    start_date       DATE NOT NULL,
    end_date         DATE NOT NULL,

    -- F-PARAM-090: Frei konfigurierbare Parameter
    ema_fast         INT NOT NULL DEFAULT 14,          -- F-IND-020: EMA Fast Periode
    ema_slow         INT NOT NULL DEFAULT 18,          -- F-IND-020: EMA Slow Periode
    trend_sma_period INT NOT NULL DEFAULT 10,          -- F-IND-030: SMA Periode auf Trend Strength
    trend_threshold  NUMERIC NOT NULL DEFAULT 0.0,     -- F-LOGIC-040: Statischer Schwellenwert
    setup_count_n    INT NOT NULL DEFAULT 4,           -- F-LOGIC-050: Anzahl aufeinanderfolgender Tage
    risk_pct         NUMERIC NOT NULL DEFAULT 0.01,    -- F-RISK-100: Risiko in Dezimal (0.01 = 1%)
    initial_capital  NUMERIC NOT NULL DEFAULT 10000,   -- Startkapital
    min_tick         NUMERIC NOT NULL DEFAULT 0.01,    -- F-RISK-110: Minimum Range Fallback

    created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- TABLE: bt_runs
-- Ergebnis-Header eines einzelnen Simulationslaufs.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bt_runs (
    run_id           SERIAL PRIMARY KEY,
    config_id        INT NOT NULL REFERENCES bt_configs(config_id) ON DELETE CASCADE,
    status           TEXT NOT NULL DEFAULT 'pending',   -- pending, running, completed, failed
    started_at       TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ,

    -- Aggregierte Ergebnisse
    total_trades     INT,
    winning_trades   INT,
    losing_trades    INT,
    win_rate         NUMERIC,
    total_pnl        NUMERIC,
    max_drawdown     NUMERIC,
    profit_factor    NUMERIC,
    avg_r_multiple   NUMERIC,
    final_capital    NUMERIC,

    -- Textuelle Zusammenfassung des gesamten Laufs
    report_text      TEXT,

    error_message    TEXT,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- TABLE: bt_trades
-- Einzelne Trades eines Simulationslaufs.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bt_trades (
    trade_id         SERIAL PRIMARY KEY,
    run_id           INT NOT NULL REFERENCES bt_runs(run_id) ON DELETE CASCADE,
    ticker           TEXT NOT NULL,
    entry_date       DATE NOT NULL,
    entry_price      NUMERIC NOT NULL,
    exit_date        DATE,
    exit_price       NUMERIC,
    position_size    INT,                -- Stückzahl
    risk_per_share   NUMERIC,            -- High - Low am Entry-Tag (oder min_tick)
    pnl              NUMERIC,
    r_multiple       NUMERIC,
    exit_reason      TEXT                 -- 'trailing_exit', 'end_of_period'
);

CREATE INDEX IF NOT EXISTS idx_bt_trades_run_id ON bt_trades (run_id);
CREATE INDEX IF NOT EXISTS idx_bt_trades_ticker ON bt_trades (ticker);
CREATE INDEX IF NOT EXISTS idx_bt_runs_config_id ON bt_runs (config_id);

-- ─────────────────────────────────────────────────────────────
-- GRANTS
-- ─────────────────────────────────────────────────────────────
GRANT ALL ON TABLE public.bt_configs TO anon, service_role;
GRANT ALL ON SEQUENCE bt_configs_config_id_seq TO anon, service_role;

GRANT ALL ON TABLE public.bt_runs TO anon, service_role;
GRANT ALL ON SEQUENCE bt_runs_run_id_seq TO anon, service_role;

GRANT ALL ON TABLE public.bt_trades TO anon, service_role;
GRANT ALL ON SEQUENCE bt_trades_trade_id_seq TO anon, service_role;
