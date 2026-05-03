import { MatrixClient, SimpleFsStorageProvider, AutojoinRoomsMixin } from "matrix-bot-sdk";
import * as fs from "fs";

// 1. Configuration from Environment
const MATRIX_URL = process.env.MATRIX_HOMESERVER_URL || "http://localhost:6167";
const MATRIX_USER = process.env.MATRIX_USER || "ea";
const MATRIX_PASSWORD = process.env.MATRIX_PASSWORD || "freeadamnemesisx1";
const MCP_SERVER_URLS_STR = process.env.MCP_SERVER_URLS || process.env.MCP_SERVER_URL || "http://localhost:8787";
const MCP_ACCESS_KEY = process.env.MCP_ACCESS_KEY || "";
const LM_STUDIO_URL = process.env.LM_STUDIO_URL || "http://localhost:1234";

const MCP_SERVER_URLS = MCP_SERVER_URLS_STR.split(",").map(url => url.trim()).filter(url => url.length > 0);

// 2. Setup Matrix Storage
const storage = new SimpleFsStorageProvider("bot-storage.json");

// 3. System Prompt (Dynamic)
let SYSTEM_PROMPT = `Du bist ein generischer Agent. Bitte mounte eine prompt.txt.`;
const PROMPT_PATH = process.env.PROMPT_PATH || "/app/prompt.txt";
if (fs.existsSync(PROMPT_PATH)) {
    SYSTEM_PROMPT = fs.readFileSync(PROMPT_PATH, "utf-8");
} else if (fs.existsSync("prompt.txt")) {
    SYSTEM_PROMPT = fs.readFileSync("prompt.txt", "utf-8");
} else {
    console.warn(`⚠️ Warning: No prompt.txt found at ${PROMPT_PATH}. Using fallback prompt.`);
}

// --- Simple Stateless MCP Client via HTTP/JSON-RPC ---
class StatelessMcpClient {
    constructor(public url: string, private key: string) {}

    private async request(method: string, params: any) {
        const res = await fetch(`${this.url}?key=${this.key}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                method: method,
                params: params,
                id: Date.now()
            })
        });

        const text = await res.text();
        let jsonStr = text;

        // If it's an SSE response (starts with event: message), extract the data line
        if (text.includes("event: message")) {
            const dataLine = text.split("\n").find(line => line.startsWith("data: "));
            if (dataLine) {
                jsonStr = dataLine.substring(6);
            }
        }

        try {
            const data = JSON.parse(jsonStr);
            if (data.error) throw new Error(data.error.message);
            return data.result;
        } catch (e: any) {
            console.error("❌ Failed to parse MCP response:", text);
            throw new Error(`Invalid MCP response: ${e.message}`);
        }
    }

    async listTools() {
        return this.request("tools/list", {});
    }

    async callTool(name: string, args: any) {
        return this.request("tools/call", { name, arguments: args });
    }
}

async function main() {
    console.log("🚀 Starting EA Bot (Stateless Mode)...");

    // --- A. Login to Matrix ---
    console.log(`🔑 Logging into Matrix at ${MATRIX_URL} as ${MATRIX_USER}...`);
    const authResponse = await fetch(`${MATRIX_URL}/_matrix/client/v3/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            type: "m.login.password",
            identifier: { type: "m.id.user", user: MATRIX_USER },
            password: MATRIX_PASSWORD
        })
    });

    if (!authResponse.ok) {
        console.error("❌ Matrix Login failed:", await authResponse.text());
        process.exit(1);
    }
    const authData = await authResponse.json();
    const accessToken = authData.access_token;
    const userId = authData.user_id;

    const matrixClient = new MatrixClient(MATRIX_URL, accessToken, storage);
    AutojoinRoomsMixin.setupOnClient(matrixClient);

    // --- B. Setup Stateless MCP Clients ---
    console.log(`🔌 Setup MCP Clients for: ${MCP_SERVER_URLS.join(", ")}`);
    const mcpClients = MCP_SERVER_URLS.map(url => new StatelessMcpClient(url, MCP_ACCESS_KEY));

    // --- C. Listen for Chat Messages ---
    matrixClient.on("room.message", async (roomId, event) => {
        if (!event.content || !event.content.body || event.sender === userId) return;

        const userMessage = event.content.body;
        const msgLower = userMessage.toLowerCase();
        const botName = process.env.MATRIX_USER!.toLowerCase();

        // 1. Bots ignorieren Nachrichten von anderen Bots, es sei denn, sie werden namentlich erwähnt
        const isFromBot = event.sender.includes("@ea:") || event.sender.includes("@cco:");
        const isMentioned = msgLower.includes(botName) || msgLower.includes(`@${botName}`);
        
        if (isFromBot && !isMentioned) {
            console.log(`🔕 [${botName}] Ignoriere Nachricht von anderem Bot.`);
            return;
        }
        
        // 2. Bots ignorieren Menschen, wenn ein anderer Bot explizit angesprochen wurde
        const mentionsEa = msgLower.includes("ea");
        const mentionsCco = msgLower.includes("cco");
        
        if (botName === "ea" && mentionsCco && !mentionsEa) return;
        if (botName === "cco" && mentionsEa && !mentionsCco) return;

        console.log(`\n💬 Received message: ${userMessage}`);

        matrixClient.setTyping(roomId, true, 30000).catch(console.error);

        try {
            await handleMessage(matrixClient, mcpClients, roomId, userMessage);
        } catch (error) {
            console.error("❌ Error handling message:", error);
            matrixClient.sendMessage(roomId, {
                msgtype: "m.text",
                body: "Sorry, ich hatte ein internes Problem bei der Verarbeitung."
            });
        } finally {
            matrixClient.setTyping(roomId, false).catch(console.error);
        }
    });

    await matrixClient.start();
    console.log(`✅ EA Bot is now syncing and listening!`);
}

const POSTGREST_URL = "http://postgrest:3000";

// --- Database Helpers ---
async function saveMessageToDb(roomId: string, sender: string, role: string, content: string) {
    try {
        await fetch(`${POSTGREST_URL}/chat_messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ room_id: roomId, sender, role, content })
        });
    } catch (e) {
        console.error("❌ DB save failed:", e);
    }
}

async function loadHistoryFromDb(roomId: string, limit: number = 10) {
    try {
        const res = await fetch(`${POSTGREST_URL}/chat_messages?room_id=eq.${encodeURIComponent(roomId)}&order=created_at.desc&limit=${limit}`);
        if (!res.ok) return [];
        const data: any[] = await res.json();
        // PostgREST returns desc, so we need to reverse to chronological order
        return data.reverse().map(row => ({
            role: row.role,
            content: row.content
        }));
    } catch (e) {
        console.error("❌ DB load failed:", e);
        return [];
    }
}

async function handleMessage(matrixClient: MatrixClient, mcpClients: StatelessMcpClient[], roomId: string, userMessage: string) {
    // 1. Speichere neue User-Nachricht asynchron
    saveMessageToDb(roomId, "user", "user", userMessage);

    // 2. Lade Historie und Tools
    const historyPromise = loadHistoryFromDb(roomId, 10);
    
    const availableTools: any[] = [];
    const toolToClientMap = new Map<string, StatelessMcpClient>();

    await Promise.all(mcpClients.map(async (client) => {
        try {
            const res = await client.listTools();
            for (const t of res.tools) {
                availableTools.push({
                    type: "function",
                    function: {
                        name: t.name,
                        description: t.description,
                        parameters: t.inputSchema
                    }
                });
                toolToClientMap.set(t.name, client);
            }
        } catch (err) {
            console.error(`❌ Failed to load tools from ${client.url}:`, err);
        }
    }));

    const history = await historyPromise;

    const messages: any[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
        { role: "user", content: userMessage }
    ];

    console.log("🧠 Asking LM Studio...");
    let response: any = await callLMStudio(messages, availableTools);

    while (response.tool_calls && response.tool_calls.length > 0) {
        messages.push(response.message);

        for (const toolCall of response.tool_calls) {
            console.log(`🛠️ Calling tool: ${toolCall.function.name}`);
            try {
                const args = JSON.parse(toolCall.function.arguments);
                const client = toolToClientMap.get(toolCall.function.name);
                if (!client) throw new Error(`Tool ${toolCall.function.name} not found on any connected MCP server.`);
                
                const result = await client.callTool(toolCall.function.name, args);
                
                const toolResultText = result.content.map((c: any) => c.type === 'text' ? c.text : JSON.stringify(c)).join("\n");
                
                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    name: toolCall.function.name,
                    content: toolResultText
                });
            } catch (err: any) {
                console.error(`❌ Tool failed: ${err.message}`);
                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    name: toolCall.function.name,
                    content: `Error: ${err.message}`
                });
            }
        }
        console.log("🧠 Asking LM Studio again...");
        response = await callLMStudio(messages, availableTools);
    }

    if (response.message && response.message.content) {
        // Speichere Assistant-Antwort asynchron
        saveMessageToDb(roomId, "ea", "assistant", response.message.content);
        
        await matrixClient.sendMessage(roomId, {
            msgtype: "m.text",
            body: response.message.content
        });
    }
}

async function callLMStudio(messages: any[], tools: any[]) {
    const payload: any = {
        model: "local-model",
        messages: messages,
        temperature: 0.2
    };
    if (tools.length > 0) payload.tools = tools;

    const res = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        const errorText = await res.text();
        console.error("❌ LM Studio returned error:", errorText);
        throw new Error(`LM Studio error: ${res.status} - ${errorText}`);
    }
    
    const data: any = await res.json();
    if (!data.choices || data.choices.length === 0) {
        console.error("❌ LM Studio response missing choices:", JSON.stringify(data));
        throw new Error("LM Studio returned empty or invalid response");
    }
    
    const message = data.choices[0].message;
    return { message, tool_calls: message.tool_calls || null };
}

main().catch(console.error);
