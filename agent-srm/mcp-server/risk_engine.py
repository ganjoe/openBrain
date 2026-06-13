from typing import List, Dict, Any

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
        
    def recalculate_totals(self):
        """
        Recalculates current heat, crisk, and asset value based on active trades.
        """
        total_heat_eur = 0.0
        total_crisk_eur = 0.0
        for t in self.active_trades:
            # Heat is dynamic risk: (current_price - sl) * nos
            heat = (t.current_price - t.sl) * t.nos
            total_heat_eur += heat
            total_crisk_eur += t.crisk_eur

        self.current_heat_pct = (total_heat_eur / self.nav) * 100 if self.nav > 0 else 0.0
        self.current_crisk_pct = (total_crisk_eur / self.nav) * 100 if self.nav > 0 else 0.0

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
        self.commission = float(data.get("commission", 0.0))
        self.days = int(data.get("days", 0))
        self.nos = int(data.get("nos") or 0)
        self.status = data.get("status", "planned")
        
        # Risk per share
        self.r_per_share = max(0.0001, self.price - self.sl)
        self.sl_distance_pct = (self.r_per_share / self.price) * 100
        
        self.tp = data.get("tp")
        self.target_r = data.get("target_r")
        
        if self.tp is not None:
            self.tp = float(self.tp)
            self.target_r = (self.tp - self.price) / self.r_per_share
        elif self.target_r is not None:
            self.target_r = float(self.target_r)
            self.tp = self.price + (self.target_r * self.r_per_share)
        else:
            raise ValueError("Either tp (Take Profit) or target_r (Target R) must be provided.")
            
        self.crisk_eur = float(data.get("crisk_eur") or (self.nos * self.r_per_share))
        
        # For live updates
        self.current_price = self.price
        self.current_r_multiple = 0.0
        self.current_pnl = 0.0

    def update_current_price(self, new_price: float):
        """
        Update the current market price and recalculate live metrics.
        """
        self.current_price = new_price
        if self.r_per_share > 0:
            self.current_r_multiple = (self.current_price - self.price) / self.r_per_share
        self.current_pnl = self.nos * (self.current_price - self.price)

    def validate(self, portfolio: PortfolioObject, requested_nos: int = None):
        """
        Validate this trade against the portfolio limits.
        If requested_nos is None, calculates the max allowed shares (discovery).
        Returns a dictionary suitable for JSON serialization.
        """
        # Block if Target R is too low
        if self.target_r < portfolio.min_r:
            return {"error": f"Trade rejected: Target R ({round(self.target_r, 2)}R) is below the required minimum of {portfolio.min_r}R."}
            
        # Limit 1a: Position Core Risk
        allowed_pos_crisk_eur = portfolio.get_max_crisk_pos_eur()
        nos_pos_crisk = int(allowed_pos_crisk_eur / self.r_per_share)
        
        # Limit 1b: Total Portfolio Core Risk
        allowed_total_crisk_eur = portfolio.get_available_crisk_eur()
        nos_total_crisk = int(allowed_total_crisk_eur / self.r_per_share)
        
        # Limit 2: Portfolio Heat
        allowed_heat_eur = portfolio.get_available_heat_eur()
        nos_heat = int(allowed_heat_eur / self.r_per_share)
        
        # Limit 3: Cash (Accounting for commission)
        if portfolio.cash > self.commission:
            nos_cash = int((portfolio.cash - self.commission) / self.price)
        else:
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
            "Position Core Risk Limit": nos_pos_crisk,
            "Portfolio Core Risk Limit": nos_total_crisk,
            "Portfolio Heat Limit": nos_heat,
            "Cash Limit": nos_cash,
            "Max Positions Limit": "Reached" if nos_max_positions == 0 else "OK"
        }
        
        # Is this a discovery?
        is_discovery = (requested_nos is None)
        actual_nos = min(requested_nos if not is_discovery else max_nos, max_nos)
        
        if actual_nos <= 0:
            if is_discovery:
                return {
                    "status": "discovery_success",
                    "ticker": self.ticker,
                    "price": self.price,
                    "stop_loss": self.sl,
                    "commission": self.commission,
                    "max_allowed_shares": 0,
                    "limiting_factors": limits,
                    "message": "Discovery complete. Limit reached. Cannot buy shares."
                }
            return {"error": f"Cannot buy shares. Requested: {requested_nos}, Allowed: {max_nos}. Check limits."}
            
        trade_cost = (actual_nos * self.price) + self.commission
        cash_after = portfolio.cash - trade_cost
        cash_pct_before = (portfolio.cash / portfolio.nav) * 100 if portfolio.nav > 0 else 0
        cash_pct_after = (cash_after / portfolio.nav) * 100 if portfolio.nav > 0 else 0
        
        crisk_eur = actual_nos * self.r_per_share
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
            "status": "discovery_success" if is_discovery else "impact_simulation_success",
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
        
        if not is_discovery:
            res["requested_nos"] = requested_nos
            
        return res
