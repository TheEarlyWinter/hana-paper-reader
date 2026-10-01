import { readRecentPaper, WorkspaceIntegrityError } from "../domain/recent-paper.js";
import { storageStateFailure } from "../domain/workspace-storage-errors.js";
import {
  getResearchEvidence,
  isSafePaperHash,
  listLibrary,
  listResearchEvidence,
  readResearchPaper,
  researchOutline,
  searchResearchPaper,
} from "../domain/research-read.js";
import registerResearchWriteRoutes from "./research-write-routes.js";
import registerResearchExtraRoutes from "./research-extra-routes.js";
import registerMineruRoutes from "./mineru-routes.js";
import registerModelRoutes from "./model-routes.js";

const APP_API_VERSION = "1.0.0";

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

function requestQuery(c, name) {
  try {
    return typeof c.req?.query === "function" ? c.req.query(name) || "" : "";
  } catch {
    return "";
  }
}

function requireAppRequest(c) {
  if (hasPrincipal(appRequestContextOf(c))) return null;
  return c.json({
    ok: false,
    error: {
      code: "app_request_context_required",
      message: "需要经过 Hana App UI 授权的请求",
    },
    apiVersion: APP_API_VERSION,
  }, 403);
}

function paperHashQuery(c) {
  const value = requestQuery(c, "paperHash").trim().toLowerCase();
  if (!isSafePaperHash(value)) return null;
  return value;
}

function inputError(c, code, message) {
  return c.json({ ok: false, error: { code, message }, apiVersion: APP_API_VERSION }, 400);
}

function errorResponse(c, error) {
  const storageState = storageStateFailure(error);
  if (storageState) return c.json({ ok: false, error: { code: storageState.code, message: storageState.message }, apiVersion: APP_API_VERSION }, storageState.status);
  if (error instanceof WorkspaceIntegrityError) {
    return c.json({
      ok: false,
      error: { code: error.code, message: error.message },
      apiVersion: APP_API_VERSION,
    }, 503);
  }
  return c.json({
    ok: false,
    error: { code: "research_recent_failed", message: "无法读取最近论文" },
    apiVersion: APP_API_VERSION,
  }, 500);
}

export default function registerApiRoutes(app, runtime) {
  if (!app || typeof app.get !== "function") throw new TypeError("A Hono route app is required");
  if (!runtime || typeof runtime.dataDir !== "string") throw new TypeError("An App data directory is required");

  app.get("/api/research/recent", (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    try {
      return c.json({
        ok: true,
        paper: readRecentPaper(runtime.dataDir),
        apiVersion: APP_API_VERSION,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/api/research/library", (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    try {
      const items = listLibrary(runtime.dataDir, {
        query: requestQuery(c, "q") || requestQuery(c, "query"),
        sort: requestQuery(c, "sort"),
        order: requestQuery(c, "order"),
        favorite: requestQuery(c, "favorite"),
        archived: requestQuery(c, "archived"),
        tag: requestQuery(c, "tag"),
      });
      return c.json({ ok: true, items, total: items.length, apiVersion: APP_API_VERSION });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/api/research/paper", (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    const paperHash = paperHashQuery(c);
    if (!paperHash) return inputError(c, "paper_hash_invalid", "缺少有效的 paperHash");
    try {
      const bundle = readResearchPaper(runtime.dataDir, paperHash);
      return bundle
        ? c.json({ ok: true, paper: bundle.paper, apiVersion: APP_API_VERSION })
        : c.json({ ok: false, error: { code: "paper_not_found", message: "论文不存在" }, apiVersion: APP_API_VERSION }, 404);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/api/research/parse-cache/check", (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    const paperHash = paperHashQuery(c);
    if (!paperHash) return inputError(c, "paper_hash_invalid", "缺少有效的 paperHash");
    try {
      const bundle = readResearchPaper(runtime.dataDir, paperHash);
      const hit = Boolean(bundle?.paper && Array.isArray(bundle.paper.blocks) && bundle.paper.blocks.length);
      const paper = hit ? bundle.paper : null;
      return c.json({
        ok: true,
        paperHash,
        hit,
        cached: hit,
        blockCount: hit ? paper.blocks.length : 0,
        pageCount: Number(paper?.parser?.pageCount || 0),
        paper,
        apiVersion: APP_API_VERSION,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/api/research/search", (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    const paperHash = paperHashQuery(c);
    const query = requestQuery(c, "q") || requestQuery(c, "query");
    if (!paperHash) return inputError(c, "paper_hash_invalid", "缺少有效的 paperHash");
    if (!query.trim()) return inputError(c, "search_query_required", "缺少搜索关键词");
    try {
      const results = searchResearchPaper(runtime.dataDir, paperHash, query, {
        scope: requestQuery(c, "scope"),
        language: requestQuery(c, "language"),
        type: requestQuery(c, "type") || requestQuery(c, "types"),
        page: requestQuery(c, "page"),
        sectionId: requestQuery(c, "sectionId"),
        limit: requestQuery(c, "limit"),
      });
      return results
        ? c.json({ ok: true, paperHash, query, results, apiVersion: APP_API_VERSION })
        : c.json({ ok: false, error: { code: "paper_not_found", message: "论文不存在" }, apiVersion: APP_API_VERSION }, 404);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/api/research/evidence", (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    const paperHash = paperHashQuery(c);
    if (!paperHash) return inputError(c, "paper_hash_invalid", "缺少有效的 paperHash");
    try {
      const options = {
        evidenceId: requestQuery(c, "evidenceId"),
        blockId: requestQuery(c, "blockId"),
        type: requestQuery(c, "type"),
        sectionId: requestQuery(c, "sectionId"),
        usageKind: requestQuery(c, "usageKind") || "reference",
        limit: requestQuery(c, "limit"),
      };
      const evidence = options.evidenceId || options.blockId
        ? getResearchEvidence(runtime.dataDir, paperHash, options)
        : listResearchEvidence(runtime.dataDir, paperHash, options);
      if (evidence === null) return c.json({ ok: false, error: { code: "paper_not_found", message: "论文不存在" }, apiVersion: APP_API_VERSION }, 404);
      if (!Array.isArray(evidence) && !evidence) return c.json({ ok: false, error: { code: "evidence_not_found", message: "证据不存在" }, apiVersion: APP_API_VERSION }, 404);
      return c.json(Array.isArray(evidence)
        ? { ok: true, paperHash, evidence, apiVersion: APP_API_VERSION }
        : { ok: true, evidence, apiVersion: APP_API_VERSION });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/api/research/outline", (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    const paperHash = paperHashQuery(c);
    if (!paperHash) return inputError(c, "paper_hash_invalid", "缺少有效的 paperHash");
    try {
      const outline = researchOutline(runtime.dataDir, paperHash);
      return outline
        ? c.json({ ok: true, paperHash, outline, apiVersion: APP_API_VERSION })
        : c.json({ ok: false, error: { code: "paper_not_found", message: "论文不存在" }, apiVersion: APP_API_VERSION }, 404);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  registerResearchWriteRoutes(app, runtime);
  registerResearchExtraRoutes(app, runtime);
  registerMineruRoutes(app, runtime);
  registerModelRoutes(app, runtime);
}

export { APP_API_VERSION };
