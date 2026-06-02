import os
import asyncio
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Any
from ib_insync import IB, Stock, Index, util, Contract

router = APIRouter()
logger = logging.getLogger("pca.options")

# Global IB instance
ib = IB()

IB_HOST = os.getenv("IB_GATEWAY_HOST", "10.20.0.23")
IB_PORT = int(os.getenv("IB_GATEWAY_PORT", "4002"))
IB_CLIENT_ID = int(os.getenv("IB_CLIENT_ID", "10002"))

class OptionChainResponse(BaseModel):
    exchange: str
    underlyingConId: int
    tradingClass: str
    multiplier: str
    expirations: List[str]
    strikes: List[float]

async def get_ib_connection() -> IB:
    if not ib.isConnected():
        try:
            logger.info(f"Connecting to IB Gateway at {IB_HOST}:{IB_PORT} with client ID {IB_CLIENT_ID}")
            await ib.connectAsync(IB_HOST, IB_PORT, clientId=IB_CLIENT_ID, timeout=5.0)
        except Exception as e:
            logger.error(f"Failed to connect to IB Gateway: {e}")
            raise HTTPException(status_code=503, detail="IB Gateway connection failed")
    return ib

@router.get("/options/chain/{ticker}", response_model=List[OptionChainResponse])
async def get_option_chain(ticker: str):
    """
    Fetches the option chain parameters (expirations and strikes) for a given ticker.
    """
    ib_conn = await get_ib_connection()
    
    # Try Stock first, if not found, try Index
    contract = Stock(ticker.upper(), 'SMART', 'USD')
    qualifications = await ib_conn.qualifyContractsAsync(contract)
    
    if not qualifications:
        # Fallback to Index
        contract = Index(ticker.upper(), 'SMART', 'USD')
        qualifications = await ib_conn.qualifyContractsAsync(contract)
        
    if not qualifications:
        raise HTTPException(status_code=404, detail=f"Could not qualify contract for {ticker}")
        
    qualified_contract = qualifications[0]
    
    try:
        chains = await ib_conn.reqSecDefOptParamsAsync(
            qualified_contract.symbol,
            '', 
            qualified_contract.secType,
            qualified_contract.conId
        )
        
        # Filter for SMART exchange to avoid duplicates, or just return all
        result = []
        for chain in chains:
            # Sort expirations and strikes for convenience
            expirations = sorted(list(chain.expirations))
            strikes = sorted(list(chain.strikes))
            
            result.append(OptionChainResponse(
                exchange=chain.exchange,
                underlyingConId=chain.underlyingConId,
                tradingClass=chain.tradingClass,
                multiplier=chain.multiplier,
                expirations=expirations,
                strikes=strikes
            ))
            
        return result
    except Exception as e:
        logger.error(f"Error fetching option chain for {ticker}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class OptionQuoteResponse(BaseModel):
    ticker: str
    expiry: str
    strike: float
    right: str
    bid: float
    ask: float
    last: float
    volume: float

@router.get("/options/quote/{ticker}", response_model=OptionQuoteResponse)
async def get_option_quote(ticker: str, expiry: str, strike: float, right: str):
    """
    Fetches the live quote (bid/ask/last) for a specific option contract.
    expiry format: YYYYMMDD
    right: 'C' or 'P'
    """
    ib_conn = await get_ib_connection()
    from ib_insync import Option
    
    # Try Stock first, if needed we could pass the underlying secType, 
    # but ib_insync's Option wrapper works automatically with qualifyContracts
    contract = Option(ticker.upper(), expiry, strike, right.upper(), 'SMART', currency='USD')
    
    qualifications = await ib_conn.qualifyContractsAsync(contract)
    if not qualifications:
        raise HTTPException(status_code=404, detail=f"Could not qualify option contract for {ticker} {expiry} {strike} {right}")
        
    qualified_contract = qualifications[0]
    
    try:
        # Request market data
        ticker_data = ib_conn.reqMktData(qualified_contract, '', False, False)
        
        # Wait a short moment for data to arrive from IBKR servers
        await asyncio.sleep(2.0)
        
        # Unsubscribe
        ib_conn.cancelMktData(qualified_contract)
        
        return OptionQuoteResponse(
            ticker=ticker.upper(),
            expiry=expiry,
            strike=strike,
            right=right.upper(),
            bid=ticker_data.bid if ticker_data.bid == ticker_data.bid else 0.0,
            ask=ticker_data.ask if ticker_data.ask == ticker_data.ask else 0.0,
            last=ticker_data.last if ticker_data.last == ticker_data.last else 0.0,
            volume=ticker_data.volume if ticker_data.volume == ticker_data.volume else 0.0
        )
    except Exception as e:
        logger.error(f"Error fetching option quote for {ticker}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

