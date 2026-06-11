class Portfolio:
    def __init__(self, nav: float, cash: float, max_crisk_pct: float, max_heat_pct: float, current_heat_pct: float, max_positions: int = 10, current_positions: int = 0):
        self.nav = nav
        self.cash = cash
        self.max_crisk_pct = max_crisk_pct
        self.max_heat_pct = max_heat_pct
        self.current_heat_pct = current_heat_pct
        self.max_positions = max_positions
        self.current_positions = current_positions

    def get_available_heat_pct(self) -> float:
        return max(0.0, self.max_heat_pct - self.current_heat_pct)
        
    def get_available_heat_eur(self) -> float:
        return self.get_available_heat_pct() * self.nav / 100.0

    def get_max_crisk_eur(self) -> float:
        return (self.max_crisk_pct / 100.0) * self.nav

class TradeObject:
    def __init__(self, ticker: str, price: float, sl: float, commission: float = 0.0):
        self.ticker = ticker
        self.price = price
        self.sl = sl
        self.commission = commission
        
        # Risk per share (absolute difference)
        self.r_per_share = max(0.0001, self.price - self.sl)

    def simulate_impact(self, portfolio: Portfolio, nos: int = None):
        """
        Simulate the trade limits, or if nos is provided, the specific impact.
        Returns a dictionary suitable for JSON serialization.
        """
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
        
        # If nos is not provided, return the limits discovery
        if nos is None:
            return {
                "status": "discovery_success",
                "ticker": self.ticker,
                "price": self.price,
                "stop_loss": self.sl,
                "commission": self.commission,
                "max_allowed_shares": max_nos,
                "limiting_factors": limits,
                "message": "Discovery complete. Provide 'nos' to see detailed portfolio impact."
            }
            
        # If nos IS provided, simulate the exact impact
        actual_nos = min(nos, max_nos)
        if actual_nos <= 0:
            return {"error": "Cannot buy shares. Limits reached or invalid nos."}
            
        trade_cost = (actual_nos * self.price) + self.commission
        cash_after = portfolio.cash - trade_cost
        cash_pct_before = (portfolio.cash / portfolio.nav) * 100
        cash_pct_after = (cash_after / portfolio.nav) * 100
        
        crisk_eur = actual_nos * self.r_per_share
        crisk_pct = (crisk_eur / portfolio.nav) * 100
        
        heat_pct_after = portfolio.current_heat_pct + crisk_pct
        
        return {
            "status": "impact_simulation_success",
            "ticker": self.ticker,
            "requested_nos": nos,
            "actual_nos": actual_nos,
            "trade_cost_eur": round(trade_cost, 2),
            "portfolio_impact": {
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
        }
