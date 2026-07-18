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
  agents:        {},          // mapping: agent_id -> { online: boolean }
  activeFilter:  new Set(["boss"]), // checked agent IDs (boss default)
  messages:      [],          // all buffered messages (capped at 500)
  lastSeenUnix:  parseInt(localStorage.getItem("nexus_last_seen") || String(Math.floor(Date.now() / 1000))),
  providerConfig: {},         // per-agent LLM provider mapping
};

// ── DOM refs ──────────────────────────────────────────────────
const $messages      = document.getElementById("messages");
const $agentList     = document.getElementById("agent-list");
const $roomLabel     = document.getElementById("room-label");
const $connIndicator = document.getElementById("conn-indicator");
const $sendBtn       = document.getElementById("send-btn");
const $sendFrom      = document.getElementById("send-from");
const $sendTo        = document.getElementById("send-to");
const $sendText      = document.getElementById("send-text");
const $filterHistory = document.getElementById("filter-history");
const $providerList  = document.getElementById("provider-list");
const $contextToggle = document.getElementById("context-toggle");
const $contextInput  = document.getElementById("context-limit-input");

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

/**
 * Unified parser to handle both nested MQTT envelopes and flat DB rows.
 */
function parseMessage(msg) {
  const h = msg.header || {};
  return {
    from:    h.from || h.from_agent || msg.from_agent || "?",
    to:      h.to   || msg.to_agent || "?",
    type:    h.msg_type || msg.message_type || "chat",
    unix:    h.unix || msg.unix_ts || 0,
    text:    msg.content?.text || msg.content || (msg.raw_status ? JSON.stringify(msg.raw_status) : ""),
    raw:     msg
  };
}


function buildMessageEl(msg) {
  const p = parseMessage(msg);

  const el = document.createElement("div");
  el.className = `msg ${p.type}`;
  el.dataset.from = p.from;
  el.dataset.to   = p.to;
  el.dataset.type = p.type;

  el.innerHTML = `
    <div class="msg-header">
      <span class="msg-from">${p.from}</span>
      <span class="msg-arrow">→</span>
      <span class="msg-to">${p.to}</span>
      <span class="msg-type">${p.type}</span>
      <span class="msg-time">${formatTime(p.unix)}</span>
    </div>
    <div class="msg-body">${renderMarkdown(p.text)}</div>
  `;

  return el;
}

function appendMessage(msg) {
  state.messages.push(msg);
  if (state.messages.length > 500) state.messages.shift();

  const p = parseMessage(msg);
  
  // Handle status messages
  if (p.type === "status") {
    const agentId = p.from;
    const isOnline = msg.raw_status?.status === "online";
    if (agentId && agentId !== "nexus" && agentId !== "?") {
      state.agents[agentId] = { online: isOnline };
      renderAgentCheckboxes();
      renderProviders();
    }
    return;
  }

  if (!isVisible(p.from, p.to, p.type)) return;

  const el = buildMessageEl(msg);
  $messages.appendChild(el);
  
  const $autoscrollToggle = document.getElementById("autoscroll-toggle");
  if ($autoscrollToggle && $autoscrollToggle.checked) {
    $messages.scrollTop = $messages.scrollHeight;
  }

  // Update last-seen timestamp
  const unix = p.unix || 0;
  if (unix > state.lastSeenUnix) {
    state.lastSeenUnix = unix;
    localStorage.setItem("nexus_last_seen", unix);
  }
}

// ── Filter Logic ──────────────────────────────────────────────
function isVisible(from, to, msgType) {
  // Hide status messages in chat
  if (msgType === "status") return false;

  // No agent selected → global stream
  if (state.activeFilter.size === 0) return true;
  
  // Single agent selected → show all messages to or from this agent
  if (state.activeFilter.size === 1) {
    return state.activeFilter.has(from) || state.activeFilter.has(to);
  }

  // Multiple agents selected → show messages only between the selected agents
  return state.activeFilter.has(from) && state.activeFilter.has(to);
}

function rerender() {
  $messages.innerHTML = "";
  state.messages.forEach(m => {
    const p = parseMessage(m);
    if (isVisible(p.from, p.to, p.type)) {
      const el = buildMessageEl(m);
      $messages.appendChild(el);
    }
  });
  const $autoscrollToggle = document.getElementById("autoscroll-toggle");
  if ($autoscrollToggle && $autoscrollToggle.checked) {
    $messages.scrollTop = $messages.scrollHeight;
  }
  updateRoomLabel();
}

function updateRoomLabel() {
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
  Object.keys(state.agents).sort().forEach(id => {
    const info = state.agents[id];
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
      rerender();
    });

    const dot  = document.createElement("span");
    dot.className = `dot dot-agent ${info.online ? 'online' : 'offline'}`;

    const name = document.createElement("span");
    name.textContent = id;
    if (!info.online) name.style.opacity = "0.5";

    label.append(cb, dot, name);
    $agentList.appendChild(label);
  });

  if (Object.keys(state.agents).length === 0) {
    $agentList.innerHTML = '<p class="hint">Warte auf Agenten…</p>';
  }
}

// ── Context Logic ──────────────────────────────────────────────
async function loadContextConfig() {
  try {
    const r = await fetch(`${API}/api/settings/context_limit`);
    const config = await r.json();
    $contextToggle.checked = config.enabled;
    $contextInput.value = config.limit;
    $contextInput.disabled = !config.enabled;
  } catch (e) {
    console.error("Failed to load context config:", e);
  }
}

async function updateContextConfig() {
  const enabled = $contextToggle.checked;
  const limit = parseInt($contextInput.value) || 10;
  $contextInput.disabled = !enabled;
  try {
    await fetch(`${API}/api/settings/context_limit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, limit }),
    });
  } catch (e) {
    console.error("Failed to update context config:", e);
  }
}

if ($contextToggle && $contextInput) {
  $contextToggle.addEventListener("change", updateContextConfig);
  $contextInput.addEventListener("change", updateContextConfig);
}

// ── Provider Logic ────────────────────────────────────────────
async function loadProviderConfig() {
  try {
    const r = await fetch(`${API}/api/settings/provider`);
    state.providerConfig = await r.json();
  } catch (e) {
    console.error("Failed to load provider config:", e);
  }
}

async function updateProvider(agentId, provider) {
  try {
    await fetch(`${API}/api/settings/provider`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: agentId, provider }),
    });
    state.providerConfig[agentId] = provider;
  } catch (e) {
    console.error("Failed to update provider:", e);
  }
}

function renderProviders() {
  if (!$providerList) return;
  $providerList.innerHTML = "";
  
  const relevantAgents = Object.keys(state.agents).filter(id => id !== "boss" && id !== "nexus");
  
  relevantAgents.sort().forEach(id => {
    const currentProvider = state.providerConfig[id] || "local";
    
    const row = document.createElement("div");
    row.className = "provider-row";
    
    row.innerHTML = `
      <div class="provider-agent">
        <span class="dot dot-agent"></span>
        <span>${id}</span>
      </div>
      <select class="provider-select" data-agent="${id}">
        <option value="local" ${currentProvider === 'local' ? 'selected' : ''}>Local</option>
        <option value="gemini" ${currentProvider === 'gemini' ? 'selected' : ''}>Gemini 3 Flash</option>
        <option value="gemini-pro" ${currentProvider === 'gemini-pro' ? 'selected' : ''}>Gemini 3.1 Pro (High)</option>
        <option value="gemini-3.5-flash" ${currentProvider === 'gemini-3.5-flash' ? 'selected' : ''}>Gemini 3.5 Flash</option>
        <option value="gemini-2.5-pro" ${currentProvider === 'gemini-2.5-pro' ? 'selected' : ''}>Gemini 2.5 Pro</option>
        <option value="gemini-2.5-flash" ${currentProvider === 'gemini-2.5-flash' ? 'selected' : ''}>Gemini 2.5 Flash</option>
      </select>
    `;
    
    $providerList.appendChild(row);
  });
  
  // Attach event listeners
  $providerList.querySelectorAll("select").forEach(select => {
    select.addEventListener("change", (e) => {
      updateProvider(e.target.dataset.agent, e.target.value);
    });
  });
  
  if (relevantAgents.length === 0) {
    $providerList.innerHTML = '<p class="hint">Warte auf Agenten…</p>';
  }
}

// ── LM Studio Logic ───────────────────────────────────────────
const $lmContent = document.getElementById("lmstudio-content");
const $lmRefreshBtn = document.getElementById("lm-refresh-btn");
const $lmLoadBtn = document.getElementById("lm-load-btn");

if ($lmRefreshBtn) {
  $lmRefreshBtn.addEventListener("click", () => {
    fetchLMStudioStatus();
  });
}

if ($lmLoadBtn) {
  $lmLoadBtn.addEventListener("click", async () => {
    const select = document.getElementById("lmstudio-select");
    if (!select || !select.value) return;
    
    $lmLoadBtn.disabled = true;
    select.disabled = true;
    
    try {
      await fetch(`${API}/api/lmstudio/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model_id: select.value })
      });
      // Visually indicate loading
      $lmLoadBtn.style.opacity = "0.5";
    } catch (e) {
      console.error(e);
      $lmLoadBtn.disabled = false;
      select.disabled = false;
    }
  });
}

async function fetchLMStudioStatus() {
  if (!$lmContent) return;
  
  $lmContent.innerHTML = '<p class="hint">Prüfe Status…</p>';
  
  try {
    const r = await fetch(`${API}/api/lmstudio/status`);
    const data = await r.json();
    renderLMStudioStatus(data);
  } catch (e) {
    console.error("Failed to fetch LM Studio status:", e);
    renderLMStudioStatus({ state: "offline", loaded_models: [], available_models: [] });
  }
}

function renderLMStudioStatus(data) {
  if (!$lmContent) return;
  $lmContent.innerHTML = "";
  
  // Render Status Badge
  const statusEl = document.createElement("div");
  statusEl.className = `lm-status-text lm-${data.state}`;
  if (data.state === "offline") statusEl.textContent = "❌ Offline";
  else if (data.state === "empty") statusEl.textContent = "⚠️ Leer";
  else if (data.state === "online") statusEl.textContent = "🟢 Online";
  $lmContent.appendChild(statusEl);

  const listEl = document.createElement("div");
  listEl.className = "lm-model-list";
  $lmContent.appendChild(listEl);

  // Render Loaded Models
  if (data.loaded_models && data.loaded_models.length > 0) {
    data.loaded_models.forEach(modelId => {
      const item = document.createElement("div");
      item.className = "lm-model-item";
      item.innerHTML = `
        <span class="lm-model-name" title="${modelId}">${modelId}</span>
        <button class="lm-btn unload" data-action="unload">Unload</button>
      `;
      listEl.appendChild(item);
      
      item.querySelector("button").addEventListener("click", async () => {
        await fetch(`${API}/api/lmstudio/unload`, { 
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model_id: modelId })
        });
        fetchLMStudioStatus();
      });
    });
  }

  // Render Available Models (to load)
  if (data.state !== "offline" && data.available_models) {
    const unloaded = data.available_models.filter(m => !data.loaded_models.includes(m));
    if (unloaded.length > 0) {
      if ($lmLoadBtn) {
        $lmLoadBtn.style.display = "inline-block";
        $lmLoadBtn.disabled = false;
        $lmLoadBtn.style.opacity = "1";
      }
      
      const wrapper = document.createElement("div");
      wrapper.className = "lm-select-wrapper";
      
      const select = document.createElement("select");
      select.id = "lmstudio-select";
      unloaded.forEach(m => {
        const opt = document.createElement("option");
        opt.value = m;
        opt.textContent = m.replace('lmstudio-community/', '');
        select.appendChild(opt);
      });
      
      wrapper.appendChild(select);
      listEl.appendChild(wrapper);
    } else {
      if ($lmLoadBtn) $lmLoadBtn.style.display = "none";
    }
  } else {
    if ($lmLoadBtn) $lmLoadBtn.style.display = "none";
  }
}


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
async function loadHistory(forceFull = false) {
  const since = forceFull ? 0 : state.lastSeenUnix;
  try {
    const r   = await fetch(`${API}/api/history?since=${since}`);
    const rows = await r.json();

    if (forceFull) {
      state.messages = [];
      $messages.innerHTML = "";
    }

    rows.reverse().forEach(row => {
      // DB rows have the full MQTT envelope in raw_payload
      const msg = row.raw_payload || row;
      appendMessage(msg);
    });
  } catch (e) {
    console.error("History load failed:", e);
  }
}

// ── History Toggle ────────────────────────────────────────────
$filterHistory.addEventListener("change", () => {
  if ($filterHistory.checked) {
    loadHistory(true);
  } else {
    // Optional: reload missed messages only
    state.messages = [];
    $messages.innerHTML = "";
    loadHistory(false);
  }
});

// ── Load known agents on start ────────────────────────────────
async function loadAgents() {
  try {
    const r = await fetch(`${API}/api/agents`);
    const list = await r.json();
    list.forEach(id => {
      if (!state.agents[id]) state.agents[id] = { online: true };
    });
    renderAgentCheckboxes();
    renderProviders();
  } catch {
    renderAgentCheckboxes();
    renderProviders();
  }
}

// ── IB Gateway Status ─────────────────────────────────────────
async function fetchIBGatewayStatus() {
  const $live  = document.getElementById("ib-live-btn");
  const $paper = document.getElementById("ib-paper-btn");
  if (!$live || !$paper) return;
  try {
    const r    = await fetch(`${API}/api/settings/ib_gateway_status`);
    const data = await r.json();
    // data = { active_mode, live: {docker_running, connected}, paper: {docker_running, connected} }
    applyModeBtnState("live",  data.live  || {}, data.active_mode === "live");
    applyModeBtnState("paper", data.paper || {}, data.active_mode === "paper");
  } catch (e) {
    console.error("Failed to fetch IB Gateway status:", e);
    [$live, $paper].forEach(el => {
      el.style.color = "var(--offline)";
      el.style.boxShadow = "none";
      el.dataset.state = "red";
    });
  }
}

function applyModeBtnState(mode, status, isActive) {
  const btn = document.getElementById(`ib-${mode}-btn`);
  if (!btn) return;
  let color, shadow, state;
  if (!status.docker_running) {
    color  = "#ef4444"; shadow = "0 0 8px rgba(239,68,68,0.5)";  state = "red";    // 🔴 gestoppt
  } else if (!status.connected) {
    color  = "#f59e0b"; shadow = "0 0 8px rgba(245,158,11,0.5)"; state = "yellow"; // 🟡 läuft, kein Login
  } else {
    color  = "#22c55e"; shadow = "0 0 8px rgba(34,197,94,0.5)";  state = "green";  // 🟢 verbunden
  }
  btn.style.color       = color;
  btn.style.textShadow  = shadow;
  btn.style.borderColor = color;
  btn.style.opacity     = isActive ? "1" : "0.55";
  btn.style.fontWeight  = isActive ? "800" : "600";
  btn.style.textDecoration = isActive ? "underline" : "none";
  btn.dataset.state = state;
  // Tooltip
  const labels = { red: "gestoppt", yellow: "läuft – warte auf Login", green: "verbunden" };
  const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
  btn.title = `IBKR-${modeLabel}: ${labels[state]}${isActive ? " (aktiv)" : " – klicken zum Aktivieren"}`;
}

// ── IBKR Mode Button Click Handlers ──────────────────────────
["live", "paper"].forEach(mode => {
  const btn = document.getElementById(`ib-${mode}-btn`);
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const state = btn.dataset.state; // "red" | "yellow" | "green"
    btn.style.opacity = "0.4";

    try {
      if (state === "green") {
        // 🟢 → Container stoppen
        await fetch(`${API}/api/settings/ib_gateway/stop_container`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode })
        });
      } else {
        // 🔴 / 🟡 → zu diesem Mode wechseln (startet Container automatisch falls nötig)
        await fetch(`${API}/api/settings/ib_gateway_mode`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode })
        });
      }
    } catch (e) {
      console.error(`IBKR ${mode} button error:`, e);
    } finally {
      btn.style.opacity = "";
      setTimeout(fetchIBGatewayStatus, 800);
    }
  });
});


// ── Boot ──────────────────────────────────────────────────────
(async () => {
  $sendFrom.value = "boss"; // Initial value
  await loadContextConfig();
  await loadProviderConfig();
  await loadAgents();
  await loadHistory();
  fetchLMStudioStatus();
  fetchIBGatewayStatus();
  setInterval(fetchIBGatewayStatus, 5000);
  connectSSE();
  updateRoomLabel();
})();
