async function testYahoo(ticker) {
    try {
        const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`);
        const data = await res.json();
        const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
        console.log(`Price for ${ticker}: ${price}`);
    } catch(e) {
        console.error("Fallback failed", e);
    }
}

testYahoo("RDDT");
