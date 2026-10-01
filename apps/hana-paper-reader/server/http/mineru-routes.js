import { createHash } from "node:crypto";
import { createPaperWorkspace } from "../domain/paper-workspace.js";
import { parsePdfWithMineru, readMineruAsset } from "../integrations/mineru.js";
import { paperRevisionOf, paperGenerationOf } from "../domain/paper-revision.js";
import { storageStateFailure } from "../domain/workspace-storage-errors.js";

const APP_API_VERSION = "1.0.0";
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MINERU_MODELS = new Set(["vlm", "pipeline"]);
const MINERU_LANGUAGES = new Set(["ch", "en", "japan", "latin"]);
const MINERU_ALLOWED_HOSTS = new Set(["mineru.net", "openxlab.org.cn", "mineru.oss-cn-shanghai.aliyuncs.com"]);

function requestContextOf(c) {
  try { return typeof c.get === "function" ? c.get("appRequestContext") : null; } catch { return null; }
}

function hasPrincipal(value) {
  const principal = value?.principal;
  return Boolean(principal && typeof principal === "object" && (
    typeof principal.principalId === "string" && principal.principalId.trim()
      || typeof principal.id === "string" && principal.id.trim()
  ));
}

function requireAppRequest(c) {
  if (hasPrincipal(requestContextOf(c))) return null;
  return c.json({
    ok: false,
    error: { code: "app_request_context_required", message: "需要经过 Hana App UI 授权的请求" },
    apiVersion: APP_API_VERSION,
  }, 403);
}

function query(c, name) {
  try { return typeof c.req?.query === "function" ? c.req.query(name) || "" : ""; } catch { return ""; }
}

function normalizeApiBaseSetting(value) {
  const candidate = String(value || "https://mineru.net/api/v4").trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("MinerU API 地址无效");
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || (host !== "mineru.net" && !host.endsWith(".mineru.net"))) {
    throw new Error("MinerU API 地址必须使用 mineru.net 官方 HTTPS 域名");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function header(c, name) {
  try { return typeof c.req?.header === "function" ? c.req.header(name) || "" : ""; } catch { return ""; }
}

async function jsonBody(c) {
  return typeof c.req?.json === "function" ? c.req.json() : {};
}

function responseError(c, error, fallbackStatus = 502) {
  const state = storageStateFailure(error);
  if (state) return c.json({ ok: false, parser: "mineru", apiVersion: APP_API_VERSION,
    code: state.code, error: state.message }, state.status);
  if (["paper_conflict", "paper_generation_invalid", "parse_cancelled"].includes(error?.code)) {
    return c.json({ ok: false, parser: "mineru", apiVersion: APP_API_VERSION, code: error.code,
      error: error.code === "paper_conflict" ? "论文已被其他窗口更新或重新导入，解析结果未覆盖现有数据，请重新载入"
        : error.code === "parse_cancelled" ? "解析已取消" : "论文导入版本无效" }, error.status);
  }
  const message = redactError(error);
  let status = Number.isInteger(error?.status) ? error.status : fallbackStatus;
  if (!Number.isInteger(error?.status) && /Token|API 地址|模型只能|文档语言|未配置/i.test(message)) status = 400;
  return c.json({
    ok: false,
    parser: "mineru",
    apiVersion: APP_API_VERSION,
    error: message,
  }, status);
}

function redactError(error) {
  return String(error?.message || "MinerU 解析失败")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/https?:\/\/\S+/gi, "[受保护地址]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "[受保护 ID]")
    .replace(/批次 ID：\S+/g, "批次 ID：[受保护 ID]")
    .slice(0, 600);
}

function workspaceFor(runtime) {
  if (!runtime.workspace) runtime.workspace = createPaperWorkspace({ dataDir: runtime.dataDir });
  return runtime.workspace;
}

function settingsStore(runtime) {
  return runtime.settings || runtime.config;
}

async function configValue(runtime, key) {
  const settings = settingsStore(runtime);
  return typeof settings?.get === "function" ? await settings.get(key) : undefined;
}

async function publicSettings(runtime) {
  const [modelVersion, language, enableFormula, enableTable, ocr, timeoutSeconds, pollIntervalSeconds, token, apiBaseUrl] = await Promise.all([
    configValue(runtime, "mineruModelVersion"),
    configValue(runtime, "mineruLanguage"),
    configValue(runtime, "mineruEnableFormula"),
    configValue(runtime, "mineruEnableTable"),
    configValue(runtime, "mineruOcr"),
    configValue(runtime, "mineruTimeoutSeconds"),
    configValue(runtime, "mineruPollIntervalSeconds"),
    configValue(runtime, "mineruApiToken"),
    configValue(runtime, "mineruApiBaseUrl"),
  ]);
  const timeout = Number.isInteger(Number(timeoutSeconds)) ? Math.max(60, Math.min(3600, Number(timeoutSeconds))) : 900;
  const poll = Number.isInteger(Number(pollIntervalSeconds)) ? Math.max(2, Math.min(30, Number(pollIntervalSeconds))) : 5;
  return {
    ok: true,
    apiVersion: APP_API_VERSION,
    configured: Boolean(String(token || "").trim()),
    apiBaseUrl: normalizeApiBaseSetting(apiBaseUrl),
    modelVersion: MINERU_MODELS.has(String(modelVersion || "")) ? modelVersion : "vlm",
    language: MINERU_LANGUAGES.has(String(language || "")) ? language : "ch",
    enableFormula: enableFormula !== false,
    enableTable: enableTable !== false,
    ocr: ocr === true,
    timeoutSeconds: timeout,
    pollIntervalSeconds: poll,
  };
}

function validateSettings(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("MinerU 设置格式无效");
  const patch = {};
  if (body.clearToken === true) patch.mineruApiToken = "";
  if (typeof body.token === "string" && body.token.trim()) {
    const token = body.token.trim().replace(/^Bearer\s+/i, "");
    if (token.length < 16 || token.length > 4096 || /\s/.test(token)) throw new Error("MinerU Token 格式无效");
    patch.mineruApiToken = token;
  }
  if (body.apiBaseUrl !== undefined) {
    if (typeof body.apiBaseUrl !== "string") throw new Error("MinerU API 地址格式无效");
    patch.mineruApiBaseUrl = normalizeApiBaseSetting(body.apiBaseUrl);
  }
  if (body.modelVersion !== undefined) {
    if (!MINERU_MODELS.has(body.modelVersion)) throw new Error("MinerU 模型只能是 vlm 或 pipeline");
    patch.mineruModelVersion = body.modelVersion;
  }
  if (body.language !== undefined) {
    if (!MINERU_LANGUAGES.has(body.language)) throw new Error("MinerU 文档语言无效");
    patch.mineruLanguage = body.language;
  }
  for (const [inputKey, configKey] of [["enableFormula", "mineruEnableFormula"], ["enableTable", "mineruEnableTable"], ["ocr", "mineruOcr"]]) {
    if (body[inputKey] !== undefined) {
      if (typeof body[inputKey] !== "boolean") throw new Error(`${inputKey} 必须是布尔值`);
      patch[configKey] = body[inputKey];
    }
  }
  for (const [inputKey, configKey, min, max] of [["timeoutSeconds", "mineruTimeoutSeconds", 60, 3600], ["pollIntervalSeconds", "mineruPollIntervalSeconds", 2, 30]]) {
    if (body[inputKey] !== undefined) {
      const numeric = Number(body[inputKey]);
      if (!Number.isInteger(numeric) || numeric < min || numeric > max) throw new Error(`${inputKey} 超出允许范围`);
      patch[configKey] = numeric;
    }
  }
  return patch;
}

function hostAllowed(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return MINERU_ALLOWED_HOSTS.has(host) || [...MINERU_ALLOWED_HOSTS].some((allowed) => host.endsWith(`.${allowed}`));
}

function mineruContext(runtime, signal) {
  if (!runtime.network || typeof runtime.network.fetch !== "function") throw new Error("Hana App network capability unavailable");
  return {
    dataDir: runtime.dataDir,
    config: settingsStore(runtime),
    log: runtime.logger || runtime.log,
    network: {
      async fetch(url, init = {}) {
        if (!hostAllowed(url)) throw new Error("MinerU 请求地址不在 App allowlist 内");
        return runtime.network.fetch(url, { ...init, signal: init.signal || signal });
      },
    },
  };
}

async function requestPdfBytes(c) {
  const contentType = header(c, "content-type").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/pdf" && contentType !== "application/octet-stream") {
    const error = new Error("PDF 上传协议不受支持");
    error.status = 415;
    throw error;
  }
  const declared = Number(header(c, "content-length"));
  if (Number.isInteger(declared) && declared > MAX_PDF_BYTES) {
    const error = new Error("PDF 不得超过 50 MB");
    error.status = 413;
    throw error;
  }
  let bytes;
  if (typeof c.req?.arrayBuffer === "function") {
    bytes = Buffer.from(await c.req.arrayBuffer());
  } else {
    const stream = c.req?.raw?.body;
    if (!stream || typeof stream.getReader !== "function") {
      const error = new Error("未收到 PDF 二进制数据");
      error.status = 400;
      throw error;
    }
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) continue;
        total += value.byteLength;
        if (total > MAX_PDF_BYTES) {
          await reader.cancel("PDF payload too large").catch(() => {});
          const error = new Error("PDF 不得超过 50 MB");
          error.status = 413;
          throw error;
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    bytes = Buffer.concat(chunks, total);
  }
  if (!bytes.length) {
    const error = new Error("未收到 PDF 二进制数据");
    error.status = 400;
    throw error;
  }
  if (bytes.length > MAX_PDF_BYTES) {
    const error = new Error("PDF 不得超过 50 MB");
    error.status = 413;
    throw error;
  }
  return bytes;
}

export default function registerMineruRoutes(app, runtime) {
  if (!app || typeof app.get !== "function") throw new TypeError("A Hono route app is required");
  app.get("/api/mineru-settings", async (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    try { return c.json(await publicSettings(runtime)); } catch (error) { return responseError(c, error, 503); }
  });

  if (typeof app.post === "function") {
    app.post("/api/mineru-settings", async (c) => {
      const denied = requireAppRequest(c);
      if (denied) return denied;
      try {
        const settings = settingsStore(runtime);
        if (typeof settings?.setMany !== "function") throw new Error("Hana App settings storage unavailable");
        await settings.setMany(validateSettings(await jsonBody(c)));
        return c.json(await publicSettings(runtime));
      } catch (error) {
        return responseError(c, error, 400);
      }
    });

    app.post("/api/parse-pdf", async (c) => {
      const denied = requireAppRequest(c);
      if (denied) return denied;
      try {
        if ((query(c, "parser") || "mineru").trim().toLowerCase() !== "mineru") {
          const error = new Error("本地解析已移除；PDF 只使用 MinerU API 解析");
          error.status = 400;
          throw error;
        }
        const buffer = await requestPdfBytes(c);
        if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
          const error = new Error("上传的文件不是有效 PDF");
          error.status = 400;
          throw error;
        }
        const paperHash = createHash("sha256").update(buffer).digest("hex");
        const workspace = workspaceFor(runtime);
        const existing = workspace.getPaper(paperHash);
        const requestedGeneration = header(c, "X-Hana-Paper-Generation");
        if (requestedGeneration) {
          if (!/^(?:0|[1-9]\d*)$/.test(requestedGeneration) || !Number.isSafeInteger(Number(requestedGeneration))) {
            throw Object.assign(new Error("论文导入版本无效"), { code: "paper_generation_invalid", status: 400 });
          }
          if (!existing || Number(requestedGeneration) !== paperGenerationOf(existing)) {
            throw Object.assign(new Error("论文已重新导入"), { code: "paper_conflict", status: 409 });
          }
        }
        const expectedRevision = paperRevisionOf(existing);
        const force = query(c, "force") === "1" || query(c, "force") === "true";
        if (!force && existing?.blocks?.length) {
          return c.json({
            ok: true,
            parser: existing.parser?.kind || "mineru",
            modelVersion: existing.parser?.modelVersion || "vlm",
            ocrUsed: existing.parser?.ocrUsed === true,
            ocrFallback: existing.parser?.ocrFallback === true,
            pageCount: Number(existing.parser?.pageCount || 0),
            blockCount: existing.blocks.length,
            blocks: existing.blocks,
            paperHash,
            revision: existing.revision,
            generation: paperGenerationOf(existing),
            cached: true,
            apiVersion: APP_API_VERSION,
            transport: "binary",
          });
        }
        const abortSignal = c.req?.raw?.signal;
        const result = await parsePdfWithMineru({
          buffer,
          fileName: query(c, "fileName") || "paper.pdf",
          ctx: mineruContext(runtime, abortSignal),
        });
        if (abortSignal?.aborted) throw Object.assign(new Error("解析已取消"), { code: "parse_cancelled", status: 499 });
        const saved = await workspace.upsertPaper({
          paperHash,
          expectedRevision,
          ...(existing ? { expectedGeneration: paperGenerationOf(existing) } : {}),
          metadata: { title: query(c, "fileName") || "paper.pdf" },
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
        return c.json({ ...result, paperHash, revision: saved.revision, generation: saved.generation,
          cached: false, apiVersion: APP_API_VERSION, transport: "binary" });
      } catch (error) {
        return responseError(c, error, error?.status || 502);
      }
    });
  }

  app.get("/api/mineru-asset", (c) => {
    const denied = requireAppRequest(c);
    if (denied) return denied;
    try {
      const asset = readMineruAsset({ ctx: { dataDir: runtime.dataDir }, cacheId: query(c, "cacheId"), assetPath: query(c, "path") });
      if (!asset) return c.json({ ok: false, error: { code: "mineru_asset_not_found", message: "MinerU 资源不存在" }, apiVersion: APP_API_VERSION }, 404);
      if (typeof c.body === "function") return c.body(asset.bytes, 200, { "Content-Type": asset.contentType, "Cache-Control": "private, max-age=3600" });
      return c.json({ ok: true, bytes: asset.bytes.toString("base64"), contentType: asset.contentType, apiVersion: APP_API_VERSION });
    } catch (error) {
      return responseError(c, error, 404);
    }
  });
}
