-- SRM Database Schema
-- Defines the base tables for risk management: srm_portfolio and srm_trades

-- 1. Create Portfolio Table
CREATE TABLE IF NOT EXISTS srm_portfolio (
    portfolio_id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    currency TEXT,
    start_capital NUMERIC,
    
    -- Dynamische Basis-Werte
    nav NUMERIC,
    assets NUMERIC,
    cash NUMERIC,
    cash_pct NUMERIC,
    
    -- Dynamische Performance
    pnl NUMERIC,
    pnl_pct NUMERIC,
    
    -- Dynamisches Risiko (aggregiert)
    crisk_eur NUMERIC,
    crisk_pct NUMERIC,
    heat_eur NUMERIC,
    heat_pct NUMERIC,
    
    -- Fixe Risikoparameter (Limits)
    max_crisk_pct NUMERIC,
    max_heat_pct NUMERIC,
    
    -- Zeitstempel
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Drop the existing srm_trades table if it exists (since we're rebuilding it cleanly)
DROP TABLE IF EXISTS srm_trades;

-- 3. Create Trades Table with Foreign Key
CREATE TABLE srm_trades (
    trade_id SERIAL PRIMARY KEY,
    portfolio_id INTEGER REFERENCES srm_portfolio(portfolio_id) ON DELETE CASCADE,
    planned TIMESTAMPTZ,
    open TIMESTAMPTZ,
    closed TIMESTAMPTZ,
    ticker TEXT NOT NULL,
    cbase NUMERIC,
    nos NUMERIC,
    sl NUMERIC,
    rmultiple NUMERIC,
    rmultiple_pct NUMERIC,
    name TEXT,
    currency TEXT,
    crisk_eur NUMERIC,
    crisk_pct NUMERIC,
    heat_eur NUMERIC,
    heat_pct NUMERIC,
    pnl NUMERIC,
    commission NUMERIC
);

-- Permissions
GRANT ALL ON srm_portfolio TO anon, service_role;
GRANT ALL ON srm_portfolio_portfolio_id_seq TO anon, service_role;
GRANT ALL ON srm_trades TO anon, service_role;
GRANT ALL ON srm_trades_trade_id_seq TO anon, service_role;
