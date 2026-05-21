import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";

dotenv.config({ path: "../../.env" });

const SUPABASE_URL = "http://127.0.0.1:3001"; // PostgREST port from docker-compose
const SUPABASE_KEY = process.env.SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "missing";

if (!SUPABASE_KEY || SUPABASE_KEY === "missing") {
    console.error("No SERVICE_ROLE_KEY found in .env");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function runTest() {
    console.log("🚀 Starting Quote Test for RDDT...");
    const ticker = "RDDT";

    // 1. Insert Quote Request
    console.log("📝 Inserting QUOTE_REQUESTED into pta_execution_log...");
    const { data: insertData, error: insertErr } = await supabase
        .from("pta_execution_log")
        .insert({
            event_type: "QUOTE_REQUESTED",
            ticker: ticker,
            action: "INFO",
            quantity: 0,
            notes: "PENDING",
        })
        .select("id")
        .single();

    if (insertErr || !insertData) {
        console.error("❌ Error inserting quote request:", insertErr);
        return;
    }

    const requestId = insertData.id;
    console.log(`✅ Inserted successfully. Request ID: ${requestId}`);

    // 2. Poll for completion
    console.log("⏳ Polling for result (max 20 seconds)...");
    let quotePrice: number | null = null;
    let finalStatus = "PENDING";
    
    for (let i = 0; i < 40; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        
        const { data: checkData, error: checkErr } = await supabase
            .from("pta_execution_log")
            .select("notes, price, updated_at")
            .eq("id", requestId)
            .single();

        if (checkErr) {
            console.error("❌ Polling error:", checkErr.message);
            continue;
        }

        if (checkData) {
            finalStatus = checkData.notes;
            if (checkData.notes !== "PENDING" && checkData.notes !== "PROCESSING") {
               console.log(`🔄 [Tick ${i}] Status changed to: ${checkData.notes}`);
            }
            if (checkData.notes === "COMPLETED" && checkData.price) {
                quotePrice = checkData.price;
                console.log(`🎉 SUCCESS! Price received: ${quotePrice} (Last Updated: ${checkData.updated_at})`);
                break;
            }
        }
    }

    if (quotePrice === null) {
        console.log(`❌ TIMEOUT! Final status was: ${finalStatus}. Quote price is still null.`);
        console.log("Check the logs of ibkr_sync.ts to see what happened:");
        console.log("docker logs openbrain-pta-bot | tail -n 50");
    }

    // Clean up
    console.log(`🧹 Cleaning up DB row ID ${requestId}...`);
    await supabase.from("pta_execution_log").delete().eq("id", requestId);
    console.log("Done.");
}

runTest();
