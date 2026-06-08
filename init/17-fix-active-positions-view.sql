-- 17-fix-active-positions-view.sql
-- Root cause fix for paper/live mode isolation.
-- pta_active_positions was a VIEW that ignored the 'mode' column from pta_execution_log.
-- This rebuilds the view to include mode in the aggregation and final SELECT,
-- so MCP tools can filter by mode without mixing paper and live trades.

CREATE OR REPLACE VIEW pta_active_positions AS
WITH fill_aggregation AS (
    SELECT 
        trade_id,
        ticker,
        currency,
        mode,    -- carry mode through from execution_log
        SUM(
            CASE 
                WHEN action IN ('BUY', 'DEPOSIT') THEN quantity 
                WHEN action IN ('SELL', 'WITHDRAW') THEN -quantity 
                ELSE 0 
            END
        ) as net_quantity,
        SUM(commission) as total_commission,
        SUM(slippage) as total_slippage,
        MIN(created_at) as open_time
    FROM pta_execution_log
    WHERE event_type = 'FILL'
    GROUP BY trade_id, ticker, currency, mode    -- mode in GROUP BY
),
latest_stops AS (
    -- Most recent stop price per trade+mode
    SELECT DISTINCT ON (trade_id, mode) 
        trade_id,
        mode,
        stop_price as current_stop_loss
    FROM pta_execution_log
    WHERE event_type = 'ORDER_SUBMITTED' AND stop_price IS NOT NULL
    ORDER BY trade_id, mode, created_at DESC
)
SELECT 
    f.trade_id,
    f.ticker,
    f.currency,
    f.mode,    -- exposed so MCP tools can filter with .eq("mode", activeMode)
    f.net_quantity,
    f.total_commission,
    f.total_slippage,
    f.open_time,
    s.current_stop_loss,
    CASE 
        WHEN f.net_quantity > 0 THEN 'LONG'
        WHEN f.net_quantity < 0 THEN 'SHORT'
        ELSE 'CLOSED'
    END as position_type
FROM fill_aggregation f
LEFT JOIN latest_stops s ON f.trade_id = s.trade_id AND f.mode = s.mode    -- mode in JOIN
WHERE f.net_quantity != 0;    -- only open positions

-- Grants
GRANT SELECT ON public.pta_active_positions TO anon, service_role;
