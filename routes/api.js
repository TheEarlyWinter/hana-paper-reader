import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parsePdfWithMineru, readMineruAsset } from "../lib/mineru.js";

const AGENT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const PLUGIN_API_VERSION = "0.4.2";
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_LEGACY_BASE64_CHARS = Math.ceil(MAX_PDF_BYTES / 3) * 4;
const MAX_LEGACY_JSON_BYTES = MAX_LEGACY_BASE64_CHARS + 1024 * 1024;
const MAX_TEXT_CHARS = 12000;
const MAX_BATCH_ITEMS = 8;
const MAX_BATCH_CHARS = 50000;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const THINKING_LEVELS = new Set(["off", "low", "medium", "high", "max"]);
const DEFAULT_THINKING_LEVEL = "max";
const HIDDEN_AGENT_IDS = new Set(["one", "one-2", "one-3", "image2", "agent-mqz22q9q"]);
const agentSessionCache = new Map();
const agentTurnLocks = new Map();
const MINERU_MODELS = new Set(["vlm", "pipeline"]);
const MINERU_LANGUAGES = new Set(["ch", "en", "japan", "latin"]);

class PdfRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "PdfRequestError";
    this.status = status;
  }
}

function getHanaHomeDir() {
  return process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
}

function getRequestRuntime(c, ctx) {
  const requestContext = typeof c.get === "function" ? c.get("pluginRequestContext") : null;
  return {
    bus: requestContext?.bus || ctx.bus,
    requestContext,
  };
}

function isAgentId(value) {
  return typeof value === "string" && AGENT_ID_RE.test(value) && !HIDDEN_AGENT_IDS.has(value);
}

function parseConfig(raw) {
  const nameMatch = raw.match(/^\s{2}name:\s*([^\r\n#]+)/m);
  const chatBlock = raw.match(/(?:^|\r?\n)\s{2}chat:\s*\r?\n([\s\S]*?)(?=\r?\n\s{2}[A-Za-z_][\w-]*:\s|$)/m);
  const modelMatch = (chatBlock?.[1] || "").match(/^\s{4}id:\s*([^\r\n#]+)/m);
  return {
    name: nameMatch?.[1]?.trim().replace(/^["']|["']$/g, "") || null,
    model: modelMatch?.[1]?.trim().replace(/^["']|["']$/g, "") || null,
  };
}

function modelFromProfile(profile) {
  const chat = profile?.models?.chat;
  if (typeof chat === "string" && chat.trim()) return chat.trim();
  if (chat && typeof chat === "object") {
    return chat.id || chat.modelId || chat.model || "默认模型";
  }
  return "默认模型";
}

function readLocalAgent(agentId, profile = null) {
  if (!isAgentId(agentId)) return null;
  const agentDir = path.join(getHanaHomeDir(), "agents", agentId);
  if (path.basename(agentDir) !== agentId || !fs.existsSync(agentDir)) return null;

  let info = {};
  const cfgPath = path.join(agentDir, "config.yaml");
  try {
    if (fs.existsSync(cfgPath)) info = parseConfig(fs.readFileSync(cfgPath, "utf8"));
  } catch {}

  let avatarUrl = null;
  let description = profile?.description || profile?.identity || "";
  const descriptionPath = path.join(agentDir, "description.md");
  try {
    if (!description && fs.existsSync(descriptionPath)) description = fs.readFileSync(descriptionPath, "utf8").slice(0, 500).trim();
  } catch {}
  const avatarPath = path.join(agentDir, "avatars", "agent.png");
  try {
    const stat = fs.statSync(avatarPath);
    if (stat.isFile() && stat.size <= MAX_AVATAR_BYTES) {
      avatarUrl = `data:image/png;base64,${fs.readFileSync(avatarPath).toString("base64")}`;
    }
  } catch {}

  return {
    id: agentId,
    name: profile?.name || info.name || agentId,
    model: modelFromProfile(profile) !== "默认模型" ? modelFromProfile(profile) : (info.model || "默认模型"),
    description,
    avatarUrl,
  };
}

async function listAgents(bus) {
  const records = new Map();
  try {
    const result = await bus?.request?.("agent:list", {});
    const hostAgents = Array.isArray(result) ? result : (result?.agents || []);
    for (const agent of hostAgents) {
      if (isAgentId(agent?.id)) records.set(agent.id, { id: agent.id, name: agent.name || null });
    }
  } catch {}

  const agentsDir = path.join(getHanaHomeDir(), "agents");
  try {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && isAgentId(entry.name) && fs.existsSync(path.join(agentsDir, entry.name, "config.yaml"))) {
        if (!records.has(entry.name)) records.set(entry.name, { id: entry.name, name: null });
      }
    }
  } catch {}

  const agents = [...records.values()].map(({ id, name }) => {
    const local = readLocalAgent(id);
    return local || { id, name: name || id, model: "默认模型", description: "", avatarUrl: null };
  });

  for (const agent of agents) {
    const record = records.get(agent.id);
    if (record?.name && agent.name === agent.id) agent.name = record.name;
  }

  const priorityOrder = ["hakimi", "agent-mqb7zal0", "cixiaogui", "beishu", "hanako"];
  agents.sort((a, b) => {
    const ia = priorityOrder.indexOf(a.id);
    const ib = priorityOrder.indexOf(b.id);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return String(a.name).localeCompare(String(b.name));
  });
  return agents;
}

async function resolveAgent(bus, agentId) {
  if (!isAgentId(agentId)) return null;
  let profile = null;
  try {
    const result = await bus?.request?.("agent:profile", { agentId });
    profile = result?.profile || result?.agent || null;
  } catch {}

  const local = readLocalAgent(agentId, profile);
  if (local) return local;
  if (profile) {
    return {
      id: agentId,
      name: profile.name || profile.agentName || agentId,
      model: modelFromProfile(profile),
      description: profile.description || profile.identity || "",
      avatarUrl: null,
    };
  }
  return null;
}

function extractText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (typeof result.text === "string") return result.text;
  if (typeof result.content === "string") return result.content;
  if (Array.isArray(result.content)) {
    return result.content.map((item) => typeof item === "string" ? item : item?.text || "").join("\n");
  }
  if (result.message?.content) {
    return typeof result.message.content === "string" ? result.message.content : extractText(result.message);
  }
  return "";
}

function extractMessageText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((item) => typeof item === "string" ? item : item?.text || "").join("\n");
  }
  return typeof message.text === "string" ? message.text : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeThinkingLevel(value) {
  const level = String(value || "").trim().toLowerCase();
  if (level === "xhigh") return "max";
  return THINKING_LEVELS.has(level) ? level : DEFAULT_THINKING_LEVEL;
}

function isThinkingLevelCompatibilityError(error) {
  const message = String(error?.message || error || "");
  return /thinking|reasoning|effort/i.test(message)
    || /no handler|not implemented|unknown.*(?:field|option|parameter|property)|unsupported.*(?:field|option|parameter|property)|invalid.*(?:field|option|parameter|property)/i.test(message);
}

async function withAgentTurnLock(key, task) {
  const previous = agentTurnLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  agentTurnLocks.set(key, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (agentTurnLocks.get(key) === current) agentTurnLocks.delete(key);
  }
}

async function createAgentSession(bus, ctx, agentId, visibility, thinkingLevel = DEFAULT_THINKING_LEVEL) {
  const requestedThinkingLevel = normalizeThinkingLevel(thinkingLevel);
  const basePayload = {
    agentId,
    ownerPluginId: ctx.pluginId,
    visibility,
    kind: "paper-reader",
    memoryEnabled: false,
  };
  let created;
  try {
    created = await bus.request("session:create", {
      ...basePayload,
      thinkingLevel: requestedThinkingLevel,
    });
  } catch (error) {
    // Older Hana builds may not accept thinkingLevel; keep the reader usable there.
    if (!isThinkingLevelCompatibilityError(error)) throw error;
    created = await bus.request("session:create", basePayload);
  }
  if (!created?.sessionId) throw new Error("Hana did not return a sessionId");
  return {
    sessionId: created.sessionId,
    sessionRef: created.sessionRef || { sessionId: created.sessionId, sessionPath: created.sessionPath || null },
    thinkingLevel: created.thinkingLevel || null,
    requestedThinkingLevel,
  };
}

async function updateAgentSessionThinkingLevel(bus, target, thinkingLevel) {
  const requestedThinkingLevel = normalizeThinkingLevel(thinkingLevel);
  if (target.requestedThinkingLevel === requestedThinkingLevel) return target;
  try {
    const updated = await bus.request("session:update", {
      sessionId: target.sessionId,
      sessionRef: target.sessionRef,
      thinkingLevel: requestedThinkingLevel,
    });
    target.thinkingLevel = updated?.session?.thinkingLevel || updated?.thinkingLevel || target.thinkingLevel || null;
  } catch (error) {
    if (!isThinkingLevelCompatibilityError(error)) throw error;
  }
  target.requestedThinkingLevel = requestedThinkingLevel;
  return target;
}

async function getAgentSession(bus, ctx, agentId, visibility, namespace, reuse, thinkingLevel) {
  const cacheKey = `${namespace}:${visibility}:${agentId}`;
  if (reuse && agentSessionCache.has(cacheKey)) return { target: agentSessionCache.get(cacheKey), cacheKey };
  const target = await createAgentSession(bus, ctx, agentId, visibility, thinkingLevel);
  if (reuse) agentSessionCache.set(cacheKey, target);
  return { target, cacheKey };
}

async function sendToTarget(bus, target, text, context) {
  return bus.request("session:send", {
    sessionId: target.sessionId,
    sessionRef: target.sessionRef,
    text,
    ...(context ? { context } : {}),
  });
}

async function runAgentTurn(bus, ctx, agentId, text, options = {}) {
  const visibility = options.visibility || "plugin_private";
  const namespace = options.namespace || "reader";
  const reuse = options.reuse !== false;
  const lockKey = `${namespace}:${visibility}:${agentId}`;

  return withAgentTurnLock(lockKey, async () => {
    let { target, cacheKey } = await getAgentSession(
      bus,
      ctx,
      agentId,
      visibility,
      namespace,
      reuse,
      options.thinkingLevel,
    );
    try {
      await updateAgentSessionThinkingLevel(bus, target, options.thinkingLevel);
      let baselineCount = 0;
      try {
        const before = await bus.request("session:history", {
          sessionId: target.sessionId,
          sessionRef: target.sessionRef,
          limit: 200,
        });
        baselineCount = Array.isArray(before?.messages) ? before.messages.length : 0;
      } catch {}
      try {
        await sendToTarget(bus, target, text);
      } catch (error) {
        if (!reuse || !String(error?.message || "").includes("session_busy")) throw error;
        agentSessionCache.delete(cacheKey);
        target = await createAgentSession(bus, ctx, agentId, visibility, options.thinkingLevel);
        agentSessionCache.set(cacheKey, target);
        baselineCount = 0;
        await sendToTarget(bus, target, text);
      }

      const deadline = Date.now() + (options.timeoutMs || 60000);
      let previousAnswer = null;
      let stableReads = 0;
      while (Date.now() < deadline) {
        try {
          const history = await bus.request("session:history", {
            sessionId: target.sessionId,
            sessionRef: target.sessionRef,
            limit: 200,
          });
          const messages = Array.isArray(history?.messages) ? history.messages : [];
          let userIndex = -1;
          for (let index = messages.length - 1; index >= Math.max(0, baselineCount); index -= 1) {
            if (messages[index]?.role === "user" && extractMessageText(messages[index]) === text) {
              userIndex = index;
              break;
            }
          }
          if (userIndex >= baselineCount) {
            const answer = messages.slice(userIndex + 1).find((message) => message?.role === "assistant" && extractMessageText(message).trim());
            const answerText = answer ? extractMessageText(answer).trim() : "";
            if (answerText && answerText === previousAnswer) stableReads += 1;
            else stableReads = 0;
            previousAnswer = answerText || previousAnswer;
            if (answerText && stableReads >= 1) return { text: answerText, target };
          }
        } catch {}
        await sleep(500);
      }
      throw new Error("助手响应超时，请稍后重试");
    } catch (error) {
      if (reuse && agentSessionCache.get(cacheKey) === target) agentSessionCache.delete(cacheKey);
      throw error;
    }
  });
}

async function sendAgentMessage(bus, ctx, agentId, text, thinkingLevel) {
  const visibility = "public";
  const namespace = "send";
  const lockKey = `${namespace}:${visibility}:${agentId}`;
  return withAgentTurnLock(lockKey, async () => {
    let { target, cacheKey } = await getAgentSession(
      bus,
      ctx,
      agentId,
      visibility,
      namespace,
      true,
      thinkingLevel,
    );
    try {
      await updateAgentSessionThinkingLevel(bus, target, thinkingLevel);
      try {
        await sendToTarget(bus, target, text);
      } catch (error) {
        if (!String(error?.message || "").includes("session_busy")) throw error;
        agentSessionCache.delete(cacheKey);
        target = await createAgentSession(bus, ctx, agentId, visibility, thinkingLevel);
        agentSessionCache.set(cacheKey, target);
        await sendToTarget(bus, target, text);
      }
      return target;
    } catch (error) {
      if (agentSessionCache.get(cacheKey) === target) agentSessionCache.delete(cacheKey);
      throw error;
    }
  });
}

function parseJsonArray(text) {
  const match = String(text || "").match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[0]);
    return Array.isArray(value) ? value.map((item) => String(item ?? "")) : null;
  } catch {
    return null;
  }
}

async function runUtilityTranslation(bus, list) {
  const prompt = `请将以下学术英文逐条翻译为准确、自然的学术中文。保留公式、数字和专业缩写。只返回 JSON 字符串数组，数组长度必须为 ${list.length}，不要附加解释：\n${JSON.stringify(list)}`;
  const result = await bus.request("model:sample-text", {
    pluginId: "hana-paper-reader",
    messages: [{ role: "user", content: prompt }],
    systemPrompt: "你是学术论文翻译助手。",
    temperature: 0.2,
  });
  const translations = parseJsonArray(extractText(result));
  if (!translations || translations.length !== list.length) throw new Error("翻译模型返回格式无效");
  return translations;
}

function integerSetting(ctx, key, fallback, min, max) {
  const numeric = Number(ctx.config.get(key));
  return Number.isInteger(numeric) ? Math.max(min, Math.min(max, numeric)) : fallback;
}

function publicMineruSettings(ctx) {
  return {
    ok: true,
    apiVersion: PLUGIN_API_VERSION,
    configured: Boolean(String(ctx.config.get("mineruApiToken") || "").trim()),
    modelVersion: MINERU_MODELS.has(String(ctx.config.get("mineruModelVersion") || ""))
      ? String(ctx.config.get("mineruModelVersion"))
      : "vlm",
    language: MINERU_LANGUAGES.has(String(ctx.config.get("mineruLanguage") || ""))
      ? String(ctx.config.get("mineruLanguage"))
      : "ch",
    enableFormula: ctx.config.get("mineruEnableFormula") !== false,
    enableTable: ctx.config.get("mineruEnableTable") !== false,
    ocr: ctx.config.get("mineruOcr") === true,
    timeoutSeconds: integerSetting(ctx, "mineruTimeoutSeconds", 900, 60, 3600),
    pollIntervalSeconds: integerSetting(ctx, "mineruPollIntervalSeconds", 5, 2, 30),
  };
}

function validateMineruSettings(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("MinerU 设置格式无效");
  const patch = {};
  if (body.clearToken === true) patch.mineruApiToken = "";
  if (typeof body.token === "string" && body.token.trim()) {
    const token = body.token.trim().replace(/^Bearer\s+/i, "");
    if (token.length < 16 || token.length > 4096 || /\s/.test(token)) throw new Error("MinerU Token 格式无效");
    patch.mineruApiToken = token;
  }
  if (body.modelVersion !== undefined) {
    if (!MINERU_MODELS.has(body.modelVersion)) throw new Error("MinerU 模型只能是 vlm 或 pipeline");
    patch.mineruModelVersion = body.modelVersion;
  }
  if (body.language !== undefined) {
    if (!MINERU_LANGUAGES.has(body.language)) throw new Error("MinerU 文档语言无效");
    patch.mineruLanguage = body.language;
  }
  for (const [inputKey, configKey] of [
    ["enableFormula", "mineruEnableFormula"],
    ["enableTable", "mineruEnableTable"],
    ["ocr", "mineruOcr"],
  ]) {
    if (body[inputKey] !== undefined) {
      if (typeof body[inputKey] !== "boolean") throw new Error(`${inputKey} 必须是布尔值`);
      patch[configKey] = body[inputKey];
    }
  }
  for (const [inputKey, configKey, min, max] of [
    ["timeoutSeconds", "mineruTimeoutSeconds", 60, 3600],
    ["pollIntervalSeconds", "mineruPollIntervalSeconds", 2, 30],
  ]) {
    if (body[inputKey] !== undefined) {
      const numeric = Number(body[inputKey]);
      if (!Number.isInteger(numeric) || numeric < min || numeric > max) throw new Error(`${inputKey} 超出允许范围`);
      patch[configKey] = numeric;
    }
  }
  return patch;
}

function publicMineruError(error, ctx) {
  let message = String(error?.message || "MinerU 解析失败");
  const configuredToken = String(ctx?.config?.get?.("mineruApiToken") || "")
    .trim()
    .replace(/^Bearer\s+/i, "");
  if (configuredToken) message = message.split(configuredToken).join("[REDACTED]");
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/https?:\/\/\S+/gi, "[受保护地址]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "[受保护 ID]")
    .replace(/批次 ID：\S+/g, "批次 ID：[受保护 ID]")
    .slice(0, 600);
}

async function readBoundedRequestBytes(c, maxBytes, emptyMessage) {
  const declaredLengthText = String(c.req.header("content-length") || "").trim();
  if (/^\d+$/.test(declaredLengthText) && Number(declaredLengthText) > maxBytes) {
    throw new PdfRequestError(`PDF 不得超过 ${MAX_PDF_BYTES / 1024 / 1024} MB`, 413);
  }

  const stream = c.req.raw?.body;
  if (!stream || typeof stream.getReader !== "function") throw new PdfRequestError(emptyMessage, 400);
  const reader = stream.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength === 0) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("PDF payload too large").catch(() => {});
        throw new PdfRequestError(`PDF 不得超过 ${MAX_PDF_BYTES / 1024 / 1024} MB`, 413);
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }
  if (totalBytes === 0) throw new PdfRequestError(emptyMessage, 400);
  return Buffer.concat(chunks, totalBytes);
}

function decodeLegacyPdfBase64(value) {
  let encoded = typeof value === "string" ? value : "";
  const dataPrefix = "data:application/pdf;base64,";
  if (encoded.startsWith(dataPrefix)) encoded = encoded.slice(dataPrefix.length);
  if (!encoded || encoded.length > MAX_LEGACY_BASE64_CHARS) {
    throw new PdfRequestError(`PDF 不得超过 ${MAX_PDF_BYTES / 1024 / 1024} MB`, encoded ? 413 : 400);
  }
  if (encoded.length % 4 !== 0) {
    throw new PdfRequestError("旧版卡片发送的 PDF Base64 长度无效，请关闭并重新打开阅读器", 400);
  }
  let paddingStart = encoded.length;
  while (paddingStart > 0 && encoded.charCodeAt(paddingStart - 1) === 61) paddingStart -= 1;
  const paddingLength = encoded.length - paddingStart;
  if (paddingLength > 2) {
    throw new PdfRequestError("旧版卡片发送的 PDF Base64 填充无效，请关闭并重新打开阅读器", 400);
  }
  for (let index = 0; index < encoded.length; index += 1) {
    const code = encoded.charCodeAt(index);
    const allowedData = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43 || code === 47;
    if ((!allowedData && code !== 61) || (code === 61 && index < paddingStart)) {
      throw new PdfRequestError("旧版卡片发送的 PDF 数据格式无效，请关闭并重新打开阅读器", 400);
    }
  }
  const decodedLength = encoded.length / 4 * 3 - paddingLength;
  if (decodedLength <= 0 || decodedLength > MAX_PDF_BYTES) {
    throw new PdfRequestError(`PDF 不得超过 ${MAX_PDF_BYTES / 1024 / 1024} MB`, decodedLength > 0 ? 413 : 400);
  }
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length !== decodedLength) {
    throw new PdfRequestError("旧版卡片发送的 PDF Base64 无法完整解码，请关闭并重新打开阅读器", 400);
  }
  return buffer;
}

async function readPdfRequest(c) {
  const contentType = String(c.req.header("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType === "application/pdf" || contentType === "application/octet-stream") {
    return {
      buffer: await readBoundedRequestBytes(c, MAX_PDF_BYTES, "未收到 PDF 二进制数据"),
      fileName: c.req.query("fileName") || "paper.pdf",
      transport: "binary",
      uiVersion: String(c.req.header("x-hana-paper-reader-ui-version") || ""),
    };
  }
  if (contentType === "application/json") {
    const bytes = await readBoundedRequestBytes(c, MAX_LEGACY_JSON_BYTES, "未收到旧版 PDF 数据");
    let body;
    try {
      body = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new PdfRequestError("旧版卡片发送的 PDF JSON 无法解析，请关闭并重新打开阅读器", 400);
    }
    if (body?.parser && body.parser !== "mineru") {
      throw new PdfRequestError("本地解析已移除；PDF 只使用 MinerU API 解析", 400);
    }
    return {
      buffer: decodeLegacyPdfBase64(body?.base64),
      fileName: typeof body?.fileName === "string" ? body.fileName : "paper.pdf",
      transport: "legacy-base64",
      uiVersion: "0.4.0",
    };
  }
  throw new PdfRequestError("PDF 上传协议不受支持，请关闭并重新打开阅读器后重试", 415);
}

export default function registerApiRoutes(app, ctx) {
  app.get("/api/mineru-settings", (c) => c.json(publicMineruSettings(ctx)));

  app.post("/api/mineru-settings", async (c) => {
    try {
      const patch = validateMineruSettings(await c.req.json());
      ctx.config.setMany(patch, { scope: "global" });
      return c.json(publicMineruSettings(ctx));
    } catch (error) {
      return c.json({ ok: false, error: String(error?.message || "MinerU 设置保存失败").slice(0, 300) }, 400);
    }
  });

  app.get("/api/mineru-asset", (c) => {
    try {
      const cacheId = c.req.query("cacheId") || "";
      const assetPath = c.req.query("path") || "";
      const asset = readMineruAsset({ ctx, cacheId, assetPath });
      if (!asset) return c.json({ ok: false, error: "MinerU 资源不存在" }, 404);
      return new Response(asset.bytes, {
        status: 200,
        headers: {
          "Content-Type": asset.contentType,
          "Content-Length": String(asset.bytes.length),
          "Cache-Control": "private, max-age=86400, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      ctx.log?.error?.("read MinerU asset error:", error);
      return c.json({ ok: false, error: "MinerU 资源读取失败" }, 500);
    }
  });

  app.get("/api/agents", async (c) => {
    try {
      const { bus } = getRequestRuntime(c, ctx);
      return c.json({ ok: true, agents: await listAgents(bus) });
    } catch (error) {
      ctx.log?.error?.("get agents error:", error);
      return c.json({ ok: false, error: "无法读取本机助手列表", agents: [] }, 500);
    }
  });

  app.post("/api/parse-pdf", async (c) => {
    try {
      const requestedParser = String(c.req.query("parser") || "mineru").trim().toLowerCase();
      if (requestedParser !== "mineru") {
        return c.json({ ok: false, parser: "mineru", apiVersion: PLUGIN_API_VERSION, error: "本地解析已移除；PDF 只使用 MinerU API 解析" }, 400);
      }
      const request = await readPdfRequest(c);
      if (request.buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
        throw new PdfRequestError("上传的文件不是有效 PDF", 400);
      }
      const result = await parsePdfWithMineru({
        buffer: request.buffer,
        fileName: request.fileName,
        ctx,
      });
      return c.json({
        ...result,
        apiVersion: PLUGIN_API_VERSION,
        uiVersion: request.uiVersion || null,
        transport: request.transport,
      });
    } catch (error) {
      const message = publicMineruError(error, ctx);
      if (!(error instanceof PdfRequestError)) ctx.log?.error?.("MinerU parse pdf error:", message);
      const status = error instanceof PdfRequestError
        ? error.status
        : message.startsWith("请先") || message.includes("API 地址") || message.includes("Token") ? 400 : 502;
      return c.json({ ok: false, parser: "mineru", apiVersion: PLUGIN_API_VERSION, error: message }, status);
    }
  });

  app.post("/api/translate", async (c) => {
    try {
      const { bus } = getRequestRuntime(c, ctx);
      const body = await c.req.json();
      const list = Array.isArray(body?.texts) ? body.texts : (typeof body?.text === "string" ? [body.text] : []);
      if (!list.length || list.length > MAX_BATCH_ITEMS) return c.json({ ok: false, error: `一次最多翻译 ${MAX_BATCH_ITEMS} 段` }, 400);
      if (list.some((item) => typeof item !== "string" || item.length > MAX_TEXT_CHARS) || list.join("").length > MAX_BATCH_CHARS) return c.json({ ok: false, error: "文本过长，请拆分后翻译" }, 413);

      if (body?.agentId) {
        const agent = await resolveAgent(bus, body.agentId);
        if (!agent) return c.json({ ok: false, error: "未找到指定助手" }, 400);
        const prompt = `请翻译下面的学术英文。只返回 JSON 字符串数组，数组长度必须为 ${list.length}，不要输出解释。\n${JSON.stringify(list)}`;
        const result = await runAgentTurn(bus, ctx, agent.id, prompt, {
          reuse: true,
          namespace: "translation",
          thinkingLevel: body.thinkingLevel,
        });
        const translations = parseJsonArray(result.text);
        if (!translations || translations.length !== list.length) return c.json({ ok: false, error: "翻译模型返回格式无效" }, 502);
        return c.json({
          ok: true,
          translations,
          model: agent.model,
          thinkingLevel: result.target.thinkingLevel || result.target.requestedThinkingLevel,
        });
      }

      return c.json({ ok: true, translations: await runUtilityTranslation(bus, list), model: "utility" });
    } catch (error) {
      ctx.log?.error?.("translate error:", error);
      return c.json({ ok: false, error: "翻译失败，请稍后重试" }, 502);
    }
  });

  app.post("/api/ask-agent", async (c) => {
    try {
      const { bus } = getRequestRuntime(c, ctx);
      const body = await c.req.json();
      const agent = await resolveAgent(bus, body?.agentId);
      if (!agent) return c.json({ ok: false, error: "未找到指定助手" }, 400);
      const quote = typeof body.quote === "string" ? body.quote.trim() : "";
      const context = typeof body.context === "string" ? body.context.trim() : "";
      if (!quote || quote.length > MAX_TEXT_CHARS) return c.json({ ok: false, error: "选中文本为空或过长" }, 400);

      let task = "请用严谨但易懂的语言解释选中文献内容的原理、论证逻辑和关键要点。";
      if (body.questionType === "formula") task = "请逐项解释公式中的变量、推导逻辑和数学或物理意义。";
      if (body.questionType === "explain") task = "请解释术语的定义、背景、应用场景及其在本文中的作用。";
      if (body.questionType === "critique") task = "请从审稿人角度客观分析方法和结论的可靠性。";
      if (typeof body.prompt === "string" && body.prompt.trim()) task = body.prompt.trim().slice(0, MAX_TEXT_CHARS);

      const prompt = `论文：${String(body.paperTitle || "当前学术文献").slice(0, 500)}\n上下文：${context}\n选中文本：${quote}\n\n任务：${task}\n请直接回答，支持 Markdown。`;
      const result = await runAgentTurn(bus, ctx, agent.id, prompt, {
        reuse: true,
        namespace: "reader",
        thinkingLevel: body.thinkingLevel,
      });
      return c.json({
        ok: true,
        answer: result.text,
        model: agent.model,
        sessionId: result.target.sessionId,
        thinkingLevel: result.target.thinkingLevel || result.target.requestedThinkingLevel,
      });
    } catch (error) {
      ctx.log?.error?.("ask agent error:", error);
      return c.json({ ok: false, error: "助手响应失败或超时，请稍后重试" }, 502);
    }
  });

  app.post("/api/send-to-session", async (c) => {
    try {
      const { bus } = getRequestRuntime(c, ctx);
      const body = await c.req.json();
      const agent = await resolveAgent(bus, body?.agentId);
      if (!agent) return c.json({ ok: false, error: "未找到指定助手" }, 400);
      const quote = typeof body.quote === "string" ? body.quote.trim() : "";
      if (!quote || quote.length > MAX_TEXT_CHARS) return c.json({ ok: false, error: "选中文本为空或过长" }, 400);

      const text = `【文献划词研讨】\n论文：${String(body.paperTitle || "当前阅读论文").slice(0, 500)}\n选中文本：${quote}\n上下文：${String(body.context || "").slice(0, MAX_TEXT_CHARS)}\n\n请在这个助手会话中继续分析这段内容。`;
      const target = await sendAgentMessage(bus, ctx, agent.id, text, body.thinkingLevel);
      return c.json({
        ok: true,
        accepted: true,
        sessionId: target.sessionId,
        thinkingLevel: target.thinkingLevel || target.requestedThinkingLevel,
        message: "已发送到该助手的文献研讨会话",
      });
    } catch (error) {
      ctx.log?.error?.("send to session error:", error);
      return c.json({ ok: false, error: "发送会话失败，请稍后重试" }, 502);
    }
  });
}
