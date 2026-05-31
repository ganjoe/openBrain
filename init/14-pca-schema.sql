-- Open Brain Local: PCA (Chart & View Manager) Schema
-- Two tables: pca_watchlists (named ticker lists) and pca_layouts (JSONB layout configs).
-- The layout config is intentionally schema-free (JSONB) so it can grow organically.

SET search_path = public, extensions;

-- ─────────────────────────────────────────────────────────────
-- TABLE: pca_watchlists
-- ─────────────────────────────────────────────────────────────
-- Stores named ticker lists. A ticker can exist in multiple lists.
-- The `position` column defines display order within a list.
CREATE TABLE IF NOT EXISTS pca_watchlists (
    id          BIGSERIAL PRIMARY KEY,
    list_name   TEXT NOT NULL,          -- e.g. 'growth_stocks', 'minervini_universe'
    ticker      TEXT NOT NULL,
    position    INT  DEFAULT 0,         -- order within the list (0-indexed)
    added_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (list_name, ticker)          -- no duplicates per list
);

CREATE INDEX IF NOT EXISTS idx_pca_wl_list_name ON pca_watchlists (list_name);
CREATE INDEX IF NOT EXISTS idx_pca_wl_ticker    ON pca_watchlists (ticker);


-- ─────────────────────────────────────────────────────────────
-- TABLE: pca_layouts
-- ─────────────────────────────────────────────────────────────
-- Stores named layout configurations as JSONB.
-- The config structure is intentionally open-ended and grows with requirements.
-- Key top-level fields: watchlist (string), grid ({cols, rows}), views (array).
-- Each view has: view_id, type, label, grid_pos, timeframe, bar_count, indicators, volume.
CREATE TABLE IF NOT EXISTS pca_layouts (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT UNIQUE NOT NULL,  -- e.g. 'desktop', 'mobile', 'focus'
    description  TEXT,
    config       JSONB NOT NULL,        -- full layout definition, grows over time
    is_default   BOOLEAN DEFAULT FALSE,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pca_layouts_name       ON pca_layouts (name);
CREATE INDEX IF NOT EXISTS idx_pca_layouts_is_default ON pca_layouts (is_default);

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION pca_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pca_layouts_updated_at ON pca_layouts;
CREATE TRIGGER trg_pca_layouts_updated_at
    BEFORE UPDATE ON pca_layouts
    FOR EACH ROW EXECUTE FUNCTION pca_set_updated_at();


-- ─────────────────────────────────────────────────────────────
-- GRANTS
-- ─────────────────────────────────────────────────────────────
GRANT ALL ON TABLE public.pca_watchlists TO anon, service_role;
GRANT ALL ON SEQUENCE pca_watchlists_id_seq TO anon, service_role;

GRANT ALL ON TABLE public.pca_layouts TO anon, service_role;
GRANT ALL ON SEQUENCE pca_layouts_id_seq TO anon, service_role;

GRANT EXECUTE ON FUNCTION pca_set_updated_at TO anon, service_role;


-- ═════════════════════════════════════════════════════════════
-- STARTER DATA
-- ═════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- Watchlist: growth_stocks
-- Minervini-style growth candidates with strong RS.
-- All tickers expected to have full parquet data in stock-data-node.
-- ─────────────────────────────────────────────────────────────
INSERT INTO pca_watchlists (list_name, ticker, position) VALUES
    ('growth_stocks', 'NVDA',  0),
    ('growth_stocks', 'AXON',  1),
    ('growth_stocks', 'CRWD',  2),
    ('growth_stocks', 'APP',   3),
    ('growth_stocks', 'CELH',  4),
    ('growth_stocks', 'VIST',  5),
    ('growth_stocks', 'PLTR',  6),
    ('growth_stocks', 'GEV',   7),
    ('trading_stats', '$STATS.PNL', 0),
    ('trading_stats', '$STATS.RMULTIPLE', 1),
    ('trading_stats', '$STATS.DRAWDOWN', 2),
    ('trading_stats', '$STATS.WINRATE', 3),
    ('trading_stats', '$STATS.PROFIT_FACTOR', 4),
    ('trading_stats', '$STATS.WINRATE_PF', 5),
    ('trading_stats', '$STATS.CASH_QUOTE', 6)
ON CONFLICT (list_name, ticker) DO NOTHING;


-- ─────────────────────────────────────────────────────────────
-- Layout: desktop
-- 4-window 2x2 grid. Default test layout.
--
-- v1 (top-left):    Candlestick + Volume pane + SMA 50/150/200
-- v2 (top-right):   OHLC Barchart + SMA 50
-- v3 (bottom-left): Watchlist table (Ticker, Close, RS, M-Score)
-- v4 (bottom-right): Stats panel (key metrics for focused ticker)
--
-- Indicator column names map directly to _features.parquet columns
-- produced by stock-data-features (ma_sma_50, ibd_rs, minervini_score, etc.)
-- ─────────────────────────────────────────────────────────────
INSERT INTO pca_layouts (name, description, is_default, config) VALUES (
    'desktop',
    '4-Fenster Test-Layout: Candlestick+Volumen, Barchart, Watchlist-Tabelle, Stats-Panel',
    TRUE,
    '{
        "watchlist": "growth_stocks",
        "grid": { "cols": 2, "rows": 2 },
        "views": [
            {
                "view_id": "v1",
                "type": "candle_volume",
                "label": "Candlestick + Volumen",
                "grid_pos": { "col": 0, "row": 0 },
                "timeframe": "1D",
                "bar_count": 2000,
                "indicators": [
                    {
                        "type": "sma",
                        "column": "ma_sma_50",
                        "color": "#f59e0b",
                        "label": "SMA 50",
                        "width": 1.5
                    },
                    {
                        "type": "sma",
                        "column": "ma_sma_150",
                        "color": "#6366f1",
                        "label": "SMA 150",
                        "width": 1.5
                    },
                    {
                        "type": "sma",
                        "column": "ma_sma_200",
                        "color": "#ef4444",
                        "label": "SMA 200",
                        "width": 2.0
                    }
                ],
                "volume": {
                    "enabled": true,
                    "pane_ratio": 0.22,
                    "color_up": "#22c55e",
                    "color_down": "#ef4444"
                }
            },
            {
                "view_id": "v2",
                "type": "bar_chart",
                "label": "OHLC Barchart",
                "grid_pos": { "col": 1, "row": 0 },
                "timeframe": "1D",
                "bar_count": 2000,
                "indicators": [
                    {
                        "type": "sma",
                        "column": "ma_sma_50",
                        "color": "#f59e0b",
                        "label": "SMA 50",
                        "width": 1.5
                    }
                ],
                "volume": { "enabled": false }
            },
            {
                "view_id": "v3",
                "type": "watchlist_table",
                "label": "Watchlist",
                "grid_pos": { "col": 0, "row": 1 },
                "columns": [
                    { "key": "ticker",                   "label": "Ticker" },
                    { "key": "close",                    "label": "Close" },
                    { "key": "ibd_rs",                   "label": "RS" },
                    { "key": "minervini_score",           "label": "Score" },
                    { "key": "minervini_trend_template",  "label": "✓" }
                ]
            },
            {
                "view_id": "v4",
                "type": "stats_panel",
                "label": "Ticker-Info",
                "grid_pos": { "col": 1, "row": 1 },
                "fields": [
                    "close",
                    "ma_sma_50",
                    "ma_sma_150",
                    "ma_sma_200",
                    "ibd_rs",
                    "minervini_score",
                    "minervini_trend_template"
                ]
            }
        ]
    }'::jsonb
) ON CONFLICT (name) DO UPDATE
    SET config     = EXCLUDED.config,
        description = EXCLUDED.description,
        is_default  = EXCLUDED.is_default,
        updated_at  = NOW();

-- ─────────────────────────────────────────────────────────────
-- Layout: trading_journal
-- Trading Stats Layout (PnL, R-Multiple)
-- ─────────────────────────────────────────────────────────────
INSERT INTO pca_layouts (name, description, is_default, config) VALUES (
    'trading_journal',
    'Trading Stats Layout mit PnL und R-Multiple',
    FALSE,
    '{
        "watchlist": "trading_stats",
        "grid": { "cols": 2, "rows": 2 },
        "views": [
            {
                "view_id": "v1",
                "type": "line",
                "label": "Cumulative PnL",
                "grid_pos": { "col": 0, "row": 0 },
                "timeframe": "1D",
                "bar_count": 2000,
                "symbol": "$STATS.PNL",
                "indicators": [],
                "volume": { "enabled": true }
            },
            {
                "view_id": "v2",
                "type": "line",
                "label": "Winrate & Profit Factor",
                "grid_pos": { "col": 1, "row": 0 },
                "timeframe": "1D",
                "bar_count": 2000,
                "symbol": "$STATS.WINRATE_PF",
                "indicators": [],
                "volume": { "enabled": true }
            },
            {
                "view_id": "v3",
                "type": "line",
                "label": "Cash Quote & Active Positions",
                "grid_pos": { "col": 0, "row": 1 },
                "timeframe": "1D",
                "bar_count": 2000,
                "symbol": "$STATS.CASH_QUOTE",
                "indicators": [],
                "volume": { "enabled": true }
            },
            {
                "view_id": "v4",
                "type": "watchlist_table",
                "label": "Available Stats",
                "grid_pos": { "col": 1, "row": 1 },
                "columns": [
                    { "key": "ticker", "label": "Statistic" },
                    { "key": "close",  "label": "Value" }
                ]
            }
        ]
    }'::jsonb
) ON CONFLICT (name) DO UPDATE
    SET config     = EXCLUDED.config,
        description = EXCLUDED.description,
        is_default  = EXCLUDED.is_default,
        updated_at  = NOW();
-- ─────────────────────────────────────────────────────────────
-- Layout: qmaggi
-- 4-window 2x2 grid. Custom traders setup.
--
-- v1 (top-left):    Candlestick + Dollar-Volume pane + 6 SMAs (10, 20, 50, 100, 150, 200) + 50 SMA of Dollar Volume
-- v2 (top-right):   Candlestick + ADR (Daily Range) pane + RS rating overlay line + 20 SMA of ADR
-- v3 (bottom-left): Watchlist table
-- v4 (bottom-right): Stats panel
-- ─────────────────────────────────────────────────────────────
INSERT INTO pca_layouts (name, description, is_default, config) VALUES (
    'qmaggi',
    'QMaggi Layout: 6 SMAs & Dollar-Volumen, ADR-Säulen mit 20d SMA, RS Overlay, Watchlist, Stats',
    FALSE,
    '{
        "watchlist": "growth_stocks",
        "grid": { "cols": 2, "rows": 2 },
        "views": [
            {
                "view_id": "v1",
                "type": "candle_volume",
                "label": "Mainchart (SMAs + Dollar-Volumen)",
                "grid_pos": { "col": 0, "row": 0 },
                "timeframe": "1D",
                "bar_count": 2000,
                "indicators": [
                    {
                        "type": "sma",
                        "column": "ma_sma_10",
                        "color": "#ef4444",
                        "label": "SMA 10",
                        "width": 1.0
                    },
                    {
                        "type": "sma",
                        "column": "ma_sma_20",
                        "color": "#eab308",
                        "label": "SMA 20",
                        "width": 1.0
                    },
                    {
                        "type": "sma",
                        "column": "ma_sma_50",
                        "color": "#22c55e",
                        "label": "SMA 50",
                        "width": 1.5
                    },
                    {
                        "type": "sma",
                        "column": "ma_sma_100",
                        "color": "#06b6d4",
                        "label": "SMA 100",
                        "width": 1.5
                    },
                    {
                        "type": "sma",
                        "column": "ma_sma_150",
                        "color": "#3b82f6",
                        "label": "SMA 150",
                        "width": 1.5
                    },
                    {
                        "type": "sma",
                        "column": "ma_sma_200",
                        "color": "#a855f7",
                        "label": "SMA 200",
                        "width": 2.0
                    },
                    {
                        "type": "sma",
                        "column": "ma_sma_50_dollar_volume",
                        "color": "#eab308",
                        "label": "SMA 50 (Vol)",
                        "width": 1.5,
                        "pane": "volume"
                    }
                ],
                "volume": {
                    "enabled": true,
                    "column": "dollar_volume",
                    "pane_ratio": 0.22,
                    "color_up": "#22c55e",
                    "color_down": "#ef4444"
                }
            },
            {
                "view_id": "v2",
                "type": "candle_volume",
                "label": "Second Chart (ADR + RS Rating)",
                "grid_pos": { "col": 1, "row": 0 },
                "timeframe": "1D",
                "bar_count": 2000,
                "indicators": [
                    {
                        "type": "rs",
                        "column": "ibd_rs",
                        "color": "#06b6d4",
                        "label": "RS Rating",
                        "width": 2.0,
                        "scale": "normalized",
                        "scale_min": 0,
                        "scale_max": 100
                    },
                    {
                        "type": "sma",
                        "column": "adr_20",
                        "color": "#ef4444",
                        "label": "ADR (20)",
                        "width": 1.5,
                        "pane": "volume"
                    }
                ],
                "volume": {
                    "enabled": true,
                    "column": "daily_range",
                    "pane_ratio": 0.22,
                    "color_up": "#64748b",
                    "color_down": "#64748b"
                }
            },
            {
                "view_id": "v3",
                "type": "watchlist_table",
                "label": "Watchlist",
                "grid_pos": { "col": 0, "row": 1 },
                "columns": [
                    { "key": "ticker",                   "label": "Ticker" },
                    { "key": "close",                    "label": "Close" },
                    { "key": "ibd_rs",                   "label": "RS" },
                    { "key": "minervini_score",           "label": "Score" },
                    { "key": "minervini_trend_template",  "label": "✓" }
                ]
            },
            {
                "view_id": "v4",
                "type": "stats_panel",
                "label": "Ticker-Info",
                "grid_pos": { "col": 1, "row": 1 },
                "fields": [
                    "close",
                    "ma_sma_50",
                    "ma_sma_150",
                    "ma_sma_200",
                    "ibd_rs",
                    "minervini_score",
                    "minervini_trend_template"
                ]
            }
        ]
    }'::jsonb
) ON CONFLICT (name) DO UPDATE
    SET config     = EXCLUDED.config,
        description = EXCLUDED.description,
        is_default  = EXCLUDED.is_default,
        updated_at  = NOW();
