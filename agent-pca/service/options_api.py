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
