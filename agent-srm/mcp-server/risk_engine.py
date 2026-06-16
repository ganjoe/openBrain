from typing import List, Dict, Any
import pandas as pd
from datetime import datetime, timezone
class PortfolioObject:
    def __init__(self, data: Dict[str, Any]):
        """
        Initialize the portfolio state directly from a database dictionary.
        """
        self.portfolio_id = data.get("portfolio_id")
        nav_val = data.get("nav")
        self.nav = float(nav_val if nav_val is not None else 100000.0)
        cash_val = data.get("cash")
        self.cash = float(cash_val if cash_val is not None else 100000.0)
        
        # Helper for percentages
        def to_pct(val, default):
            v = float(val if val is not None else default)
            return v * 100.0 if (0 < v <= 1.0) else v

        self.max_crisk_pct = to_pct(data.get("max_crisk_pct"), 1.25)
        self.max_heat_pct = to_pct(data.get("max_heat_pct"), 15.0)
        self.current_heat_pct = float(data.get("heat_pct") or 0.0)
        self.current_crisk_pct = float(data.get("crisk_pct") or 0.0)
        
        self.min_r = float(data.get("min_r") or 3.0)
        self.max_positions = int(data.get("max_positions") or 10)
        self.max_days = float(data.get("max_days") or 30.0)
        self.max_crisk_pos_pct = to_pct(data.get("max_crisk_pos_pct"), 15.0)
        # Store raw DB value for 1R calculation (to_pct corrupts small values like 0.5%)
        self._raw_max_crisk_pos_pct = float(data.get("max_crisk_pos_pct") or 0.5)
        
        self.active_trades: List['TradeObject'] = []
        
    @property
    def current_positions(self) -> int:
        return len(self.active_trades)

    def get_available_heat_pct(self) -> float:
        return max(0.0, self.max_heat_pct - self.current_heat_pct)
        
    def get_available_heat_eur(self) -> float:
        return self.get_available_heat_pct() * self.nav / 100.0

    def get_max_crisk_pos_eur(self) -> float:
        return (self.max_crisk_pos_pct / 100.0) * self.nav

    def get_available_crisk_eur(self) -> float:
        available_pct = max(0.0, self.max_crisk_pct - self.current_crisk_pct)
        return (available_pct / 100.0) * self.nav
        
    def get_1r_eur(self) -> float:
        """Returns the absolute 1R risk in EUR for the portfolio (risk per position)."""
        return self.nav * (self.max_crisk_pos_pct / 100.0)

    def recalculate_totals(self, target_date=None):
        """
        Recalculates current heat, crisk, and asset value based on active trades.
        """
        total_heat_eur = 0.0
        total_crisk_eur = 0.0
        for t in self.active_trades:
            # Heat is dynamic risk
            if target_date is not None:
                active_sl = t.get_active_sl(target_date)
            else:
                active_sl = t.sl
                
            heat_eur = max(0.0, (t.current_price - active_sl) * t.nos)
            total_heat_eur += heat_eur
            total_crisk_eur += t.crisk_eur

        self.current_heat_pct = (total_heat_eur / self.nav * 100.0) if self.nav > 0 else 0.0
        self.current_crisk_pct = (total_crisk_eur / self.nav * 100.0) if self.nav > 0 else 0.0

    def deduct_cash(self, amount: float):
        self.cash -= amount
        
    def add_crisk_eur(self, amount: float):
        crisk_pct_increase = (amount / self.nav) * 100 if self.nav > 0 else 0.0
        self.current_crisk_pct += crisk_pct_increase
        
    def add_heat_eur(self, amount: float):
        heat_pct_increase = (amount / self.nav) * 100 if self.nav > 0 else 0.0
        self.current_heat_pct += heat_pct_increase

class TradeObject:
    def __init__(self, data: Dict[str, Any]):
        """
        Initialize a trade from a dictionary (could be from DB or user request).
        """
        self.trade_id = data.get("trade_id")
        self.ticker = data.get("ticker", "UNKNOWN")
        
        # Handle 'price' from user input or 'cbase' from DB
        self.price = float(data.get("price") or data.get("cbase") or 0.0)
        self.sl = float(data.get("sl", 0.0))
        self.sl_history = data.get("sl_history") or []
        self.commission = float(data.get("commission", 0.0))
        self.days = int(data.get("days", 0))
        self.nos = int(data.get("nos") or 0)
        self.status = data.get("status", "planned")
        
        # Initial Core Risk per share uses the INITIAL SL
        initial_sl = self.sl_history[0].get("sl", self.sl) if self.sl_history else self.sl
        self.risk_per_share = max(0.0001, self.price - initial_sl)
        self.sl_distance_pct = (self.risk_per_share / self.price) * 100 if self.price > 0 else 0.0
        
        self.tp = data.get("tp")
        self.target_r = data.get("target_r")
        
        # We store these as they are from the DB. 
        # For new trades, we calculate them properly during validate() when portfolio 1R and NOS are known.
        if self.tp is not None:
            self.tp = float(self.tp)
        if self.target_r is not None:
            self.target_r = float(self.target_r)
            
        self.crisk_eur = float(data.get("crisk_eur") or (self.nos * self.risk_per_share))
        
        # For live updates
        self.current_price = self.price
        self.current_r_multiple = float(data.get("rmultiple", 0.0))
        self.current_pnl = 0.0

    def get_active_sl(self, target_date) -> float:
        """
        Returns the active stop loss for the given target_date.
        target_date can be a string (ISO format) or a pandas Timestamp/datetime object.
        """
        if not self.sl_history:
            return self.sl
            
        # Convert target_date to string prefix for easy comparison (e.g. '2023-01-01')
        target_date_str = str(target_date)[:10]
        
        active_sl = self.sl_history[0].get("sl", self.sl)
        for entry in self.sl_history:
            entry_date_str = str(entry.get("date", "2000-01-01"))[:10]
            if entry_date_str <= target_date_str:
                active_sl = entry.get("sl", active_sl)
        return float(active_sl)

    def get_historical_1r_eur(self) -> float:
        """
        Recover the historical Portfolio 1R in EUR from the stored target_r and tp.
        This avoids needing a database migration.
        """
        if self.target_r and self.target_r > 0 and self.tp and self.tp > self.price and self.nos > 0:
            target_profit_eur = self.nos * (self.tp - self.price)
            return target_profit_eur / self.target_r
        # Fallback to current risk per share if we can't recover it (old trades or missing fields)
        return self.nos * self.risk_per_share if self.nos > 0 else 100.0

    def update_current_price(self, new_price: float, portfolio_1r_eur: float = None):
        """
        Update the current market price and recalculate live metrics.
        If portfolio_1r_eur is provided, calculates R-Multiple according to Van Tharp (Portfolio R).
        Otherwise attempts to use the historical 1R.
        """
        self.current_price = new_price
        self.current_pnl = self.nos * (self.current_price - self.price)
        
        active_1r_eur = portfolio_1r_eur if portfolio_1r_eur and portfolio_1r_eur > 0 else self.get_historical_1r_eur()
        
        if active_1r_eur > 0:
            self.current_r_multiple = self.current_pnl / active_1r_eur
        else:
            self.current_r_multiple = 0.0

    def validate(self, portfolio: PortfolioObject, requested_nos: int = None):
        """
        Validate this trade against the portfolio limits.
        If requested_nos is None, calculates the max allowed shares (discovery).
        Returns a dictionary suitable for JSON serialization.
        """
        # Limit 1a: Position Core Risk
        allowed_pos_crisk_eur = portfolio.get_max_crisk_pos_eur()
        nos_pos_crisk_raw = allowed_pos_crisk_eur / self.risk_per_share
        nos_pos_crisk = int(nos_pos_crisk_raw)
        
        # Limit 1b: Total Portfolio Core Risk
        allowed_total_crisk_eur = portfolio.get_available_crisk_eur()
        nos_total_crisk_raw = allowed_total_crisk_eur / self.risk_per_share
        nos_total_crisk = int(nos_total_crisk_raw)
        
        # Limit 2: Portfolio Heat
        allowed_heat_eur = portfolio.get_available_heat_eur()
        nos_heat_raw = allowed_heat_eur / self.risk_per_share
        nos_heat = int(nos_heat_raw)
        
        # Limit 3: Cash (Accounting for commission)
        if portfolio.cash > self.commission:
            nos_cash_raw = (portfolio.cash - self.commission) / self.price
            nos_cash = int(nos_cash_raw)
        else:
            nos_cash_raw = 0.0
            nos_cash = 0
            
        # Limit 4: Max positions
        if portfolio.current_positions >= portfolio.max_positions:
            nos_max_positions = 0
        else:
            nos_max_positions = float('inf')
            
        # Final max allowed shares
        max_nos = min(nos_pos_crisk, nos_total_crisk, nos_heat, nos_cash, nos_max_positions)
        if max_nos < 0: max_nos = 0
        
        # Determine limiting factor
        limits = {
            "Position Core Risk Limit": round(nos_pos_crisk_raw, 1),
            "Portfolio Core Risk Limit": round(nos_total_crisk_raw, 1),
            "Portfolio Heat Limit": round(nos_heat_raw, 1),
            "Cash Limit": round(nos_cash_raw, 1),
            "Max Positions Limit": "Reached" if nos_max_positions == 0 else "OK"
        }
        
        if requested_nos is not None:
            actual_nos = requested_nos
            if actual_nos > max_nos:
                # Find which limit was breached for better error messages
                limit_name = min(limits, key=lambda k: float('inf') if limits[k] == "OK" or limits[k] == "Reached" else limits[k])
                return {
                    "error": f"Requested shares ({actual_nos}) exceed maximum allowed ({max_nos}). Limiting factor: {limit_name}."
                }
            if actual_nos <= 0:
                return {
                    "error": "Requested shares must be > 0."
                }
        else:
            actual_nos = max_nos
            if actual_nos <= 0:
                # Find which limit caused the rejection
                limiting_reason = "Unknown Limit"
                if nos_cash <= 0:
                    limiting_reason = "Cash Limit (Insufficient Funds)"
                elif nos_pos_crisk <= 0:
                    limiting_reason = "Position Core Risk Limit"
                elif nos_total_crisk <= 0:
                    limiting_reason = "Portfolio Core Risk Limit"
                elif nos_heat <= 0:
                    limiting_reason = "Portfolio Heat Limit"
                elif nos_max_positions <= 0:
                    limiting_reason = "Max Positions Limit Reached"
                    
                return {
                    "error": "REJECTED_LIMIT_REACHED",
                    "message": f"Cannot buy shares. Calculated max allowed is {max_nos}. Limiting Factor: {limiting_reason}.",
                    "limits": limits
                }
            
        portfolio_1r = portfolio.get_1r_eur()
        if self.tp is not None:
            target_profit_eur = actual_nos * (self.tp - self.price)
            self.target_r = target_profit_eur / portfolio_1r
        elif self.target_r is not None:
            target_profit_eur = self.target_r * portfolio_1r
            self.tp = self.price + (target_profit_eur / actual_nos)
        else:
            return {"error": "Either tp (Take Profit) or target_r (Target R) must be provided."}
            
        if self.target_r < portfolio.min_r:
            return {"error": f"Trade rejected: Target R ({round(self.target_r, 2)}R) is below the required minimum of {portfolio.min_r}R."}

        trade_cost = (actual_nos * self.price) + self.commission
        cash_after = portfolio.cash - trade_cost
        cash_pct_before = (portfolio.cash / portfolio.nav) * 100 if portfolio.nav > 0 else 0
        cash_pct_after = (cash_after / portfolio.nav) * 100 if portfolio.nav > 0 else 0
        
        crisk_eur = actual_nos * self.risk_per_share
        crisk_pct = (crisk_eur / portfolio.nav) * 100 if portfolio.nav > 0 else 0
        
        trade_heat_eur = actual_nos * (self.current_price - self.sl)
        trade_heat_pct = (trade_heat_eur / portfolio.nav) * 100 if portfolio.nav > 0 else 0
        
        heat_pct_after = portfolio.current_heat_pct + trade_heat_pct
        
        impact_data = {
            "cash_before": round(portfolio.cash, 2),
            "cash_after": round(cash_after, 2),
            "cash_delta": round(cash_after - portfolio.cash, 2),
            
            "cash_pct_before": f"{round(cash_pct_before, 2)}%",
            "cash_pct_after": f"{round(cash_pct_after, 2)}%",
            "cash_pct_delta": f"{round(cash_pct_after - cash_pct_before, 2)}%",
            
            "heat_pct_before": f"{round(portfolio.current_heat_pct, 2)}%",
            "heat_pct_after": f"{round(heat_pct_after, 2)}%",
            "heat_pct_delta": f"+{round(trade_heat_pct, 2)}%",
            
            "trade_crisk_eur": round(crisk_eur, 2),
            "trade_crisk_pct": f"{round(crisk_pct, 2)}%",
            
            "trade_heat_eur": round(trade_heat_eur, 2),
            "trade_heat_pct": f"{round(trade_heat_pct, 2)}%"
        }
        
        res = {
            "status": "discovery_success" if requested_nos is None else "impact_simulation_success",
            "ticker": self.ticker,
            "price": self.price,
            "stop_loss": self.sl,
            "take_profit": round(self.tp, 2),
            "target_r": round(self.target_r, 2),
            "commission": self.commission,
            "days": self.days,
            "max_allowed_shares": max_nos,
            "limiting_factors": limits,
            "actual_nos": actual_nos,
            "trade_cost_eur": round(trade_cost, 2),
            "portfolio_impact": impact_data
        }
        
        if requested_nos is not None:
            res["requested_nos"] = requested_nos
            
        return res

class PortfolioRepository:
    @staticmethod
    def load_portfolio_and_trades(client, target_date: str = None) -> PortfolioObject:
        if not client:
            raise Exception("Database not connected.")
            
        res = client.table("srm_portfolio").select("*").limit(1).execute()
        if not res.data:
            raise Exception("No portfolio found in srm_portfolio table.")
            
        port_data = res.data[0]
        
        if port_data.get("portfolio_id") is not None:
            trades_res = client.table("srm_trades").select("*").eq("portfolio_id", port_data["portfolio_id"]).execute()
            all_trades = trades_res.data or []
        else:
            all_trades = []
            
        if target_date is None:
            target_date = datetime.now(timezone.utc).isoformat()
            
        t_date_pd = pd.to_datetime(target_date, utc=True)
        
        realized_capital = 0.0
        invested_capital = 0.0
        active_trades = []
        
        for t_data in all_trades:
            planned_str = t_data.get("planned")
            if not planned_str:
                planned = pd.to_datetime("2000-01-01", utc=True)
            else:
                planned = pd.to_datetime(planned_str, utc=True)
                
            if planned > t_date_pd:
                continue
                
            status = t_data.get("status")
            closed_date_str = t_data.get("closed")
            
            # Determine if trade was closed ON OR BEFORE the target date
            is_closed_then = False
            if status == "closed":
                if closed_date_str:
                    closed_date = pd.to_datetime(closed_date_str, utc=True)
                    if closed_date <= t_date_pd:
                        is_closed_then = True
                else:
                    is_closed_then = True
                    
            if is_closed_then:
                realized_capital += float(t_data.get("pnl") or 0.0)
            else:
                trade = TradeObject(t_data)
                active_trades.append(trade)
                invested_capital += float(t_data.get("cbase") or 0.0) * int(t_data.get("nos") or 0)
                
        cash = realized_capital - invested_capital
        port_data["nav"] = realized_capital # Base NAV
        port_data["cash"] = cash
        
        portfolio = PortfolioObject(port_data)
        portfolio.active_trades = active_trades
                        
        return portfolio

    @staticmethod
    def save_portfolio(client, portfolio: PortfolioObject):
        if not client or not portfolio.portfolio_id:
            return
            
        cash_pct = (portfolio.cash / portfolio.nav * 100) if portfolio.nav > 0 else 0.0
        
        client.table("srm_portfolio").update({
            "nav": portfolio.nav,
            "cash": portfolio.cash,
            "cash_pct": cash_pct,
            "heat_pct": portfolio.current_heat_pct,
            "heat_eur": (portfolio.current_heat_pct / 100.0) * portfolio.nav,
            "crisk_pct": portfolio.current_crisk_pct,
            "crisk_eur": (portfolio.current_crisk_pct / 100.0) * portfolio.nav
        }).eq("portfolio_id", portfolio.portfolio_id).execute()

