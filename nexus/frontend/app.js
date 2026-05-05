/**
 * Nexus Dashboard — app.js
 *
 * Architecture:
 *  - SSE for live messages (/api/stream)
 *  - REST polling fallback for history (/api/history)
 *  - Checkbox-based Virtual Chatroom filter
 *  - marked.js for Markdown rendering in message bodies
 */

const API = window.location.origin.replace("7733", "7734");

// ── State ─────────────────────────────────────────────────────
const state = {
  agents:        [],          // list of known agent IDs
  activeFilter:  new Set(["boss"]), // checked agent IDs (boss default)
  statusMode:    false,       // status-channel checkbox
  messages:      [],          // all buffered messages (capped at 500)
  lastSeenUnix:  parseInt(localStorage.getItem("nexus_last_seen") || "0"),
};

// ── DOM refs ──────────────────────────────────────────────────
const $messages    = document.getElementById("messages");
const $agentList   = document.getElementById("agent-list");
const $roomLabel   = document.getElementById("room-label");
const $connIndicator = document.getElementById("conn-indicator");
const $filterStatus  = document.getElementById("filter-status");
const $sendBtn       = document.getElementById("send-btn");
const $sendFrom      = document.getElementById("send-from");
const $sendTo        = document.getElementById("send-to");
const $sendText      = document.getElementById("send-text");

// ── Helpers ───────────────────────────────────────────────────
function formatTime(unix) {
  if (!unix) return "";
  return new Date(unix * 1000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function renderMarkdown(text) {
  try {
    return marked.parse(String(text || ""), { breaks: true, gfm: true });
  } catch {
    return String(text || "");
  }
}

function buildMessageEl(msg) {
  const h = msg.header || {};
  const from     = h.from || h.from_agent || "?";
  const to       = h.to || "?";
  const msgType  = h.msg_type || "chat";
  const unix     = h.unix || 0;
  const text     = msg.content?.text || msg.raw_status
    ? (msg.content?.text || JSON.stringify(msg.raw_status))
    : "";

  const el = document.createElement("div");
  el.className = `msg ${msgType}`;
  el.dataset.from = from;
  el.dataset.to   = to;
  el.dataset.type = msgType;

  el.innerHTML = `
    <div class="msg-header">
      <span class="msg-from">${from}</span>
      <span class="msg-arrow">→</span>
      <span class="msg-to">${to}</span>
      <span class="msg-type">${msgType}</span>
      <span class="msg-time">${formatTime(unix)}</span>
    </div>
    <div class="msg-body">${renderMarkdown(text)}</div>
  `;

  return el;
}

function appendMessage(msg) {
  state.messages.push(msg);
  if (state.messages.length > 500) state.messages.shift();

  const h = msg.header || {};
  const from    = h.from || h.from_agent || "?";
  const to      = h.to || "?";
  const msgType = h.msg_type || "chat";

  if (!isVisible(from, to, msgType)) return;

  const el = buildMessageEl(msg);
  $messages.appendChild(el);
  $messages.scrollTop = $messages.scrollHeight;

  // Update last-seen timestamp
  const unix = h.unix || 0;
  if (unix > state.lastSeenUnix) {
    state.lastSeenUnix = unix;
    localStorage.setItem("nexus_last_seen", unix);
  }

  // Auto-register new agents
  [from, to].forEach(id => {
    if (id && id !== "nexus" && id !== "?" && !state.agents.includes(id)) {
      state.agents.push(id);
      renderAgentCheckboxes();
    }
  });
}

// ── Filter Logic ──────────────────────────────────────────────
function isVisible(from, to, msgType) {
  // Status mode: only show status messages
  if (state.statusMode) return msgType === "status";

  // No agent selected → global stream
  if (state.activeFilter.size === 0) return true;

  // At least 2 agents selected → show messages between any of the selected agents
  return state.activeFilter.has(from) && state.activeFilter.has(to);
}

function rerender() {
  $messages.innerHTML = "";
  state.messages
    .filter(m => {
      const h = m.header || {};
      return isVisible(h.from || h.from_agent || "?", h.to || "?", h.msg_type || "chat");
    })
    .forEach(m => {
      const el = buildMessageEl(m);
      $messages.appendChild(el);
    });
  $messages.scrollTop = $messages.scrollHeight;
  updateRoomLabel();
}

function updateRoomLabel() {
  if (state.statusMode) {
    $roomLabel.textContent = "📡 Status Channel";
    return;
  }
  if (state.activeFilter.size === 0) {
    $roomLabel.textContent = "🌐 Global Stream";
    return;
  }
  const agents = [...state.activeFilter].sort().join(" ↔ ");
  $roomLabel.textContent = `💬 ${agents}`;
}

// ── Agent Checkboxes ──────────────────────────────────────────
function renderAgentCheckboxes() {
  $agentList.innerHTML = "";
  state.agents.sort().forEach(id => {
    const label = document.createElement("label");
    label.className = "checkbox-row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id   = `agent-${id}`;
    cb.checked = state.activeFilter.has(id);
    cb.addEventListener("change", () => {
      if (cb.checked) state.activeFilter.add(id);
      else            state.activeFilter.delete(id);

      // Auto-fill Send fields based on selection count
      const activeArray = [...state.activeFilter];
      if (activeArray.length === 1) {
        $sendFrom.value = activeArray[0];
      } else if (activeArray.length === 2) {
        $sendTo.value = activeArray[1];
      }

      // Disable status mode when agent selected
      if (state.activeFilter.size > 0) {
        state.statusMode = false;
        $filterStatus.checked = false;
      }
      rerender();
    });

    const dot  = document.createElement("span");
    dot.className = "dot dot-agent";

    const name = document.createElement("span");
    name.textContent = id;

    label.append(cb, dot, name);
    $agentList.appendChild(label);
  });

  if (state.agents.length === 0) {
    $agentList.innerHTML = '<p class="hint">Warte auf Agenten…</p>';
  }
}

// ── Status checkbox ───────────────────────────────────────────
$filterStatus.addEventListener("change", () => {
  state.statusMode = $filterStatus.checked;
  if (state.statusMode) {
    state.activeFilter.clear();
    // Uncheck all agent boxes
    document.querySelectorAll("#agent-list input[type=checkbox]").forEach(cb => cb.checked = false);
  }
  rerender();
});

// ── Send ──────────────────────────────────────────────────────
$sendBtn.addEventListener("click", async () => {
  const from = document.getElementById("send-from").value.trim();
  const to   = document.getElementById("send-to").value.trim();
  const text = document.getElementById("send-text").value.trim();
  if (!from || !to || !text) return;

  try {
    const r = await fetch(`${API}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_agent: from, to, text }),
    });
    if (r.ok) document.getElementById("send-text").value = "";
  } catch (e) {
    console.error("Send failed:", e);
  }
});

// Send on Enter (Shift+Enter for newline)
$sendText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $sendBtn.click();
  }
});

// ── SSE connection ────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource(`${API}/api/stream`);

  es.onopen = () => {
    $connIndicator.className = "indicator online";
    $connIndicator.title = "Live";
  };

  es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      appendMessage(msg);
    } catch { /* ignore parse errors */ }
  };

  es.onerror = () => {
    $connIndicator.className = "indicator offline";
    $connIndicator.title = "Reconnecting…";
    es.close();
    setTimeout(connectSSE, 3000);
  };
}

// ── Load history on start ─────────────────────────────────────
async function loadHistory() {
  try {
    const r   = await fetch(`${API}/api/history?since=${state.lastSeenUnix}`);
    const rows = await r.json();
    rows.forEach(row => {
      // DB rows have full_json as the envelope
      const msg = row.full_json || row;
      appendMessage(msg);
    });
  } catch (e) {
    console.error("History load failed:", e);
  }
}

// ── Load known agents on start ────────────────────────────────
async function loadAgents() {
  try {
    const r = await fetch(`${API}/api/agents`);
    state.agents = await r.json();
    renderAgentCheckboxes();
  } catch {
    renderAgentCheckboxes();
  }
}

// ── Boot ──────────────────────────────────────────────────────
(async () => {
  $sendFrom.value = "boss"; // Initial value
  await loadAgents();
  await loadHistory();
  connectSSE();
  updateRoomLabel();
})();
