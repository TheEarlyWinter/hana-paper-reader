import { createPaperWorkspace } from "../domain/paper-workspace.js";
import { storageStateFailure } from "../domain/workspace-storage-errors.js";
import { isSafePaperHash } from "../domain/research-read.js";

const APP_API_VERSION = "1.0.0";
const MAX_LIMIT = 100;

function requestContextOf(c) {
  try {
    return typeof c.get === "function" ? c.get("appRequestContext") : null;
  } catch {
    return null;
  }
}

function hasPrincipal(value) {
  const principal = value?.principal;
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

function requestParam(c, name) {
  try {
    return typeof c.req?.param === "function" ? c.req.param(name) || "" : "";
  } catch {
    return "";
  }
}

async function requestJson(c) {
  if (typeof c.req?.json !== "function") return {};
  try {
    const value = await c.req.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    // DELETE requests commonly carry their identifiers in the query string
    // and have no JSON body; malformed/empty bodies are validated by the
    // route-specific required-field checks below.
    return {};
  }
}

function requireAppRequest(c) {
  if (hasPrincipal(requestContextOf(c))) return null;
  return c.json({
    ok: false,
    error: { code: "app_request_context_required", message: "需要经过 Hana App UI 授权的请求" },
    apiVersion: APP_API_VERSION,
  }, 403);
}

function invalid(c, code, message) {
  return c.json({ ok: false, error: { code, message }, apiVersion: APP_API_VERSION }, 400);
}

function paperHashFrom(c, body = {}) {
  const raw = body.paperHash || requestQuery(c, "paperHash");
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return isSafePaperHash(value) ? value : "";
}

function limitFrom(c) {
  return Math.max(1, Math.min(MAX_LIMIT, Number(requestQuery(c, "limit")) || MAX_LIMIT));
}

function workspaceError(c, error) {
  const storageState = storageStateFailure(error);
  if (storageState) return c.json({ ok: false, error: { code: storageState.code, message: storageState.message }, apiVersion: APP_API_VERSION }, storageState.status);
  const rawCode = error?.code;
  const rawMessage = String(error?.message || "");
  const storageFailure = ["EACCES", "EPERM", "ENOSPC", "EIO", "EROFS", "EMFILE", "ENFILE"].includes(rawCode);
  const publicCodes = new Set([
    "workspace_integrity_error", "paper_conflict", "paper_revision_invalid", "paper_not_found",
    "research_write_failed", "workspace_storage_unavailable",
    "paper_generation_invalid", "research_item_conflict", "research_item_changed", "research_item_version_invalid",
  ]);
  const code = storageFailure
    ? "workspace_storage_unavailable"
    : publicCodes.has(rawCode) ? rawCode : "research_write_failed";
  const notFound = /not found|不存在|missing/i.test(rawMessage);
  const message = storageFailure
    ? "研究工作区暂时不可写，请稍后重试"
    : code === "workspace_integrity_error"
      ? "研究工作区完整性校验失败"
      : code === "paper_conflict"
        ? "论文已在其他窗口更新，请重新载入后再试"
        : code === "research_item_conflict"
          ? "研究记录编号已存在或属于另一篇论文"
          : code === "research_item_changed"
            ? "研究记录已被更新或删除，请保留本地修改后重新打开记录"
            : code === "research_item_version_invalid"
              ? "研究记录版本条件无效"
          : code === "paper_generation_invalid"
            ? "论文导入版本无效"
        : code === "paper_revision_invalid"
          ? "论文 revision 无效"
          : notFound
            ? "请求的论文或研究项不存在"
            : "研究数据写入失败，请稍后重试";
  const status = storageFailure || code === "workspace_integrity_error"
    ? 503
    : code === "paper_conflict" || code === "research_item_conflict" || code === "research_item_changed"
      ? 409
      : notFound || code === "paper_not_found"
        ? 404
        : 400;
  return c.json({ ok: false, error: { code, message }, apiVersion: APP_API_VERSION }, status);
}

function workspaceFor(runtime) {
  if (!runtime.workspace) runtime.workspace = createPaperWorkspace({ dataDir: runtime.dataDir });
  return runtime.workspace;
}

function registerCollectionRoutes(app, runtime, collection, methodName) {
  app.post(`/api/research/${collection}`, async (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    try {
      const item = await workspaceFor(runtime)[methodName](await requestJson(c));
      return c.json({ ok: true, [collection.slice(0, -1)]: item, apiVersion: APP_API_VERSION });
    } catch (error) {
      return workspaceError(c, error);
    }
  });
  app.get(`/api/research/${collection}`, (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    const paperHash = paperHashFrom(c);
    if (!paperHash) return invalid(c, "paper_hash_invalid", "缺少有效的 paperHash");
    try {
      const filters = collection === "notes" ? {
        noteType: requestQuery(c, "noteType"),
        sectionId: requestQuery(c, "sectionId"),
        tag: requestQuery(c, "tag"),
        unresolvedOnly: requestQuery(c, "unresolvedOnly") === "true",
      } : {};
      const items = workspaceFor(runtime).listItems(collection, paperHash, limitFrom(c), filters);
      return c.json({ ok: true, paperHash, [collection]: items, filters, apiVersion: APP_API_VERSION });
    } catch (error) {
      return workspaceError(c, error);
    }
  });
  if (typeof app.delete === "function") {
    const deleteItem = async (c) => {
      const denied = requireAppRequest(c);
      if (denied) return denied;
      try {
        const body = await requestJson(c);
        const id = requestParam(c, "id") || requestQuery(c, "id") || body.id;
        if (!id) return invalid(c, "item_id_required", "缺少记录 id");
        const deleted = await workspaceFor(runtime).deleteItem(collection, id, {
          paperHash: body.paperHash ?? (requestQuery(c, "paperHash") || undefined),
          expectedRevision: body.expectedRevision ?? (requestQuery(c, "expectedRevision") || undefined),
          expectedGeneration: body.expectedGeneration !== undefined ? body.expectedGeneration : (requestQuery(c, "expectedGeneration") || undefined),
          expectedItemVersion: body.expectedItemVersion !== undefined ? body.expectedItemVersion : (requestQuery(c, "expectedItemVersion") || undefined),
        });
        return deleted
          ? c.json({ ok: true, deleted: true, apiVersion: APP_API_VERSION })
          : c.json({ ok: false, error: { code: "item_not_found", message: "记录不存在" }, apiVersion: APP_API_VERSION }, 404);
      } catch (error) {
        return workspaceError(c, error);
      }
    };
    app.delete(`/api/research/${collection}/:id`, deleteItem);
    app.delete(`/api/research/${collection}`, deleteItem);
  }
}

export default function registerResearchWriteRoutes(app, runtime) {
  if (!app || typeof app.post !== "function") return;
  if (!runtime || typeof runtime.dataDir !== "string") throw new TypeError("An App data directory is required");

  app.post("/api/research/paper", async (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    try {
      const paper = await workspaceFor(runtime).upsertPaper(await requestJson(c));
      return c.json({ ok: true, paper, apiVersion: APP_API_VERSION });
    } catch (error) {
      return workspaceError(c, error);
    }
  });

  app.post("/api/research/library/metadata", async (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    try {
      const body = await requestJson(c);
      const paperHash = paperHashFrom(c, body);
      if (!paperHash) return invalid(c, "paper_hash_invalid", "缺少有效的 paperHash");
      const updated = await workspaceFor(runtime).updatePaperMetadata(paperHash, body);
      return c.json({ ok: true, paperHash, revision: updated.revision, metadata: updated.metadata, lastReadAt: updated.lastReadAt, apiVersion: APP_API_VERSION });
    } catch (error) {
      return workspaceError(c, error);
    }
  });

  if (typeof app.delete === "function") {
    app.delete("/api/research/paper", async (c) => {
      const denied = requireAppRequest(c);
      if (denied) return denied;
      try {
        const body = await requestJson(c);
        const paperHash = paperHashFrom(c, body);
        if (!paperHash) return invalid(c, "paper_hash_invalid", "缺少有效的 paperHash");
        const result = await workspaceFor(runtime).removePaper(paperHash, {
          expectedRevision: body.expectedRevision ?? requestQuery(c, "expectedRevision"),
          returnReceipt: true,
        });
        const deleted = typeof result === "object" && result !== null ? result.deleted === true : result === true;
        return deleted
          ? c.json({ ok: true, deleted: true, ...(typeof result === "object" ? { cleanup: result } : {}), apiVersion: APP_API_VERSION })
          : c.json({ ok: false, error: { code: "paper_not_found", message: "论文不存在" }, apiVersion: APP_API_VERSION }, 404);
      } catch (error) {
        return workspaceError(c, error);
      }
    });
  }

  registerCollectionRoutes(app, runtime, "notes", "putNote");
  registerCollectionRoutes(app, runtime, "bookmarks", "putBookmark");

  app.post("/api/research/progress", async (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    try {
      return c.json({ ok: true, progress: await workspaceFor(runtime).setProgress(await requestJson(c)), apiVersion: APP_API_VERSION });
    } catch (error) {
      return workspaceError(c, error);
    }
  });
  app.get("/api/research/progress", (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    const paperHash = paperHashFrom(c);
    if (!paperHash) return invalid(c, "paper_hash_invalid", "缺少有效的 paperHash");
    try {
      return c.json({ ok: true, paperHash, progress: workspaceFor(runtime).getProgress(paperHash), apiVersion: APP_API_VERSION });
    } catch (error) {
      return workspaceError(c, error);
    }
  });

  app.get("/api/research/glossary", (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    const paperHash = paperHashFrom(c);
    if (!paperHash) return invalid(c, "paper_hash_invalid", "缺少有效的 paperHash");
    try {
      return c.json({ ok: true, paperHash, glossary: workspaceFor(runtime).getGlossary(paperHash), apiVersion: APP_API_VERSION });
    } catch (error) {
      return workspaceError(c, error);
    }
  });
  app.post("/api/research/glossary", async (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    try {
      return c.json({ ok: true, glossary: await workspaceFor(runtime).putGlossary(await requestJson(c)), apiVersion: APP_API_VERSION });
    } catch (error) {
      return workspaceError(c, error);
    }
  });
  if (typeof app.delete === "function") {
    app.delete("/api/research/glossary", async (c) => {
      const denied = requireAppRequest(c);
      if (denied) return denied;
      try {
        const body = await requestJson(c);
        const paperHash = paperHashFrom(c, body);
        const term = requestQuery(c, "term") || body.term;
        if (!paperHash) return invalid(c, "paper_hash_invalid", "缺少有效的 paperHash");
        if (!term) return invalid(c, "glossary_term_required", "缺少术语");
        const receipt = await workspaceFor(runtime).deleteGlossaryTerm(paperHash, term, {
          expectedRevision: body.expectedRevision ?? (requestQuery(c, "expectedRevision") || undefined),
          expectedGeneration: body.expectedGeneration !== undefined ? body.expectedGeneration : (requestQuery(c, "expectedGeneration") || undefined),
          expectedItemVersion: body.expectedItemVersion !== undefined ? body.expectedItemVersion : (requestQuery(c, "expectedItemVersion") || undefined),
          includeReceipt: true,
        });
        return c.json({ ok: true, ...receipt, apiVersion: APP_API_VERSION });
      } catch (error) {
        return workspaceError(c, error);
      }
    });
  }

  app.get("/api/research/translation-cache", (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    const paperHash = paperHashFrom(c);
    if (!paperHash) return invalid(c, "paper_hash_invalid", "缺少有效的 paperHash");
    try {
      const translation = workspaceFor(runtime).getTranslation(
        paperHash,
        requestQuery(c, "blockId"),
        Number(requestQuery(c, "glossaryVersion")) || 0,
        {
          agentId: requestQuery(c, "agentId"),
          modelRef: requestQuery(c, "modelRef"),
          promptVersion: requestQuery(c, "promptVersion"),
          inputHash: requestQuery(c, "inputHash"),
        },
      );
      return c.json({ ok: true, hit: Boolean(translation), translation, apiVersion: APP_API_VERSION });
    } catch (error) {
      return workspaceError(c, error);
    }
  });
  app.post("/api/research/translation-cache", async (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    try {
      return c.json({ ok: true, translation: await workspaceFor(runtime).putTranslation(await requestJson(c)), apiVersion: APP_API_VERSION });
    } catch (error) {
      return workspaceError(c, error);
    }
  });

  app.get("/api/research/parse-status/tasks", (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    const paperHash = paperHashFrom(c);
    if (!paperHash) return invalid(c, "paper_hash_invalid", "缺少有效的 paperHash");
    try {
      return c.json({ ok: true, paperHash, tasks: workspaceFor(runtime).listTasks(paperHash, limitFrom(c)), apiVersion: APP_API_VERSION });
    } catch (error) {
      return workspaceError(c, error);
    }
  });
  app.post("/api/research/parse-status/tasks", async (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    try {
      const body = await requestJson(c);
      if (c.req?.raw?.signal?.aborted) return c.json({ ok: false, error: { code: "task_creation_cancelled", message: "解析任务创建已取消" }, apiVersion: APP_API_VERSION }, 499);
      const workspace = workspaceFor(runtime);
      const task = await workspace.createTask(body);
      if (c.req?.raw?.signal?.aborted) {
        if (["queued", "running"].includes(task.state)) await workspace.updateTask(task.id, {
          state: "cancelled", stage: "cancelled", error: "解析任务创建已取消", expectedGeneration: task.paperGeneration,
        });
        return c.json({ ok: false, error: { code: "task_creation_cancelled", message: "解析任务创建已取消" }, apiVersion: APP_API_VERSION }, 499);
      }
      return c.json({ ok: true, task, apiVersion: APP_API_VERSION });
    } catch (error) {
      return workspaceError(c, error);
    }
  });
  const updateTask = async (c, forcedState = null) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    try {
      const body = await requestJson(c);
      const patch = {};
      for (const key of ["state", "stage", "progress", "error", "paperHash", "expectedRevision", "expectedGeneration"]) if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key];
      if (forcedState) patch.state = forcedState;
      const id = requestParam(c, "taskId") || requestQuery(c, "taskId") || body.taskId;
      if (!id) return invalid(c, "task_id_required", "缺少 taskId");
      return c.json({ ok: true, task: await workspaceFor(runtime).updateTask(id, patch), apiVersion: APP_API_VERSION });
    } catch (error) {
      return workspaceError(c, error);
    }
  };
  app.post("/api/research/parse-status/tasks/:taskId", (c) => updateTask(c));
  app.post("/api/research/parse-status/tasks/:taskId/update", (c) => updateTask(c));
  app.post("/api/research/parse-status/tasks/:taskId/cancel", (c) => updateTask(c, "cancelled"));
}
