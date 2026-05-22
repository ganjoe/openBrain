import { createClient } from "npm:@supabase/supabase-js";
import "jsr:@std/dotenv/load";

// Setup Supabase Client
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "http://127.0.0.1:8001"; // Fallback to local Gateway
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SERVICE_ROLE_KEY in environment or .env file");
  Deno.exit(1);
}

// URL might be gateway (8001) or postgrest (3001).
const supabaseUrl = SUPABASE_URL.includes("postgrest") ? "http://127.0.0.1:8001" : SUPABASE_URL;

const supabase = createClient(supabaseUrl, SUPABASE_SERVICE_ROLE_KEY);

// Currencies to fetch
const BASE_CURRENCY = "EUR";
const TARGET_CURRENCIES = ["USD", "JPY", "SEK", "CAD", "KRW", "CHF", "GBP", "AUD", "HKD", "SGD"];

// Calculate dates
const formatDate = (date: Date) => {
  const d = new Date(date);
  let month = '' + (d.getMonth() + 1);
  let day = '' + d.getDate();
  const year = d.getFullYear();

  if (month.length < 2) month = '0' + month;
  if (day.length < 2) day = '0' + day;

  return [year, month, day].join('-');
};

const today = new Date();
const twoYearsAgo = new Date();
twoYearsAgo.setFullYear(today.getFullYear() - 2);

// Accept command line args for custom date range, otherwise default to last 2 years
const startDate = Deno.args[0] || formatDate(twoYearsAgo);
const endDate = Deno.args[1] || formatDate(today);

console.log(`Fetching exchange rates from ${startDate} to ${endDate} for base ${BASE_CURRENCY}...`);
console.log(`Targets: ${TARGET_CURRENCIES.join(", ")}`);

const url = `https://api.frankfurter.app/${startDate}..${endDate}?base=${BASE_CURRENCY}&symbols=${TARGET_CURRENCIES.join(",")}`;

try {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`API returned status ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  
  if (!data.rates || Object.keys(data.rates).length === 0) {
    console.log("No data returned for the given period.");
    Deno.exit(0);
  }

  const payload = [];

  for (const [date, rates] of Object.entries(data.rates)) {
    for (const [targetCurrency, rate] of Object.entries(rates as Record<string, number>)) {
      payload.push({
        date: date,
        base_currency: BASE_CURRENCY,
        target_currency: targetCurrency,
        rate: rate
      });
    }
  }

  console.log(`Preparing to insert/upsert ${payload.length} rows...`);

  // Batch insert in chunks to avoid large payload issues, though Supabase handles decent sizes
  const chunkSize = 1000;
  for (let i = 0; i < payload.length; i += chunkSize) {
    const chunk = payload.slice(i, i + chunkSize);
    
    // Upsert avoids duplicate key errors and updates existing dates if they changed
    const { error } = await supabase
      .from("exchange_rates")
      .upsert(chunk, { onConflict: "date, base_currency, target_currency" });

    if (error) {
      console.error(`Error inserting chunk ${i} to ${i + chunkSize}:`, error.message);
    } else {
      console.log(`Successfully inserted chunk ${i} to ${i + chunkSize}`);
    }
  }

  console.log("Exchange rate update completed successfully.");

} catch (err) {
  console.error("Failed to update exchange rates:", err);
  Deno.exit(1);
}
