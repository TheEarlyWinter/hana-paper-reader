import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { verifyNoSymlinks } from "./paper-path-guard.js";
import { getResearchEvidence, readResearchPaper, isSafePaperHash } from "./research-read.js";
import { readPublicAgent, selectModel, normalizeThinkingLevel } from "./model-agent.js";

const LIMIT = 300;
const TTL = 15 * 60 * 1000;
const text = (v, max = 512) => typeof v === "string" ? v.trim().slice(0, max) : "";
const digest = value => createHash("sha256").update(value).digest("hex");
const recordStates = new Set(["preparing", "creating", "created", "sending", "accepted", "uncertain", "failed"]);
const isRecord = value => value && typeof value === "object" && !Array.isArray(value);
export class SessionDeliveryError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message); Object.assign(this, { code, status, details });
  }
}
const fail = (code, message, status = 400, details) => { throw new SessionDeliveryError(code, message, status, details); };
const denied = e => e?.kind === "permission" || /PERMISSION|CAPABILITY|DENIED|NOT_AUTHORIZED/i.test(String(e?.code || ""));
function unwrap(value) {
  if (value?.error || value?.ok === false) {
    const error = new Error("Host operation rejected");
    error.code = value.code || value.error?.code; throw error;
  }
  return value;
}

export function createSessionDelivery(runtime) {
  const tickets = new Map();
  const inFlight = new Map();
  const root = path.join(runtime.dataDir, "session-delivery");
  function ledgerPath(principal, requestId) {
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(requestId || "")) fail("session_request_invalid", "发送请求标识无效");
    verifyNoSymlinks(root, runtime.dataDir);
    const file = path.join(root, `${digest(principal)}-${requestId}.json`);
    verifyNoSymlinks(file, runtime.dataDir); return file;
  }
  function save(file, value) {
    verifyNoSymlinks(file, runtime.dataDir); fs.mkdirSync(root, { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { flag: "wx" });
    fs.renameSync(tmp, file);
  }
  function read(file) {
    if (!fs.existsSync(file)) return null;
    verifyNoSymlinks(file, runtime.dataDir);
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > 16384) fail("session_receipt_unavailable", "发送记录不可读", 503);
    let record;
    try { record = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { fail("session_receipt_unavailable", "发送记录不可读；不会重新发送", 503); }
    // A present but malformed intent must never be mistaken for a missing one.
    if (!isRecord(record) || !recordStates.has(record.state) || !/^[a-f0-9]{64}$/.test(record.fingerprint || "")
        || (record.state === "accepted" && (!isRecord(record.result) || record.result.accepted !== true
          || !text(record.result.session?.sessionId, 200)))
        || (record.state === "failed" && (!text(record.code, 100) || !text(record.message, 1000)
          || ![400, 403, 409, 503].includes(record.status)))) {
      fail("session_receipt_unavailable", "发送记录损坏；请先查看目标对话，不会重新发送", 503);
    }
    return record;
  }
  async function permissions(words) {
    if (!runtime.sessions || typeof runtime.capabilities?.get !== "function") fail("session_delivery_not_enabled", "当前宿主不提供对话发送接口", 503);
    let result;
    try { result = unwrap(await runtime.capabilities.get()); }
    catch (error) {
      if (denied(error)) fail("session_permission_required", "请在 Hana 设置的“应用能力”中授权论文阅读器操作对话", 403);
      fail("session_catalog_unavailable", "宿主暂时无法读取应用能力状态", 503);
    }
    const allowed = new Set((result?.capabilities || []).filter(row => ["always", "session"].includes(row.status)).map(row => row.capability));
    const missing = words.filter(word => !allowed.has(word));
    if (missing.length) fail("session_permission_required", "请在 Hana 设置的“应用能力”中允许论文阅读器读取、管理对话及启动回合；新建时选择模型和思考档位也需要对应权限。", 403);
  }
  async function catalog() {
    await permissions(["app/sessions.read"]);
    let result;
    try { result = unwrap(await runtime.sessions.list({ scope: "all", lifecycle: "active" })); }
    catch (error) {
      if (denied(error)) fail("session_permission_required", "读取对话列表的权限已撤销，请检查应用能力授权", 403);
      fail("session_catalog_unavailable", "对话列表暂时不可用", 503);
    }
    if (!Array.isArray(result?.sessions)) fail("session_catalog_unavailable", "对话列表暂时不可用", 503);
    const unique = new Map();
    for (const row of result.sessions) {
      if (row && text(row.sessionId, 200) && row.lifecycle === "active" && !unique.has(row.sessionId)) unique.set(row.sessionId, row);
    }
    const modifiedAt = row => Number.isFinite(new Date(row.modified).getTime()) ? new Date(row.modified).getTime() : 0;
    return [...unique.values()].sort((a, b) => modifiedAt(b) - modifiedAt(a));
  }
  function publicRow(row, targetId) {
    const date = new Date(row.modified);
    return { targetId, title: text(row.title, 160) || "未命名对话", agentName: text(row.agentName, 160),
      modified: row.modified && Number.isFinite(date.getTime()) ? date.toISOString() : "", messageCount: Number.isSafeInteger(row.messageCount) ? row.messageCount : 0 };
  }
  async function list(principal) {
    const now = Date.now();
    for (const [key, value] of tickets) if (value.expires < now) tickets.delete(key);
    const rows = await catalog();
    if (tickets.size + Math.min(rows.length, LIMIT) > 3000) fail("session_catalog_busy", "对话选择请求过多，请稍后再试", 429);
    return rows.slice(0, LIMIT).map(row => {
      const ticket = randomUUID(); tickets.set(ticket, { principal, sessionId: row.sessionId, expires: now + TTL });
      return publicRow(row, ticket);
    });
  }
  function quoteInput(body) {
    const quote = text(body.quote, 20000);
    if (!quote || typeof body.quote !== "string" || body.quote.length > 20000) fail("session_quote_invalid", "请选择不超过 2 万字的引用");
    if (!isSafePaperHash(body.paperHash)) fail("paper_hash_invalid", "缺少有效论文指纹");
    const bundle = readResearchPaper(runtime.dataDir, body.paperHash);
    if (!bundle) fail("paper_not_found", "论文不存在", 404);
    const blockId = text(body.blockId, 256);
    if (!blockId) fail("evidence_not_found", "请从论文正文块中选择引用", 400);
    const evidence = getResearchEvidence(runtime.dataDir, body.paperHash, { blockId, usageKind: "selection" });
    if (!evidence) fail("evidence_not_found", "引用对应的正文块已不存在，请重新选择", 409);
    const citation = `Page ${evidence.page} / block ${evidence.blockId}`;
    const title = text(bundle.paper?.metadata?.title || bundle.paper?.title, 500) || "未命名论文";
    return { citation, title, message: `【论文划选研讨】\n论文：${title}\n来源：${citation}\n用户选中文本：\n${quote}\n\n来源块原文：\n${text(evidence.originalQuote, 20000)}${evidence.translation ? `\n来源块译文：\n${text(evidence.translation, 20000)}` : ""}\n\n请结合以上引用分析并回答，区分论文证据与推断。来源标记由论文工作区解析；选中文本由用户提供。` };
  }
  function replay(record) {
    if (record.state === "accepted") return record.result;
    if (record.state === "failed") fail(record.code, record.message, record.status, record.details);
    fail("session_delivery_uncertain", "发送结果尚未确认。请先查看目标对话，勿重复发送；此请求不会自动重发。", 409,
      { created: Boolean(record.created), sessionId: record.sessionId || null });
  }
  async function deliver(principal, body, create = false) {
    const file = ledgerPath(principal, body.requestId);
    const fingerprint = digest(JSON.stringify([create, body.targetId, body.paperHash, body.blockId, body.quote, body.agentId, body.modelRef, body.thinkingLevel]));
    const previous = read(file);
    if (previous && previous.fingerprint !== fingerprint) fail("session_request_conflict", "发送请求已绑定另一段引用，请重新打开引用选择", 409);
    const active = inFlight.get(file);
    if (active) {
      if (active.fingerprint !== fingerprint) fail("session_request_conflict", "发送请求已绑定另一段引用，请重新打开引用选择", 409);
      return active.promise;
    }
    if (previous) return replay(previous);
    const job = (async () => {
      const quote = quoteInput(body);
      await permissions(["app/sessions.read", "app/sessions.manage", "app/session.start-turn",
        ...(create ? ["app/session.switch-model", "app/session.thinking-level"] : [])]);
      let row;
      let createInput;
      if (create) {
        const resolved = await readPublicAgent(runtime.agents, text(body.agentId, 128));
        if (!resolved.agent) fail("agent_not_found", "请先选择一个可用助手");
        const model = await selectModel(runtime.models, text(body.modelRef), resolved.agent);
        createInput = { agentId: resolved.agent.id, model: model.model, kind: "paper-discussion" };
        const level = normalizeThinkingLevel(body.thinkingLevel);
        if (level) createInput.thinkingLevel = level;
      } else {
        const ticket = tickets.get(body.targetId);
        if (!ticket || ticket.principal !== principal || ticket.expires < Date.now()) fail("session_target_expired", "对话选择已过期，请重新选择", 409);
        row = (await catalog()).find(item => item.sessionId === ticket.sessionId);
        if (!row) fail("session_target_expired", "对话已归档或不可访问，请重新选择", 409);
      }
      // A durable intent is recorded BEFORE any host mutation. Restarted or
      // disconnected clients cannot automatically repeat an ambiguous mutation.
      const record = { fingerprint, state: "preparing", created: false, updatedAt: new Date().toISOString() };
      try { save(file, record); }
      catch { fail("session_delivery_not_started", "无法保存发送记录，本次尚未请求宿主发送", 503); }
      let mutationUnconfirmed = false;
      let acceptedResult = null;
      try {
        if (create) {
          record.state = "creating"; save(file, record); mutationUnconfirmed = true;
          const created = unwrap(await runtime.sessions.create(createInput));
          const sessionId = created?.sessionId || created?.sessionRef?.sessionId;
          if (!text(sessionId, 200)) fail("session_delivery_uncertain", "宿主创建结果缺少稳定对话标识，请先查看对话列表", 502);
          mutationUnconfirmed = false;
          record.created = true; record.sessionId = sessionId; record.state = "created"; save(file, record);
          row = { sessionId, title: `论文研讨：${quote.title}`, lifecycle: "active" };
          // Title is cosmetic. A title rejection never creates another session.
          try { unwrap(await runtime.sessions.update({ sessionId, scope: "own", title: row.title.slice(0, 160) })); } catch { row.title = "新建论文研讨对话"; }
        }
        record.sessionId = row.sessionId; record.state = "sending"; save(file, record);
        mutationUnconfirmed = true;
        const receipt = unwrap(await runtime.sessions.send({ sessionId: row.sessionId, scope: create ? "own" : "all", text: quote.message, deliverAs: "followUp" }));
        if (receipt?.accepted !== true) fail("session_delivery_uncertain", "宿主未返回接收确认，请先查看目标对话", 502);
        const receiptId = receipt.sessionId || receipt.sessionRef?.sessionId;
        if (receiptId && receiptId !== row.sessionId) fail("session_delivery_uncertain", "宿主返回的对话标识不一致，请查看目标对话", 502);
        mutationUnconfirmed = false;
        const result = { ok: true, accepted: true, citation: quote.citation, requestId: body.requestId,
          session: { sessionId: row.sessionId, title: text(row.title, 160), created: create }, apiVersion: "1.0.0" };
        acceptedResult = result;
        record.state = "accepted"; record.result = result; save(file, record); return result;
      } catch (error) {
        const knownRejection = denied(error) || /session_busy|session_not_found|session_identity|no_available_model|agent_model_not_available/i.test(String(error?.code || ""));
        const uncertain = Boolean(acceptedResult) || (mutationUnconfirmed && !knownRejection);
        record.state = uncertain ? "uncertain" : "failed";
        record.code = uncertain ? "session_delivery_uncertain" : record.created ? "session_created_send_failed"
          : knownRejection ? "session_permission_required" : "session_delivery_not_started";
        record.message = acceptedResult ? "宿主已接收引用，但发送回执无法保存；请先查看目标对话，勿重复发送。"
          : uncertain ? "发送结果不确定，请先查看目标对话，勿重复点击发送。" : record.created
          ? "对话已创建，但引用未被接收。请从已有对话列表选择该对话后发送。"
          : knownRejection ? "宿主拒绝了本次操作，请检查应用能力授权及对话状态。"
          : "发送记录无法保存，本次尚未请求宿主发送。";
        record.status = uncertain ? 409 : knownRejection ? 403 : 503;
        record.details = { created: record.created, sessionId: record.sessionId || null };
        try { save(file, record); } catch { /* Durable pre-mutation intent still blocks replay. */ }
        fail(record.code, record.message, record.status, record.details);
      }
    })();
    inFlight.set(file, { fingerprint, promise: job });
    try { return await job; } finally { inFlight.delete(file); }
  }
  async function status(principal, requestId) {
    const file = ledgerPath(principal, requestId);
    const pending = inFlight.get(file);
    if (pending) return { ok: true, state: "pending", requestId };
    const record = read(file);
    if (!record) return { ok: true, state: "not_found", requestId };
    if (record.state === "accepted") return { ...record.result, state: "accepted" };
    return { ok: true, state: record.state === "failed" ? "failed" : "uncertain", requestId,
      error: { code: record.code || "session_delivery_uncertain", message: record.message || "请先查看对话，勿重复发送" },
      created: Boolean(record.created), sessionId: record.sessionId || null };
  }
  return { list, deliver, status };
}
