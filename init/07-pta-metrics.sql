-- Open Brain Local: PTA Metrics View
-- Calculates Portfolio Equity & Performance strictly from internal logs.

SET search_path = public, extensions;

-- View: Aggregates total cash deposits and withdrawals
CREATE OR REPLACE VIEW pta_cash_flow AS
SELECT 
    SUM(CASE WHEN action = 'DEPOSIT' THEN quantity ELSE 0 END) as total_deposits,
    SUM(CASE WHEN action = 'WITHDRAW' THEN quantity ELSE 0 END) as total_withdrawals,
    SUM(CASE WHEN action = 'DEPOSIT' THEN quantity WHEN action = 'WITHDRAW' THEN -quantity ELSE 0 END) as net_cash_injected
FROM pta_execution_log
WHERE event_type = 'CASH_TRANSFER';

-- View: Calculates realized PnL per trade (only for CLOSED trades)
-- A trade is closed when sum of buy quantity equals sum of sell quantity.
CREATE OR REPLACE VIEW pta_trade_performance AS
WITH fill_stats AS (
    SELECT 
        trade_id,
        ticker,
        SUM(CASE WHEN action = 'BUY' THEN quantity ELSE 0 END) as qty_bought,
        SUM(CASE WHEN action = 'SELL' THEN quantity ELSE 0 END) as qty_sold,
        SUM(CASE WHEN action = 'BUY' THEN (quantity * price) ELSE 0 END) as cost_basis,
        SUM(CASE WHEN action = 'SELL' THEN (quantity * price) ELSE 0 END) as revenue,
        SUM(commission) as total_commission,
        SUM(slippage) as total_slippage
    FROM pta_execution_log
    WHERE event_type = 'FILL'
    GROUP BY trade_id, ticker
)
SELECT 
    trade_id,
    ticker,
    qty_bought,
    qty_sold,
    cost_basis,
    revenue,
    total_commission,
    total_slippage,
    (revenue - cost_basis) as raw_pnl,
    (revenue - cost_basis - total_commission) as net_pnl,
    CASE WHEN qty_bought > 0 AND qty_bought = qty_sold THEN TRUE ELSE FALSE END as is_closed,
    CASE WHEN qty_bought > 0 AND qty_bought = qty_sold AND (revenue - cost_basis - total_commission) > 0 THEN TRUE ELSE FALSE END as is_winner
FROM fill_stats
WHERE qty_bought > 0;

-- View: Global Portfolio Summary
CREATE OR REPLACE VIEW pta_portfolio_summary AS
SELECT
    (SELECT COALESCE(net_cash_injected, 0) FROM pta_cash_flow) as cash_injected,
    COUNT(trade_id) as total_trades,
    SUM(CASE WHEN is_closed THEN 1 ELSE 0 END) as closed_trades,
    SUM(CASE WHEN is_closed AND is_winner THEN 1 ELSE 0 END) as winning_trades,
    SUM(CASE WHEN is_closed THEN net_pnl ELSE 0 END) as total_realized_pnl,
    SUM(total_commission) as total_commissions_paid,
    -- Simple Equity calculation based on Realized PnL (ignoring Unrealized for now as we don't have live prices here)
    (SELECT COALESCE(net_cash_injected, 0) FROM pta_cash_flow) + SUM(CASE WHEN is_closed THEN net_pnl ELSE 0 END) as calculated_cash_balance
FROM pta_trade_performance;

GRANT SELECT ON public.pta_cash_flow TO anon;
GRANT SELECT ON public.pta_trade_performance TO anon;
GRANT SELECT ON public.pta_portfolio_summary TO anon;
