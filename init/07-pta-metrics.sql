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
        currency,
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
    GROUP BY trade_id, ticker, currency
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
        -- Initial risk is Cost Basis if no stop loss (user explicit preference)
        COALESCE(
            f.qty_bought * ((f.cost_basis / NULLIF(f.qty_bought, 0)) - r.initial_stop_loss), 
            f.cost_basis
        ) as initial_risk,
        -- Find closest rate on or before close_time
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

-- View: Trade History with Running Metrics
CREATE OR REPLACE VIEW pta_trade_history AS
WITH closed_trades AS (
    SELECT *
    FROM pta_trade_performance
    WHERE is_closed = TRUE
),
ordered_trades AS (
    SELECT 
        *,
        ROW_NUMBER() OVER (ORDER BY close_time ASC) as trade_index,
        SUM(net_pnl_eur) OVER (ORDER BY close_time ASC) as running_net_pnl_eur
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
WINDOW w AS (ORDER BY trade_index ASC);

-- View: Global Portfolio Summary
CREATE OR REPLACE VIEW pta_portfolio_summary AS
SELECT
    (SELECT COALESCE(SUM(
        CASE WHEN action = 'DEPOSIT' THEN quantity 
             WHEN action = 'WITHDRAW' THEN -quantity 
             ELSE 0 END 
        / COALESCE((
            SELECT rate FROM exchange_rates er 
            WHERE er.target_currency = currency 
              AND er.base_currency = 'EUR'
              AND er.date <= DATE(created_at)
            ORDER BY er.date DESC 
            LIMIT 1
        ), 1.0)
    ), 0) FROM pta_execution_log WHERE event_type = 'CASH_TRANSFER') as cash_injected_eur,
    COUNT(trade_id) as total_trades,
    SUM(CASE WHEN is_closed THEN 1 ELSE 0 END) as closed_trades,
    SUM(CASE WHEN is_closed AND is_winner THEN 1 ELSE 0 END) as winning_trades,
    SUM(CASE WHEN is_closed THEN net_pnl_eur ELSE 0 END) as total_realized_pnl_eur,
    SUM(total_commission / COALESCE((SELECT rate FROM exchange_rates er WHERE er.target_currency = currency AND er.base_currency = 'EUR' AND er.date <= DATE(close_time) ORDER BY er.date DESC LIMIT 1), 1.0)) as total_commissions_paid_eur,
    AVG(CASE WHEN is_closed THEN days_out ELSE NULL END) as avg_days_out,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY CASE WHEN is_closed THEN days_out ELSE NULL END) as median_days_out,
    AVG(CASE WHEN is_closed AND is_winner THEN days_out ELSE NULL END) as avg_days_out_winners,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY CASE WHEN is_closed AND is_winner THEN days_out ELSE NULL END) as median_days_out_winners,
    AVG(CASE WHEN is_closed AND NOT is_winner THEN days_out ELSE NULL END) as avg_days_out_losers,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY CASE WHEN is_closed AND NOT is_winner THEN days_out ELSE NULL END) as median_days_out_losers,
    AVG(CASE WHEN is_closed THEN r_multiple ELSE NULL END) as avg_r_multiple,
    AVG(CASE WHEN is_closed AND is_winner THEN r_multiple ELSE NULL END) as avg_r_multiple_winners,
    AVG(CASE WHEN is_closed AND NOT is_winner THEN r_multiple ELSE NULL END) as avg_r_multiple_losers,
    (SELECT MIN(current_drawdown_eur) FROM pta_trade_history) as max_drawdown_eur,
    (SELECT COALESCE(SUM(CASE WHEN action = 'DEPOSIT' THEN quantity WHEN action = 'WITHDRAW' THEN -quantity ELSE 0 END / COALESCE((SELECT rate FROM exchange_rates er WHERE er.target_currency = currency AND er.base_currency = 'EUR' AND er.date <= DATE(created_at) ORDER BY er.date DESC LIMIT 1), 1.0)), 0) FROM pta_execution_log WHERE event_type = 'CASH_TRANSFER') + SUM(CASE WHEN is_closed THEN net_pnl_eur ELSE 0 END) as calculated_cash_balance_eur
FROM pta_trade_performance;

GRANT SELECT ON public.pta_cash_flow TO anon, service_role;
GRANT SELECT ON public.pta_trade_performance TO anon, service_role;
GRANT SELECT ON public.pta_portfolio_summary TO anon, service_role;
GRANT SELECT ON public.pta_trade_history TO anon, service_role;
