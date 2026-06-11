import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";
const maxBodyBytes = 42 * 1024 * 1024;

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

function getBearerKey(req, body) {
  const authorization = req.headers.authorization || "";
  const fromHeader = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7)
    : "";
  return sanitizeApiKey(fromHeader || body.apiKey || process.env.OPENAI_API_KEY || "");
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

function buildOpenAiPayload(body, stream) {
  const model = compactText(body.model, "gpt-5.5").trim() || "gpt-5.5";
  const input = normalizeMessages(body.messages);
  const developerInstructions = [
    "You are a general-purpose private web agent for analysis, writing, coding, planning, and file generation.",
    "When the user asks you to create a downloadable file, provide the complete file content in a fenced code block.",
    "Put a filename in the fence info when possible, for example: ```filename=report.md",
    "Be concise by default, but include enough structure for the user to act on the result."
  ];

  const userInstructions = compactText(body.instructions).trim();
  if (userInstructions) developerInstructions.push(userInstructions);

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

async function handleConfig(_req, res) {
  sendJson(res, 200, {
    serverKeyAvailable: Boolean(process.env.OPENAI_API_KEY),
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

  const apiKey = getBearerKey(req, body);
  if (!apiKey) {
    sendJson(res, 401, { error: "Missing API key." });
    return;
  }

  const payload = buildOpenAiPayload(body, body.stream !== false);
  if (!payload.input.length) {
    sendJson(res, 400, { error: "Please send at least one message." });
    return;
  }

  let upstream;
  try {
    upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    sendJson(res, 502, { error: `Could not reach OpenAI: ${error.message}` });
    return;
  }

  if (!upstream.ok) {
    const detail = await upstream.text();
    sendJson(res, upstream.status, {
      error: "OpenAI request failed.",
      detail: detail.slice(0, 4000)
    });
    return;
  }

  if (payload.stream === false) {
    const json = await upstream.json();
    sendJson(res, 200, {
      text: extractOutputText(json),
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
