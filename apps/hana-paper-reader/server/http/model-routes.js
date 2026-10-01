import { isSafePaperHash, readResearchEvidenceSnapshot } from "../domain/research-read.js";
import { WorkspaceIntegrityError } from "../domain/recent-paper.js";
import { storageStateFailure } from "../domain/workspace-storage-errors.js";
import {
  ModelBoundaryError,
  listPublicAgents,
  listPublicModels,
  normalizeThinkingLevel,
  parseJsonArray,
  publicModelSelection,
  readPublicAgent,
  runUtilityTranslation,
  selectModel,
  streamText,
  validateTextList,
} from "../domain/model-agent.js";

const APP_API_VERSION = "1.0.0";
const MAX_CONTEXT_CHARS = 20000;
const MAX_PROMPT_CHARS = 12000;

function appRequestContextOf(c) {
  try {
    return typeof c.get === "function" ? c.get("appRequestContext") : null;
  } catch {
    return null;
  }
}

function hasPrincipal(requestContext) {
  const principal = requestContext?.principal;
  return Boolean(principal && typeof principal === "object" && (
    typeof principal.principalId === "string" && principal.principalId.trim()
      || typeof principal.id === "string" && principal.id.trim()
  ));
}

function requireAppRequest(c) {
  if (hasPrincipal(appRequestContextOf(c))) return null;
  return c.json({
    ok: false,
    error: "需要经过 Hana App UI 授权的请求",
    code: "app_request_context_required",
    apiVersion: APP_API_VERSION,
  }, 403);
}

function requestSignal(c) {
  return c.req?.raw?.signal || c.req?.signal;
}

function errorResponse(c, error, fallbackCode = "model_inference_failed", fallbackMessage = "模型请求失败，请稍后重试") {
  if (error instanceof WorkspaceIntegrityError) {
    return c.json({
      ok: false,
      error: "论文工作区完整性校验失败",
      code: "workspace_integrity_error",
      apiVersion: APP_API_VERSION,
    }, 503);
  }
  const storageFailure = storageStateFailure(error);
  if (storageFailure) return c.json({ ok: false, error: storageFailure.message, code: storageFailure.code, apiVersion: APP_API_VERSION }, storageFailure.status);
  const safe = error instanceof ModelBoundaryError
    ? error
    : new ModelBoundaryError(fallbackCode, fallbackMessage, 502);
  return c.json({
    ok: false,
    error: safe.message,
    code: safe.code,
    apiVersion: APP_API_VERSION,
  }, Number.isInteger(safe.status) ? safe.status : 502);
}

async function readJsonBody(c) {
  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid body");
    return body;
  } catch {
    throw new ModelBoundaryError("request_body_invalid", "请求体格式无效", 400);
  }
}

function explicitModelRef(value) {
  const ref = typeof value === "string" ? value.trim() : "";
  return Boolean(ref && ref !== "agent-default");
}

function textValue(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function translationPrompt(list, glossaryTerms) {
  const entries = glossaryTerms && typeof glossaryTerms === "object" && !Array.isArray(glossaryTerms)
    ? Object.entries(glossaryTerms)
      .filter(([source, target]) => typeof source === "string" && source.trim() && typeof target === "string" && target.trim())
      .slice(0, 100)
    : [];
  const glossary = entries.length ? `\n术语表（必须优先采用固定译法）：${JSON.stringify(Object.fromEntries(entries))}` : "";
  return `请翻译下面的学术英文。只返回 JSON 字符串数组，数组长度必须为 ${list.length}，不要输出解释。${glossary}\n${JSON.stringify(list)}`;
}

function withoutClientCitation(value) {
  return String(value || "")
    .replace(/\n\s*(?:来源|已核验来源)：Page\s+\d+\s+\/\s+block\s+[^\r\n]+\s*$/i, "")
    .trim()
    .slice(0, MAX_CONTEXT_CHARS);
}

function selectionSnapshot(runtime, body) {
  if (!body.evidenceId && !body.blockId && !body.selectedBlockId) {
    if (body.expectedSource !== undefined || body.expectedGeneration !== undefined) {
      throw new ModelBoundaryError("evidence_reference_required", "来源条件需要指定论文证据块", 400);
    }
    return null;
  }
  return evidenceSnapshotForQuestion(runtime, body, { sourceKind: "selection" });
}

function selectionQuote(body) {
  const quote = typeof body.quote === "string" ? body.quote.trim() : "";
  if (!quote || quote.length > 12000) throw new ModelBoundaryError("quote_invalid", "选中文本为空或过长", 400);
  if (body.fromTranslation !== undefined && typeof body.fromTranslation !== "boolean") {
    throw new ModelBoundaryError("selection_kind_invalid", "划选来源类型无效", 400);
  }
  return quote;
}

function quoteOriginOf(quote, evidence, body) {
  const normalize = value => String(value || "").replace(/\s+/gu, " ").trim();
  const selected = normalize(quote);
  const kinds = body.fromTranslation ? ["translation", "original"] : ["original", "translation"];
  for (const kind of kinds) if (normalize(kind === "original" ? evidence?.originalQuote : evidence?.translation).includes(selected)) return kind;
  return "unverified";
}

function storedSelectionContext(snapshot) {
  const evidence = snapshot.evidence[0], block = snapshot.paper.blocks.find(item => item.id === evidence.blockId);
  return [`论文原文：${evidence.originalQuote}`, block?.caption ? `图表说明：${block.caption}` : "",
    block?.latex ? `公式：${block.latex}` : "", block?.tableHtml ? `结构化表格：${block.tableHtml}` : "",
    evidence.translation ? `译文（非论文原文）：${evidence.translation}` : ""].filter(Boolean).join("\n").slice(0, MAX_CONTEXT_CHARS);
}

function evidenceCitation(evidence) {
  return evidence ? `Page ${evidence.page} / block ${evidence.blockId}` : "";
}

function enforceVerifiedCitation(answer, citation) {
  const verified = String(citation || "").replace(/\s+/g, " ").trim();
  return String(answer || "").trim().replace(/Page\s+\d+\s+\/\s+block\s+[A-Za-z0-9._:-]+/gi, (candidate) => {
    const normalized = candidate.replace(/\s+/g, " ").trim();
    // Preserve only the exact server-resolved citation. A forged marker must
    // be removed, never rewritten into a citation the model did not produce.
    return verified && normalized === verified ? verified : "[未核验来源已移除]";
  });
}

function askPrompt(body, agent, citation, quoteOrigin = "unverified") {
  const quote = selectionQuote(body);
  const context = withoutClientCitation(body.context);
  const paperTitle = textValue(body.paperTitle, 500) || "当前学术文献";
  const question = textValue(body.prompt, MAX_PROMPT_CHARS)
    || (body.questionType === "formula"
      ? "请逐项解释公式中的变量、推导逻辑和数学或物理意义。"
      : body.questionType === "explain"
        ? "请解释术语的定义、背景、应用场景及其在本文中的作用。"
        : body.questionType === "critique"
          ? "请从审稿人角度客观分析方法和结论的可靠性。"
          : "请用严谨但易懂的语言解释选中文献内容的原理、论证逻辑和关键要点。");
  const sourceLine = citation ? `\n工作区核验的论文块位置：${citation}` : "";
  const selectionRule = quoteOrigin === "original" ? "划选文本已匹配工作区原文片段。"
    : quoteOrigin === "translation" ? "划选文本匹配的是工作区译文，译文不是论文原文；引用须依据上方论文原文。"
      : "划选文本未匹配工作区原文或译文，只是用户提供的讨论线索，不得将其当作已核验论文原文。";
  const citationRule = citation
    ? `涉及论文的结论只能根据上方工作区内容引用 ${citation}；证据不足请明确说明，不得把用户划选线索冒充原文。`
    : "不要输出页码、block 或其他未核验来源标记。";
  return `论文：${paperTitle}\n${citation ? "工作区提供的上下文" : "用户提供的上下文"}：${context}\n用户划选文本：${quote}${sourceLine}\n${selectionRule}\n\n任务：${question}\n请直接回答，支持 Markdown。${citationRule}${agent?.name ? `\n当前助手：${agent.name}` : ""}`;
}

function evidenceSnapshotForQuestion(runtime, body, options = {}) {
  const paperHash = textValue(body?.paperHash, 128).toLowerCase();
  if (!isSafePaperHash(paperHash)) {
    throw new ModelBoundaryError("paper_hash_invalid", "缺少有效的 paperHash", 400);
  }
  const evidenceId = textValue(body?.evidenceId, 128);
  const blockId = textValue(body?.blockId || body?.selectedBlockId, 256);
  const snapshot = readResearchEvidenceSnapshot(runtime.dataDir, paperHash, { evidenceId: evidenceId || undefined, blockId: blockId || undefined, sourceKind: options.sourceKind });
  if (!snapshot) throw new ModelBoundaryError("paper_not_found", "论文不存在", 404);
  if ((evidenceId || blockId) && !snapshot.evidence.length) throw new ModelBoundaryError("evidence_not_found", "指定证据块不存在或不匹配", 404);
  return snapshot;
}

function evidenceSourceChanged() { return new ModelBoundaryError("evidence_source_changed", "论文证据已更新、删除或恢复，请保留问题并重新载入后再提交", 409); }

function assertClientEvidenceSource(snapshot, body) {
  if (body.expectedGeneration !== undefined) {
    const raw = body.expectedGeneration, generation = Number(raw);
    if (!(typeof raw === "number" || typeof raw === "string" && /^(?:0|[1-9]\d*)$/.test(raw))
        || !Number.isSafeInteger(generation) || generation < 0) throw new ModelBoundaryError("paper_generation_invalid", "论文导入版本无效", 400);
    if (generation !== snapshot.paper.generation) throw evidenceSourceChanged();
  }
  if (body.expectedSource !== undefined) {
    if (typeof body.expectedSource !== "string" || !body.expectedSource || body.expectedSource.length > 1024 * 1024) {
      throw new ModelBoundaryError("evidence_source_condition_invalid", "论文证据条件无效", 400);
    }
    if (body.expectedSource !== snapshot.sourceBasis) throw evidenceSourceChanged();
  }
}

function assertEvidenceSnapshotCurrent(runtime, body, snapshot) {
  const current = readResearchEvidenceSnapshot(runtime.dataDir, snapshot.paper.paperHash, {
    evidenceId: textValue(body.evidenceId, 128) || undefined, blockId: textValue(body.blockId || body.selectedBlockId, 256) || undefined, sourceKind: snapshot.sourceKind });
  if (!current || current.sourceBasis !== snapshot.sourceBasis) throw evidenceSourceChanged();
}

function evidenceQuestionPrompt(body, agent, evidence) {
  const question = textValue(body.question || body.prompt, MAX_PROMPT_CHARS);
  if (!question) throw new ModelBoundaryError("question_required", "question is required", 400);
  const paperTitle = textValue(body.paperTitle, 500) || "当前学术文献";
  const sources = evidence.map((item, index) => {
    const quote = textValue(item.originalQuote || item.translation, 1800);
    return `[${index + 1}] Page ${item.page} / block ${item.blockId}${item.sectionTitle ? ` · ${item.sectionTitle}` : ""}: ${quote}`;
  }).join("\n");
  return `论文：${paperTitle}\n\n可用且已核验的证据：\n${sources}\n\n问题：${question}\n请只根据上面的证据回答，明确区分论文原文与推断；如果证据不足，直接说明不足。引用时只使用精确格式“Page N / block BLOCK_ID”，不得编造页码、block 或来源。${agent?.name ? `\n当前助手：${agent.name}` : ""}`;
}

function enforceEvidenceCitations(answer, evidence) {
  const allowed = new Set(evidence.map((item) => `Page ${item.page} / block ${item.blockId}`));
  return String(answer || "").trim().replace(/Page\s+\d+\s+\/\s+block\s+[A-Za-z0-9._:-]+/gi, (candidate) => {
    const normalized = candidate.replace(/\s+/g, " ");
    return allowed.has(normalized) ? normalized : "[未核验来源已移除]";
  });
}

export default function registerModelRoutes(app, runtime) {
  if (!app || typeof app.get !== "function") throw new TypeError("A Hono route app is required");
  if (!runtime || typeof runtime.dataDir !== "string") throw new TypeError("An App data directory is required");
  const post = typeof app.post === "function" ? app.post.bind(app) : () => {};

  app.get("/api/models", async (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    try {
      return c.json({ ok: true, models: await listPublicModels(runtime.models), apiVersion: APP_API_VERSION });
    } catch (error) {
      return errorResponse(c, error, "model_catalog_unavailable", "无法读取当前聊天模型列表，请稍后重试");
    }
  });

  app.get("/api/agents", async (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    try {
      const catalog = await listPublicAgents(runtime.agents);
      return c.json({
        ok: true,
        agents: catalog.agents,
        agentScope: catalog.scope,
        agentReadDowngraded: catalog.downgraded,
        ...(catalog.downgradeReason ? { agentReadWarning: catalog.downgradeReason } : {}),
        apiVersion: APP_API_VERSION,
      });
    } catch (error) {
      return errorResponse(c, error, "agent_catalog_unavailable", "无法读取当前助手列表，请稍后重试");
    }
  });

  app.get("/api/agents/:agentId", async (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    const agentId = typeof c.req?.param === "function" ? c.req.param("agentId") : "";
    try {
      const resolved = await readPublicAgent(runtime.agents, agentId);
      return resolved.agent
        ? c.json({
          ok: true,
          agent: resolved.agent,
          agentScope: resolved.scope,
          agentReadDowngraded: resolved.downgraded,
          ...(resolved.downgradeReason ? { agentReadWarning: resolved.downgradeReason } : {}),
          apiVersion: APP_API_VERSION,
        })
        : c.json({ ok: false, error: "未找到指定助手", code: "agent_not_found", apiVersion: APP_API_VERSION }, 404);
    } catch (error) {
      return errorResponse(c, error, "agent_profile_unavailable", "无法读取指定助手，请稍后重试");
    }
  });

  post("/api/translate", async (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    try {
      const body = await readJsonBody(c);
      const list = validateTextList(body);
      const agentId = textValue(body.agentId, 128);
      const requestedRef = textValue(body.modelRef, 512);
      if (explicitModelRef(requestedRef) && !agentId) {
        throw new ModelBoundaryError("model_agent_required", "选择模型时必须同时选择助手", 400);
      }
      if (!agentId) {
        const result = await runUtilityTranslation(runtime.models, list, body.glossaryTerms, runtime, requestSignal(c));
        return c.json({ ok: true, translations: result.translations, model: "utility", requestId: result.requestId, apiVersion: APP_API_VERSION });
      }
      const resolvedAgent = await readPublicAgent(runtime.agents, agentId);
      const agent = resolvedAgent.agent;
      if (!agent) return c.json({ ok: false, error: "未找到指定助手", code: "agent_not_found", apiVersion: APP_API_VERSION }, 400);
      const selection = await selectModel(runtime.models, requestedRef, agent);
      const result = await streamText({
        models: runtime.models,
        selection,
        messages: [{ role: "user", content: translationPrompt(list, body.glossaryTerms) }],
        systemPrompt: agent.identity || "你是学术论文翻译助手。",
        reasoningEffort: normalizeThinkingLevel(body.thinkingLevel),
        maxTokens: 4096,
        temperature: 0.2,
        signal: requestSignal(c),
        runtime,
      });
      const translations = parseJsonArray(result.text);
      if (!translations || translations.length !== list.length || translations.some((text) => text.length > 12000)) {
        throw new ModelBoundaryError("translation_output_invalid", "翻译模型返回格式无效", 502);
      }
      return c.json({
        ok: true,
        translations,
        model: selection.ref,
        modelSelection: publicModelSelection(selection, agent),
        requestId: result.requestId,
        thinkingLevel: normalizeThinkingLevel(body.thinkingLevel) || null,
        agentScope: resolvedAgent.scope,
        agentReadDowngraded: resolvedAgent.downgraded,
        ...(resolvedAgent.downgradeReason ? { agentReadWarning: resolvedAgent.downgradeReason } : {}),
        apiVersion: APP_API_VERSION,
      });
    } catch (error) {
      return errorResponse(c, error, "translation_failed", "翻译失败，请稍后重试");
    }
  });

  post("/api/ask-agent", async (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    try {
      const body = await readJsonBody(c);
      const quote = selectionQuote(body);
      const snapshot = selectionSnapshot(runtime, body);
      if (snapshot) assertClientEvidenceSource(snapshot, body);
      const evidence = snapshot?.evidence[0] || null;
      const quoteOrigin = quoteOriginOf(quote, evidence, body);
      const agentId = textValue(body.agentId, 128);
      const resolvedAgent = await readPublicAgent(runtime.agents, agentId);
      const agent = resolvedAgent.agent;
      if (!agent) return c.json({ ok: false, error: "未找到指定助手", code: "agent_not_found", apiVersion: APP_API_VERSION }, 400);
      const citation = evidenceCitation(evidence);
      const selection = await selectModel(runtime.models, textValue(body.modelRef, 512), agent);
      if (snapshot) assertEvidenceSnapshotCurrent(runtime, body, snapshot);
      const result = await streamText({
        models: runtime.models,
        selection,
        messages: [{ role: "user", content: askPrompt(snapshot ? { ...body, quote,
          context: storedSelectionContext(snapshot), paperTitle: snapshot.paper.metadata?.title || "当前学术文献" } : { ...body, quote }, agent, citation, quoteOrigin) }],
        systemPrompt: agent.identity || "你是严谨的学术论文助手。",
        reasoningEffort: normalizeThinkingLevel(body.thinkingLevel),
        maxTokens: 8192,
        temperature: 0.3,
        signal: requestSignal(c),
        runtime,
      });
      if (snapshot) assertEvidenceSnapshotCurrent(runtime, body, snapshot);
      return c.json({
        ok: true,
        answer: enforceVerifiedCitation(result.text, citation),
        citation: citation || null,
        evidence: evidence || null,
        quote,
        quoteOrigin,
        paperHash: snapshot?.paper.paperHash || null,
        sourceBasis: snapshot?.sourceBasis || null,
        sourceGeneration: snapshot?.paper.generation ?? null,
        model: selection.ref,
        modelSelection: publicModelSelection(selection, agent),
        requestId: result.requestId,
        thinkingLevel: normalizeThinkingLevel(body.thinkingLevel) || null,
        agentScope: resolvedAgent.scope,
        agentReadDowngraded: resolvedAgent.downgraded,
        ...(resolvedAgent.downgradeReason ? { agentReadWarning: resolvedAgent.downgradeReason } : {}),
        apiVersion: APP_API_VERSION,
      });
    } catch (error) {
      return errorResponse(c, error, "agent_failed", "助手请求失败，请稍后重试");
    }
  });

  post("/api/research/evidence", async (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    try {
      const body = await readJsonBody(c);
      const snapshot = evidenceSnapshotForQuestion(runtime, body);
      assertClientEvidenceSource(snapshot, body);
      const evidence = snapshot.evidence;
      if (!evidence.length) throw new ModelBoundaryError("evidence_unavailable", "没有可用的论文证据块", 400);
      const agentId = textValue(body.agentId, 128);
      const resolvedAgent = await readPublicAgent(runtime.agents, agentId);
      const agent = resolvedAgent.agent;
      if (!agent) return c.json({ ok: false, error: "未找到指定助手", code: "agent_not_found", apiVersion: APP_API_VERSION }, 400);
      const selection = await selectModel(runtime.models, textValue(body.modelRef, 512), agent);
      assertEvidenceSnapshotCurrent(runtime, body, snapshot);
      const result = await streamText({
        models: runtime.models,
        selection,
        messages: [{ role: "user", content: evidenceQuestionPrompt({ ...body, paperTitle: snapshot.paper.metadata?.title || "当前学术文献" }, agent, evidence) }],
        systemPrompt: agent.identity || "你是严谨的论文证据助手。",
        reasoningEffort: normalizeThinkingLevel(body.thinkingLevel),
        maxTokens: 8192,
        temperature: 0.2,
        signal: requestSignal(c),
        runtime,
      });
      assertEvidenceSnapshotCurrent(runtime, body, snapshot);
      return c.json({
        ok: true,
        answer: enforceEvidenceCitations(result.text, evidence),
        paperHash: evidence[0].paperHash,
        question: textValue(body.question || body.prompt, MAX_PROMPT_CHARS),
        sourceBasis: snapshot.sourceBasis,
        sourceGeneration: snapshot.paper.generation,
        evidence,
        model: selection.ref,
        modelSelection: publicModelSelection(selection, agent),
        requestId: result.requestId,
        thinkingLevel: normalizeThinkingLevel(body.thinkingLevel) || null,
        agentScope: resolvedAgent.scope,
        agentReadDowngraded: resolvedAgent.downgraded,
        ...(resolvedAgent.downgradeReason ? { agentReadWarning: resolvedAgent.downgradeReason } : {}),
        apiVersion: APP_API_VERSION,
      });
    } catch (error) {
      return errorResponse(c, error, "research_evidence_failed", "论文证据问答失败，请稍后重试");
    }
  });
}

export { APP_API_VERSION };
