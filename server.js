import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";
const maxBodyBytes = 42 * 1024 * 1024;
const officialOpenAiApiBaseUrl = "https://api.openai.com";
const officialAnthropicApiBaseUrl = "https://api.anthropic.com";

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"]
]);

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 }));
      }
    });

    req.on("error", reject);
  });
}

function sanitizeApiKey(value = "") {
  const key = String(value).trim();
  if (!key || key.length > 400 || /[\r\n]/.test(key)) return "";
  return key;
}

function getApiKey(req, body, apiMode) {
  const authorization = req.headers.authorization || "";
  const fromHeader = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7)
    : "";
  const envKey = apiMode === "anthropic"
    ? process.env.ANTHROPIC_API_KEY || process.env.API_KEY
    : process.env.OPENAI_API_KEY || process.env.API_KEY;
  return sanitizeApiKey(fromHeader || body.apiKey || envKey || "");
}

function isPrivateIPv4(hostname) {
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isBlockedApiHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".localhost") ||
    host === "host.docker.internal" ||
    isPrivateIPv4(host)
  );
}

function normalizeApiBaseUrl(value = "", fallback = officialOpenAiApiBaseUrl) {
  const raw = String(value || fallback).trim();
  if (!raw || raw.length > 400 || /[\r\n]/.test(raw)) {
    throw Object.assign(new Error("Invalid API base URL."), { statusCode: 400 });
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("Invalid API base URL."), { statusCode: 400 });
  }

  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw Object.assign(new Error("API base URL must be http(s) without credentials."), { statusCode: 400 });
  }

  if (isBlockedApiHost(url.hostname) && process.env.ALLOW_PRIVATE_API_BASE !== "1") {
    throw Object.assign(new Error("Local/private API base URLs are disabled on this server. Use a public New API address."), { statusCode: 400 });
  }

  url.search = "";
  url.hash = "";
  let pathname = url.pathname.replace(/\/+$/, "");
  pathname = pathname
    .replace(/\/v1\/responses$/i, "")
    .replace(/\/v1\/chat\/completions$/i, "")
    .replace(/\/v1\/messages$/i, "")
    .replace(/\/v1$/i, "");
  url.pathname = pathname || "";
  return url.toString().replace(/\/+$/, "");
}

function looksLikeClaudeModel(model = "") {
  return compactText(model).trim().toLowerCase().startsWith("claude-");
}

function getRequestedApiMode(body) {
  const requested = compactText(body.apiMode).trim();
  if (["responses", "chat", "anthropic"].includes(requested)) return requested;

  const configured = String(process.env.API_MODE || process.env.OPENAI_API_MODE || "").trim();
  if (["responses", "chat", "anthropic"].includes(configured)) return configured;

  return "";
}

function defaultApiBaseUrlForMode(apiMode) {
  if (apiMode === "anthropic") {
    return process.env.ANTHROPIC_BASE_URL || officialAnthropicApiBaseUrl;
  }
  return process.env.OPENAI_BASE_URL || officialOpenAiApiBaseUrl;
}

function getApiMode(body, apiBaseUrl, requestedMode = "") {
  if (requestedMode) return requestedMode;
  if (looksLikeClaudeModel(body.model) || apiBaseUrl === officialAnthropicApiBaseUrl) return "anthropic";
  return apiBaseUrl === officialOpenAiApiBaseUrl ? "responses" : "chat";
}

function compactText(value, fallback = "") {
  return typeof value === "string" ? value.slice(0, 220000) : fallback;
}

function buildContentForMessage(message) {
  if (message.role === "assistant") {
    return compactText(message.content);
  }

  const content = [];
  const text = compactText(message.content);
  if (text) {
    content.push({ type: "input_text", text });
  }

  for (const attachment of Array.isArray(message.attachments) ? message.attachments : []) {
    if (!attachment?.dataUrl || !attachment?.name) continue;
    const name = String(attachment.name).slice(0, 160);
    const dataUrl = String(attachment.dataUrl);
    const mimeType = String(attachment.type || "");

    if (mimeType.startsWith("image/")) {
      content.push({ type: "input_image", image_url: dataUrl });
      continue;
    }

    content.push({
      type: "input_file",
      filename: name,
      file_data: dataUrl
    });
  }

  if (!content.length) {
    content.push({ type: "input_text", text: "" });
  }

  return content;
}

function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && ["user", "assistant"].includes(message.role))
    .slice(-24)
    .map((message) => ({
      role: message.role,
      content: buildContentForMessage(message)
    }));
}

function extractOutputText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;

  let text = "";
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        text += content.text;
      }
    }
  }
  return text;
}

function extractChatOutputText(payload) {
  return (Array.isArray(payload?.choices) ? payload.choices : [])
    .map((choice) => choice?.message?.content || choice?.text || "")
    .join("");
}

function extractAnthropicOutputText(payload) {
  return (Array.isArray(payload?.content) ? payload.content : [])
    .map((block) => block?.type === "text" ? block.text || "" : "")
    .join("");
}

function buildDeveloperInstructions(body) {
  const developerInstructions = [
    "You are a general-purpose private web agent for analysis, writing, coding, planning, and file generation.",
    "When the user asks you to create a downloadable file, provide the complete file content in a fenced code block.",
    "Put a filename in the fence info when possible, for example: ```filename=report.md",
    "Be concise by default, but include enough structure for the user to act on the result."
  ];

  const userInstructions = compactText(body.instructions).trim();
  if (userInstructions) developerInstructions.push(userInstructions);
  return developerInstructions;
}

function isTextLikeMime(mimeType = "") {
  const mime = String(mimeType).toLowerCase();
  return (
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("xml") ||
    mime.includes("csv") ||
    mime.includes("javascript") ||
    mime.includes("typescript") ||
    mime.includes("yaml")
  );
}

function dataUrlToText(dataUrl = "", mimeType = "") {
  const match = String(dataUrl).match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!match) return "";

  const mime = mimeType || match[1] || "";
  if (!isTextLikeMime(mime)) return "";

  try {
    const body = match[3] || "";
    const text = match[2]
      ? Buffer.from(body, "base64").toString("utf8")
      : decodeURIComponent(body);
    return text.slice(0, 60000);
  } catch {
    return "";
  }
}

function buildChatContentForMessage(message) {
  if (message.role === "assistant") {
    return compactText(message.content);
  }

  const textParts = [];
  const imageParts = [];
  const text = compactText(message.content);
  if (text) textParts.push(text);

  for (const attachment of Array.isArray(message.attachments) ? message.attachments : []) {
    if (!attachment?.dataUrl || !attachment?.name) continue;
    const name = String(attachment.name).slice(0, 160);
    const dataUrl = String(attachment.dataUrl);
    const mimeType = String(attachment.type || "");

    if (mimeType.startsWith("image/")) {
      imageParts.push({ type: "image_url", image_url: { url: dataUrl } });
      continue;
    }

    const fileText = dataUrlToText(dataUrl, mimeType);
    textParts.push(fileText
      ? `Attached file: ${name}\n\n${fileText}`
      : `Attached file omitted in OpenAI-compatible mode: ${name}`);
  }

  if (imageParts.length) {
    return [
      ...textParts.map((part) => ({ type: "text", text: part })),
      ...imageParts
    ];
  }

  return textParts.join("\n\n") || "";
}

function dataUrlToAnthropicImageSource(dataUrl = "", mimeType = "") {
  const match = String(dataUrl).match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!match || !match[2]) return null;

  const mediaType = mimeType || match[1] || "";
  if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mediaType)) {
    return null;
  }

  return {
    type: "base64",
    media_type: mediaType,
    data: match[3] || ""
  };
}

function buildAnthropicContentForMessage(message) {
  if (message.role === "assistant") {
    return compactText(message.content);
  }

  const content = [];
  const text = compactText(message.content);
  if (text) content.push({ type: "text", text });

  for (const attachment of Array.isArray(message.attachments) ? message.attachments : []) {
    if (!attachment?.dataUrl || !attachment?.name) continue;
    const name = String(attachment.name).slice(0, 160);
    const dataUrl = String(attachment.dataUrl);
    const mimeType = String(attachment.type || "");

    if (mimeType.startsWith("image/")) {
      const source = dataUrlToAnthropicImageSource(dataUrl, mimeType);
      if (source) {
        content.push({ type: "image", source });
        continue;
      }
    }

    const fileText = dataUrlToText(dataUrl, mimeType);
    content.push({
      type: "text",
      text: fileText
        ? `Attached file: ${name}\n\n${fileText}`
        : `Attached file omitted in Claude mode: ${name}`
    });
  }

  return content.length ? content : [{ type: "text", text: "" }];
}

function getAnthropicMaxTokens() {
  const value = Number(process.env.ANTHROPIC_MAX_TOKENS || 4096);
  if (!Number.isFinite(value)) return 4096;
  return Math.min(Math.max(Math.floor(value), 1), 128000);
}

function buildOpenAiPayload(body, stream) {
  const model = compactText(body.model, "gpt-5.5").trim() || "gpt-5.5";
  const input = normalizeMessages(body.messages);
  const developerInstructions = buildDeveloperInstructions(body);

  const payload = {
    model,
    input,
    instructions: developerInstructions.join("\n"),
    stream,
    store: false
  };

  const reasoningEffort = compactText(body.reasoningEffort).trim();
  if (["minimal", "low", "medium", "high"].includes(reasoningEffort)) {
    payload.reasoning = { effort: reasoningEffort };
  }

  const verbosity = compactText(body.verbosity).trim();
  if (["low", "medium", "high"].includes(verbosity)) {
    payload.text = { verbosity };
  }

  if (body.webSearch === true) {
    payload.tools = [{ type: "web_search_preview" }];
  }

  return payload;
}

function buildChatPayload(body, stream) {
  const model = compactText(body.model, "gpt-5.5").trim() || "gpt-5.5";
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((message) => message && ["user", "assistant"].includes(message.role))
    .slice(-24)
    .map((message) => ({
      role: message.role,
      content: buildChatContentForMessage(message)
    }));

  return {
    model,
    messages: [
      { role: "system", content: buildDeveloperInstructions(body).join("\n") },
      ...messages
    ],
    stream
  };
}

function buildAnthropicPayload(body, stream) {
  const model = compactText(body.model, "claude-fable-5").trim() || "claude-fable-5";
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((message) => message && ["user", "assistant"].includes(message.role))
    .slice(-24)
    .map((message) => ({
      role: message.role,
      content: buildAnthropicContentForMessage(message)
    }));

  return {
    model,
    max_tokens: getAnthropicMaxTokens(),
    system: buildDeveloperInstructions(body).join("\n"),
    messages,
    stream
  };
}

async function handleConfig(_req, res) {
  sendJson(res, 200, {
    serverKeyAvailable: Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.API_KEY),
    defaultModel: process.env.DEFAULT_MODEL || "gpt-5.5"
  });
}

async function handleChat(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message });
    return;
  }

  const requestedMode = getRequestedApiMode(body);
  const preferredMode = requestedMode || (looksLikeClaudeModel(body.model) ? "anthropic" : "");
  let apiBaseUrl;
  try {
    apiBaseUrl = normalizeApiBaseUrl(body.apiBaseUrl, defaultApiBaseUrlForMode(preferredMode));
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message });
    return;
  }

  const apiMode = getApiMode(body, apiBaseUrl, requestedMode || preferredMode);
  const apiKey = getApiKey(req, body, apiMode);
  if (!apiKey) {
    sendJson(res, 401, { error: "Missing API key." });
    return;
  }

  const stream = body.stream !== false;
  const payload = apiMode === "anthropic"
    ? buildAnthropicPayload(body, stream)
    : apiMode === "chat"
      ? buildChatPayload(body, stream)
      : buildOpenAiPayload(body, stream);
  const hasMessages = apiMode === "anthropic" || apiMode === "chat"
    ? payload.messages.some((message) => message.role !== "system")
    : payload.input.length;

  if (!hasMessages) {
    sendJson(res, 400, { error: "Please send at least one message." });
    return;
  }

  const endpoint = apiMode === "anthropic"
    ? `${apiBaseUrl}/v1/messages`
    : `${apiBaseUrl}/v1/${apiMode === "chat" ? "chat/completions" : "responses"}`;
  const headers = apiMode === "anthropic"
    ? {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      }
    : {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`
      };

  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
  } catch (error) {
    sendJson(res, 502, { error: `Could not reach upstream API: ${error.message}` });
    return;
  }

  if (!upstream.ok) {
    const detail = await upstream.text();
    sendJson(res, upstream.status, {
      error: "Upstream API request failed.",
      detail: detail.slice(0, 4000)
    });
    return;
  }

  if (payload.stream === false) {
    const json = await upstream.json();
    sendJson(res, 200, {
      text: apiMode === "anthropic"
        ? extractAnthropicOutputText(json)
        : apiMode === "chat"
          ? extractChatOutputText(json)
          : extractOutputText(json),
      responseId: json.id,
      model: json.model,
      usage: json.usage || null
    });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "x-accel-buffering": "no"
  });

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";

      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;

          let event;
          try {
            event = JSON.parse(raw);
          } catch {
            continue;
          }

          if (apiMode === "anthropic") {
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
              res.write(`event: delta\ndata: ${JSON.stringify({ text: event.delta.text || "" })}\n\n`);
            }

            if (event.type === "message_stop") {
              res.write(`event: done\ndata: ${JSON.stringify({})}\n\n`);
            }

            if (event.type === "error") {
              res.write(`event: error\ndata: ${JSON.stringify({ error: event.error?.message || "Claude stream failed." })}\n\n`);
            }
          } else if (apiMode === "chat") {
            const text = (Array.isArray(event.choices) ? event.choices : [])
              .map((choice) => choice?.delta?.content || "")
              .join("");
            if (text) {
              res.write(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`);
            }

            if (event.error) {
              res.write(`event: error\ndata: ${JSON.stringify({ error: event.error?.message || "OpenAI-compatible stream failed." })}\n\n`);
            }
          } else {
            if (event.type === "response.output_text.delta") {
              res.write(`event: delta\ndata: ${JSON.stringify({ text: event.delta || "" })}\n\n`);
            }

            if (event.type === "response.completed") {
              const response = event.response || {};
              res.write(`event: done\ndata: ${JSON.stringify({
                responseId: response.id,
                model: response.model,
                usage: response.usage || null
              })}\n\n`);
            }

            if (event.type === "response.failed" || event.type === "error") {
              res.write(`event: error\ndata: ${JSON.stringify({ error: event.error?.message || "OpenAI stream failed." })}\n\n`);
            }
          }
        }
      }
    }
  } catch (error) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
  } finally {
    res.end();
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const normalized = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  const filePath = join(publicDir, normalized);

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: "Forbidden." });
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes.get(extname(filePath)) || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(file);
  } catch {
    const fallback = await readFile(join(publicDir, "index.html"));
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(fallback);
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url?.startsWith("/api/config")) {
      await handleConfig(req, res);
      return;
    }

    if (req.method === "POST" && req.url?.startsWith("/api/chat")) {
      await handleChat(req, res);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed." });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Internal server error." });
  }
});

server.listen(port, host, () => {
  console.log(`Web Agent running at http://localhost:${port}`);
  console.log(`LAN access: http://<this-computer-ip>:${port}`);
});
