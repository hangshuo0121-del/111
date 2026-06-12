const STORAGE = {
  sessions: "web-agent.sessions",
  activeSession: "web-agent.activeSession",
  settings: "web-agent.settings",
  apiKey: "web-agent.apiKey",
  apiBaseUrl: "web-agent.apiBaseUrl",
  apiMode: "web-agent.apiMode"
};

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
const DEFAULT_CLAUDE_MODEL = "claude-fable-5";
const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";

const els = {
  sidebar: document.querySelector("#sidebar"),
  keyStatus: document.querySelector("#keyStatus"),
  newChatButton: document.querySelector("#newChatButton"),
  sessionList: document.querySelector("#sessionList"),
  settingsButton: document.querySelector("#settingsButton"),
  logoutButton: document.querySelector("#logoutButton"),
  menuButton: document.querySelector("#menuButton"),
  chatTitle: document.querySelector("#chatTitle"),
  chatMeta: document.querySelector("#chatMeta"),
  modelSelect: document.querySelector("#modelSelect"),
  exportChatButton: document.querySelector("#exportChatButton"),
  messageStage: document.querySelector("#messageStage"),
  emptyState: document.querySelector("#emptyState"),
  messages: document.querySelector("#messages"),
  attachmentList: document.querySelector("#attachmentList"),
  composer: document.querySelector("#composer"),
  attachButton: document.querySelector("#attachButton"),
  fileInput: document.querySelector("#fileInput"),
  promptInput: document.querySelector("#promptInput"),
  sendButton: document.querySelector("#sendButton"),
  dropHint: document.querySelector("#dropHint"),
  loginModal: document.querySelector("#loginModal"),
  loginForm: document.querySelector("#loginForm"),
  loginSubcopy: document.querySelector("#loginSubcopy"),
  apiKeyInput: document.querySelector("#apiKeyInput"),
  apiBaseUrlInput: document.querySelector("#apiBaseUrlInput"),
  apiModeSelect: document.querySelector("#apiModeSelect"),
  rememberKeyInput: document.querySelector("#rememberKeyInput"),
  settingsModal: document.querySelector("#settingsModal"),
  settingsForm: document.querySelector("#settingsForm"),
  instructionsInput: document.querySelector("#instructionsInput"),
  reasoningSelect: document.querySelector("#reasoningSelect"),
  verbositySelect: document.querySelector("#verbositySelect"),
  webSearchInput: document.querySelector("#webSearchInput"),
  closeSettingsButton: document.querySelector("#closeSettingsButton"),
  toast: document.querySelector("#toast")
};

let state = {
  sessions: [],
  activeSessionId: "",
  settings: {
    model: "gpt-5.5",
    instructions: "",
    reasoningEffort: "",
    verbosity: "",
    webSearch: false
  },
  apiKey: "",
  apiBaseUrl: "",
  apiMode: "responses",
  useServerKey: false,
  attachments: [],
  sending: false
};

function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || "") || fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function getStoredApiKey() {
  return sessionStorage.getItem(STORAGE.apiKey) || localStorage.getItem(STORAGE.apiKey) || "";
}

function getStoredConnection() {
  return {
    apiKey: getStoredApiKey(),
    apiBaseUrl: sessionStorage.getItem(STORAGE.apiBaseUrl) || localStorage.getItem(STORAGE.apiBaseUrl) || "",
    apiMode: sessionStorage.getItem(STORAGE.apiMode) || localStorage.getItem(STORAGE.apiMode) || "responses"
  };
}

function setStoredConnection(connection, remember) {
  sessionStorage.removeItem(STORAGE.apiKey);
  localStorage.removeItem(STORAGE.apiKey);
  sessionStorage.removeItem(STORAGE.apiBaseUrl);
  localStorage.removeItem(STORAGE.apiBaseUrl);
  sessionStorage.removeItem(STORAGE.apiMode);
  localStorage.removeItem(STORAGE.apiMode);

  const target = remember ? localStorage : sessionStorage;
  if (connection.apiKey) target.setItem(STORAGE.apiKey, connection.apiKey);
  if (connection.apiBaseUrl) target.setItem(STORAGE.apiBaseUrl, connection.apiBaseUrl);
  if (connection.apiMode) target.setItem(STORAGE.apiMode, connection.apiMode);
}

function isClaudeModel(model = "") {
  return String(model).trim().toLowerCase().startsWith("claude-");
}

function isAnthropicBaseUrl(baseUrl = "") {
  try {
    const url = new URL(baseUrl || ANTHROPIC_API_BASE_URL);
    return url.hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

function parseNewApiConnection(value) {
  const text = String(value || "").trim();
  if (!text.startsWith("{")) return null;

  try {
    const parsed = JSON.parse(text);
    if (parsed?._type !== "newapi_channel_conn") return null;
    return {
      apiKey: String(parsed.key || "").trim(),
      apiBaseUrl: String(parsed.url || "").trim(),
      apiMode: "chat"
    };
  } catch {
    return null;
  }
}

function apiModeFor(baseUrl, selectedMode, model = state.settings.model) {
  if (isClaudeModel(model) && selectedMode !== "chat" && (!baseUrl || isAnthropicBaseUrl(baseUrl))) {
    return "anthropic";
  }
  if (selectedMode === "chat" || selectedMode === "responses" || selectedMode === "anthropic") return selectedMode;
  return baseUrl ? "chat" : "responses";
}

function createSession(title = "新对话") {
  return {
    id: uid("chat"),
    title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: []
  };
}

function activeSession() {
  return state.sessions.find((session) => session.id === state.activeSessionId);
}

function persist() {
  saveJson(STORAGE.sessions, state.sessions);
  localStorage.setItem(STORAGE.activeSession, state.activeSessionId);
  saveJson(STORAGE.settings, state.settings);
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => els.toast.classList.remove("visible"), 2600);
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function inlineMarkdown(value) {
  let text = escapeHtml(value);
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return text;
}

function renderMarkdown(markdown) {
  const parts = [];
  const regex = /```([^\n`]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(markdown)) !== null) {
    if (match.index > lastIndex) parts.push(renderTextBlock(markdown.slice(lastIndex, match.index)));
    const info = escapeHtml(match[1].trim());
    const code = escapeHtml(match[2].replace(/\n$/, ""));
    parts.push(`<pre><code data-info="${info}">${code}</code></pre>`);
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < markdown.length) parts.push(renderTextBlock(markdown.slice(lastIndex)));
  return parts.join("");
}

function renderTextBlock(text) {
  const lines = text.split(/\n/);
  const html = [];
  let list = [];

  function flushList() {
    if (!list.length) return;
    html.push(`<ul>${list.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`);
    list = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushList();
      continue;
    }

    if (/^#{1,3}\s+/.test(trimmed)) {
      flushList();
      const level = Math.min(trimmed.match(/^#+/)[0].length, 3);
      html.push(`<h${level}>${inlineMarkdown(trimmed.replace(/^#{1,3}\s+/, ""))}</h${level}>`);
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      list.push(trimmed.replace(/^[-*]\s+/, ""));
      continue;
    }

    flushList();
    html.push(`<p>${inlineMarkdown(trimmed)}</p>`);
  }

  flushList();
  return html.join("");
}

function extractCodeBlocks(markdown) {
  const blocks = [];
  const regex = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match;

  while ((match = regex.exec(markdown)) !== null) {
    const info = match[1].trim();
    const content = match[2].replace(/\n$/, "");
    const filenameMatch = info.match(/(?:filename|file|path)=([^\s]+)/i) || info.match(/([A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+)/);
    const language = info.split(/\s+/)[0] || "txt";
    const extension = languageToExtension(language);
    blocks.push({
      info,
      content,
      filename: filenameMatch?.[1] || `artifact-${blocks.length + 1}.${extension}`
    });
  }

  return blocks;
}

function languageToExtension(language) {
  const map = {
    javascript: "js",
    js: "js",
    typescript: "ts",
    ts: "ts",
    tsx: "tsx",
    jsx: "jsx",
    python: "py",
    py: "py",
    html: "html",
    css: "css",
    json: "json",
    markdown: "md",
    md: "md",
    shell: "sh",
    bash: "sh",
    powershell: "ps1",
    sql: "sql",
    text: "txt"
  };
  return map[language.toLowerCase()] || "txt";
}

function downloadText(filename, content, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function updateTextareaHeight() {
  els.promptInput.style.height = "auto";
  els.promptInput.style.height = `${Math.min(els.promptInput.scrollHeight, 180)}px`;
}

function renderSessions() {
  els.sessionList.innerHTML = "";
  for (const session of state.sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-item${session.id === state.activeSessionId ? " active" : ""}`;
    button.innerHTML = `
      <span class="session-title">${escapeHtml(session.title || "新对话")}</span>
      <span class="session-meta">${session.messages.length} 条 · ${formatDate(session.updatedAt)}</span>
    `;
    button.addEventListener("click", () => {
      state.activeSessionId = session.id;
      persist();
      render();
      els.sidebar.classList.remove("open");
    });
    els.sessionList.append(button);
  }
}

function renderAttachmentsForMessage(message) {
  if (!message.attachments?.length) return "";
  return `
    <div class="message-files">
      ${message.attachments.map((file) => `
        <span class="file-pill" title="${escapeHtml(file.name)}">
          <span>${escapeHtml(file.name)} · ${formatBytes(file.size || 0)}</span>
        </span>
      `).join("")}
    </div>
  `;
}

function renderMessages() {
  const session = activeSession();
  els.messages.innerHTML = "";
  els.emptyState.classList.toggle("hidden", Boolean(session?.messages?.length));

  for (const message of session?.messages || []) {
    const wrapper = document.createElement("article");
    wrapper.className = `message ${message.role}`;
    wrapper.dataset.messageId = message.id;
    const content = message.role === "assistant"
      ? renderMarkdown(message.content || "")
      : renderTextBlock(message.content || "");
    wrapper.innerHTML = `
      ${renderAttachmentsForMessage(message)}
      <div class="bubble">${content || "<p></p>"}</div>
      ${message.role === "assistant" ? renderAssistantActions(message) : ""}
    `;
    els.messages.append(wrapper);
  }
}

function renderAssistantActions(message) {
  const codeBlocks = extractCodeBlocks(message.content || "");
  const codeButtons = codeBlocks.map((block, index) => (
    `<button class="mini-button" type="button" data-action="download-code" data-message-id="${message.id}" data-code-index="${index}">下载 ${escapeHtml(block.filename)}</button>`
  )).join("");

  return `
    <div class="message-actions">
      <button class="mini-button" type="button" data-action="copy" data-message-id="${message.id}">复制</button>
      <button class="mini-button" type="button" data-action="download-md" data-message-id="${message.id}">下载回答</button>
      ${codeButtons}
    </div>
  `;
}

function renderPendingAttachments() {
  els.attachmentList.innerHTML = "";
  for (const attachment of state.attachments) {
    const chip = document.createElement("span");
    chip.className = "attachment-chip";
    chip.innerHTML = `
      <b title="${escapeHtml(attachment.name)}">${escapeHtml(attachment.name)}</b>
      <span>${formatBytes(attachment.size)}</span>
      <button type="button" aria-label="移除 ${escapeHtml(attachment.name)}">×</button>
    `;
    chip.querySelector("button").addEventListener("click", () => {
      state.attachments = state.attachments.filter((item) => item.id !== attachment.id);
      renderPendingAttachments();
    });
    els.attachmentList.append(chip);
  }
}

function renderHeader() {
  const session = activeSession();
  const hasCustomBase = Boolean(state.apiBaseUrl);
  const providerLabel = state.apiMode === "anthropic"
    ? "Claude"
    : hasCustomBase ? "New API" : "OpenAI";
  els.chatTitle.textContent = session?.title || "新对话";
  els.chatMeta.textContent = `${state.settings.model} · ${providerLabel}`;
  els.modelSelect.value = state.settings.model;
  els.keyStatus.textContent = state.useServerKey && !state.apiKey
    ? "服务器 Key"
    : state.apiKey
      ? providerLabel
      : "未登录";
}

function render() {
  renderHeader();
  renderSessions();
  renderMessages();
  renderPendingAttachments();
  els.sendButton.disabled = state.sending;
  requestAnimationFrame(() => {
    els.messageStage.scrollTop = els.messageStage.scrollHeight;
  });
}

async function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("File read failed."));
    reader.readAsDataURL(file);
  });
}

async function addFiles(files) {
  const currentTotal = state.attachments.reduce((sum, item) => sum + item.size, 0);
  let incomingTotal = 0;
  const accepted = [];

  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      showToast(`${file.name} 超过 ${formatBytes(MAX_FILE_BYTES)}`);
      continue;
    }
    incomingTotal += file.size;
    if (currentTotal + incomingTotal > MAX_TOTAL_BYTES) {
      showToast(`附件总大小不能超过 ${formatBytes(MAX_TOTAL_BYTES)}`);
      break;
    }
    accepted.push(file);
  }

  for (const file of accepted) {
    const dataUrl = await readFileAsDataUrl(file);
    state.attachments.push({
      id: uid("file"),
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
      dataUrl
    });
  }
  renderPendingAttachments();
}

function ensureSession() {
  if (activeSession()) return activeSession();
  const session = createSession();
  state.sessions.unshift(session);
  state.activeSessionId = session.id;
  return session;
}

function titleFromPrompt(prompt) {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 34) || "新对话";
}

function buildRequestMessages(session) {
  const messages = session.messages.filter((message) => !message.pending);
  return messages.map((message, index, all) => {
    if (message.role === "user" && index !== all.length - 1 && message.attachments?.length) {
      return {
        ...message,
        attachments: message.attachments.map((file) => ({
          id: file.id,
          name: file.name,
          size: file.size,
          type: file.type
        }))
      };
    }
    return message;
  });
}

async function sendMessage() {
  const prompt = els.promptInput.value.trim();
  if (!prompt && !state.attachments.length) return;
  if (!state.apiKey && !state.useServerKey) {
    openLoginModal();
    return;
  }

  const session = ensureSession();
  const userMessage = {
    id: uid("msg"),
    role: "user",
    content: prompt,
    attachments: state.attachments,
    createdAt: new Date().toISOString()
  };
  const assistantMessage = {
    id: uid("msg"),
    role: "assistant",
    content: "",
    createdAt: new Date().toISOString(),
    pending: true
  };

  session.messages.push(userMessage, assistantMessage);
  if (session.messages.length === 2) session.title = titleFromPrompt(prompt || state.attachments[0]?.name || "文件分析");
  session.updatedAt = new Date().toISOString();
  state.attachments = [];
  els.promptInput.value = "";
  updateTextareaHeight();
  state.sending = true;
  persist();
  render();

  try {
    await streamAssistantResponse(session, assistantMessage);
  } catch (error) {
    assistantMessage.content = `请求失败：${error.message}`;
    showToast(error.message);
  } finally {
    assistantMessage.pending = false;
    state.sending = false;
    session.updatedAt = new Date().toISOString();
    persist();
    render();
  }
}

async function streamAssistantResponse(session, assistantMessage) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(state.apiKey ? { "authorization": `Bearer ${state.apiKey}` } : {})
    },
    body: JSON.stringify({
      model: state.settings.model,
      instructions: state.settings.instructions,
      reasoningEffort: state.settings.reasoningEffort,
      verbosity: state.settings.verbosity,
      webSearch: state.settings.webSearch,
      apiBaseUrl: state.apiBaseUrl,
      apiMode: state.apiMode,
      messages: buildRequestMessages(session),
      stream: true
    })
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.detail || detail.error || `HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";

    for (const frame of frames) {
      const eventName = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim() || "message";
      const dataLine = frame.match(/^data:\s*(.+)$/m)?.[1];
      if (!dataLine) continue;
      const data = JSON.parse(dataLine);

      if (eventName === "delta") {
        assistantMessage.content += data.text || "";
        renderMessages();
        els.messageStage.scrollTop = els.messageStage.scrollHeight;
      }

      if (eventName === "error") {
        throw new Error(data.error || "OpenAI stream failed.");
      }
    }
  }
}

function openLoginModal() {
  els.apiKeyInput.value = state.apiKey || "";
  els.apiBaseUrlInput.value = state.apiBaseUrl || "";
  els.apiModeSelect.value = apiModeFor(state.apiBaseUrl, state.apiMode, state.settings.model);
  els.rememberKeyInput.checked = Boolean(localStorage.getItem(STORAGE.apiKey));
  if (state.useServerKey) {
    els.loginSubcopy.textContent = "服务器已配置 Key，也可以输入新的 OpenAI、New API 或 Claude Key 覆盖。";
    els.apiKeyInput.placeholder = "可留空使用服务器 Key，也可粘贴 newapi_channel_conn JSON";
  } else {
    els.loginSubcopy.textContent = "输入 OpenAI、New API 或 Anthropic Claude API key，也可粘贴 newapi_channel_conn JSON。";
    els.apiKeyInput.placeholder = "sk-ant-... / sk-... / {\"_type\":\"newapi_channel_conn\",...}";
  }
  if (!els.loginModal.open) els.loginModal.showModal();
  requestAnimationFrame(() => els.apiKeyInput.focus());
}

function openSettingsModal() {
  els.instructionsInput.value = state.settings.instructions;
  els.reasoningSelect.value = state.settings.reasoningEffort;
  els.verbositySelect.value = state.settings.verbosity;
  els.webSearchInput.checked = state.settings.webSearch;
  if (!els.settingsModal.open) els.settingsModal.showModal();
}

function newChat() {
  const session = createSession();
  state.sessions.unshift(session);
  state.activeSessionId = session.id;
  persist();
  render();
  els.sidebar.classList.remove("open");
}

function exportCurrentChat() {
  const session = activeSession();
  if (!session) return;
  const body = session.messages.map((message) => {
    const title = message.role === "user" ? "User" : "Assistant";
    const files = message.attachments?.length
      ? `\n\nAttachments: ${message.attachments.map((file) => file.name).join(", ")}`
      : "";
    return `## ${title}\n\n${message.content || ""}${files}`;
  }).join("\n\n");
  downloadText(`${session.title || "chat"}.md`, `# ${session.title || "Chat"}\n\n${body}`, "text/markdown;charset=utf-8");
}

function handleMessageAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const session = activeSession();
  const message = session?.messages.find((item) => item.id === button.dataset.messageId);
  if (!message) return;

  if (button.dataset.action === "copy") {
    navigator.clipboard.writeText(message.content || "");
    showToast("已复制");
  }

  if (button.dataset.action === "download-md") {
    downloadText("assistant-answer.md", message.content || "", "text/markdown;charset=utf-8");
  }

  if (button.dataset.action === "download-code") {
    const block = extractCodeBlocks(message.content || "")[Number(button.dataset.codeIndex)];
    if (block) downloadText(block.filename, block.content);
  }
}

async function init() {
  state.sessions = loadJson(STORAGE.sessions, []);
  state.settings = { ...state.settings, ...loadJson(STORAGE.settings, {}) };
  const connection = getStoredConnection();
  state.apiKey = connection.apiKey;
  state.apiBaseUrl = connection.apiBaseUrl;
  state.apiMode = apiModeFor(connection.apiBaseUrl, connection.apiMode, state.settings.model);

  const config = await fetch("/api/config").then((res) => res.json()).catch(() => ({}));
  state.useServerKey = Boolean(config.serverKeyAvailable);
  if (config.defaultModel && !loadJson(STORAGE.settings, null)?.model) {
    state.settings.model = config.defaultModel;
  }

  state.activeSessionId = localStorage.getItem(STORAGE.activeSession) || state.sessions[0]?.id || "";
  if (!state.sessions.length) {
    const session = createSession();
    state.sessions.push(session);
    state.activeSessionId = session.id;
  }

  persist();
  render();

  if (!state.apiKey && !state.useServerKey) openLoginModal();
}

els.newChatButton.addEventListener("click", newChat);
els.settingsButton.addEventListener("click", openSettingsModal);
els.logoutButton.addEventListener("click", () => {
  state.apiKey = "";
  state.apiBaseUrl = "";
  state.apiMode = isClaudeModel(state.settings.model) ? "anthropic" : "responses";
  setStoredConnection({}, false);
  openLoginModal();
  render();
});
els.menuButton.addEventListener("click", () => els.sidebar.classList.toggle("open"));
els.exportChatButton.addEventListener("click", exportCurrentChat);
els.modelSelect.addEventListener("change", () => {
  state.settings.model = els.modelSelect.value;
  if (isClaudeModel(state.settings.model) && state.apiMode !== "chat") {
    state.apiMode = "anthropic";
  } else if (!isClaudeModel(state.settings.model) && state.apiMode === "anthropic" && !state.apiBaseUrl) {
    state.apiMode = "responses";
  }
  persist();
  renderHeader();
});
els.attachButton.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", async () => {
  await addFiles([...els.fileInput.files]);
  els.fileInput.value = "";
});
els.promptInput.addEventListener("input", updateTextareaHeight);
els.promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    els.composer.requestSubmit();
  }
});
els.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state.sending) sendMessage();
});
els.apiKeyInput.addEventListener("input", () => {
  const parsed = parseNewApiConnection(els.apiKeyInput.value);
  if (!parsed) return;
  els.apiKeyInput.value = parsed.apiKey;
  els.apiBaseUrlInput.value = parsed.apiBaseUrl;
  els.apiModeSelect.value = "chat";
  showToast("已识别 New API 配置");
});
els.apiBaseUrlInput.addEventListener("input", () => {
  if (els.apiBaseUrlInput.value.trim() && els.apiModeSelect.value === "responses") {
    els.apiModeSelect.value = "chat";
  }
});
els.apiModeSelect.addEventListener("change", () => {
  if (els.apiModeSelect.value === "anthropic" && !isClaudeModel(state.settings.model)) {
    state.settings.model = DEFAULT_CLAUDE_MODEL;
    els.modelSelect.value = state.settings.model;
    persist();
    renderHeader();
  }
});
els.loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const parsed = parseNewApiConnection(els.apiKeyInput.value);
  const key = parsed?.apiKey || els.apiKeyInput.value.trim();
  const apiBaseUrl = parsed?.apiBaseUrl || els.apiBaseUrlInput.value.trim();
  const apiMode = apiModeFor(apiBaseUrl, parsed?.apiMode || els.apiModeSelect.value, state.settings.model);

  if (!key && !state.useServerKey) {
    showToast("请输入 API key");
    return;
  }

  if (els.apiKeyInput.value.trim().startsWith("{") && !parsed) {
    showToast("New API JSON 格式不正确");
    return;
  }

  state.apiKey = key;
  state.apiBaseUrl = apiBaseUrl;
  state.apiMode = apiMode;
  if (state.apiMode === "anthropic" && !isClaudeModel(state.settings.model)) {
    state.settings.model = DEFAULT_CLAUDE_MODEL;
    persist();
  }
  setStoredConnection({ apiKey: key, apiBaseUrl, apiMode }, els.rememberKeyInput.checked);
  els.loginModal.close();
  render();
});
els.settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.settings.instructions = els.instructionsInput.value.trim();
  state.settings.reasoningEffort = els.reasoningSelect.value;
  state.settings.verbosity = els.verbositySelect.value;
  state.settings.webSearch = els.webSearchInput.checked;
  persist();
  els.settingsModal.close();
  showToast("设置已保存");
});
els.closeSettingsButton.addEventListener("click", () => els.settingsModal.close());
els.messages.addEventListener("click", handleMessageAction);
els.emptyState.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-prompt]");
  if (!button) return;
  els.promptInput.value = button.dataset.prompt;
  updateTextareaHeight();
  els.promptInput.focus();
});

for (const eventName of ["dragenter", "dragover"]) {
  window.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropHint.classList.add("visible");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  window.addEventListener(eventName, (event) => {
    event.preventDefault();
    if (eventName === "drop") addFiles([...event.dataTransfer.files]);
    els.dropHint.classList.remove("visible");
  });
}

window.addEventListener("click", (event) => {
  if (window.innerWidth <= 860 && !els.sidebar.contains(event.target) && !els.menuButton.contains(event.target)) {
    els.sidebar.classList.remove("open");
  }
});

init();
