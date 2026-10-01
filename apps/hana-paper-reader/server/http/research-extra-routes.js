import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createPaperWorkspace } from "../domain/paper-workspace.js";
import { storageStateFailure } from "../domain/workspace-storage-errors.js";
import { generatePaperMarkdown } from "../domain/paper-export.js";
import { verifyNoSymlinks } from "../domain/paper-path-guard.js";
import { isSafePaperHash } from "../domain/research-read.js";
import { buildDiagnostics } from "../domain/diagnostics.js";
import registerSessionRoutes from "./session-routes.js";
import registerMigrationRoutes from "./migration-routes.js";

const APP_API_VERSION = "1.0.0";
const MAX_LIMIT = 100;
const MAX_EXPORT_MARKDOWN_BYTES = 32 * 1024 * 1024;
const MAX_BACKUP_BYTES = 256 * 1024 * 1024;

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

async function requestJson(c) {
  if (typeof c.req?.json !== "function") return {};
  try {
    const value = await c.req.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    // DELETE/query-only requests may legitimately have no JSON body.
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
  const storageCodes = ["EACCES", "EPERM", "ENOSPC", "EIO", "EROFS", "EMFILE", "ENFILE"];
  const storageFailure = storageCodes.includes(rawCode) || storageCodes.includes(error?.cause?.code);
  const publicCodes = new Set([
    "workspace_integrity_error", "workspace_storage_unavailable", "paper_conflict", "paper_not_found",
    "backup_invalid", "backup_too_large", "backup_assets_unavailable", "export_too_large", "export_path_invalid", "export_condition_invalid",
    "restore_failed", "restore_fatal", "research_extra_failed",
  ]);
  const code = storageFailure
    ? "workspace_storage_unavailable"
    : publicCodes.has(rawCode) ? rawCode : "research_extra_failed";
  const notFound = /not found|不存在|missing/i.test(rawMessage);
  const messages = {
    workspace_integrity_error: "研究工作区完整性校验失败",
    workspace_storage_unavailable: "研究工作区暂时不可写，请稍后重试",
    paper_conflict: "论文已在其他窗口更新，请重新载入后再试",
    backup_invalid: "备份内容无效",
    backup_assets_unavailable: "完整备份缺少或无法读取资源，请恢复资源后重试，或选择不含资源的备份",
    backup_too_large: "备份文件超过大小限制",
    export_too_large: "导出文件超过大小限制",
    export_path_invalid: "App 导出目录不可用",
    export_condition_invalid: "导出来源条件无效",
    restore_fatal: "恢复失败，工作区需要人工检查",
    restore_failed: "恢复失败，原有数据未改变",
    paper_not_found: "请求的论文不存在",
  };
  const message = storageFailure ? messages.workspace_storage_unavailable
    : messages[code] || (notFound ? messages.paper_not_found : "研究工作区请求失败，请稍后重试");
  const status = storageFailure || code === "workspace_integrity_error" || code === "workspace_storage_unavailable"
    ? 503
    : code === "paper_conflict" || code === "backup_assets_unavailable"
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

function safeFileName(value, extension, fallback) {
  const suffix = String(extension || "");
  const raw = String(value || "")
    .replace(/[\\/:*?"<>|\r\n]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180)
    .replace(/[. ]+$/g, "");
  const base = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(raw) ? `_${raw}` : raw || fallback;
  return base.toLowerCase().endsWith(suffix.toLowerCase()) ? base : `${base}${suffix}`;
}

function contentDispositionAttachment(fileName) {
  const safeName = String(fileName || "download").replace(/[\r\n"\\]/g, "_");
  const asciiName = safeName.replace(/[^\x20-\x7e]/g, "_") || "download";
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function downloadResponse(content, fileName, contentType, paperHash, paper) {
  return new Response(content, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": contentDispositionAttachment(fileName),
      "Cache-Control": "private, no-store",
      "X-Paper-Hash": paperHash,
      ...(paper ? { "X-Paper-Revision": String(paper.revision), "X-Paper-Generation": String(paper.generation) } : {}),
    },
  });
}

function verifyExportDir(runtime, exportDir) {
  try {
    verifyNoSymlinks(exportDir, runtime.dataDir);
  } catch {
    const error = new Error("App 导出目录不可用");
    error.code = "export_path_invalid";
    throw error;
  }
}

async function saveInAppExports(runtime, fileName, content) {
  const exportDir = path.join(runtime.dataDir, "exports");
  verifyExportDir(runtime, exportDir);
  fs.mkdirSync(exportDir, { recursive: true });
  verifyExportDir(runtime, exportDir);
  const ext = path.extname(fileName);
  const baseName = path.basename(fileName, ext);
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  if (bytes.length > MAX_BACKUP_BYTES) {
    const error = new Error("导出文件超过 256 MB 限制");
    error.code = "export_too_large";
    throw error;
  }
  const temporary = path.join(exportDir, `.export-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.promises.open(temporary, "wx");
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = null;
    for (let counter = 0; ; counter += 1) {
      verifyExportDir(runtime, exportDir);
      verifyNoSymlinks(temporary, exportDir);
      const finalName = counter === 0 ? fileName : `${baseName} (${counter})${ext}`;
      const target = path.join(exportDir, finalName);
      try {
        // The complete, flushed inode is published without replacing another export.
        await fs.promises.link(temporary, target);
        return { filePath: target, fileName: finalName, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      } catch (error) {
        if (error?.code === "EEXIST") continue;
        throw error;
      }
    }
  } finally {
    if (handle) { try { await handle.close(); } catch {} }
    try { verifyExportDir(runtime, exportDir); await fs.promises.unlink(temporary); } catch {}
  }
}

function publicExportInput(workspace, paperHash, body = {}) {
  const captured = workspace.exportBackup(paperHash, { includeAssets: false });
  const paper = captured.paper;
  assertExportConditions(paper, body);
  return { paper, input: {
    metadata: paper.metadata,
    blocks: paper.blocks,
    translations: body.translations ?? paper.translations ?? Object.fromEntries(paper.blocks.map((block) => [block.id, block.translatedText]).filter(([, value]) => value)),
    translationStates: body.translationStates ?? paper.translationStates ?? {},
    notes: captured.notes,
    bookmarks: captured.bookmarks,
    progress: captured.progress,
    glossary: captured.glossary?.terms || {},
    assets: paper.resources,
    options: body.options,
  } };
}

function assertExportConditions(paper, conditions = {}) {
  for (const [field, actual] of [["expectedRevision", paper.revision], ["expectedGeneration", paper.generation]]) {
    const raw = conditions[field]; if (raw === undefined) continue;
    if (!(typeof raw === "number" || typeof raw === "string" && /^(?:0|[1-9]\d*)$/.test(raw)) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 0) {
      throw Object.assign(new Error("导出来源条件无效"), { code: "export_condition_invalid" });
    }
    if (Number(raw) !== actual) throw Object.assign(new Error("论文已被更新"), { code: "paper_conflict" });
  }
}

function queryExportConditions(c) {
  return Object.fromEntries(["expectedRevision", "expectedGeneration"].flatMap(field => requestQuery(c, field) ? [[field, requestQuery(c, field)]] : []));
}

function sourceReceipt(paper) { return { paperHash: paper.paperHash, sourceRevision: paper.revision, sourceGeneration: paper.generation }; }

function exportMarkdown(runtime, paperHash, body = {}) {
  const workspace = workspaceFor(runtime);
  const captured = publicExportInput(workspace, paperHash, body);
  const markdown = generatePaperMarkdown(captured.input);
  if (Buffer.byteLength(markdown, "utf8") > MAX_EXPORT_MARKDOWN_BYTES) {
    const error = new Error("Markdown 导出超过 32 MB 限制");
    error.code = "export_too_large";
    throw error;
  }
  return { paper: captured.paper, markdown };
}

function backupPayload(runtime, paperHash, includeAssets, conditions = {}) {
  const backup = workspaceFor(runtime).exportBackup(paperHash, { includeAssets });
  assertExportConditions(backup.paper, conditions);
  const encoded = JSON.stringify(backup);
  if (Buffer.byteLength(encoded, "utf8") > MAX_BACKUP_BYTES) {
    const error = new Error("备份文件超过 256 MB 限制");
    error.code = "backup_too_large";
    throw error;
  }
  return { backup, encoded };
}

export default function registerResearchExtraRoutes(app, runtime) {
  if (!app || typeof app.get !== "function" || typeof app.post !== "function") return;
  if (!runtime || typeof runtime.dataDir !== "string") throw new TypeError("An App data directory is required");

  app.get("/api/research/snapshot", (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    const paperHash = paperHashFrom(c);
    if (!paperHash) return invalid(c, "paper_hash_invalid", "缺少有效的 paperHash");
    try {
      const snapshot = workspaceFor(runtime).snapshot(paperHash, { limit: limitFrom(c) });
      return snapshot
        ? c.json({ ok: true, snapshot, apiVersion: APP_API_VERSION })
        : c.json({ ok: false, error: { code: "paper_not_found", message: "论文不存在" }, apiVersion: APP_API_VERSION }, 404);
    } catch (error) {
      return workspaceError(c, error);
    }
  });

  app.post("/api/diagnostics/export", async (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    try {
      const body = await requestJson(c);
      const report = buildDiagnostics(runtime, body);
      const stamp = report.generatedAt.replace(/[^0-9]/g, "").slice(0, 14);
      const fileName = `hana-paper-reader-diagnostics-${stamp}.json`;
      const saved = await saveInAppExports(runtime, fileName, `${JSON.stringify(report, null, 2)}\n`);
      return c.json({ ok: true, saved: true, ...saved, apiVersion: APP_API_VERSION });
    } catch {
      return c.json({ ok: false, error: { code: "diagnostics_export_failed", message: "诊断信息无法保存，请检查应用导出目录" }, apiVersion: APP_API_VERSION }, 503);
    }
  });

  app.get("/api/research/storage", (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    const paperHash = paperHashFrom(c);
    if (!paperHash) return invalid(c, "paper_hash_invalid", "缺少有效的 paperHash");
    try {
      const storage = workspaceFor(runtime).storageStats(paperHash);
      return storage
        ? c.json({ ok: true, storage, apiVersion: APP_API_VERSION })
        : c.json({ ok: false, error: { code: "paper_not_found", message: "论文不存在" }, apiVersion: APP_API_VERSION }, 404);
    } catch (error) {
      return workspaceError(c, error);
    }
  });

  app.post("/api/research/cleanup", async (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    try {
      const body = await requestJson(c);
      const paperHash = paperHashFrom(c, body);
      const action = String(body?.action || "");
      if (!paperHash) return invalid(c, "paper_hash_invalid", "缺少有效的 paperHash");
      if (!["assets", "ai-translations", "structure-keep-notes"].includes(action)) {
        return invalid(c, "cleanup_action_invalid", "不支持的清理范围");
      }
      const result = await workspaceFor(runtime).clearPaperData(paperHash, action, {
        expectedRevision: body.expectedRevision,
      });
      return c.json({ ok: true, result, storage: workspaceFor(runtime).storageStats(paperHash), apiVersion: APP_API_VERSION });
    } catch (error) {
      return workspaceError(c, error);
    }
  });

  app.post("/api/research/restore", async (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    try {
      const body = await requestJson(c);
      const paper = await workspaceFor(runtime).restoreBackup(body);
      return c.json({
        ok: true,
        paper,
        storage: workspaceFor(runtime).storageStats(paper.paperHash),
        apiVersion: APP_API_VERSION,
      });
    } catch (error) {
      return workspaceError(c, error);
    }
  });

  app.post("/api/research/backup", async (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    try {
      const body = await requestJson(c);
      const paperHash = paperHashFrom(c, body);
      if (!paperHash) return invalid(c, "paper_hash_invalid", "缺少有效的 paperHash");
      const includeAssets = body.includeAssets !== false && body.includeAssets !== "false";
      const { backup, encoded } = backupPayload(runtime, paperHash, includeAssets, body);
      const fileName = `hana-paper-reader-${paperHash.slice(0, 12)}.backup.json`;
      if (body.saveToDisk === true) {
        const saved = await saveInAppExports(runtime, fileName, encoded);
        return c.json({ ok: true, saved: true, ...saved, ...sourceReceipt(backup.paper), assetMode: backup.assetMode, apiVersion: APP_API_VERSION });
      }
      return downloadResponse(encoded, fileName, "application/json; charset=utf-8", paperHash, backup.paper);
    } catch (error) {
      return workspaceError(c, error);
    }
  });

  app.get("/api/research/backup", (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    const paperHash = paperHashFrom(c);
    if (!paperHash) return invalid(c, "paper_hash_invalid", "缺少有效的 paperHash");
    try {
      const includeAssets = requestQuery(c, "includeAssets") !== "false";
      const { backup, encoded } = backupPayload(runtime, paperHash, includeAssets, queryExportConditions(c));
      return downloadResponse(encoded, `hana-paper-reader-${paperHash.slice(0, 12)}.backup.json`, "application/json; charset=utf-8", paperHash, backup.paper);
    } catch (error) {
      return workspaceError(c, error);
    }
  });

  app.post("/api/research/export", async (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    try {
      const body = await requestJson(c);
      const paperHash = paperHashFrom(c, body);
      if (!paperHash) return invalid(c, "paper_hash_invalid", "缺少有效的 paperHash");
      const result = exportMarkdown(runtime, paperHash, body);
      if (!result) return c.json({ ok: false, error: { code: "paper_not_found", message: "论文不存在" }, apiVersion: APP_API_VERSION }, 404);
      const fileName = safeFileName(result.paper?.metadata?.title, ".md", "paper.md");
      if (body.saveToDisk === true) {
        const saved = await saveInAppExports(runtime, fileName, result.markdown);
        return c.json({ ok: true, saved: true, ...saved, ...sourceReceipt(result.paper), apiVersion: APP_API_VERSION });
      }
      return downloadResponse(result.markdown, fileName, "text/markdown; charset=utf-8", paperHash, result.paper);
    } catch (error) {
      return workspaceError(c, error);
    }
  });

  app.get("/api/research/export", (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    const paperHash = paperHashFrom(c);
    if (!paperHash) return invalid(c, "paper_hash_invalid", "缺少有效的 paperHash");
    try {
      const result = exportMarkdown(runtime, paperHash, queryExportConditions(c));
      if (!result) return c.json({ ok: false, error: { code: "paper_not_found", message: "论文不存在" }, apiVersion: APP_API_VERSION }, 404);
      return downloadResponse(result.markdown, safeFileName(result.paper?.metadata?.title, ".md", "paper.md"), "text/markdown; charset=utf-8", paperHash, result.paper);
    } catch (error) {
      return workspaceError(c, error);
    }
  });

  registerSessionRoutes(app, runtime);
  registerMigrationRoutes(app, runtime);
}

export { MAX_BACKUP_BYTES, MAX_EXPORT_MARKDOWN_BYTES };
