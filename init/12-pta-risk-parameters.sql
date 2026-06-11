-- 12-pta-risk-parameters.sql
-- Schema for PTA Risk Parameters (Base currency EUR, percentages normalized 0-100)

CREATE TABLE IF NOT EXISTS public.pta_risk_parameters (
    id SERIAL PRIMARY KEY,
    base_risk_pct NUMERIC(5,2) NOT NULL DEFAULT 1.00,
    max_position_size_pct NUMERIC(5,2) NOT NULL DEFAULT 25.00,
    max_total_positions INTEGER NOT NULL DEFAULT 10,
    base_cash_quote_pct NUMERIC(5,2) NOT NULL DEFAULT 10.00,
    allow_margin BOOLEAN NOT NULL DEFAULT false,
    max_margin_pct NUMERIC(5,2) NOT NULL DEFAULT 100.00,
    max_core_risk_pct NUMERIC(5,2) NOT NULL DEFAULT 6.00,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Insert default single record
INSERT INTO public.pta_risk_parameters (id, base_risk_pct, max_position_size_pct, max_total_positions, base_cash_quote_pct, allow_margin, max_margin_pct, max_core_risk_pct)
VALUES (1, 1.00, 25.00, 10, 10.00, true, 120.00, 6.00)
ON CONFLICT (id) DO UPDATE SET
    base_risk_pct = EXCLUDED.base_risk_pct,
    max_position_size_pct = EXCLUDED.max_position_size_pct,
    max_total_positions = EXCLUDED.max_total_positions,
    base_cash_quote_pct = EXCLUDED.base_cash_quote_pct,
    allow_margin = EXCLUDED.allow_margin,
    max_margin_pct = EXCLUDED.max_margin_pct,
    max_core_risk_pct = EXCLUDED.max_core_risk_pct;
