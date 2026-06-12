class Portfolio:
    def __init__(self, nav: float, cash: float, max_crisk_pct: float, max_heat_pct: float, current_heat_pct: float, min_r: float = 3.0, max_positions: int = 10, current_positions: int = 0, max_days: float = 30.0, max_crisk_pos_pct: float = 15.0):
        self.nav = nav
        self.cash = cash
        self.max_crisk_pct = max_crisk_pct
        self.max_heat_pct = max_heat_pct
        self.current_heat_pct = current_heat_pct
        self.min_r = min_r
        self.max_positions = max_positions
        self.current_positions = current_positions
        self.max_days = max_days
        self.max_crisk_pos_pct = max_crisk_pos_pct

    def get_available_heat_pct(self) -> float:
        return max(0.0, self.max_heat_pct - self.current_heat_pct)
        
    def get_available_heat_eur(self) -> float:
        return self.get_available_heat_pct() * self.nav / 100.0

    def get_max_crisk_eur(self) -> float:
        return (self.max_crisk_pct / 100.0) * self.nav

class TradeObject:
    def __init__(self, ticker: str, price: float, sl: float, tp: float = None, target_r: float = None, commission: float = 0.0):
        self.ticker = ticker
        self.price = price
        self.sl = sl
        self.commission = commission
        self.days = 0
        
        # Risk per share (absolute difference)
        self.r_per_share = max(0.0001, self.price - self.sl)
        self.crisk_pos_pct = (self.r_per_share / self.price) * 100
        
        if tp is not None:
            self.tp = tp
            self.target_r = (self.tp - self.price) / self.r_per_share
        elif target_r is not None:
            self.target_r = target_r
            self.tp = self.price + (self.target_r * self.r_per_share)
        else:
            raise ValueError("Either tp (Take Profit) or target_r (Target R) must be provided.")

    def simulate_impact(self, portfolio: Portfolio, nos: int = None):
        """
        Simulate the trade limits, or if nos is provided, the specific impact.
        Returns a dictionary suitable for JSON serialization.
        """
        # Block if Target R is too low
        if self.target_r < portfolio.min_r:
            return {"error": f"Trade rejected: Target R ({round(self.target_r, 2)}R) is below the required minimum of {portfolio.min_r}R."}
            
        # Block if Stop-Loss distance is too wide
        if self.crisk_pos_pct > portfolio.max_crisk_pos_pct:
            return {"error": f"Trade rejected: Stop-Loss is too wide ({round(self.crisk_pos_pct, 2)}%). The maximum allowed risk per position is {round(portfolio.max_crisk_pos_pct, 2)}%."}
            
        # Limit 1: Core Risk (crisk)
        allowed_crisk_eur = portfolio.get_max_crisk_eur()
        nos_crisk = int(allowed_crisk_eur / self.r_per_share)
        
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
        max_nos = min(nos_crisk, nos_heat, nos_cash, nos_max_positions)
        if max_nos < 0: max_nos = 0
        
        # Determine limiting factor
        limits = {
            "Core Risk Limit": nos_crisk,
            "Portfolio Heat Limit": nos_heat,
            "Cash Limit": nos_cash,
            "Max Positions Limit": "Reached" if nos_max_positions == 0 else "OK"
        }
        
        # Is this a discovery?
        is_discovery = False
        if nos is None:
            is_discovery = True
            nos = max_nos
            
        # Simulate the exact impact
        actual_nos = min(nos, max_nos)
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
            return {"error": "Cannot buy shares. Limits reached or invalid nos."}
            
        trade_cost = (actual_nos * self.price) + self.commission
        cash_after = portfolio.cash - trade_cost
        cash_pct_before = (portfolio.cash / portfolio.nav) * 100
        cash_pct_after = (cash_after / portfolio.nav) * 100
        
        crisk_eur = actual_nos * self.r_per_share
        crisk_pct = (crisk_eur / portfolio.nav) * 100
        
        heat_pct_after = portfolio.current_heat_pct + crisk_pct
        
        impact_data = {
            "cash_before": round(portfolio.cash, 2),
            "cash_after": round(cash_after, 2),
            "cash_delta": round(cash_after - portfolio.cash, 2),
            
            "cash_pct_before": f"{round(cash_pct_before, 2)}%",
            "cash_pct_after": f"{round(cash_pct_after, 2)}%",
            "cash_pct_delta": f"{round(cash_pct_after - cash_pct_before, 2)}%",
            
            "heat_pct_before": f"{round(portfolio.current_heat_pct, 2)}%",
            "heat_pct_after": f"{round(heat_pct_after, 2)}%",
            "heat_pct_delta": f"+{round(crisk_pct, 2)}%",
            
            "trade_crisk_eur": round(crisk_eur, 2),
            "trade_crisk_pct": f"{round(crisk_pct, 2)}%"
        }
        
        if is_discovery:
            return {
                "status": "discovery_success",
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
                "portfolio_impact": impact_data,
                "message": "Discovery complete. The portfolio_impact shows the effect of buying the max_allowed_shares."
            }
        
        return {
            "status": "impact_simulation_success",
            "ticker": self.ticker,
            "take_profit": round(self.tp, 2),
            "target_r": round(self.target_r, 2),
            "commission": self.commission,
            "days": self.days,
            "requested_nos": nos,
            "actual_nos": actual_nos,
            "trade_cost_eur": round(trade_cost, 2),
            "portfolio_impact": impact_data
        }
