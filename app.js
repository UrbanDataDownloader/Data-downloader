const messagesEl = document.getElementById("messages");
const form = document.getElementById("form");
const topicInput = document.getElementById("topicInput");
const sendBtn = document.getElementById("sendBtn");
const methodSelect = document.getElementById("methodSelect");
const paramFields = document.getElementById("paramFields");
const historyDrawer = document.getElementById("historyDrawer");
const historyToggle = document.getElementById("historyToggle");
const historyList = document.getElementById("historyList");
const newChatBtn = document.getElementById("newChatBtn");
const methodBadge = document.getElementById("methodBadge");
const authOverlay = document.getElementById("authOverlay");
const authForm = document.getElementById("authForm");
const authMode = document.getElementById("authMode");
const authAccessPassword = document.getElementById("authAccessPassword");
const authUsername = document.getElementById("authUsername");
const authUsernameHint = document.getElementById("authUsernameHint");
const authPassword = document.getElementById("authPassword");
const authConfirmPassword = document.getElementById("authConfirmPassword");
const authAdminPassword = document.getElementById("authAdminPassword");
const authAccessWrap = document.getElementById("authAccessWrap");
const authUserWrap = document.getElementById("authUserWrap");
const authPassWrap = document.getElementById("authPassWrap");
const authConfirmWrap = document.getElementById("authConfirmWrap");
const authAdminWrap = document.getElementById("authAdminWrap");
const authError = document.getElementById("authError");
const authLogout = document.getElementById("authLogout");
const APP_CONFIG = window.__APP_CONFIG__ || {};
const API_BASE = String(APP_CONFIG.API_BASE || "").replace(/\/+$/, "");
const AUTH_TOKEN_KEY = "urban_ai_auth_token";
const AUTH_USER_KEY = "urban_ai_auth_user";

const STEP_KEYS = [
  "generation_config",
  "input_topic",
  "query_4_retrieval",
  "retrieval_indices",
  "generate_camp",
  "new_idea",
  "idea_review",
  "novelty_analysis",
  "dataset_search",
];

const RUNNING_STATUS_TEXT = "正在运行...";
let registry = {};
let authToken = "";
let currentUser = null;
let usernameCheckState = {
  valid: false,
  available: false,
  checkedValue: "",
};
let authConfig = {
  require_access_password_for_register: true,
  admin_enabled: true,
};
let currentConversation = {
  mode: "new", // "new" | "history"
  filename: null,
  owner: null,
};

const HISTORY_OPEN_KEY = "urban_ai_history_drawer_open";
const MAX_TEXTAREA_HEIGHT = 220;

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function apiUrl(path) {
  if (!path.startsWith("/")) {
    throw new Error(`API path must start with "/": ${path}`);
  }
  return `${API_BASE}${path}`;
}

function datasetReviewUrl(filename, owner) {
  const params = new URLSearchParams();
  params.set("filename", filename);
  if (owner) params.set("owner", owner);
  return `./datasets.html?${params.toString()}`;
}

async function apiFetch(path, options) {
  const opts = options ? { ...options } : {};
  const headers = opts.headers ? { ...opts.headers } : {};
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  opts.headers = headers;
  return fetch(apiUrl(path), opts);
}

function showAuthOverlay() {
  if (!authOverlay) return;
  authOverlay.hidden = false;
  authOverlay.style.display = "flex";
  updateAuthFormByMode();
}

function hideAuthOverlay() {
  if (!authOverlay) return;
  authOverlay.hidden = true;
  authOverlay.style.display = "none";
  if (authError) authError.textContent = "";
}

function saveAuthSession(token, user) {
  authToken = token || "";
  currentUser = user || null;
  try {
    sessionStorage.setItem(AUTH_TOKEN_KEY, authToken);
    sessionStorage.setItem(AUTH_USER_KEY, JSON.stringify(currentUser || null));
  } catch (_) {}
}

function clearAuthSession() {
  authToken = "";
  currentUser = null;
  try {
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    sessionStorage.removeItem(AUTH_USER_KEY);
  } catch (_) {}
}

async function validateSession() {
  const res = await apiFetch("/api/auth/me");
  if (!res.ok) {
    let msg = `认证失败（HTTP ${res.status}）`;
    const payload = await res.json().catch(() => ({}));
    if (res.status === 401) msg = "登录已失效，请重新登录。";
    else if (payload && typeof payload.detail === "string") msg = payload.detail;
    throw new Error(msg);
  }
  const payload = await res.json().catch(() => ({}));
  currentUser = payload.user || currentUser;
}

async function loadAuthConfig() {
  try {
    const res = await fetch(apiUrl("/api/auth/config"));
    if (!res.ok) return;
    const payload = await res.json().catch(() => ({}));
    if (payload && typeof payload === "object") {
      authConfig = {
        require_access_password_for_register:
          payload.require_access_password_for_register !== false,
        admin_enabled: payload.admin_enabled !== false,
      };
    }
  } catch (_) {}
}

function updateAuthFormByMode() {
  if (!authMode) return;
  const mode = authMode.value;
  const isRegister = mode === "register";
  const isAdmin = mode === "admin";
  const requireAccess = !!authConfig.require_access_password_for_register;

  function setWrapState(wrapEl, visible) {
    if (!wrapEl) return;
    wrapEl.hidden = !visible;
    wrapEl.querySelectorAll("input,select,textarea,button").forEach((el) => {
      el.disabled = !visible;
    });
  }

  setWrapState(authAccessWrap, !isAdmin && isRegister && requireAccess);
  setWrapState(authUserWrap, !isAdmin);
  setWrapState(authPassWrap, !isAdmin);
  setWrapState(authConfirmWrap, isRegister);
  setWrapState(authAdminWrap, isAdmin);

  if (authAccessPassword) authAccessPassword.required = isRegister && requireAccess;
  if (authUsername) authUsername.required = !isAdmin;
  if (authPassword) authPassword.required = !isAdmin;
  if (authConfirmPassword) authConfirmPassword.required = isRegister;
  if (authAdminPassword) authAdminPassword.required = isAdmin;

  if (authError) authError.textContent = "";
  if (authUsernameHint) authUsernameHint.textContent = "";
  usernameCheckState = { valid: false, available: false, checkedValue: "" };

  if (isAdmin && authAdminPassword) authAdminPassword.focus();
  if (!isAdmin && authUsername) authUsername.focus();
}

function showUsernameHint(text, isError = false) {
  if (!authUsernameHint) return;
  authUsernameHint.textContent = text || "";
  authUsernameHint.classList.toggle("error", !!isError);
}

function isRegisterMode() {
  return !!authMode && authMode.value === "register";
}

async function checkUsernameAvailability() {
  if (!authUsername) return false;
  const username = authUsername.value.trim();
  if (!username) {
    usernameCheckState = { valid: false, available: false, checkedValue: "" };
    showUsernameHint("");
    return false;
  }

  try {
    const res = await fetch(
      apiUrl(`/api/auth/check-username?username=${encodeURIComponent(username)}`)
    );
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      showUsernameHint("用户名校验失败，请重试。", true);
      usernameCheckState = { valid: false, available: false, checkedValue: username };
      return false;
    }

    const valid = !!payload.valid;
    const available = !!payload.available;
    usernameCheckState = { valid, available, checkedValue: username };
    showUsernameHint(payload.message || "", !(valid && available));
    return valid && available;
  } catch (_) {
    showUsernameHint("用户名校验失败，请重试。", true);
    usernameCheckState = { valid: false, available: false, checkedValue: username };
    return false;
  }
}

async function initializeAfterAuth() {
  try {
    await Promise.all([loadMethods(), refreshHistoryList()]);
    startNewConversation();
    updateSendButtonState();
    autoResizeTopicInput();
    try {
      if (localStorage.getItem(HISTORY_OPEN_KEY) === "1") {
        setHistoryOpen(true);
      }
    } catch (_) {}
    await maybeLoadHistoryFromQuery();
  } catch (err) {
    console.error("Initialize after auth failed:", err);
  }
}

function stepLabelsForMethod(methodId) {
  const m = registry[methodId] || Object.values(registry)[0] || {};
  return m.step_labels || {};
}

function updateSendButtonState() {
  const hasTopic = !!topicInput.value.trim();
  sendBtn.disabled = !hasTopic;
}

function updateComposerModeUI() {
  if (currentConversation.mode === "history" && currentConversation.filename) {
    topicInput.placeholder = "输入你对该 Idea 的评价/补充，提交后仅记录；点击 Generate_response 才触发 LLM 回复";
    sendBtn.textContent = "记录";
  } else {
    topicInput.placeholder = "输入研究主题或关键词，例如：城市热岛与公共健康";
    sendBtn.textContent = "生成";
  }
}

function startNewConversation() {
  currentConversation = {
    mode: "new",
    filename: null,
    owner: null,
  };
  resetConversation();
  updateComposerModeUI();
  topicInput.value = "";
  updateSendButtonState();
  autoResizeTopicInput();
  topicInput.focus();
}

function activateHistoryConversation(filename, owner = null) {
  currentConversation = {
    mode: "history",
    filename,
    owner,
  };
  updateComposerModeUI();
}

function autoResizeTopicInput() {
  topicInput.style.height = "auto";
  const next = Math.min(topicInput.scrollHeight, MAX_TEXTAREA_HEIGHT);
  topicInput.style.height = `${Math.max(next, 52)}px`;
  topicInput.style.overflowY = topicInput.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
}

function updateMethodBadge(methodId) {
  if (!methodBadge) return;
  const meta = registry[methodId] || {};
  methodBadge.textContent = `Method: ${meta.label || methodId || "-"}`;
}

function resetConversation() {
  messagesEl.innerHTML = "";
}

function labelForKey(key, labels) {
  if (key === "generation_config") return "Generation Config";
  if (key === "idea_review") return "Idea Reviewer";
  if (key === "novelty_analysis") return "Novelty Analysis";
  if (key === "dataset_search") return "Dataset Search";
  return labels[key] || key;
}

function appendUserMessage(text) {
  const div = document.createElement("div");
  div.className = "msg user";
  div.innerHTML = `<div class="msg-role">User</div><div>${esc(text)}</div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function appendAssistantTextMessage(text) {
  const div = document.createElement("div");
  div.className = "msg assistant";
  div.innerHTML = `<div class="msg-role">Assistant</div><div>${esc(text)}</div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function appendAssistantShell({ running = true } = {}) {
  const div = document.createElement("div");
  div.className = `msg assistant${running ? " running" : ""}`;
  div.innerHTML = `
    <div class="msg-role">Assistant</div>
    <div class="steps"></div>
    <div class="status-line muted">${RUNNING_STATUS_TEXT}</div>
    <div class="msg-actions"></div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function addStep(container, key, label, data) {
  const wrap = document.createElement("div");
  wrap.className = "step done";
  wrap.dataset.stepKey = key;
  const id = `step-${key}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  wrap.innerHTML = `
    <details open>
      <summary><span>${esc(label)}</span> <span class="muted" style="font-weight:400;font-size:0.8rem">(${esc(key)})</span></summary>
      <pre class="step-body" id="${id}"></pre>
    </details>`;
  container.appendChild(wrap);
  const pre = wrap.querySelector(`#${CSS.escape(id)}`);
  pre.textContent = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return wrap;
}

function payloadForHistoryStep(key, data) {
  if (key === "retrieval_indices" && data.retrieval_indices !== undefined) {
    return {
      indices: data.retrieval_indices,
      preview: data.retrieval_preview || [],
    };
  }
  if (key === "input_topic") return data.input_topic;
  if (key === "idea_review") return data.idea_review;
  if (key === "novelty_analysis") return data.novelty_analysis;
  if (key === "dataset_search") return data.dataset_search;
  return data[key];
}

function readErrorMessage(payload, fallback = "Request failed") {
  if (!payload) return fallback;
  if (typeof payload === "string") return payload;
  if (typeof payload.detail === "string") return payload.detail;
  if (typeof payload.message === "string") return payload.message;
  return fallback;
}

async function readHistoryPayload(filename, owner = null) {
  const qs = owner ? `?owner=${encodeURIComponent(owner)}` : "";
  const res = await apiFetch(`/api/history/${encodeURIComponent(filename)}${qs}`);
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHistoryField(filename, owner, field, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 18000;
  const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 1200;
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    const latest = await readHistoryPayload(filename, owner).catch(() => null);
    if (latest && latest[field] !== undefined) {
      return latest[field];
    }
    await sleep(intervalMs);
  }
  return undefined;
}

function mountActionButtons(actionsEl, stepsEl, statusEl, filename, owner) {
  if (!actionsEl || !filename) return;
  actionsEl.innerHTML = "";

  function upsertStep(key, label, payload) {
    const existing = stepsEl.querySelector(`[data-step-key="${key}"]`);
    if (existing) existing.remove();
    addStep(stepsEl, key, label, payload);
  }

  const reviewBtn = document.createElement("button");
  reviewBtn.type = "button";
  reviewBtn.className = "action-btn";
  reviewBtn.textContent = "Idea_reviewer";

  reviewBtn.addEventListener("click", async () => {
    reviewBtn.disabled = true;
    statusEl.textContent = "正在调用 IdeaReviewer...";
    statusEl.classList.remove("error", "muted");

    try {
      const res = await apiFetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, owner }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(readErrorMessage(payload, `HTTP ${res.status}`));
      }

      upsertStep("idea_review", "Idea Reviewer", payload.review);

      statusEl.textContent = "IdeaReviewer 已完成并写入历史记录。";
      statusEl.classList.remove("error", "muted");
      await refreshHistoryList();
    } catch (e) {
      statusEl.textContent = `IdeaReviewer 调用失败: ${e}`;
      statusEl.classList.add("error");
    } finally {
      reviewBtn.disabled = false;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  });

  const noveltyBtn = document.createElement("button");
  noveltyBtn.type = "button";
  noveltyBtn.className = "action-btn";
  noveltyBtn.textContent = "Novelty_analysis";

  noveltyBtn.addEventListener("click", async () => {
    noveltyBtn.disabled = true;
    statusEl.textContent = "正在调用 Novelty Analysis...";
    statusEl.classList.remove("error", "muted");

    try {
      const res = await apiFetch("/api/novelty", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, owner }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(readErrorMessage(payload, `HTTP ${res.status}`));
      }

      upsertStep("novelty_analysis", "Novelty Analysis", payload.novelty_analysis);

      statusEl.textContent = "Novelty Analysis 已完成并写入历史记录。";
      statusEl.classList.remove("error", "muted");
      await refreshHistoryList();
    } catch (e) {
      let recovered = false;
      try {
        statusEl.textContent = "请求返回异常，正在自动回查 Novelty Analysis 结果...";
        statusEl.classList.remove("error", "muted");
        const novelty = await waitForHistoryField(filename, owner, "novelty_analysis", {
          timeoutMs: 20000,
          intervalMs: 1200,
        });
        if (novelty !== undefined) {
          upsertStep("novelty_analysis", "Novelty Analysis", novelty);
          statusEl.textContent = "Novelty Analysis 已完成（请求返回异常，但结果已成功写入历史记录）。";
          statusEl.classList.remove("error", "muted");
          await refreshHistoryList();
          recovered = true;
        }
      } catch (_) {}

      if (!recovered) {
        statusEl.textContent = `Novelty Analysis 调用失败: ${e}`;
        statusEl.classList.add("error");
      }
    } finally {
      noveltyBtn.disabled = false;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  });

  actionsEl.appendChild(reviewBtn);
  actionsEl.appendChild(noveltyBtn);

  const datasetBtn = document.createElement("button");
  datasetBtn.type = "button";
  datasetBtn.className = "action-btn";
  datasetBtn.textContent = "Dataset_search";

  datasetBtn.addEventListener("click", () => {
    window.location.href = datasetReviewUrl(filename, owner || "");
  });

  actionsEl.appendChild(datasetBtn);

  const genRespBtn = document.createElement("button");
  genRespBtn.type = "button";
  genRespBtn.className = "action-btn";
  genRespBtn.textContent = "Generate_response";

  genRespBtn.addEventListener("click", async () => {
    genRespBtn.disabled = true;
    statusEl.textContent = "正在生成 LLM 回复...";
    statusEl.classList.remove("error", "muted");

    try {
      const res = await apiFetch("/api/chat/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, owner }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(readErrorMessage(payload, `HTTP ${res.status}`));
      }

      appendAssistantTextMessage(payload.reply || "(空响应)");
      const n = Number(payload.consumed_user_notes || 0);
      statusEl.textContent = `已生成回复（合并 ${Number.isFinite(n) ? n : 0} 条待回复输入）。`;
      statusEl.classList.remove("error", "muted");
      await refreshHistoryList();
    } catch (e) {
      statusEl.textContent = `Generate_response 调用失败: ${e}`;
      statusEl.classList.add("error");
    } finally {
      genRespBtn.disabled = false;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  });

  actionsEl.appendChild(genRespBtn);
}

function renderHistoryRecord(data, filename, owner = null) {
  activateHistoryConversation(filename, owner);
  resetConversation();
  const topic = data.input_topic || "(No Topic)";
  appendUserMessage(topic);
  const assistantEl = appendAssistantShell({ running: false });
  const stepsEl = assistantEl.querySelector(".steps");
  const statusEl = assistantEl.querySelector(".status-line");
  const actionsEl = assistantEl.querySelector(".msg-actions");
  const labels = stepLabelsForMethod(methodSelect.value);

  for (const key of STEP_KEYS) {
    if (key === "input_topic") {
      if (data.input_topic !== undefined) {
        addStep(stepsEl, key, labelForKey(key, labels), data.input_topic);
      }
      continue;
    }
    if (data[key] === undefined && !(key === "retrieval_indices" && data.retrieval_indices !== undefined)) {
      continue;
    }
    const payload = payloadForHistoryStep(key, data);
    if (payload === undefined) continue;
    addStep(stepsEl, key, labelForKey(key, labels), payload);
  }

  statusEl.textContent = "以上为历史记录，可继续提问。";
  statusEl.classList.remove("muted", "error");
  mountActionButtons(actionsEl, stepsEl, statusEl, filename, owner);

  if (Array.isArray(data.chat_history)) {
    for (const turn of data.chat_history) {
      if (!turn || typeof turn !== "object") continue;
      const role = String(turn.role || "").toLowerCase();
      const content = String(turn.content || "").trim();
      if (!content) continue;
      if (role === "user") appendUserMessage(content);
      if (role === "assistant") appendAssistantTextMessage(content);
    }
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderParamForm(methodId) {
  const meta = registry[methodId];
  paramFields.innerHTML = "";
  if (!meta || !meta.params) return;
  for (const p of meta.params) {
    const field = document.createElement("div");
    field.className = "field";
    const inputId = `param-${p.id}`;
    let inputHtml = "";
    if (p.type === "float" || p.type === "int") {
      const min = p.min != null ? ` min="${p.min}"` : "";
      const max = p.max != null ? ` max="${p.max}"` : "";
      const step = p.type === "int" ? ` step="1"` : ` step="0.05"`;
      inputHtml = `<input type="number" id="${inputId}" data-param="${p.id}" value="${p.default}"${min}${max}${step} />`;
    } else if (p.type === "select" && Array.isArray(p.options)) {
      const optionsHtml = p.options
        .map((opt) => {
          const selected = String(opt) === String(p.default) ? " selected" : "";
          return `<option value="${esc(String(opt))}"${selected}>${esc(String(opt))}</option>`;
        })
        .join("");
      inputHtml = `<select id="${inputId}" data-param="${p.id}">${optionsHtml}</select>`;
    } else {
      inputHtml = `<input type="text" id="${inputId}" data-param="${p.id}" value="${esc(String(p.default))}" />`;
    }
    const desc = p.description ? `<small>${esc(p.description)}</small>` : "";
    field.innerHTML = `<label for="${inputId}">${esc(p.label)}</label>${inputHtml}${desc}`;
    paramFields.appendChild(field);
  }
}

function collectParams() {
  const out = {};
  paramFields.querySelectorAll("[data-param]").forEach((el) => {
    const id = el.getAttribute("data-param");
    if (el.type === "number") {
      const raw = el.value;
      out[id] = raw.includes(".") ? parseFloat(raw) : parseInt(raw, 10);
    } else {
      out[id] = el.value;
    }
  });
  return out;
}

function setHistoryOpen(open) {
  historyDrawer.classList.toggle("open", open);
  historyToggle.setAttribute("aria-expanded", open ? "true" : "false");
  try {
    localStorage.setItem(HISTORY_OPEN_KEY, open ? "1" : "0");
  } catch (_) {}
}

historyToggle.addEventListener("click", () => {
  setHistoryOpen(!historyDrawer.classList.contains("open"));
});

if (newChatBtn) {
  newChatBtn.addEventListener("click", () => {
    startNewConversation();
    setHistoryOpen(false);
  });
}

if (authLogout) {
  authLogout.addEventListener("click", async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch (_) {}
    clearAuthSession();
    showAuthOverlay();
  });
}

async function loadMethods() {
  const res = await apiFetch("/api/methods");
  registry = await res.json();
  methodSelect.innerHTML = "";
  for (const [id, meta] of Object.entries(registry)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = meta.label || id;
    methodSelect.appendChild(opt);
  }
  const first = Object.keys(registry)[0];
  if (first) {
    methodSelect.value = first;
    renderParamForm(first);
    updateMethodBadge(first);
  } else {
    updateMethodBadge("");
  }
}

async function refreshHistoryList() {
  try {
    const res = await apiFetch("/api/history");
    const { items } = await res.json();
    historyList.innerHTML = "";
    if (!items || !items.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.style.padding = "0.5rem 0";
      li.textContent = "暂无记录";
      historyList.appendChild(li);
      return;
    }
    for (const it of items) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "history-item";
      const topicLine = it.topic || it.filename.replace(/\.json$/i, "");
      const ownerText = it.owner ? `[${it.owner}] ` : "";
      const tstr = it.modified
        ? new Date(it.modified * 1000).toLocaleString()
        : "";
      btn.innerHTML = `<span class="history-item-top"><span class="hi-icon" aria-hidden="true">◷</span><span class="hi-topic">${esc(ownerText + topicLine)}</span></span><span class="hi-meta">${esc(it.filename)}${tstr ? " | " + esc(tstr) : ""}</span>`;
      btn.addEventListener("click", () => loadHistoryFile(it.filename, it.owner || null));
      li.appendChild(btn);
      historyList.appendChild(li);
    }
  } catch (e) {
    historyList.innerHTML = "";
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "加载历史失败";
    historyList.appendChild(li);
  }
}

async function loadHistoryFile(filename, owner = null) {
  try {
    const qs = owner ? `?owner=${encodeURIComponent(owner)}` : "";
    const res = await apiFetch(`/api/history/${encodeURIComponent(filename)}${qs}`);
    if (!res.ok) return false;
    const data = await res.json();
    renderHistoryRecord(data, filename, owner);
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

async function loadLatestHistoryRecord(owner = null) {
  const qs = owner ? `?owner=${encodeURIComponent(owner)}` : "";
  const res = await apiFetch(`/api/history${qs}`);
  if (!res.ok) return false;
  const payload = await res.json().catch(() => ({}));
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length || !items[0].filename) return false;
  const latest = items[0];
  await loadHistoryFile(latest.filename, latest.owner || owner || null);
  return true;
}

function maybeLoadHistoryFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const filename = params.get("history");
  const owner = params.get("owner");
  if (!filename) return Promise.resolve(false);
  return loadHistoryFile(filename, owner);
}

methodSelect.addEventListener("change", () => {
  renderParamForm(methodSelect.value);
  updateMethodBadge(methodSelect.value);
});

topicInput.addEventListener("input", () => {
  updateSendButtonState();
  autoResizeTopicInput();
});

topicInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!sendBtn.disabled) {
      form.requestSubmit();
    }
  }
});

async function parseSSEStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];

  function parseDataLine(trimmedLine) {
    if (!trimmedLine.startsWith("data:")) return;
    const jsonStr = trimmedLine.slice(5).trim();
    if (!jsonStr) return;
    try {
      events.push(JSON.parse(jsonStr));
    } catch (e) {
      console.warn("SSE JSON parse failed", e, jsonStr.slice(0, 120));
    }
  }

  function flushCompleteMessages(buf) {
    const parts = buf.split(/\r?\n\r?\n/);
    const pending = parts.pop() ?? "";
    for (const block of parts) {
      for (const rawLine of block.split(/\r?\n/)) {
        parseDataLine(rawLine.trim());
      }
    }
    return pending;
  }

  while (true) {
    const { done, value } = await reader.read();
    if (value && value.byteLength > 0) {
      buffer += decoder.decode(value, { stream: true });
      buffer = flushCompleteMessages(buffer);
    }
    if (done) {
      buffer += decoder.decode();
      buffer = flushCompleteMessages(buffer);
      const tail = buffer.trim();
      if (tail.startsWith("data:")) {
        parseDataLine(tail);
      }
      break;
    }
  }
  return events;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const inputText = topicInput.value.trim();
  if (!inputText) return;

  if (currentConversation.mode === "history" && currentConversation.filename) {
    sendBtn.disabled = true;
    appendUserMessage(inputText);

    try {
      const res = await apiFetch("/api/chat/note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: currentConversation.filename,
          owner: currentConversation.owner,
          message: inputText,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(readErrorMessage(payload, `HTTP ${res.status}`));
      }
      await refreshHistoryList();
    } catch (err) {
      appendAssistantTextMessage(`记录失败：${String(err)}`);
    } finally {
      sendBtn.disabled = false;
      topicInput.value = "";
      updateSendButtonState();
      autoResizeTopicInput();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    return;
  }

  const topic = inputText;
  sendBtn.disabled = true;
  resetConversation();
  appendUserMessage(topic);
  const assistantEl = appendAssistantShell();
  const stepsEl = assistantEl.querySelector(".steps");
  const statusEl = assistantEl.querySelector(".status-line");
  const actionsEl = assistantEl.querySelector(".msg-actions");

  const params = collectParams();
  const body = {
    topic,
    method: methodSelect.value,
    ...params,
  };

  let res;
  try {
    res = await apiFetch("/api/generate/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      statusEl.textContent = `请求失败: ${res.status}`;
      statusEl.classList.add("error");
      assistantEl.classList.remove("running");
      return;
    }
    const evs = await parseSSEStream(res);
    for (const ev of evs) {
      if (ev.event === "step") {
        addStep(stepsEl, ev.key, labelForKey(ev.key, stepLabelsForMethod(body.method)), ev.data);
      } else if (ev.event === "done") {
        statusEl.textContent = `已完成，已保存：${ev.path || ""}`;
        statusEl.classList.remove("muted", "error");
        assistantEl.classList.remove("running");
        mountActionButtons(actionsEl, stepsEl, statusEl, ev.filename, ev.owner || null);
        activateHistoryConversation(ev.filename, ev.owner || null);
      } else if (ev.event === "error") {
        statusEl.textContent = ev.message || "未知错误";
        statusEl.classList.add("error");
        assistantEl.classList.remove("running");
      }
    }
    if (assistantEl.classList.contains("running")) {
      assistantEl.classList.remove("running");
      if (statusEl.textContent === RUNNING_STATUS_TEXT) {
        let autoLoaded = false;
        try {
          autoLoaded = await loadLatestHistoryRecord(currentUser ? currentUser.username : null);
          if (autoLoaded) {
            await refreshHistoryList();
          }
        } catch (_) {}

        if (!autoLoaded) {
          statusEl.textContent =
            "流已结束但未收到完成信号。若 results/web_run 下已有新 JSON，可点击“历史”刷新列表。";
          statusEl.classList.remove("muted");
        }
      }
    }
  } catch (err) {
    statusEl.textContent = String(err);
    statusEl.classList.add("error");
    assistantEl.classList.remove("running");
  } finally {
    sendBtn.disabled = false;
    topicInput.value = "";
    updateSendButtonState();
    autoResizeTopicInput();
    updateComposerModeUI();
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (res && res.ok) {
      refreshHistoryList();
    }
  }
});

if (authMode) {
  authMode.addEventListener("change", updateAuthFormByMode);
}

if (authUsername) {
  authUsername.addEventListener("blur", async () => {
    if (!isRegisterMode()) return;
    await checkUsernameAvailability();
  });
  authUsername.addEventListener("input", () => {
    if (!isRegisterMode()) return;
    usernameCheckState = {
      valid: false,
      available: false,
      checkedValue: authUsername.value.trim(),
    };
    showUsernameHint("将自动检测用户名是否可用。");
  });
}

if (authForm) authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const mode = authMode ? authMode.value : "login";

  try {
    authError.textContent = "";
    let path = "/api/auth/login";
    let body = {};

    if (mode === "register") {
      const username = authUsername ? authUsername.value.trim() : "";
      if (
        usernameCheckState.checkedValue !== username ||
        !usernameCheckState.valid ||
        !usernameCheckState.available
      ) {
        const ok = await checkUsernameAvailability();
        if (!ok) {
          throw new Error("用户名不合法或已存在，请更换用户名。");
        }
      }
      path = "/api/auth/register";
      body = {
        access_password: authAccessPassword ? authAccessPassword.value.trim() : "",
        username,
        password: authPassword ? authPassword.value : "",
        confirm_password: authConfirmPassword ? authConfirmPassword.value : "",
      };
    } else if (mode === "admin") {
      path = "/api/auth/admin-login";
      body = {
        admin_password: authAdminPassword ? authAdminPassword.value.trim() : "",
      };
    } else {
      body = {
        username: authUsername ? authUsername.value.trim() : "",
        password: authPassword ? authPassword.value : "",
      };
    }

    const res = await apiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(readErrorMessage(payload, `认证失败（HTTP ${res.status}）`));
    }

    saveAuthSession(payload.token, payload.user || null);
    hideAuthOverlay();
    await initializeAfterAuth();
  } catch (err) {
    authError.textContent = String(err.message || err);
  }
});

(async function bootstrapAuth() {
  try {
    await loadAuthConfig();
    if (authMode && !authConfig.admin_enabled) {
      const adminOption = authMode.querySelector('option[value="admin"]');
      if (adminOption) adminOption.remove();
      if (authMode.value === "admin") authMode.value = "login";
    }

    const token = sessionStorage.getItem(AUTH_TOKEN_KEY) || "";
    const userRaw = sessionStorage.getItem(AUTH_USER_KEY) || "";
    const user = userRaw ? JSON.parse(userRaw) : null;
    if (token) {
      saveAuthSession(token, user);
      await validateSession();
      hideAuthOverlay();
      await initializeAfterAuth();
      return;
    }
  } catch (_) {
    clearAuthSession();
  }
  showAuthOverlay();
})();
