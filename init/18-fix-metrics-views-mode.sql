-- 18-fix-metrics-views-mode.sql
-- Rebuilds pta_trade_performance and pta_trade_history to include the 'mode' column.
-- This allows mode-filtered portfolio analytics (paper vs live).

DROP VIEW IF EXISTS pta_trade_history CASCADE;
DROP VIEW IF EXISTS pta_trade_performance CASCADE;

CREATE VIEW pta_trade_performance AS
WITH fill_stats AS (
    SELECT 
        trade_id,
        ticker,
        currency,
        mode,    -- propagate mode from execution_log
        SUM(CASE WHEN action = 'BUY' THEN quantity ELSE 0 END) as qty_bought,
        SUM(CASE WHEN action = 'SELL' THEN quantity ELSE 0 END) as qty_sold,
        SUM(CASE WHEN action = 'BUY' THEN (quantity * price) ELSE 0 END) as cost_basis,
        SUM(CASE WHEN action = 'SELL' THEN (quantity * price) ELSE 0 END) as revenue,
        SUM(commission) as total_commission,
        SUM(slippage) as total_slippage,
        MAX(created_at) as close_time,
        MIN(created_at) as open_time
    FROM pta_execution_log
    WHERE event_type = 'FILL'
    GROUP BY trade_id, ticker, currency, mode    -- mode in GROUP BY
),
trade_risks AS (
    SELECT 
        trade_id,
        stop_price as initial_stop_loss
    FROM (
        SELECT 
            trade_id,
            stop_price,
            ROW_NUMBER() OVER(PARTITION BY trade_id ORDER BY created_at ASC) as rn
        FROM pta_execution_log
        WHERE event_type = 'ORDER_SUBMITTED' AND stop_price IS NOT NULL
    ) sub
    WHERE rn = 1
),
currency_converted AS (
    SELECT 
        f.*,
        r.initial_stop_loss,
        COALESCE(
            f.qty_bought * ((f.cost_basis / NULLIF(f.qty_bought, 0)) - r.initial_stop_loss), 
            f.cost_basis
        ) as initial_risk,
        (
            SELECT rate FROM exchange_rates er 
            WHERE er.target_currency = f.currency 
              AND er.base_currency = 'EUR'
              AND er.date <= DATE(f.close_time)
            ORDER BY er.date DESC 
            LIMIT 1
        ) as exchange_rate_to_eur
    FROM fill_stats f
    LEFT JOIN trade_risks r ON f.trade_id = r.trade_id
)
SELECT 
    trade_id,
    ticker,
    currency,
    mode,    -- exposed in final SELECT
    qty_bought,
    qty_sold,
    cost_basis,
    revenue,
    total_commission,
    total_slippage,
    close_time,
    open_time,
    EXTRACT(EPOCH FROM (close_time - open_time)) / 86400.0 as days_out,
    (revenue - cost_basis) as raw_pnl,
    (revenue - cost_basis - total_commission) as net_pnl,
    (revenue - cost_basis - total_commission) / COALESCE(exchange_rate_to_eur, 1.0) as net_pnl_eur,
    initial_risk,
    CASE 
        WHEN initial_risk > 0 THEN (revenue - cost_basis - total_commission) / initial_risk
        ELSE NULL 
    END as r_multiple,
    CASE WHEN qty_bought > 0 AND qty_bought = qty_sold THEN TRUE ELSE FALSE END as is_closed,
    CASE WHEN qty_bought > 0 AND qty_bought = qty_sold AND (revenue - cost_basis - total_commission) > 0 THEN TRUE ELSE FALSE END as is_winner
FROM currency_converted
WHERE qty_bought > 0;


CREATE VIEW pta_trade_history AS
WITH closed_trades AS (
    SELECT *
    FROM pta_trade_performance
    WHERE is_closed = TRUE
),
ordered_trades AS (
    SELECT 
        *,
        ROW_NUMBER() OVER (PARTITION BY mode ORDER BY close_time ASC) as trade_index,
        SUM(net_pnl_eur) OVER (PARTITION BY mode ORDER BY close_time ASC) as running_net_pnl_eur
    FROM closed_trades
)
SELECT 
    *,
    SUM(net_pnl) OVER w as running_realized_pnl,
    SUM(total_commission) OVER w as running_commissions_paid,
    SUM(CASE WHEN is_winner THEN 1 ELSE 0 END) OVER w as running_wins,
    SUM(CASE WHEN NOT is_winner THEN 1 ELSE 0 END) OVER w as running_losses,
    (SUM(CASE WHEN is_winner THEN 1.0 ELSE 0.0 END) OVER w / trade_index) * 100 as running_winrate,
    SUM(CASE WHEN is_winner THEN net_pnl_eur ELSE 0 END) OVER w as running_gross_profit_eur,
    SUM(CASE WHEN NOT is_winner THEN ABS(net_pnl_eur) ELSE 0 END) OVER w as running_gross_loss_eur,
    CASE 
        WHEN SUM(CASE WHEN NOT is_winner THEN ABS(net_pnl_eur) ELSE 0 END) OVER w = 0 
        THEN NULL 
        ELSE SUM(CASE WHEN is_winner THEN net_pnl_eur ELSE 0 END) OVER w / SUM(CASE WHEN NOT is_winner THEN ABS(net_pnl_eur) ELSE 0 END) OVER w 
    END as running_profit_factor,
    CASE 
        WHEN SUM(CASE WHEN is_winner THEN 1 ELSE 0 END) OVER w = 0 
        THEN 0 
        ELSE SUM(CASE WHEN is_winner THEN net_pnl_eur ELSE 0 END) OVER w / SUM(CASE WHEN is_winner THEN 1 ELSE 0 END) OVER w 
    END as running_avg_win_eur,
    CASE 
        WHEN SUM(CASE WHEN NOT is_winner THEN 1 ELSE 0 END) OVER w = 0 
        THEN 0 
        ELSE SUM(CASE WHEN NOT is_winner THEN ABS(net_pnl_eur) ELSE 0 END) OVER w / SUM(CASE WHEN NOT is_winner THEN 1 ELSE 0 END) OVER w 
    END as running_avg_loss_eur,
    MAX(running_net_pnl_eur) OVER w as peak_net_pnl_eur,
    running_net_pnl_eur - MAX(running_net_pnl_eur) OVER w as current_drawdown_eur
FROM ordered_trades
WINDOW w AS (PARTITION BY mode ORDER BY trade_index ASC);

GRANT SELECT ON public.pta_trade_performance TO anon, service_role;
GRANT SELECT ON public.pta_trade_history TO anon, service_role;
