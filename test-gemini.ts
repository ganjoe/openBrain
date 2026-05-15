import { config } from "dotenv";
config();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const payload = {
  model: "gemini-3-flash-preview",
  messages: [
    {role: "system", content: "You have a tool exact_keyword_search. Use it."},
    {role: "user", content: "liste alle posts mit japanischen firmen auf"}
  ],
  tools: [{
    type: "function",
    function: {
      name: "exact_keyword_search",
      description: "Search workspace by exact keyword",
      parameters: { type: "object", properties: { keyword: { type: "string" }, dump_to_chat: { type: "boolean" } }, required: ["keyword"] }
    }
  }]
};
fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
  method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GEMINI_API_KEY}` },
  body: JSON.stringify(payload)
}).then(r => r.json()).then(console.log).catch(console.error);
