const fs = require("fs");
require("dotenv").config();
const promptText = fs.readFileSync("agent-cco/prompt.txt", "utf-8");
const payload = {
  model: "gemini-3-flash-preview",
  messages: [
    {role: "system", content: promptText},
    {role: "user", content: "liste alle posts mit japanischen firmen auf"}
  ],
  tools: [{
    type: "function",
    function: {
      name: "exact_keyword_search",
      description: "Search workspace by exact keyword",
      parameters: { type: "object", properties: { keyword: { type: "string" }, dump_to_chat: { type: "boolean" } }, required: ["keyword"] }
    }
  }, {
    type: "function",
    function: {
      name: "semantic_search_workspace",
      description: "Semantic search",
      parameters: { type: "object", properties: { query: { type: "string" }, dump_to_chat: { type: "boolean" } }, required: ["query"] }
    }
  }]
};
console.log("Starting fetch...");
fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
  method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.GEMINI_API_KEY}` },
  body: JSON.stringify(payload)
})
.then(r => {
  console.log("Status:", r.status);
  return r.json();
})
.then(x => console.log("Result:", JSON.stringify(x, null, 2)))
.catch(console.error);
