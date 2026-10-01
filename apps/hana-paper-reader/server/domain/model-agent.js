import { randomUUID } from "node:crypto";

const MODEL_REF_RE = /^[^/\x00-\x20]{1,160}\/[^/\x00-\x20]{1,240}$/u;
const AGENT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_TEXT_CHARS = 12000;
const MAX_BATCH_ITEMS = 8;
const MAX_BATCH_CHARS = 50000;
const MAX_OUTPUT_CHARS = 100000;
const DEFAULT_MODEL_TIMEOUT_MS = 120000;
const MAX_MODEL_TIMEOUT_MS = 600000;
const THINKING_LEVELS = new Set(["off", "low", "medium", "high", "max"]);

class ModelBoundaryError extends Error {
  constructor(code, message, status = 502, details = {}) {
    super(message);
    this.name = "ModelBoundaryError";
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

function nonEmptyString(value, max = 512) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : "";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  if (!isRecord(entry)) return "";
  const direct = normalizeModelRef(entry.ref);
  if (direct) return direct;
  const provider = nonEmptyString(entry.provider || entry.providerId, 160);
  const id = nonEmptyString(entry.id || entry.modelId || entry.model, 240);
  return normalizeModelRef(provider && id ? `${provider}/${id}` : "");
}

function publicModel(entry) {
  const parts = splitModelRef(modelRefFromEntry(entry));
  if (!parts) return null;
  const result = {
    ref: parts.ref,
    provider: parts.provider,
    id: parts.id,
    name: nonEmptyString(entry?.name || entry?.displayName, 240) || parts.id,
  };
  if (Array.isArray(entry?.capabilities)) {
    result.capabilities = entry.capabilities
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim().slice(0, 80))
      .slice(0, 32);
  }
  for (const key of ["reasoning", "isCurrent"]) {
    if (typeof entry?.[key] === "boolean") result[key] = entry[key];
  }
  for (const key of ["contextWindow", "maxTokens"]) {
    if (Number.isSafeInteger(entry?.[key]) && entry[key] > 0) result[key] = entry[key];
  }
  return result;
}

function modelEntries(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.models)) return result.models;
  if (Array.isArray(result?.data?.models)) return result.data.models;
  return [];
}

function agentEntries(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.agents)) return result.agents;
  if (Array.isArray(result?.data?.agents)) return result.data.agents;
  return [];
}

function profileOf(result) {
  if (!isRecord(result)) return null;
  if (Object.prototype.hasOwnProperty.call(result, "profile")) return isRecord(result.profile) ? result.profile : null;
  if (Object.prototype.hasOwnProperty.call(result, "agent")) return isRecord(result.agent) ? result.agent : null;
  return result;
}

function modelValueFromAgent(value) {
  if (typeof value === "string") return normalizeModelRef(value);
  if (!isRecord(value)) return "";
  const provider = nonEmptyString(value.provider || value.providerId, 160);
  const id = nonEmptyString(value.id || value.modelId || value.model, 240);
  return normalizeModelRef(provider && id ? `${provider}/${id}` : "");
}

function publicAgent(row, profile = null) {
  const source = { ...(isRecord(row) ? row : {}), ...(isRecord(profile) ? profile : {}) };
  const id = nonEmptyString(source.id || source.agentId, 128);
  if (!AGENT_ID_RE.test(id)) return null;
  const identity = nonEmptyString(source.identity || source.description, 16384);
  const modelRef = modelValueFromAgent(source.modelRef || source.model || source.models?.chat);
  const result = {
    id,
    name: nonEmptyString(source.name, 160) || id,
    yuan: nonEmptyString(source.yuan, 80) || null,
    identity,
    description: identity,
    model: modelRef || null,
    modelRef: modelRef || null,
    avatarUrl: null,
  };
  for (const key of ["state", "ownerPluginId", "visibility", "deletedAt"]) {
    if (typeof source[key] === "string" && source[key].trim()) result[key] = source[key].trim().slice(0, 512);
  }
  if (isRecord(source.plugin)) {
    result.plugin = {};
    for (const key of ["kind", "agentTypeId"]) {
      if (typeof source.plugin[key] === "string" && source.plugin[key].trim()) result.plugin[key] = source.plugin[key].trim().slice(0, 160);
    }
  }
  for (const key of ["isCurrent", "isPrimary"]) {
    if (typeof source[key] === "boolean") result[key] = source[key];
  }
  return result;
}

function assertModelDomain(models) {
  if (!models || typeof models.list !== "function") {
    throw new ModelBoundaryError("model_catalog_unavailable", "无法读取当前聊天模型列表，请稍后重试", 503);
  }
}

function assertAgentDomain(agents) {
  if (!agents || typeof agents.list !== "function") {
    throw new ModelBoundaryError("agent_catalog_unavailable", "无法读取当前助手列表，请稍后重试", 503);
  }
}

async function listPublicModels(models) {
  assertModelDomain(models);
  let result;
  try {
    result = await models.list();
  } catch (error) {
    throw new ModelBoundaryError("model_catalog_unavailable", "无法读取当前聊天模型列表，请稍后重试", 503, { cause: error });
  }
  const unique = new Map();
  for (const entry of modelEntries(result)) {
    const model = publicModel(entry);
    if (model && !unique.has(model.ref)) unique.set(model.ref, model);
  }
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.ref.localeCompare(b.ref));
}

function isAgentReadDenied(error) {
  const code = String(error?.code || "");
  return Boolean(error?.kind === "permission" || /PERMISSION|CAPABILITY|DENIED|NOT_AUTHORIZED|AUTHORIZATION_REQUIRED/i.test(code));
}

function isAgentNotFound(error) {
  return /NOT_FOUND|UNKNOWN_AGENT|AGENT_NOT_FOUND/i.test(String(error?.code || ""));
}

async function loadAgentCatalog(agents, scope) {
  let result;
  try {
    result = await agents.list({ scope, lifecycle: "active" });
  } catch (error) {
    throw error;
  }
  const rows = agentEntries(result);
  const values = await Promise.all(rows.map(async (row) => {
    const id = nonEmptyString(row?.id, 128);
    let profile = null;
    if (id && typeof agents.profile === "function") {
      try {
        profile = profileOf(await agents.profile({ agentId: id, scope }));
      } catch (error) {
        if (isAgentReadDenied(error)) throw error;
        profile = null;
      }
    }
    return publicAgent(row, profile);
  }));
  return values
    .filter(Boolean)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN") || a.id.localeCompare(b.id));
}

async function listPublicAgents(agents) {
  assertAgentDomain(agents);
  try {
    return {
      agents: await loadAgentCatalog(agents, "all"),
      scope: "all",
      downgraded: false,
    };
  } catch (error) {
    if (!isAgentReadDenied(error)) {
      throw new ModelBoundaryError("agent_catalog_unavailable", "无法读取当前助手列表，请稍后重试", 503, { cause: error });
    }
    try {
      return {
        agents: await loadAgentCatalog(agents, "own"),
        scope: "own",
        downgraded: true,
        downgradeReason: "app/agents.read_not_granted",
      };
    } catch (fallbackError) {
      if (isAgentReadDenied(fallbackError)) {
        throw new ModelBoundaryError("agent_read_denied", "当前应用未获准读取现有 Agent 列表", 403, { cause: fallbackError });
      }
      throw new ModelBoundaryError("agent_catalog_unavailable", "无法读取当前助手列表，请稍后重试", 503, { cause: fallbackError });
    }
  }
}

async function readPublicAgent(agents, agentId) {
  assertAgentDomain(agents);
  if (!AGENT_ID_RE.test(String(agentId || ""))) return { agent: null, scope: "all", downgraded: false };
  if (typeof agents.profile !== "function") {
    const catalog = await listPublicAgents(agents);
    return {
      agent: catalog.agents.find((agent) => agent.id === agentId) || null,
      scope: catalog.scope,
      downgraded: catalog.downgraded,
      downgradeReason: catalog.downgradeReason,
    };
  }
  const readProfile = async (scope) => {
    const result = await agents.profile({ agentId, scope });
    if (!result) return null;
    const profile = profileOf(result);
    return profile ? publicAgent({ id: agentId }, profile) : null;
  };
  try {
    return { agent: await readProfile("all"), scope: "all", downgraded: false };
  } catch (error) {
    if (isAgentNotFound(error)) return { agent: null, scope: "all", downgraded: false };
    if (!isAgentReadDenied(error)) {
      throw new ModelBoundaryError("agent_profile_unavailable", "无法读取指定助手，请稍后重试", 503, { cause: error });
    }
    try {
      return {
        agent: await readProfile("own"),
        scope: "own",
        downgraded: true,
        downgradeReason: "app/agents.read_not_granted",
      };
    } catch (fallbackError) {
      if (isAgentNotFound(fallbackError)) return { agent: null, scope: "own", downgraded: true };
      if (isAgentReadDenied(fallbackError)) {
        throw new ModelBoundaryError("agent_read_denied", "当前应用未获准读取现有 Agent", 403, { cause: fallbackError });
      }
      throw new ModelBoundaryError("agent_profile_unavailable", "无法读取指定助手，请稍后重试", 503, { cause: fallbackError });
    }
  }
}

function validateTextList(body) {
  const list = Array.isArray(body?.texts) ? body.texts : (typeof body?.text === "string" ? [body.text] : []);
  if (!list.length || list.length > MAX_BATCH_ITEMS) {
    throw new ModelBoundaryError("translation_input_invalid", `一次最多翻译 ${MAX_BATCH_ITEMS} 段`, 400);
  }
  if (list.some((item) => typeof item !== "string" || item.length > MAX_TEXT_CHARS) || list.join("").length > MAX_BATCH_CHARS) {
    throw new ModelBoundaryError("translation_input_too_large", "文本过长，请拆分后翻译", 413);
  }
  return list;
}

function glossaryInstruction(terms) {
  if (!isRecord(terms)) return "";
  const entries = Object.entries(terms)
    .filter(([source, target]) => typeof source === "string" && source.trim() && typeof target === "string" && target.trim())
    .slice(0, 100);
  return entries.length ? `\n术语表（必须优先采用固定译法）：${JSON.stringify(Object.fromEntries(entries))}` : "";
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

function timeoutFrom(runtime) {
  const configured = Number(runtime?.modelTimeoutMs);
  if (!Number.isFinite(configured)) return DEFAULT_MODEL_TIMEOUT_MS;
  return Math.max(1, Math.min(MAX_MODEL_TIMEOUT_MS, Math.floor(configured)));
}

function modelErrorFrom(error, state = {}) {
  if (error instanceof ModelBoundaryError) return error;
  const code = String(error?.code || "");
  if (state.timedOut || code === "APP_MODEL_TIMEOUT") {
    return new ModelBoundaryError("model_timeout", "模型请求超时，请稍后重试", 504, { cause: error });
  }
  if (state.cancelled || code === "RPC_ABORTED" || /ABORT|CANCEL/i.test(code)) {
    return new ModelBoundaryError("model_cancelled", "模型请求已取消", 499, { cause: error });
  }
  if (/PERMISSION|CAPABILITY|DENIED|NOT_AUTHORIZED/i.test(code)) {
    return new ModelBoundaryError("model_inference_denied", "当前应用未获准使用模型推理", 403, { cause: error });
  }
  if (/REQUEST_TOO_LARGE|OUTPUT_LIMIT|CONCURRENCY_LIMIT/i.test(code)) {
    return new ModelBoundaryError("model_output_rejected", "模型请求或输出超过宿主限制", 502, { cause: error });
  }
  if (/STREAM|INVALID|TRUNCATED|HTTP_ERROR/i.test(code)) {
    return new ModelBoundaryError("model_output_invalid", "模型返回格式无效", 502, { cause: error });
  }
  return new ModelBoundaryError("model_inference_failed", "模型请求失败，请稍后重试", 502, { cause: error });
}

function extractAssistantText(message) {
  if (typeof message === "string") return message;
  if (!isRecord(message)) return "";
  if (typeof message.text === "string") return message.text;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

const MODEL_CANCEL_GRACE_MS = 250;

async function cancelModel(models, requestId) {
  if (typeof models?.cancel !== "function") return;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => models.cancel(requestId)),
      new Promise((resolve) => { timer = setTimeout(resolve, MODEL_CANCEL_GRACE_MS); }),
    ]);
  } catch { /* preserve original model error */ }
  finally {
    if (timer) clearTimeout(timer);
  }
}

async function* readFallbackStream(response) {
  if (response && typeof response[Symbol.asyncIterator] === "function") {
    yield* response;
    return;
  }
  if (Array.isArray(response)) {
    for (const event of response) yield event;
    return;
  }
  if (typeof response === "string") {
    for (const line of response.split(/\r?\n/u)) {
      if (line.trim()) yield JSON.parse(line);
    }
    return;
  }
  if (response?.events && Array.isArray(response.events)) {
    for (const event of response.events) yield event;
    return;
  }
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const chunk = await reader.read();
        pending += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (line) yield JSON.parse(line);
        }
        if (chunk.done) break;
      }
      if (pending.trim()) yield JSON.parse(pending.trim());
    } finally {
      try { await reader.cancel(); } catch { /* ignore cleanup */ }
    }
    return;
  }
  throw new ModelBoundaryError("model_output_invalid", "模型返回格式无效", 502);
}

async function streamText({ models, selection, messages, systemPrompt, reasoningEffort, maxTokens, temperature, signal, runtime }) {
  if (!selection?.provider || !selection?.id) {
    throw new ModelBoundaryError("model_unavailable", "所选模型当前不可用，请重新选择", 409);
  }
  if (!models || typeof models.stream !== "function") {
    throw new ModelBoundaryError("model_inference_unavailable", "当前宿主不提供模型推理接口", 503);
  }
  const requestId = randomUUID();
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  const abortExternal = () => {
    cancelled = true;
    controller.abort();
  };
  if (signal?.aborted) abortExternal();
  else signal?.addEventListener?.("abort", abortExternal, { once: true });
  let timeoutHandle;
  let onAbortPromise;
  const abortPromise = new Promise((_, reject) => {
    onAbortPromise = () => reject(new ModelBoundaryError("model_cancelled", "模型请求已取消", 499));
    if (signal?.aborted) onAbortPromise();
    else signal?.addEventListener?.("abort", onAbortPromise, { once: true });
  });
  const deadlinePromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ModelBoundaryError("model_timeout", "模型请求超时，请稍后重试", 504));
    }, timeoutFrom(runtime));
  });
  let completed = false;
  try {
    const input = {
      requestId,
      provider: selection.provider,
      model: selection.id,
      messages,
    };
    if (systemPrompt) input.systemPrompt = systemPrompt;
    if (reasoningEffort) input.reasoningEffort = reasoningEffort;
    if (Number.isSafeInteger(maxTokens) && maxTokens > 0) input.maxTokens = maxTokens;
    if (typeof temperature === "number" && Number.isFinite(temperature)) input.temperature = temperature;
    const response = await Promise.race([
      typeof models.streamEvents === "function"
        ? models.streamEvents(input, { signal: controller.signal })
        : models.stream(input, { signal: controller.signal }),
      abortPromise,
      deadlinePromise,
    ]);
    let text = "";
    let assistant = null;
    let stopReason = null;
    let sawDone = false;
    const iterator = readFallbackStream(response)[Symbol.asyncIterator]();
    try {
      while (true) {
        // A stream can be established successfully and then stop producing
        // events. Guard every next() call, not only streamEvents()/stream().
        const result = await Promise.race([iterator.next(), abortPromise, deadlinePromise]);
        if (result.done) break;
        const event = result.value;
        if (event?.requestId && event.requestId !== requestId) {
          throw new ModelBoundaryError("model_output_invalid", "模型返回格式无效", 502);
        }
        if (event?.type === "error") {
          const streamError = new Error("model stream error");
          streamError.code = String(event.code || "APP_MODEL_STREAM_ERROR");
          throw streamError;
        }
        if (event?.type === "text-delta") text += typeof event.delta === "string" ? event.delta : "";
        if (event?.type === "done") {
          sawDone = true;
          assistant = event.assistant || null;
          stopReason = event.stopReason || null;
          if (!text) text = extractAssistantText(assistant);
        }
        if (text.length > MAX_OUTPUT_CHARS) {
          throw new ModelBoundaryError("model_output_rejected", "模型输出超过应用限制", 502);
        }
      }
    } finally {
      // Do not await return(): a non-cooperative provider may leave next()
      // pending even after AbortController.abort(). The request itself must
      // still resolve with the boundary timeout/cancellation error.
      try {
        const closing = iterator.return?.();
        closing?.catch?.(() => {});
      } catch { /* ignore iterator cleanup failures */ }
    }
    if (!sawDone || !text.trim()) {
      throw new ModelBoundaryError("model_output_invalid", "模型未返回有效文本", 502);
    }
    completed = true;
    return { requestId, text: text.trim(), assistant, stopReason };
  } catch (error) {
    throw modelErrorFrom(error, { timedOut, cancelled });
  } finally {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener?.("abort", abortExternal);
    signal?.removeEventListener?.("abort", onAbortPromise);
    if (!completed && (timedOut || cancelled)) await cancelModel(models, requestId);
  }
}

async function utilityText({ models, messages, systemPrompt, temperature, maxTokens, signal, runtime }) {
  if (!models || typeof models.utility !== "function") {
    throw new ModelBoundaryError("model_utility_unavailable", "当前宿主不提供文本辅助调用", 503);
  }
  const requestId = randomUUID();
  const timeout = timeoutFrom(runtime);
  let timedOut = false;
  let cancelled = false;
  let timeoutHandle;
  let onAbort;
  const abortPromise = new Promise((_, reject) => {
    onAbort = () => {
      cancelled = true;
      reject(new ModelBoundaryError("model_cancelled", "模型请求已取消", 499));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
  });
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      reject(new ModelBoundaryError("model_timeout", "模型请求超时，请稍后重试", 504));
    }, timeout);
  });
  try {
    const input = { requestId, scope: "app", messages };
    if (systemPrompt) input.systemPrompt = systemPrompt;
    if (typeof temperature === "number" && Number.isFinite(temperature)) input.temperature = temperature;
    if (Number.isSafeInteger(maxTokens) && maxTokens > 0) input.maxTokens = maxTokens;
    const result = await Promise.race([models.utility(input), abortPromise, timeoutPromise]);
    const text = extractAssistantText(result);
    if (!text.trim()) throw new ModelBoundaryError("model_output_invalid", "模型未返回有效文本", 502);
    if (text.length > MAX_OUTPUT_CHARS) throw new ModelBoundaryError("model_output_rejected", "模型输出超过应用限制", 502);
    return { requestId, text: text.trim() };
  } catch (error) {
    if (error instanceof ModelBoundaryError) throw error;
    throw modelErrorFrom(error, { timedOut, cancelled });
  } finally {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener?.("abort", onAbort);
    if (timedOut || cancelled) await cancelModel(models, requestId);
  }
}

async function selectModel(models, requestedRef, agent) {
  const requested = typeof requestedRef === "string" ? requestedRef.trim() : "";
  let ref;
  if (requested && requested !== "agent-default") {
    ref = normalizeModelRef(requested);
    if (!ref) throw new ModelBoundaryError("model_invalid", "模型选择无效，请重新选择", 400);
  } else {
    ref = modelValueFromAgent(agent?.modelRef || agent?.model);
  }
  if (!ref) {
    throw new ModelBoundaryError("model_unavailable", "所选模型当前不可用，请重新选择", 409);
  }
  const catalog = await listPublicModels(models);
  const selected = catalog.find((entry) => entry.ref === ref);
  if (!selected) {
    throw new ModelBoundaryError("model_unavailable", "所选模型当前不可用，请重新选择", 409);
  }
  return {
    mode: requested && requested !== "agent-default" ? "selected" : "agent-default",
    ref: selected.ref,
    provider: selected.provider,
    id: selected.id,
    label: selected.name,
    model: { provider: selected.provider, id: selected.id },
  };
}

function publicModelSelection(selection, agent) {
  const selected = selection?.mode === "selected";
  return {
    mode: selected ? "selected" : "agent-default",
    ref: selected ? selection.ref : null,
    provider: selected ? selection.provider : null,
    id: selected ? selection.id : null,
    label: selected ? selection.label : "跟随 Agent",
    effective: selected ? selection.ref : agent?.modelRef || agent?.model || null,
  };
}

async function runUtilityTranslation(models, list, glossaryTerms, runtime, signal) {
  const prompt = `请将以下学术英文逐条翻译为准确、自然的学术中文。保留公式、数字和专业缩写。只返回 JSON 字符串数组，数组长度必须为 ${list.length}，不要附加解释：${glossaryInstruction(glossaryTerms)}\n${JSON.stringify(list)}`;
  const result = await utilityText({
    models,
    messages: [{ role: "user", content: prompt }],
    systemPrompt: "你是学术论文翻译助手。",
    temperature: 0.2,
    maxTokens: 4096,
    signal,
    runtime,
  });
  const translations = parseJsonArray(result.text);
  if (!translations || translations.length !== list.length || translations.some((text) => text.length > MAX_TEXT_CHARS)) {
    throw new ModelBoundaryError("translation_output_invalid", "翻译模型返回格式无效", 502);
  }
  return { ...result, translations };
}

function normalizeThinkingLevel(value) {
  const level = typeof value === "string" ? value.trim().toLowerCase() : "";
  return THINKING_LEVELS.has(level) ? level : undefined;
}

export {
  AGENT_ID_RE,
  MAX_BATCH_CHARS,
  MAX_BATCH_ITEMS,
  MAX_TEXT_CHARS,
  ModelBoundaryError,
  listPublicAgents,
  listPublicModels,
  normalizeModelRef,
  normalizeThinkingLevel,
  parseJsonArray,
  publicModelSelection,
  readPublicAgent,
  runUtilityTranslation,
  selectModel,
  streamText,
  utilityText,
  validateTextList,
};
