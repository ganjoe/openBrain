const ticker = "RDDT";
const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`, {
    headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
        "Accept": "application/json"
    }
});
if (res.ok) {
    const data = await res.json();
    console.log(data?.chart?.result?.[0]?.meta?.regularMarketPrice);
} else {
    console.error(`HTTP Error: ${res.status}`);
}
