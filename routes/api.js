import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { parsePdfWithMineru, readMineruAsset } from "../lib/mineru.js";
import { generatePaperMarkdown } from "../lib/paper-export.js?hpr=0.7.0-r1";
import { createPaperWorkspace, sha256 } from "../lib/paper-workspace.js?hpr=0.7.0-r1";

const AGENT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const DELETED_AGENT_TOMBSTONE = ".deleted-agent.json";
const MODEL_REF_RE = /^[^/\x00-\x20]{1,160}\/[^\x00-\x20]{1,240}$/u;
const MODEL_CATALOG_TTL_MS = 5000;
const PLUGIN_API_VERSION = "0.7.0";
const MAX_SESSION_TARGETS = 200;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_SESSION_TARGET_ID_LENGTH = 96;
const SESSION_TARGET_TTL_MS = 15 * 60 * 1000;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_LEGACY_BASE64_CHARS = Math.ceil(MAX_PDF_BYTES / 3) * 4;
const MAX_LEGACY_JSON_BYTES = MAX_LEGACY_BASE64_CHARS + 1024 * 1024;
const MAX_TEXT_CHARS = 12000;
const MAX_BATCH_ITEMS = 8;
const MAX_BATCH_CHARS = 50000;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const THINKING_LEVELS = new Set(["off", "low", "medium", "high", "max"]);
const DEFAULT_THINKING_LEVEL = "max";
const agentSessionCache = new Map();
const agentTurnLocks = new Map();
const modelCatalogCache = new WeakMap();
const sessionTargetStore = new Map();
const MINERU_MODELS = new Set(["vlm", "pipeline"]);
const MINERU_LANGUAGES = new Set(["ch", "en", "japan", "latin"]);
const researchWorkspaceCache = new WeakMap();
const MAX_RESEARCH_BLOCKS = 24;
const MAX_RESEARCH_EVIDENCE_CHARS = 50000;
const MAX_RESEARCH_LIMIT = 100;

class PdfRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "PdfRequestError";
    this.status = status;
  }
}

class SessionTargetError extends Error {
  constructor(message, status = 400, code = "session_target_invalid") {
    super(message);
    this.name = "SessionTargetError";
    this.status = status;
    this.code = code;
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

function sessionTargetScope(requestContext) {
  const principalId = requestContext?.principal?.principalId
    || requestContext?.principal?.id
    || "local";
  return String(principalId).slice(0, 256);
}

function isAgentId(value) {
  return typeof value === "string" && AGENT_ID_RE.test(value);
}

function parseConfig(raw) {
  const clean = (value) => value?.trim().replace(/^["']|["']$/g, "") || null;
  const nameMatch = raw.match(/^\s{2}name:\s*([^\r\n#]+)/m);
  const chatBlock = raw.match(/(?:^|\r?\n)\s{2}chat:\s*\r?\n([\s\S]*?)(?=\r?\n\s{2}[A-Za-z_][\w-]*:\s|\r?\n[A-Za-z_][\w-]*:\s|$)/m);
  const modelMatch = (chatBlock?.[1] || "").match(/^\s{4}id:\s*([^\r\n#]+)/m);
  const providerMatch = (chatBlock?.[1] || "").match(/^\s{4}provider:\s*([^\r\n#]+)/m);
  const modelId = clean(modelMatch?.[1]);
  const provider = clean(providerMatch?.[1]);
  return {
    name: clean(nameMatch?.[1]),
    model: provider && modelId ? `${provider}/${modelId}` : modelId,
  };
}

function modelFromProfile(profile) {
  const chat = profile?.models?.chat;
  if (typeof chat === "string" && chat.trim()) return chat.trim();
  if (chat && typeof chat === "object") {
    const provider = chat.provider || chat.providerId;
    const id = chat.id || chat.modelId || chat.model;
    if (provider && id) return `${provider}/${id}`;
    return id || "默认模型";
  }
  return "默认模型";
}

function normalizeModelRef(value) {
  const ref = typeof value === "string" ? value.trim() : "";
  return MODEL_REF_RE.test(ref) ? ref : "";
}

function splitModelRef(value) {
  const ref = normalizeModelRef(value);
  if (!ref) return null;
  const slash = ref.indexOf("/");
  return { ref, provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

function modelRefFromEntry(entry) {
  const provider = typeof (entry?.provider || entry?.providerId) === "string"
    ? String(entry.provider || entry.providerId).trim()
    : "";
  const id = typeof entry?.id === "string" && entry.id.trim()
    ? entry.id.trim()
    : typeof entry?.modelId === "string" && entry.modelId.trim()
      ? entry.modelId.trim()
      : typeof entry?.model === "string" && entry.model.trim()
        ? entry.model.trim()
        : "";
  return normalizeModelRef(`${provider}/${id}`);
}

async function listConfiguredChatModels(bus, { forceRefresh = false } = {}) {
  if (!bus || typeof bus.request !== "function") return { ok: false, models: [], reason: "provider bus unavailable" };
  const now = Date.now();
  const cached = modelCatalogCache.get(bus);
  if (!forceRefresh && cached && cached.expiresAt > now) return cached.value;
  const pending = (async () => {
    try {
      const result = await bus.request("provider:models-by-type", { type: "chat" });
      const unique = new Map();
      for (const entry of Array.isArray(result?.models) ? result.models : []) {
        const ref = modelRefFromEntry(entry);
        if (!ref || unique.has(ref)) continue;
        const split = splitModelRef(ref);
        unique.set(ref, {
          ref,
          provider: split.provider,
          id: split.id,
          name: typeof entry?.name === "string" && entry.name.trim()
            ? entry.name.trim()
            : typeof entry?.displayName === "string" && entry.displayName.trim()
              ? entry.displayName.trim()
              : split.id,
        });
      }
      return { ok: true, models: [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.ref.localeCompare(b.ref)) };
    } catch (error) {
      return { ok: false, models: [], reason: error?.message || String(error) };
    }
  })();
  if (!forceRefresh) {
    const value = pending.then((result) => {
      modelCatalogCache.set(bus, { value: result, expiresAt: Date.now() + MODEL_CATALOG_TTL_MS });
      return result;
    }).catch((error) => {
      modelCatalogCache.delete(bus);
      throw error;
    });
    modelCatalogCache.set(bus, { value, expiresAt: now + MODEL_CATALOG_TTL_MS });
    return value;
  }
  return pending;
}

async function resolveSelectedModel(bus, modelRef, agent) {
  const requested = typeof modelRef === "string" ? modelRef.trim() : "";
  if (!requested || requested === "agent-default") return { mode: "agent-default", ref: null, model: null, label: agent?.model || "跟随 Agent" };
  const ref = normalizeModelRef(requested);
  if (!ref) throw new SessionTargetError("模型选择无效，请重新选择", 400, "model_invalid");
  const catalog = await listConfiguredChatModels(bus, { forceRefresh: true });
  if (!catalog.ok) throw new SessionTargetError("无法读取当前聊天模型列表，请稍后重试", 503, "model_catalog_unavailable");
  const selected = catalog.models.find((entry) => entry.ref === ref);
  if (!selected) throw new SessionTargetError("所选模型当前不可用，请重新选择", 409, "model_unavailable");
  const parts = splitModelRef(ref);
  return { mode: "selected", ref, model: { provider: parts.provider, id: parts.id }, label: selected.name, provider: parts.provider, id: parts.id };
}

function modelSelectionKey(selection) {
  return selection?.ref || "agent-default";
}

function publicModelSelection(selection, agent) {
  const selected = selection?.mode === "selected" && selection?.ref;
  return {
    mode: selected ? "selected" : "agent-default",
    ref: selected ? selection.ref : null,
    provider: selected ? selection.provider || selection.model?.provider || null : null,
    id: selected ? selection.id || selection.model?.id || null : null,
    label: selected ? selection.label || selection.ref : "跟随 Agent",
    effective: selected ? selection.ref : agent?.model || null,
  };
}

function hasExplicitModelRef(value) {
  const requested = typeof value === "string" ? value.trim() : "";
  return Boolean(requested && requested !== "agent-default");
}

async function resolveAgentModelSelection(bus, body, agent) {
  if (hasExplicitModelRef(body?.modelRef) && !agent) {
    throw new SessionTargetError("选择模型时必须同时选择助手", 400, "model_agent_required");
  }
  return resolveSelectedModel(bus, body?.modelRef, agent);
}

function isDeletedAgentDir(agentsDir, agentId) {
  if (!isAgentId(agentId)) return false;
  const agentDir = path.join(agentsDir, agentId);
  if (path.basename(agentDir) !== agentId) return false;
  return fs.existsSync(path.join(agentDir, DELETED_AGENT_TOMBSTONE));
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
  const agentsDir = path.join(getHanaHomeDir(), "agents");
  try {
    const result = await bus?.request?.("agent:list", { includePluginPrivate: true });
    const hostAgents = Array.isArray(result) ? result : (result?.agents || []);
    for (const agent of hostAgents) {
      if (isAgentId(agent?.id) && !isDeletedAgentDir(agentsDir, agent.id)) {
        records.set(agent.id, { id: agent.id, name: agent.name || null });
      }
    }
  } catch {}

  try {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (
        entry.isDirectory()
        && isAgentId(entry.name)
        && !isDeletedAgentDir(agentsDir, entry.name)
        && fs.existsSync(path.join(agentsDir, entry.name, "config.yaml"))
      ) {
        if (!records.has(entry.name)) records.set(entry.name, { id: entry.name, name: null });
      }
    }
  } catch {}

  const agents = await Promise.all([...records.values()].map(async ({ id, name }) => {
    let profile = null;
    try {
      const result = await bus?.request?.("agent:profile", { agentId: id });
      profile = result?.profile || result?.agent || null;
    } catch {}
    const local = readLocalAgent(id, profile);
    const agent = local || {
      id,
      name: profile?.name || name || id,
      model: modelFromProfile(profile),
      description: profile?.description || profile?.identity || "",
      avatarUrl: null,
    };
    if (name && agent.name === id) agent.name = name;
    const modelRef = normalizeModelRef(agent.model);
    return { ...agent, modelRef: modelRef || null };
  }));

  const priorityOrder = ["hakimi", "agent-mqb7zal0", "cixiaogui", "beishu", "hanako"];
  agents.sort((a, b) => {
    const ia = priorityOrder.indexOf(a.id);
    const ib = priorityOrder.indexOf(b.id);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return String(a.name).localeCompare(String(b.name), "zh-CN") || String(a.id).localeCompare(String(b.id));
  });
  return agents;
}

async function resolveAgent(bus, agentId) {
  if (!isAgentId(agentId)) return null;
  const agentsDir = path.join(getHanaHomeDir(), "agents");
  if (isDeletedAgentDir(agentsDir, agentId)) return null;
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

async function createAgentSession(bus, ctx, agentId, visibility, thinkingLevel = DEFAULT_THINKING_LEVEL, modelSelection = null) {
  const requestedThinkingLevel = normalizeThinkingLevel(thinkingLevel);
  const basePayload = {
    agentId,
    ownerPluginId: ctx.pluginId,
    visibility,
    kind: "paper-reader",
    memoryEnabled: false,
    ...(modelSelection?.model ? { model: modelSelection.model } : {}),
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
    modelSelection: modelSelection || { mode: "agent-default", ref: null, model: null, label: "跟随 Agent" },
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

async function getAgentSession(bus, ctx, agentId, visibility, namespace, reuse, thinkingLevel, modelSelection) {
  const modelKey = modelSelectionKey(modelSelection);
  const cacheKey = `${namespace}:${visibility}:${agentId}:${modelKey}`;
  if (reuse && agentSessionCache.has(cacheKey)) return { target: agentSessionCache.get(cacheKey), cacheKey };
  const target = await createAgentSession(bus, ctx, agentId, visibility, thinkingLevel, modelSelection);
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
  const modelSelection = options.modelSelection || { mode: "agent-default", ref: null, model: null, label: "跟随 Agent" };
  const modelKey = modelSelectionKey(modelSelection);
  const lockKey = `${namespace}:${visibility}:${agentId}:${modelKey}`;

  return withAgentTurnLock(lockKey, async () => {
    let { target, cacheKey } = await getAgentSession(
      bus,
      ctx,
      agentId,
      visibility,
      namespace,
      reuse,
      options.thinkingLevel,
      modelSelection,
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
        target = await createAgentSession(bus, ctx, agentId, visibility, options.thinkingLevel, modelSelection);
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

function normalizeSessionId(value) {
  const sessionId = typeof value === "string" ? value.trim() : "";
  return sessionId && sessionId.length <= MAX_SESSION_ID_LENGTH ? sessionId : "";
}

function normalizeSessionRecord(session) {
  if (!session || typeof session !== "object") return null;
  const sessionId = normalizeSessionId(session.sessionId);
  const sessionPath = typeof session.path === "string" && session.path.trim() ? session.path.trim() : null;
  const visibility = String(session.visibility || session.sessionVisibility || "public").trim().toLowerCase();
  const kind = String(session.kind || session.sessionKind || "").trim().toLowerCase();
  if ((!sessionId && !sessionPath) || session.agentDeleted === true || session.readOnlyReason || visibility === "private" || visibility === "plugin_private" || kind === "sub-chat") {
    return null;
  }
  const firstMessage = typeof session.firstMessage === "string" ? session.firstMessage.trim().slice(0, 240) : "";
  const title = typeof session.title === "string" ? session.title.trim().slice(0, 240) : "";
  const modifiedValue = session.modified instanceof Date
    ? session.modified.getTime()
    : typeof session.modified === "string" || typeof session.modified === "number"
      ? new Date(session.modified).getTime()
      : NaN;
  const modified = Number.isFinite(modifiedValue) ? new Date(modifiedValue).toISOString() : null;
  return {
    sessionId: sessionId || null,
    path: sessionPath,
    title: title || firstMessage || "未命名对话",
    firstMessage,
    agentId: typeof session.agentId === "string" ? session.agentId : null,
    agentName: typeof session.agentName === "string" && session.agentName.trim() ? session.agentName.trim() : null,
    modified,
    messageCount: Number.isFinite(Number(session.messageCount)) ? Number(session.messageCount) : 0,
    kind: typeof session.kind === "string" ? session.kind : null,
    visibility,
  };
}

function publicSessionRecord(session) {
  const { path: _path, sessionId: _sessionId, ...publicRecord } = session;
  return publicRecord;
}

function purgeExpiredSessionTargets() {
  const now = Date.now();
  for (const [targetId, target] of sessionTargetStore) {
    if (!target || target.expiresAt <= now) sessionTargetStore.delete(targetId);
  }
}

function issueSessionTarget(pluginId, record, scope, namespace) {
  purgeExpiredSessionTargets();
  const targetId = `st_${randomUUID()}`;
  sessionTargetStore.set(targetId, {
    pluginId,
    scope,
    namespace,
    targetId,
    sessionId: record.sessionId,
    path: record.path,
    record,
    expiresAt: Date.now() + SESSION_TARGET_TTL_MS,
  });
  while (sessionTargetStore.size > MAX_SESSION_TARGETS * 4) {
    const oldest = sessionTargetStore.keys().next().value;
    if (!oldest) break;
    sessionTargetStore.delete(oldest);
  }
  return { targetId, ...publicSessionRecord(record) };
}

async function listSelectableSessions(bus) {
  const result = await bus.request("session:list", {});
  const records = Array.isArray(result) ? result : result?.sessions;
  if (!Array.isArray(records)) return [];
  return records.map(normalizeSessionRecord).filter(Boolean).slice(0, MAX_SESSION_TARGETS);
}

function targetFromRecord(record, targetId = null) {
  if (!record?.sessionId && !record?.path) {
    throw new SessionTargetError("目标对话身份不可用", 404, "session_target_unavailable");
  }
  return {
    targetId,
    sessionId: record.sessionId || null,
    sessionRef: {
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      ...(record.path ? { sessionPath: record.path } : {}),
    },
    record,
  };
}

function normalizeSessionTargetId(value) {
  const targetId = typeof value === "string" ? value.trim() : "";
  return targetId && targetId.length <= MAX_SESSION_TARGET_ID_LENGTH && /^st_[A-Za-z0-9-]+$/.test(targetId)
    ? targetId
    : "";
}

async function resolveStoredSessionTarget(bus, stored, targetId) {
  const lookup = stored.sessionId
    ? { sessionId: stored.sessionId }
    : stored.path
      ? { sessionPath: stored.path }
      : null;
  if (!lookup) throw new SessionTargetError("目标对话身份不可用", 404, "session_target_unavailable");
  try {
    const result = await bus.request("session:get", lookup);
    const record = normalizeSessionRecord(result?.session || result);
    if (record) return targetFromRecord(record, targetId);
  } catch {}
  throw new SessionTargetError("目标对话已不存在或不可发送，请重新选择", 409, "session_target_expired");
}

async function resolveExistingSessionTarget(bus, input, pluginId, scope, namespace) {
  purgeExpiredSessionTargets();
  const rawTargetId = typeof input?.targetId === "string" ? input.targetId.trim() : "";
  if (rawTargetId) {
    const targetId = normalizeSessionTargetId(rawTargetId);
    if (!targetId) {
      throw new SessionTargetError("目标对话选择无效，请重新选择", 400, "session_target_invalid");
    }
    const stored = sessionTargetStore.get(targetId);
    if (!stored || stored.pluginId !== pluginId || stored.scope !== scope || stored.namespace !== namespace) {
      throw new SessionTargetError("目标对话选择已失效，请重新选择", 409, "session_target_expired");
    }
    return resolveStoredSessionTarget(bus, stored, targetId);
  }

  const sessionRef = input?.sessionRef && typeof input.sessionRef === "object" ? input.sessionRef : null;
  const sessionId = normalizeSessionId(input?.sessionId || sessionRef?.sessionId);
  const sessionPath = typeof sessionRef?.sessionPath === "string" && sessionRef.sessionPath.trim()
    ? sessionRef.sessionPath.trim()
    : "";
  if (!sessionId && !sessionPath) {
    throw new SessionTargetError("请选择一个目标对话", 400, "session_target_required");
  }

  let record = (await listSelectableSessions(bus)).find((item) => (
    sessionId && item.sessionId === sessionId
  ) || (
    !sessionId && sessionPath && item.path === sessionPath
  )) || null;
  if (!record) {
    try {
      const result = await bus.request("session:get", sessionId ? { sessionId } : { sessionPath });
      record = normalizeSessionRecord(result?.session || result);
    } catch {}
  }
  if (!record) {
    throw new SessionTargetError("目标对话不存在或不可发送", 404, "session_target_unavailable");
  }
  return targetFromRecord(record);
}

async function sendToExistingSession(bus, target, text) {
  const lockKey = `send-target:${target.sessionId || target.sessionRef?.sessionPath}`;
  return withAgentTurnLock(lockKey, async () => {
    try {
      await sendToTarget(bus, target, text);
      return target;
    } catch (error) {
      if (String(error?.message || "").includes("session_busy")) {
        error.status = 409;
        error.code = "session_busy";
      }
      throw error;
    }
  });
}

async function createAndSendAgentMessage(bus, ctx, agentId, text, thinkingLevel, modelSelection) {
  const target = await createAgentSession(bus, ctx, agentId, "public", thinkingLevel, modelSelection);
  await sendToTarget(bus, target, text);
  return target;
}

function quoteSessionPayload(workspace, body) {
  const quote = typeof body?.quote === "string" ? body.quote.trim() : "";
  if (!quote || quote.length > MAX_TEXT_CHARS) {
    throw new SessionTargetError("选中文本为空或过长", 400, "quote_invalid");
  }
  const evidence = verifiedQuoteEvidence(workspace, body);
  const citation = evidence ? `Page ${evidence.page} / block ${evidence.blockId}` : "";
  const context = withoutClientCitation(body.context);
  const text = `【文献划词研讨】\n论文：${String(body.paperTitle || "当前阅读论文").slice(0, 500)}\n${citation ? `已核验来源：${citation}\n` : ""}选中文本：${quote}\n上下文：${context}\n\n请在这个助手会话中继续分析这段内容。${citation ? `回答时请保留来源标记：${citation}。` : ""}`;
  return { quote, evidence, citation, text };
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

function glossaryInstruction(terms) {
  if (!terms || typeof terms !== "object" || Array.isArray(terms)) return "";
  const entries = Object.entries(terms)
    .filter(([source, target]) => typeof source === "string" && source.trim() && typeof target === "string" && target.trim())
    .slice(0, 100);
  return entries.length
    ? `\n术语表（必须优先采用固定译法）：${JSON.stringify(Object.fromEntries(entries))}`
    : "";
}

async function runUtilityTranslation(bus, list, glossaryTerms = {}) {
  const prompt = `请将以下学术英文逐条翻译为准确、自然的学术中文。保留公式、数字和专业缩写。只返回 JSON 字符串数组，数组长度必须为 ${list.length}，不要附加解释：${glossaryInstruction(glossaryTerms)}\n${JSON.stringify(list)}`;
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

function getResearchWorkspace(ctx) {
  let workspace = researchWorkspaceCache.get(ctx);
  if (!workspace) {
    workspace = createPaperWorkspace({ dataDir: ctx.dataDir });
    researchWorkspaceCache.set(ctx, workspace);
  }
  return workspace;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function requestQuery(c, key) {
  return typeof c.req.query === "function" ? c.req.query(key) : "";
}

function requestParam(c, key) {
  return typeof c.req.param === "function" ? c.req.param(key) : "";
}

function researchLimit(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) ? Math.max(1, Math.min(MAX_RESEARCH_LIMIT, numeric)) : MAX_RESEARCH_LIMIT;
}

function researchPaperHash(c, body = null) {
  return (body && typeof body.paperHash === "string" ? body.paperHash : requestQuery(c, "paperHash")) || "";
}

function researchJsonError(c, error, status = 400) {
  return c.json({ ok: false, error: String(error?.message || error || "研究工作区请求失败").slice(0, 500) }, status);
}

function agentJsonError(c, error, fallback, defaultStatus = 502) {
  if (error instanceof SessionTargetError) {
    return c.json({ ok: false, error: error.message, code: error.code }, error.status);
  }
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600
    ? error.status
    : defaultStatus;
  return c.json({ ok: false, error: fallback, code: error?.code || null }, status);
}

function publicCachedPaper(paper) {
  if (!paper) return null;
  return {
    paperHash: paper.paperHash,
    metadata: paper.metadata || {},
    parser: paper.parser || {},
    blocks: Array.isArray(paper.blocks) ? paper.blocks : [],
    resources: Array.isArray(paper.resources) ? paper.resources : [],
    translations: paper.translations || {},
    translationStates: paper.translationStates || {},
    readingMode: ["original", "bilingual", "translation", "contrast"].includes(paper.readingMode) ? paper.readingMode : "bilingual",
    structureDetached: paper.structureDetached === true || paper.parser?.structureDetached === true,
    translationGlossaryVersion: Number.isInteger(Number(paper.translationGlossaryVersion)) ? Number(paper.translationGlossaryVersion) : 0,
    createdAt: paper.createdAt || null,
    updatedAt: paper.updatedAt || null,
  };
}

function translationValue(translations, blockId) {
  if (!translations || !blockId) return "";
  const candidate = Array.isArray(translations)
    ? translations.find((item) => item?.blockId === blockId || item?.block_id === blockId)
    : translations[blockId];
  if (typeof candidate === "string") return candidate;
  return typeof candidate?.translation === "string" ? candidate.translation
    : typeof candidate?.text === "string" ? candidate.text
      : typeof candidate?.value === "string" ? candidate.value : "";
}

function blocksWithTranslations(blocks, translations, clearExisting = false) {
  if (!Array.isArray(blocks)) return [];
  return blocks.map((block) => {
    const normalized = clearExisting && block && typeof block === "object"
      ? Object.fromEntries(Object.entries(block).filter(([key]) => key !== "translatedText"))
      : block;
    const translation = translationValue(translations, block?.id);
    return translation ? { ...normalized, translatedText: translation } : normalized;
  });
}

function normalizedTranslationMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([blockId, translation]) => [blockId, translationValue({ [blockId]: translation }, blockId).trim()])
    .filter(([blockId, translation]) => blockId && translation));
}

function blockTranslationMap(blocks) {
  return Object.fromEntries((Array.isArray(blocks) ? blocks : [])
    .filter((block) => block?.id && typeof block.translatedText === "string" && block.translatedText.trim())
    .map((block) => [block.id, block.translatedText.trim()]));
}

function normalizedTranslationStates(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([blockId, rawState]) => {
    if (!blockId || !rawState || typeof rawState !== "object" || Array.isArray(rawState)) return [];
    const kind = rawState.kind === "final" ? "final" : rawState.kind === "ai" ? "ai" : "";
    if (!kind) return [];
    const state = { kind, locked: kind === "final" ? rawState.locked !== false : false };
    if (typeof rawState.updatedAt === "string" && rawState.updatedAt.trim()) state.updatedAt = rawState.updatedAt.trim().slice(0, 80);
    return [[blockId, state]];
  }));
}

function paperPayload(body, existing) {
  const payload = { paperHash: body?.paperHash };
  for (const key of ["metadata", "parser", "assets", "readingMode"]) {
    if (hasOwn(body, key)) payload[key] = body[key];
  }
  const hasBlocks = hasOwn(body, "blocks");
  const hasTranslations = hasOwn(body, "translations");
  const hasTranslationStates = hasOwn(body, "translationStates");
  const hasTranslationVersion = hasOwn(body, "translationGlossaryVersion");
  const existingVersion = Number.isInteger(Number(existing?.translationGlossaryVersion)) ? Math.max(0, Number(existing.translationGlossaryVersion)) : 0;
  const incomingVersion = hasTranslationVersion && Number.isInteger(Number(body.translationGlossaryVersion))
    ? Math.max(0, Number(body.translationGlossaryVersion))
    : existingVersion;
  const replaceTranslations = hasTranslations && (body?.replaceTranslations === true || (hasTranslationVersion && incomingVersion !== existingVersion));
  const allPreviousTranslations = {
    ...blockTranslationMap(existing?.blocks),
    ...normalizedTranslationMap(existing?.translations),
  };
  const previousStates = normalizedTranslationStates(existing?.translationStates);
  const protectedTranslations = Object.fromEntries(Object.entries(allPreviousTranslations)
    .filter(([blockId]) => previousStates[blockId]?.kind === "final"));
  const incomingTranslations = hasTranslations ? normalizedTranslationMap(body.translations) : {};
  const incomingStates = hasTranslationStates ? normalizedTranslationStates(body.translationStates) : {};
  const previousTranslations = replaceTranslations ? protectedTranslations : allPreviousTranslations;
  const mergedTranslations = { ...previousTranslations, ...incomingTranslations };
  for (const [blockId, translation] of Object.entries(protectedTranslations)) {
    if (incomingStates[blockId]?.kind !== "final") mergedTranslations[blockId] = translation;
  }
  const mergedStates = Object.fromEntries(Object.keys(mergedTranslations).map((blockId) => {
    const previousState = previousStates[blockId];
    const incomingState = incomingStates[blockId];
    const state = previousState?.kind === "final" && incomingState?.kind !== "final"
      ? previousState
      : incomingState
        || (replaceTranslations ? (previousState?.kind === "final" ? previousState : null) : previousState)
        || { kind: "ai", locked: false };
    return [blockId, state];
  }));
  if (hasBlocks || hasTranslations) {
    payload.blocks = blocksWithTranslations(
      hasBlocks ? body.blocks : existing?.blocks || [],
      mergedTranslations,
      replaceTranslations,
    );
  }
  if (hasTranslations || Object.keys(allPreviousTranslations).length) payload.translations = mergedTranslations;
  if (hasTranslations || hasTranslationStates || Object.keys(previousStates).length) payload.translationStates = mergedStates;
  if (hasTranslationVersion) payload.translationGlossaryVersion = incomingVersion;
  return payload;
}

function paperEvidence(workspace, paper, body) {
  const requestedReferences = Array.isArray(body?.evidenceIds) && body.evidenceIds.length
    ? body.evidenceIds.map((evidenceId) => ({ evidenceId }))
    : Array.isArray(body?.blockIds) && body.blockIds.length
      ? body.blockIds.map((blockId) => ({ blockId }))
      : [body?.evidenceId ? { evidenceId: body.evidenceId } : { blockId: body?.blockId || body?.selectedBlockId }].filter((item) => item.blockId || item.evidenceId);
  let selected = requestedReferences.length
    ? requestedReferences.map((reference) => workspace.getEvidence(paper.paperHash, reference, { usageKind: "assistant-context" })).filter(Boolean)
    : workspace.listEvidence(paper.paperHash, { limit: MAX_RESEARCH_BLOCKS, usageKind: "assistant-context" });
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (query && !requestedReferences.length) {
    selected = workspace.search(paper.paperHash, query, { limit: MAX_RESEARCH_BLOCKS })
      .map((hit) => hit.evidence)
      .filter(Boolean);
  }
  const evidence = [];
  let total = 0;
  for (const item of selected.slice(0, MAX_RESEARCH_BLOCKS)) {
    const bodyText = String(item.originalQuote || item.translation || item.visualResource?.latex || "").trim();
    if (!bodyText) continue;
    const line = `[Page ${item.page} / block ${item.blockId}] ${bodyText}`;
    if (total + line.length > MAX_RESEARCH_EVIDENCE_CHARS) break;
    evidence.push({ ...item, id: item.blockId, text: bodyText });
    total += line.length;
  }
  return evidence;
}

function evidencePrompt(paper, evidence, question) {
  const title = String(paper?.metadata?.title || "当前论文").slice(0, 500);
  const source = evidence.map((item) => `[Page ${item.page} / block ${item.id}] ${item.text}`).join("\n");
  return `论文：${title}\n\n以下是当前论文的原文证据，只能依据这些证据回答：\n${source}\n\n用户问题：${question}\n\n请给出严谨、简洁的回答。每个关键结论后必须附上精确格式的证据提示：Page X / block Y；不要编造未出现在证据中的事实。`;
}

function evidenceCitation(evidence) {
  return evidence.map((item) => `Page ${item.page} / block ${item.id}`).join("；");
}

function enforceEvidenceCitations(answer, evidence) {
  const allowed = new Set(evidence.map((item) => `Page ${item.page} / block ${item.id}`));
  let text = String(answer || "").trim().replace(/Page\s+\d+\s+\/\s+block\s+[A-Za-z0-9._:-]+/gi, (match) => {
    const normalized = match.replace(/Page\s+(\d+)\s+\/\s+block\s+/i, "Page $1 / block ");
    return allowed.has(normalized) ? normalized : "[未核验来源已移除]";
  });
  if (![...allowed].some((citation) => text.includes(citation))) text += `\n\n证据提示：${evidenceCitation(evidence)}`;
  return text;
}

function verifiedQuoteEvidence(workspace, body) {
  const hash = typeof body?.paperHash === "string" && /^[a-f0-9]{12,128}$/i.test(body.paperHash) ? body.paperHash : "";
  if (!hash) return null;
  return workspace.getEvidence(hash, { evidenceId: body?.evidenceId, blockId: body?.blockId }, { usageKind: "selection" });
}

function verifiedQuoteCitation(workspace, body) {
  const evidence = verifiedQuoteEvidence(workspace, body);
  return evidence ? `Page ${evidence.page} / block ${evidence.blockId}` : "";
}

function withoutClientCitation(value) {
  return String(value || "")
    .replace(/\n\s*(?:来源|已核验来源)：Page\s+\d+\s+\/\s+block\s+[^\r\n]+\s*$/i, "")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

function enforceVerifiedCitation(answer, citation) {
  let text = String(answer || "").trim();
  if (!citation) return text;
  text = text.replace(/Page\s+\d+\s+\/\s+block\s+[A-Za-z0-9._:-]+/gi, citation);
  if (!text.includes(citation)) text += `\n\n来源：${citation}`;
  return text;
}

function recentWorkspacePaper(workspace) {
  const direct = typeof workspace.getRecentPaper === "function" ? workspace.getRecentPaper() : null;
  if (direct) return direct;
  const papers = Object.values(workspace.load?.().papers || {}).filter((paper) => paper?.paperHash);
  papers.sort((left, right) => {
    const leftTime = String(left.updatedAt || left.createdAt || "");
    const rightTime = String(right.updatedAt || right.createdAt || "");
    return rightTime.localeCompare(leftTime);
  });
  return papers[0] || null;
}

function registerResearchRoutes(app, ctx, workspace) {
  app.get("/api/research/recent", (c) => {
    try {
      return c.json({ ok: true, paper: publicCachedPaper(recentWorkspacePaper(workspace)) });
    } catch (error) {
      return researchJsonError(c, error);
    }
  });

  app.get("/api/research/paper", (c) => {
    try {
      const paperHash = researchPaperHash(c);
      const paper = publicCachedPaper(workspace.getPaper(paperHash));
      return paper ? c.json({ ok: true, paper }) : c.json({ ok: false, error: "论文不存在" }, 404);
    } catch (error) {
      return researchJsonError(c, error);
    }
  });

  app.post("/api/research/paper", async (c) => {
    try {
      const body = await c.req.json();
      const paper = await workspace.upsertPaper(paperPayload(body, workspace.getPaper(body?.paperHash)));
      return c.json({ ok: true, paper });
    } catch (error) {
      return researchJsonError(c, error);
    }
  });

  app.get("/api/research/snapshot", (c) => {
    try {
      const paperHash = researchPaperHash(c);
      const snapshot = workspace.snapshot(paperHash, { limit: researchLimit(requestQuery(c, "limit")) });
      return snapshot ? c.json({ ok: true, snapshot }) : c.json({ ok: false, error: "论文不存在" }, 404);
    } catch (error) {
      return researchJsonError(c, error);
    }
  });

  app.get("/api/research/storage", (c) => {
    try {
      const paperHash = researchPaperHash(c);
      const storage = workspace.storageStats(paperHash);
      return storage ? c.json({ ok: true, storage }) : c.json({ ok: false, error: "论文不存在" }, 404);
    } catch (error) {
      return researchJsonError(c, error);
    }
  });

  app.post("/api/research/cleanup", async (c) => {
    try {
      const body = await c.req.json();
      const paperHash = researchPaperHash(c, body);
      const action = String(body?.action || "");
      const allowed = new Set(["assets", "ai-translations", "structure-keep-notes"]);
      if (!allowed.has(action)) return c.json({ ok: false, error: "不支持的清理范围" }, 400);
      const result = await workspace.clearPaperData(paperHash, action);
      return c.json({ ok: true, result, storage: workspace.storageStats(paperHash) });
    } catch (error) {
      return researchJsonError(c, error);
    }
  });

  if (typeof app.delete === "function") app.delete("/api/research/paper", async (c) => {
    try {
      let body = {};
      if (typeof c.req.json === "function") body = await c.req.json().catch(() => ({}));
      const paperHash = researchPaperHash(c, body);
      const deleted = await workspace.removePaper(paperHash);
      return deleted ? c.json({ ok: true, deleted: true }) : c.json({ ok: false, error: "论文不存在" }, 404);
    } catch (error) {
      return researchJsonError(c, error);
    }
  });

  app.post("/api/research/backup", async (c) => {
    try {
      const body = await c.req.json();
      const paperHash = researchPaperHash(c, body);
      const backup = workspace.exportBackup(paperHash, { includeAssets: body?.includeAssets !== false });
      return new Response(JSON.stringify(backup), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename=hana-paper-reader-${paperHash.slice(0, 12)}.backup.json`,
          "X-Paper-Hash": paperHash,
        },
      });
    } catch (error) {
      return researchJsonError(c, error);
    }
  });

  app.post("/api/research/restore", async (c) => {
    try {
      const body = await c.req.json();
      const paper = await workspace.restoreBackup(body);
      return c.json({ ok: true, paper: publicCachedPaper(paper), storage: workspace.storageStats(paper.paperHash) });
    } catch (error) {
      return researchJsonError(c, error);
    }
  });

  app.get("/api/research/search", (c) => {
    try {
      const paperHash = researchPaperHash(c);
      const query = requestQuery(c, "q") || requestQuery(c, "query");
      const options = {
        scope: requestQuery(c, "scope"),
        language: requestQuery(c, "language"),
        types: requestQuery(c, "types") || requestQuery(c, "type"),
        page: requestQuery(c, "page"),
        sectionId: requestQuery(c, "sectionId"),
        currentBlockId: requestQuery(c, "currentBlockId"),
        limit: researchLimit(requestQuery(c, "limit")),
      };
      const results = workspace.search(paperHash, query, options);
      return c.json({ ok: true, paperHash, query, options, ranking: "词频 + 标题权重 + 视觉类型 + 当前页 + 邻近块", results });
    } catch (error) {
      return researchJsonError(c, error);
    }
  });

  app.get("/api/research/evidence", (c) => {
    try {
      const paperHash = researchPaperHash(c);
      const evidenceId = requestQuery(c, "evidenceId");
      const blockId = requestQuery(c, "blockId");
      if (evidenceId || blockId) {
        const evidence = workspace.getEvidence(paperHash, { evidenceId, blockId }, { usageKind: requestQuery(c, "usageKind") || "reference" });
        return evidence ? c.json({ ok: true, evidence }) : c.json({ ok: false, error: "证据不存在" }, 404);
      }
      const evidence = workspace.listEvidence(paperHash, {
        type: requestQuery(c, "type"),
        sectionId: requestQuery(c, "sectionId"),
        usageKind: requestQuery(c, "usageKind") || "reference",
        limit: researchLimit(requestQuery(c, "limit")),
      });
      return c.json({ ok: true, paperHash, evidence });
    } catch (error) {
      return researchJsonError(c, error);
    }
  });

  app.get("/api/research/outline", (c) => {
    try {
      const paperHash = researchPaperHash(c);
      return c.json({ ok: true, paperHash, outline: workspace.outline(paperHash) });
    } catch (error) {
      return researchJsonError(c, error);
    }
  });

  for (const collection of ["notes", "bookmarks"]) {
    app.post(`/api/research/${collection}`, async (c) => {
      try {
        const item = await workspace[collection === "notes" ? "putNote" : "putBookmark"](await c.req.json());
        return c.json({ ok: true, [collection.slice(0, -1)]: item });
      } catch (error) {
        return researchJsonError(c, error);
      }
    });
    app.get(`/api/research/${collection}`, (c) => {
      try {
        const paperHash = researchPaperHash(c);
        const filters = collection === "notes" ? {
          noteType: requestQuery(c, "noteType"),
          sectionId: requestQuery(c, "sectionId"),
          tag: requestQuery(c, "tag"),
          unresolvedOnly: requestQuery(c, "unresolvedOnly") === "true",
        } : {};
        return c.json({ ok: true, paperHash, [collection]: workspace.listItems(collection, paperHash, researchLimit(requestQuery(c, "limit")), filters), filters });
      } catch (error) {
        return researchJsonError(c, error);
      }
    });
    if (typeof app.delete === "function") {
      const deleteItem = async (c) => {
        try {
          let id = requestParam(c, "id") || requestQuery(c, "id");
          if (!id && typeof c.req.json === "function") id = (await c.req.json().catch(() => ({}))).id || "";
          const deleted = await workspace.deleteItem(collection, id);
          return deleted ? c.json({ ok: true, deleted: true }) : c.json({ ok: false, error: "记录不存在" }, 404);
        } catch (error) {
          return researchJsonError(c, error);
        }
      };
      app.delete(`/api/research/${collection}/:id`, deleteItem);
      app.delete(`/api/research/${collection}`, deleteItem);
    }
  }

  app.post("/api/research/progress", async (c) => {
    try {
      return c.json({ ok: true, progress: await workspace.setProgress(await c.req.json()) });
    } catch (error) {
      return researchJsonError(c, error);
    }
  });
  app.get("/api/research/progress", (c) => {
    try {
      const paperHash = researchPaperHash(c);
      return c.json({ ok: true, paperHash, progress: workspace.getProgress(paperHash) });
    } catch (error) {
      return researchJsonError(c, error);
    }
  });

  app.get("/api/research/glossary", (c) => {
    try {
      const paperHash = researchPaperHash(c);
      return c.json({ ok: true, glossary: workspace.getGlossary(paperHash) });
    } catch (error) {
      return researchJsonError(c, error);
    }
  });
  app.post("/api/research/glossary", async (c) => {
    try {
      return c.json({ ok: true, glossary: await workspace.putGlossary(await c.req.json()) });
    } catch (error) {
      return researchJsonError(c, error);
    }
  });
  if (typeof app.delete === "function") app.delete("/api/research/glossary", async (c) => {
    try {
      const queryTerm = requestQuery(c, "term");
      const body = queryTerm || typeof c.req.json !== "function" ? {} : await c.req.json().catch(() => ({}));
      const paperHash = researchPaperHash(c, body);
      const term = queryTerm || body.term;
      if (!term) return c.json({ ok: false, error: "term is required" }, 400);
      return c.json({ ok: true, deleted: await workspace.deleteGlossaryTerm(paperHash, term) });
    } catch (error) {
      return researchJsonError(c, error);
    }
  });

  app.get("/api/research/translation-cache", (c) => {
    try {
      const paperHash = researchPaperHash(c);
      const blockId = requestQuery(c, "blockId");
      const glossaryVersion = requestQuery(c, "glossaryVersion");
      const agentId = requestQuery(c, "agentId");
      const modelRef = requestQuery(c, "modelRef");
      const translation = workspace.getTranslation(paperHash, blockId, glossaryVersion, { agentId, modelRef });
      return c.json({ ok: true, hit: Boolean(translation), translation });
    } catch (error) {
      return researchJsonError(c, error);
    }
  });
  app.post("/api/research/translation-cache", async (c) => {
    try {
      const body = await c.req.json();
      return c.json({ ok: true, translation: await workspace.putTranslation(body) });
    } catch (error) {
      return researchJsonError(c, error);
    }
  });

  const listTasks = (c) => {
    try {
      const paperHash = researchPaperHash(c);
      return c.json({ ok: true, paperHash, tasks: workspace.listTasks(paperHash, researchLimit(requestQuery(c, "limit"))) });
    } catch (error) {
      return researchJsonError(c, error);
    }
  };
  app.get("/api/research/parse-status/tasks", listTasks);
  app.post("/api/research/parse-status/tasks", async (c) => {
    try {
      return c.json({ ok: true, task: await workspace.createTask(await c.req.json()) });
    } catch (error) {
      return researchJsonError(c, error);
    }
  });

  const updateTask = async (c, forcedState = null) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const patch = {};
      for (const key of ["state", "stage", "progress", "error"]) if (hasOwn(body, key)) patch[key] = body[key];
      if (forcedState) patch.state = forcedState;
      return c.json({ ok: true, task: await workspace.updateTask(requestParam(c, "taskId") || requestQuery(c, "taskId"), patch) });
    } catch (error) {
      return researchJsonError(c, error);
    }
  };
  app.post("/api/research/parse-status/tasks/:taskId", (c) => updateTask(c));
  app.post("/api/research/parse-status/tasks/:taskId/update", (c) => updateTask(c));
  app.post("/api/research/parse-status/tasks/:taskId/cancel", (c) => updateTask(c, "cancelled"));

  app.post("/api/research/export", async (c) => {
    try {
      const body = await c.req.json();
      const paperHash = researchPaperHash(c, body);
      const paper = workspace.getPaper(paperHash);
      if (!paper) return c.json({ ok: false, error: "论文不存在" }, 404);
      const markdown = generatePaperMarkdown({
        metadata: paper.metadata,
        blocks: paper.blocks,
        translations: body.translations ?? paper.translations ?? Object.fromEntries(paper.blocks.map((block) => [block.id, block.translatedText]).filter(([, value]) => value)),
        translationStates: body.translationStates ?? paper.translationStates ?? {},
        notes: workspace.listItems("notes", paperHash),
        bookmarks: workspace.listItems("bookmarks", paperHash),
        progress: workspace.getProgress(paperHash),
        glossary: workspace.getGlossary(paperHash).terms,
        assets: paper.resources,
        options: body.options,
      });
      return new Response(markdown, { status: 200, headers: { "Content-Type": "text/markdown; charset=utf-8", "X-Paper-Hash": paperHash } });
    } catch (error) {
      return researchJsonError(c, error);
    }
  });

  app.post("/api/research/evidence", async (c) => {
    try {
      const body = await c.req.json();
      const paper = workspace.getPaper(body?.paperHash);
      if (!paper) return c.json({ ok: false, error: "论文不存在" }, 404);
      const question = String(body?.question || body?.prompt || "").trim().slice(0, MAX_TEXT_CHARS);
      if (!question) return c.json({ ok: false, error: "question is required" }, 400);
      const evidence = paperEvidence(workspace, paper, body);
      if (!evidence.length) return c.json({ ok: false, error: "没有可用的论文证据块" }, 400);
      const { bus } = getRequestRuntime(c, ctx);
      const agent = await resolveAgent(bus, body?.agentId);
      if (!agent) return c.json({ ok: false, error: "未找到指定助手" }, 400);
      const modelSelection = await resolveAgentModelSelection(bus, body, agent);
      const result = await runAgentTurn(bus, ctx, agent.id, evidencePrompt(paper, evidence, question), {
        reuse: true,
        namespace: "research-evidence",
        thinkingLevel: body.thinkingLevel,
        modelSelection,
      });
      const answer = enforceEvidenceCitations(result.text, evidence);
      return c.json({
        ok: true,
        answer,
        evidence,
        model: modelSelection.ref || agent.model,
        modelSelection: publicModelSelection(modelSelection, agent),
        sessionId: result.target.sessionId,
        thinkingLevel: result.target.thinkingLevel || result.target.requestedThinkingLevel,
      });
    } catch (error) {
      ctx.log?.error?.("research evidence error:", error);
      return agentJsonError(c, error, "论文证据问答失败，请稍后重试");
    }
  });

  app.get("/api/research/parse-cache/check", (c) => {
    try {
      const paperHash = researchPaperHash(c);
      const stored = workspace.getPaper(paperHash);
      const hit = Boolean(stored && Array.isArray(stored.blocks) && stored.blocks.length);
      const paper = hit ? publicCachedPaper(stored) : null;
      return c.json({
        ok: true,
        paperHash,
        hit,
        cached: hit,
        blockCount: hit ? paper.blocks.length : 0,
        pageCount: paper?.parser?.pageCount || 0,
        paper,
      });
    } catch (error) {
      return researchJsonError(c, error);
    }
  });
}

export { recentWorkspacePaper };

export default function registerApiRoutes(app, ctx) {
  const sessionTargetNamespace = `route_${randomUUID()}`;
  const researchWorkspace = getResearchWorkspace(ctx);
  registerResearchRoutes(app, ctx, researchWorkspace);
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
      return c.json({ ok: true, agents: await listAgents(bus), apiVersion: PLUGIN_API_VERSION });
    } catch (error) {
      ctx.log?.error?.("get agents error:", error);
      return c.json({ ok: false, error: "无法读取本机助手列表", agents: [] }, 500);
    }
  });

  app.get("/api/models", async (c) => {
    try {
      const { bus } = getRequestRuntime(c, ctx);
      const catalog = await listConfiguredChatModels(bus);
      if (!catalog.ok) {
        return c.json({ ok: false, error: "无法读取当前聊天模型列表，请稍后重试", code: "model_catalog_unavailable", models: [] }, 503);
      }
      return c.json({ ok: true, models: catalog.models, apiVersion: PLUGIN_API_VERSION });
    } catch (error) {
      ctx.log?.error?.("get chat models error:", error);
      return c.json({ ok: false, error: "无法读取当前聊天模型列表，请稍后重试", code: "model_catalog_unavailable", models: [] }, 503);
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
      const paperHash = sha256(request.buffer);
      const stored = researchWorkspace.getPaper(paperHash);
      const force = c.req.query("force") === "1" || c.req.query("force") === "true";
      if (!force && stored && Array.isArray(stored.blocks) && stored.blocks.length) {
        return c.json({
          ok: true,
          parser: stored.parser?.kind || "mineru",
          modelVersion: stored.parser?.modelVersion || "vlm",
          ocrUsed: stored.parser?.ocrUsed === true,
          ocrFallback: stored.parser?.ocrFallback === true,
          pageCount: Number(stored.parser?.pageCount || 0),
          blockCount: stored.blocks.length,
          blocks: stored.blocks,
          paperHash,
          cached: true,
          apiVersion: PLUGIN_API_VERSION,
          uiVersion: request.uiVersion || null,
          transport: request.transport,
        });
      }
      const result = await parsePdfWithMineru({
        buffer: request.buffer,
        fileName: request.fileName,
        ctx,
      });
      await researchWorkspace.upsertPaper({
        paperHash,
        metadata: { title: request.fileName },
        parser: {
          kind: "mineru",
          modelVersion: result.modelVersion,
          pageCount: result.pageCount,
          ocrUsed: result.ocrUsed === true,
          ocrFallback: result.ocrFallback === true,
          attemptCount: result.attemptCount,
        },
        blocks: result.blocks,
      });
      return c.json({
        ...result,
        paperHash,
        cached: false,
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
        const modelSelection = await resolveAgentModelSelection(bus, body, agent);
        const prompt = `请翻译下面的学术英文。只返回 JSON 字符串数组，数组长度必须为 ${list.length}，不要输出解释。${glossaryInstruction(body.glossaryTerms)}\n${JSON.stringify(list)}`;
        const result = await runAgentTurn(bus, ctx, agent.id, prompt, {
          reuse: true,
          namespace: "translation",
          thinkingLevel: body.thinkingLevel,
          modelSelection,
        });
        const translations = parseJsonArray(result.text);
        if (!translations || translations.length !== list.length) return c.json({ ok: false, error: "翻译模型返回格式无效" }, 502);
        return c.json({
          ok: true,
          translations,
          model: modelSelection.ref || agent.model,
          modelSelection: publicModelSelection(modelSelection, agent),
          thinkingLevel: result.target.thinkingLevel || result.target.requestedThinkingLevel,
        });
      }

      if (hasExplicitModelRef(body?.modelRef)) {
        throw new SessionTargetError("选择模型时必须同时选择助手", 400, "model_agent_required");
      }
      return c.json({ ok: true, translations: await runUtilityTranslation(bus, list, body?.glossaryTerms), model: "utility" });
    } catch (error) {
      ctx.log?.error?.("translate error:", error);
      return agentJsonError(c, error, "翻译失败，请稍后重试");
    }
  });

  app.post("/api/ask-agent", async (c) => {
    try {
      const { bus } = getRequestRuntime(c, ctx);
      const body = await c.req.json();
      const agent = await resolveAgent(bus, body?.agentId);
      if (!agent) return c.json({ ok: false, error: "未找到指定助手" }, 400);
      const modelSelection = await resolveAgentModelSelection(bus, body, agent);
      const quote = typeof body.quote === "string" ? body.quote.trim() : "";
      const context = withoutClientCitation(body.context);
      if (!quote || quote.length > MAX_TEXT_CHARS) return c.json({ ok: false, error: "选中文本为空或过长" }, 400);

      let task = "请用严谨但易懂的语言解释选中文献内容的原理、论证逻辑和关键要点。";
      if (body.questionType === "formula") task = "请逐项解释公式中的变量、推导逻辑和数学或物理意义。";
      if (body.questionType === "explain") task = "请解释术语的定义、背景、应用场景及其在本文中的作用。";
      if (body.questionType === "critique") task = "请从审稿人角度客观分析方法和结论的可靠性。";
      if (typeof body.prompt === "string" && body.prompt.trim()) task = body.prompt.trim().slice(0, MAX_TEXT_CHARS);

      const evidence = verifiedQuoteEvidence(researchWorkspace, body);
      const citation = evidence ? `Page ${evidence.page} / block ${evidence.blockId}` : "";
      const sourceLine = citation ? `\n已由论文工作区核验的来源：${citation}` : "";
      const prompt = `论文：${String(body.paperTitle || "当前学术文献").slice(0, 500)}\n上下文：${context}\n选中文本：${quote}${sourceLine}${glossaryInstruction(body.glossaryTerms)}\n\n任务：${task}\n请直接回答，支持 Markdown。${citation ? `关键结论必须引用且只能引用已核验来源：${citation}。` : "不要虚构页码或段落编号。"}`;
      const result = await runAgentTurn(bus, ctx, agent.id, prompt, {
        reuse: true,
        namespace: "reader",
        thinkingLevel: body.thinkingLevel,
        modelSelection,
      });
      const answer = enforceVerifiedCitation(result.text, citation);
      return c.json({
        ok: true,
        answer,
        citation: citation || null,
        evidence,
        model: modelSelection.ref || agent.model,
        modelSelection: publicModelSelection(modelSelection, agent),
        sessionId: result.target.sessionId,
        thinkingLevel: result.target.thinkingLevel || result.target.requestedThinkingLevel,
      });
    } catch (error) {
      ctx.log?.error?.("ask agent error:", error);
      return agentJsonError(c, error, "助手响应失败或超时，请稍后重试");
    }
  });

  app.get("/api/session-targets", async (c) => {
    try {
      const { bus, requestContext } = getRequestRuntime(c, ctx);
      const scope = sessionTargetScope(requestContext);
      const sessions = await listSelectableSessions(bus);
      return c.json({
        ok: true,
        sessions: sessions.map((record) => issueSessionTarget(ctx.pluginId, record, scope, sessionTargetNamespace)),
        source: null,
      });
    } catch (error) {
      ctx.log?.error?.("list session targets error:", error);
      return c.json({ ok: false, error: "无法读取可选对话列表", sessions: [] }, 502);
    }
  });

  app.post("/api/send-to-session", async (c) => {
    try {
      const { bus, requestContext } = getRequestRuntime(c, ctx);
      const body = await c.req.json();
      const payload = quoteSessionPayload(researchWorkspace, body);
      const target = await resolveExistingSessionTarget(
        bus,
        body,
        ctx.pluginId,
        sessionTargetScope(requestContext),
        sessionTargetNamespace,
      );
      await sendToExistingSession(bus, target, payload.text);
      return c.json({
        ok: true,
        accepted: true,
        citation: payload.citation || null,
        evidence: payload.evidence,
        targetId: target.targetId || null,
        session: publicSessionRecord(target.record),
        message: "已发送到所选对话",
      });
    } catch (error) {
      if (error instanceof SessionTargetError) {
        return c.json({ ok: false, error: error.message, code: error.code }, error.status);
      }
      ctx.log?.error?.("send to session error:", error);
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 502;
      return c.json({ ok: false, error: status === 409 ? "目标对话正在回复，请稍后重试" : "发送会话失败，请稍后重试", code: error?.code || null }, status);
    }
  });

  app.post("/api/create-session-and-send", async (c) => {
    try {
      const { bus } = getRequestRuntime(c, ctx);
      const body = await c.req.json();
      const agent = await resolveAgent(bus, body?.agentId);
      if (!agent) return c.json({ ok: false, error: "未找到指定助手" }, 400);
      const modelSelection = await resolveAgentModelSelection(bus, body, agent);
      const payload = quoteSessionPayload(researchWorkspace, body);
      const target = await createAndSendAgentMessage(bus, ctx, agent.id, payload.text, body.thinkingLevel, modelSelection);
      return c.json({
        ok: true,
        accepted: true,
        citation: payload.citation || null,
        evidence: payload.evidence,
        sessionId: target.sessionId,
        model: modelSelection.ref || agent.model,
        modelSelection: publicModelSelection(modelSelection, agent),
        message: "已新建对话并发送",
      });
    } catch (error) {
      if (error instanceof SessionTargetError) {
        return c.json({ ok: false, error: error.message, code: error.code }, error.status);
      }
      ctx.log?.error?.("create and send session error:", error);
      return c.json({ ok: false, error: "新建对话失败，请稍后重试" }, 502);
    }
  });
}
