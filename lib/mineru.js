import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

const DEFAULT_API_BASE = "https://mineru.net/api/v4";
const MAX_ZIP_BYTES = 250 * 1024 * 1024;
const MAX_ENTRY_BYTES = 120 * 1024 * 1024;
const MAX_TOTAL_EXTRACTED_BYTES = 500 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10000;
const MAX_BLOCKS = 20000;
const MAX_STRUCTURED_JSON_BYTES = 64 * 1024 * 1024;
const MAX_TABLE_HTML_CHARS = 1_000_000;
const MAX_CACHE_ENTRIES = 8;
const MAX_CACHE_BYTES = 1024 * 1024 * 1024;
const ALLOWED_MODELS = new Set(["vlm", "pipeline"]);
const ALLOWED_LANGUAGES = new Set(["ch", "en", "japan", "latin"]);
const AUXILIARY_TYPES = new Set([
  "header",
  "footer",
  "page_header",
  "page_footer",
  "page_number",
  "aside_text",
  "page_aside_text",
]);
const WEB_ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

class MineruStageError extends Error {
  constructor(stage, message, retryable = false, cause = null) {
    const detail = String(message || "MinerU 请求失败").trim();
    super(detail.startsWith(`${stage}：`) || detail.startsWith(`${stage}失败`) ? detail : `${stage}：${detail}`);
    this.name = "MineruStageError";
    this.stage = stage;
    this.retryable = retryable === true;
    if (cause) this.cause = cause;
  }
}

function text(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function clampInteger(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function normalizeApiBase(value) {
  const candidate = text(value, DEFAULT_API_BASE).replace(/\/+$/, "");
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

function normalizeMineruRemoteUrl(value, label) {
  const candidate = text(value);
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`MinerU 返回的${label}无效`);
  }
  const host = parsed.hostname.toLowerCase();
  const allowedHost = host === "mineru.net"
    || host.endsWith(".mineru.net")
    || host === "openxlab.org.cn"
    || host.endsWith(".openxlab.org.cn")
    || host === "mineru.oss-cn-shanghai.aliyuncs.com";
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !allowedHost) {
    throw new Error(`MinerU 返回的${label}不是允许的官方 HTTPS 地址`);
  }
  return parsed.toString();
}

function getMineruOptions(ctx) {
  const token = text(ctx.config.get("mineruApiToken")).replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new Error("请先点击阅读器顶部的 MinerU 设置并填写 API Token");
  if (/\s/.test(token)) throw new Error("MinerU API Token 格式无效");
  const modelVersion = text(ctx.config.get("mineruModelVersion"), "vlm");
  const language = text(ctx.config.get("mineruLanguage"), "ch");
  return {
    token,
    apiBase: normalizeApiBase(ctx.config.get("mineruApiBaseUrl")),
    modelVersion: ALLOWED_MODELS.has(modelVersion) ? modelVersion : "vlm",
    language: ALLOWED_LANGUAGES.has(language) ? language : "ch",
    enableFormula: ctx.config.get("mineruEnableFormula") !== false,
    enableTable: ctx.config.get("mineruEnableTable") !== false,
    isOcr: ctx.config.get("mineruOcr") === true,
    timeoutSeconds: clampInteger(ctx.config.get("mineruTimeoutSeconds"), 900, 60, 3600),
    pollIntervalSeconds: clampInteger(ctx.config.get("mineruPollIntervalSeconds"), 5, 2, 30),
  };
}

async function readJsonResponse(response, label) {
  const body = await response.text();
  if (!response.ok) throw new Error(`${label}失败：HTTP ${response.status}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label}返回了无效 JSON`);
  }
}

function requireApiSuccess(envelope, label) {
  if (Number(envelope?.code) !== 0) {
    throw new Error(text(envelope?.msg || envelope?.message, `${label}失败`));
  }
  return envelope?.data || {};
}

function safeFileName(fileName) {
  const cleaned = text(fileName, "paper.pdf").replace(/[\\/:*?"<>|]+/g, "_");
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
}

function normalizeZipPath(value) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null;
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("MinerU 结果 ZIP 缺少中央目录");
}

function readZipEntries(zipBytes) {
  const buffer = Buffer.from(zipBytes);
  if (buffer.length === 0 || buffer.length > MAX_ZIP_BYTES) throw new Error("MinerU 结果 ZIP 为空或过大");
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount > MAX_ZIP_ENTRIES) throw new Error("MinerU 结果 ZIP 文件数量过多");

  const entries = [];
  let offset = centralOffset;
  let totalExtracted = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("MinerU 结果 ZIP 中央目录损坏");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > buffer.length) throw new Error("MinerU 结果 ZIP 文件名损坏");
    const entryName = normalizeZipPath(buffer.subarray(offset + 46, nameEnd).toString("utf8"));
    offset = nameEnd + extraLength + commentLength;
    if (!entryName || entryName.endsWith("/")) continue;
    if ((flags & 0x1) !== 0) throw new Error("MinerU 结果 ZIP 包含加密文件");
    if (method !== 0 && method !== 8) throw new Error(`MinerU 结果 ZIP 使用了不支持的压缩方式：${method}`);
    if (uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`MinerU 结果文件过大：${entryName}`);
    totalExtracted += uncompressedSize;
    if (totalExtracted > MAX_TOTAL_EXTRACTED_BYTES) throw new Error("MinerU 结果解压后体积过大");
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`MinerU 结果 ZIP 本地文件头损坏：${entryName}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error(`MinerU 结果 ZIP 文件数据损坏：${entryName}`);
    const compressed = buffer.subarray(dataStart, dataEnd);
    const data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES });
    if (data.length > MAX_ENTRY_BYTES) throw new Error(`MinerU 结果文件实际体积过大：${entryName}`);
    if (uncompressedSize && data.length !== uncompressedSize) throw new Error(`MinerU 结果文件长度不匹配：${entryName}`);
    totalExtracted += Math.max(0, data.length - uncompressedSize);
    if (totalExtracted > MAX_TOTAL_EXTRACTED_BYTES) throw new Error("MinerU 结果实际解压体积过大");
    entries.push({ name: entryName, data });
  }
  return entries;
}

function chooseStructuredEntry(entries) {
  const jsonEntries = entries.filter((entry) => entry.name.toLowerCase().endsWith(".json"));
  return jsonEntries.find((entry) => entry.name.toLowerCase().endsWith("content_list_v2.json"))
    || jsonEntries.find((entry) => entry.name.toLowerCase().includes("content_list") && !entry.name.toLowerCase().includes("model"))
    || jsonEntries.find((entry) => entry.name.toLowerCase().endsWith("middle.json"))
    || null;
}

function listMineruAssetPaths(entries) {
  return entries
    .filter((entry) => WEB_ASSET_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name);
}

function cacheDirectorySize(directory) {
  let total = 0;
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) {
        try { total += fs.statSync(child).size; } catch {}
      }
    }
  }
  return total;
}

function pruneMineruCache(dataDir, keepCacheId, referencedCacheIds = []) {
  const root = path.resolve(dataDir, "mineru-cache");
  let directories;
  try {
    directories = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{24}$/.test(entry.name))
      .map((entry) => {
        const directory = path.join(root, entry.name);
        let modified = 0;
        try { modified = fs.statSync(directory).mtimeMs; } catch {}
        return { id: entry.name, directory, modified, size: cacheDirectorySize(directory) };
      })
      .sort((left, right) => (right.id === keepCacheId) - (left.id === keepCacheId) || right.modified - left.modified);
  } catch {
    return;
  }
  const protectedIds = new Set([keepCacheId, ...referencedCacheIds].filter(Boolean));
  let kept = 0;
  let total = 0;
  for (const item of directories) {
    const isProtected = protectedIds.has(item.id);
    if (isProtected || (kept < MAX_CACHE_ENTRIES && total + item.size <= MAX_CACHE_BYTES)) {
      kept += 1;
      total += item.size;
      continue;
    }
    try { fs.rmSync(item.directory, { recursive: true, force: true }); } catch {}
  }
}

import { verifyNoSymlinks } from "./paper-path-guard.js";

function writeMineruCache(entries, dataDir, cacheId, referencedPaths, options = {}) {
  const cacheBase = path.resolve(dataDir, "mineru-cache");
  verifyNoSymlinks(cacheBase, dataDir);
  const cacheRoot = path.resolve(cacheBase, cacheId.toLowerCase());
  verifyNoSymlinks(cacheRoot, cacheBase);

  const referencedCacheIds = options.referencedCacheIds || [];
  const wanted = new Set([...referencedPaths].map((item) => String(item).toLowerCase()));
  if (!wanted.size) {
    pruneMineruCache(dataDir, cacheId, referencedCacheIds);
    return cacheRoot;
  }
  fs.mkdirSync(cacheRoot, { recursive: true });
  for (const entry of entries) {
    if (!wanted.has(entry.name.toLowerCase())) continue;
    const output = path.join(cacheRoot, ...entry.name.split("/"));
    const resolved = path.resolve(output);
    const root = `${path.resolve(cacheRoot)}${path.sep}`;
    if (!resolved.startsWith(root)) throw new Error("MinerU 资源路径越界");
    verifyNoSymlinks(path.dirname(resolved), cacheBase);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    verifyNoSymlinks(resolved, cacheBase);
    fs.writeFileSync(resolved, entry.data);
  }
  try {
    const now = new Date();
    fs.utimesSync(cacheRoot, now, now);
  } catch {}
  pruneMineruCache(dataDir, cacheId, referencedCacheIds);
  return cacheRoot;
}

function resolveAssetPath(rawPath, assetPaths) {
  const wanted = normalizeZipPath(rawPath);
  if (!wanted) return null;
  const wantedLower = wanted.toLowerCase();
  const exact = assetPaths.find((item) => item.toLowerCase() === wantedLower);
  if (exact) return exact;
  const suffix = `/${wantedLower}`;
  return assetPaths.find((item) => item.toLowerCase().endsWith(suffix)) || null;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function collectText(value, ignoredKeys = new Set(), depth = 0) {
  if (value == null || depth > 32) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap((item) => collectText(item, ignoredKeys, depth + 1));
  const object = record(value);
  if (!object) return [];
  const nodeType = String(object.type || "").toLowerCase();
  const mathContent = typeof object.math_content === "string"
    ? object.math_content.trim()
    : typeof object.latex === "string" ? object.latex.trim() : "";
  if (mathContent && nodeType.includes("equation_inline")) return [`$${mathContent}$`];
  if (mathContent && (nodeType.includes("equation") || nodeType.includes("formula"))) return [`$$${mathContent}$$`];
  return Object.entries(object).flatMap(([key, child]) => ignoredKeys.has(key) ? [] : collectText(child, ignoredKeys, depth + 1));
}

const TEXT_IGNORED_KEYS = new Set([
  "type", "bbox", "page_idx", "text_level", "level", "img_path", "image_path", "path",
  "image_source", "table_body", "html", "bboxCoordinateSystem", "bboxPageSize", "sub_type",
]);

function joinText(parts) {
  return parts.map((part) => String(part || "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function firstTextByKeys(object, keys) {
  for (const key of keys) {
    if (!(key in object)) continue;
    const value = joinText(collectText(object[key], TEXT_IGNORED_KEYS));
    if (value) return value;
  }
  return "";
}

function firstStringByKeys(value, keys, depth = 0) {
  if (depth > 12 || value == null) return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstStringByKeys(item, keys, depth + 1);
      if (found) return found;
    }
    return "";
  }
  const object = record(value);
  if (!object) return "";
  for (const key of keys) {
    const candidate = object[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  for (const child of Object.values(object)) {
    const found = firstStringByKeys(child, keys, depth + 1);
    if (found) return found;
  }
  return "";
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<(?:script|style|iframe|object|template)\b[^>]*>[\s\S]*?<\/(?:script|style|iframe|object|template)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBBox(value, coordinateSystem = "normalized-1000", pageSize = null) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const numbers = value.map(Number);
  if (numbers.some((item) => !Number.isFinite(item))) return null;
  let [x0, y0, x1, y1] = numbers;
  if (Math.max(Math.abs(x0), Math.abs(y0), Math.abs(x1), Math.abs(y1)) <= 1.5) {
    x0 *= 1000; y0 *= 1000; x1 *= 1000; y1 *= 1000;
  } else if (coordinateSystem === "pdf" && Array.isArray(pageSize) && Number(pageSize[0]) > 0 && Number(pageSize[1]) > 0) {
    x0 = x0 / Number(pageSize[0]) * 1000;
    x1 = x1 / Number(pageSize[0]) * 1000;
    y0 = y0 / Number(pageSize[1]) * 1000;
    y1 = y1 / Number(pageSize[1]) * 1000;
  }
  x0 = Math.max(0, Math.min(1000, x0));
  x1 = Math.max(0, Math.min(1000, x1));
  y0 = Math.max(0, Math.min(1000, y0));
  y1 = Math.max(0, Math.min(1000, y1));
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1].map((item) => Number(item.toFixed(1))) : null;
}

function normalizeBlockType(rawType, raw) {
  const source = String(rawType || "paragraph").toLowerCase();
  if (source === "text") return Number(raw?.text_level || 0) > 0 ? "heading" : "paragraph";
  if (source.includes("title")) return "heading";
  if (source.includes("equation") || source.includes("formula")) return "equation";
  if (source.includes("table")) return "table";
  if (source.includes("chart")) return "chart";
  if (source.includes("image") || source.includes("figure")) return "image";
  if (source.includes("list") || source.includes("index") || source.includes("ref_text")) return "list";
  if (source.includes("algorithm")) return "algorithm";
  if (source.includes("code")) return "code";
  if (source.includes("caption") || source.includes("footnote")) return "caption";
  return "paragraph";
}

function contentForRawBlock(raw) {
  return record(raw.content) || raw;
}

function combinedTextByKeys(object, keys) {
  return joinText(keys.flatMap((key) => key in object ? collectText(object[key], TEXT_IGNORED_KEYS) : []));
}

function blockText(raw, type) {
  const content = contentForRawBlock(raw);
  if (type === "table") return combinedTextByKeys(content, ["table_caption", "caption", "table_footnote"]);
  if (type === "image") return combinedTextByKeys(content, ["image_caption", "caption", "image_footnote"]);
  if (type === "chart") return combinedTextByKeys(content, ["chart_caption", "caption", "chart_footnote"]);
  if (type === "equation") return firstTextByKeys(content, ["caption", "equation_caption"]);
  if (type === "list") return firstTextByKeys(content, ["list_items", "list_content", "content", "text"]);
  if (type === "code" || type === "algorithm") return firstTextByKeys(content, ["code_caption", "algorithm_caption", "code_body", "algorithm_content", "content", "text"]);
  return firstTextByKeys(content, ["title_content", "paragraph_content", "page_footnote_content", "content", "text", "value"])
    || joinText(collectText(content, TEXT_IGNORED_KEYS));
}

function blockLatex(raw) {
  const content = contentForRawBlock(raw);
  return firstTextByKeys(content, ["math_content", "latex", "equation", "text"]);
}

function blockTableHtml(raw) {
  const content = contentForRawBlock(raw);
  const candidate = content.table_body ?? content.html ?? raw.table_body ?? raw.html;
  return typeof candidate === "string" && candidate.length <= MAX_TABLE_HTML_CHARS && /<table\b/i.test(candidate)
    ? candidate
    : "";
}

function blockAssetPath(raw) {
  const content = contentForRawBlock(raw);
  return firstStringByKeys(content, ["img_path", "image_path", "path"])
    || firstStringByKeys(raw, ["img_path", "image_path"]);
}

function createUnifiedBlock(raw, pageIndex, blockIndex, assetPaths, options = {}) {
  const rawType = raw?.type || options.rawType || "paragraph";
  const lowerRawType = String(rawType).toLowerCase();
  if (AUXILIARY_TYPES.has(lowerRawType)) return null;
  const type = normalizeBlockType(rawType, raw);
  const pageSize = options.pageSize || raw?.bboxPageSize || null;
  const coordinateSystem = options.coordinateSystem || raw?.bboxCoordinateSystem || "normalized-1000";
  const bbox = normalizeBBox(raw?.bbox, coordinateSystem, pageSize);
  const rawAssetPath = blockAssetPath(raw);
  const assetPath = resolveAssetPath(rawAssetPath, assetPaths);
  const latex = type === "equation" ? blockLatex(raw) : "";
  const tableHtml = type === "table" ? blockTableHtml(raw) : "";
  let blockBodyText = blockText(raw, type);
  if (type === "equation" && blockBodyText === latex) blockBodyText = "";
  const visualType = type === "image" || type === "chart" || type === "table" || type === "equation";
  return {
    id: `mineru_p${pageIndex + 1}_b${blockIndex + 1}`,
    page: pageIndex + 1,
    type,
    text: blockBodyText,
    latex,
    tableHtml,
    bbox,
    crop: visualType ? bbox : null,
    assetPath,
    source: "mineru",
  };
}

function parseContentListPayload(parsed, assetPaths) {
  const blocks = [];
  let pageCount = 0;
  if (Array.isArray(parsed) && parsed.every(Array.isArray)) {
    pageCount = parsed.length;
    parsed.forEach((page, pageIndex) => {
      page.forEach((raw, blockIndex) => {
        if (!record(raw) || blocks.length >= MAX_BLOCKS) return;
        const block = createUnifiedBlock(raw, pageIndex, blockIndex, assetPaths);
        if (block) blocks.push(block);
      });
    });
    return { blocks, pageCount };
  }
  if (!Array.isArray(parsed)) throw new Error("MinerU content_list 不是有效数组");
  parsed.forEach((raw, blockIndex) => {
    if (!record(raw) || blocks.length >= MAX_BLOCKS) return;
    const rawPage = Number(raw.page_idx);
    const pageIndex = Number.isInteger(rawPage) && rawPage >= 0 ? rawPage : 0;
    pageCount = Math.max(pageCount, pageIndex + 1);
    const block = createUnifiedBlock(raw, pageIndex, blockIndex, assetPaths);
    if (block) blocks.push(block);
  });
  return { blocks, pageCount };
}

function extractMiddleText(rawBlock) {
  return joinText(collectText(rawBlock?.lines || rawBlock?.blocks || rawBlock?.content, new Set(["type", "bbox", "score", "index", "angle", "img_path"])));
}

function parseMiddlePayload(parsed, assetPaths) {
  const pages = Array.isArray(parsed?.pdf_info) ? parsed.pdf_info : null;
  if (!pages) throw new Error("MinerU middle JSON 缺少 pdf_info");
  const blocks = [];
  pages.forEach((page, fallbackPageIndex) => {
    if (!record(page)) return;
    const rawPage = Number(page.page_idx);
    const pageIndex = Number.isInteger(rawPage) && rawPage >= 0 ? rawPage : fallbackPageIndex;
    const pageSize = Array.isArray(page.page_size) ? page.page_size : null;
    const pageBlocks = Array.isArray(page.para_blocks) ? page.para_blocks : [];
    pageBlocks.forEach((raw, blockIndex) => {
      if (!record(raw) || blocks.length >= MAX_BLOCKS) return;
      const enriched = { ...raw, content: { text: extractMiddleText(raw), ...(record(raw.content) || {}) } };
      const block = createUnifiedBlock(enriched, pageIndex, blockIndex, assetPaths, { coordinateSystem: "pdf", pageSize });
      if (block) blocks.push(block);
    });
  });
  return { blocks, pageCount: pages.length };
}

function parseStructuredResult(jsonText, assetPaths) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("MinerU 结构化结果 JSON 无法解析");
  }
  if (record(parsed) && Array.isArray(parsed.pdf_info)) return parseMiddlePayload(parsed, assetPaths);
  return parseContentListPayload(parsed, assetPaths);
}

function contentTypeForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".bmp") return "image/bmp";
  return "application/octet-stream";
}

async function runMineruStage(stage, task, retryable = false) {
  try {
    return await task();
  } catch (error) {
    if (error instanceof MineruStageError) throw error;
    throw new MineruStageError(stage, text(error?.message, `${stage}失败`), retryable, error);
  }
}

function shouldRetryWithOcr(error) {
  return error instanceof MineruStageError && error.retryable === true;
}

async function parseMineruAttempt({ buffer, normalizedFileName, ctx, options, isOcr, attemptIndex }) {
  const digest = createHash("sha256").update(buffer).digest("hex").slice(0, 12);
  const mode = isOcr ? "ocr" : "std";
  const dataId = `hana_paper_${Date.now()}_${digest}_${mode}${attemptIndex}`;
  const uploadEndpoint = `${options.apiBase}/file-urls/batch`;
  const authHeaders = {
    Authorization: `Bearer ${options.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const uploadData = await runMineruStage("申请 MinerU 上传地址", async () => {
    const uploadEnvelope = await readJsonResponse(await ctx.network.fetch(uploadEndpoint, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        files: [{
          name: normalizedFileName,
          data_id: dataId,
          is_ocr: isOcr,
        }],
        model_version: options.modelVersion,
        enable_formula: options.enableFormula,
        enable_table: options.enableTable,
        language: options.language,
      }),
      timeoutMs: 60000,
      maxResponseBytes: 2 * 1024 * 1024,
    }), "申请 MinerU 上传地址");
    return requireApiSuccess(uploadEnvelope, "申请 MinerU 上传地址");
  });
  const batchId = text(uploadData.batch_id);
  const rawUploadUrl = Array.isArray(uploadData.file_urls) ? text(uploadData.file_urls[0]) : "";
  if (!batchId || !rawUploadUrl) {
    throw new MineruStageError("申请 MinerU 上传地址", "MinerU 未返回批次 ID 或上传地址");
  }
  const uploadUrl = await runMineruStage(
    "校验 MinerU 上传地址",
    () => normalizeMineruRemoteUrl(rawUploadUrl, "上传地址"),
  );

  await runMineruStage("上传 PDF 到 MinerU", async () => {
    const putResponse = await ctx.network.fetch(uploadUrl, {
      method: "PUT",
      body: buffer,
      timeoutMs: Math.max(120000, options.timeoutSeconds * 1000),
      maxResponseBytes: 2 * 1024 * 1024,
    });
    if (!putResponse.ok) throw new Error(`HTTP ${putResponse.status}`);
  });

  const timeoutAt = Date.now() + options.timeoutSeconds * 1000;
  let finalResult = null;
  while (Date.now() < timeoutAt) {
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalSeconds * 1000));
    const statusData = await runMineruStage("查询 MinerU 解析状态", async () => {
      const statusEnvelope = await readJsonResponse(await ctx.network.fetch(`${options.apiBase}/extract-results/batch/${encodeURIComponent(batchId)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${options.token}`, Accept: "application/json" },
        timeoutMs: 60000,
        maxResponseBytes: 4 * 1024 * 1024,
      }), "查询 MinerU 解析状态");
      return requireApiSuccess(statusEnvelope, "查询 MinerU 解析状态");
    });
    const results = Array.isArray(statusData.extract_result) ? statusData.extract_result : [statusData.extract_result].filter(Boolean);
    const current = results.find((item) => item?.data_id === dataId || item?.file_name === normalizedFileName) || results[0];
    if (!current) continue;
    if (current.state === "done") {
      finalResult = current;
      break;
    }
    if (current.state === "failed") {
      const errMsg = text(current.err_msg, "MinerU 解析失败");
      const isFatalAuthOrQuota = /auth|token|balance|quota|余额|额度|权限|401|403|unauthorized/i.test(errMsg);
      throw new MineruStageError("MinerU 任务解析", errMsg, !isFatalAuthOrQuota);
    }
  }
  const rawZipUrl = text(finalResult?.full_zip_url);
  if (!rawZipUrl) {
    throw new MineruStageError("查询 MinerU 解析状态", `MinerU 解析超时，批次 ID：${batchId}`);
  }
  const zipUrl = await runMineruStage(
    "校验 MinerU 结果地址",
    () => normalizeMineruRemoteUrl(rawZipUrl, "结果下载地址"),
  );

  const zipBytes = await runMineruStage("下载 MinerU 结果", async () => {
    const zipResponse = await ctx.network.fetch(zipUrl, {
      method: "GET",
      timeoutMs: Math.max(120000, options.timeoutSeconds * 1000),
      maxResponseBytes: MAX_ZIP_BYTES,
    });
    if (!zipResponse.ok) throw new Error(`HTTP ${zipResponse.status}`);
    return Buffer.from(await zipResponse.arrayBuffer());
  });
  const entries = await runMineruStage("校验 MinerU 结果 ZIP", () => readZipEntries(zipBytes));
  const structuredEntry = chooseStructuredEntry(entries);
  if (!structuredEntry) {
    throw new MineruStageError("读取 MinerU 结构结果", "结果包缺少 content_list 或 middle JSON", true);
  }
  if (structuredEntry.data.length > MAX_STRUCTURED_JSON_BYTES) {
    throw new MineruStageError("读取 MinerU 结构结果", "结构化结果 JSON 过大");
  }
  const cacheId = createHash("sha256").update(zipBytes).digest("hex").slice(0, 24);
  const assetPaths = listMineruAssetPaths(entries);
  const parsed = await runMineruStage(
    "解析 MinerU 结构结果",
    () => parseStructuredResult(structuredEntry.data.toString("utf8"), assetPaths),
    true,
  );
  if (!parsed.blocks.length) {
    throw new MineruStageError("解析 MinerU 结构结果", "MinerU 未返回可用结构块", true);
  }
  const referencedPaths = new Set(parsed.blocks.map((block) => block.assetPath).filter(Boolean));
  let existingReferencedCacheIds = [];
  try {
    const ws = ctx.workspace || (typeof ctx.getWorkspace === "function" ? ctx.getWorkspace() : null);
    if (ws && typeof ws.load === "function") {
      const papers = Object.values(ws.load().papers || {});
      existingReferencedCacheIds = [...new Set(papers.flatMap((p) => Array.isArray(p.blocks) ? p.blocks.map((b) => b?.assetRef?.cacheId).filter((id) => /^[a-f0-9]{24}$/i.test(id)) : []))];
    }
  } catch {}
  await runMineruStage("缓存 MinerU 视觉资源", () => writeMineruCache(entries, ctx.dataDir, cacheId, referencedPaths, { referencedCacheIds: existingReferencedCacheIds }));
  const blocks = parsed.blocks.map((block) => ({
    ...block,
    assetRef: block.assetPath ? { cacheId, path: block.assetPath } : null,
  }));
  return {
    ok: true,
    parser: "mineru",
    modelVersion: options.modelVersion,
    ocrUsed: isOcr,
    pageCount: parsed.pageCount,
    blockCount: blocks.length,
    blocks,
  };
}

export async function parsePdfWithMineru({ buffer, fileName, ctx }) {
  const options = getMineruOptions(ctx);
  const normalizedFileName = safeFileName(fileName);
  try {
    const result = await parseMineruAttempt({
      buffer,
      normalizedFileName,
      ctx,
      options,
      isOcr: options.isOcr,
      attemptIndex: 1,
    });
    return { ...result, ocrFallback: false, attemptCount: 1 };
  } catch (firstError) {
    if (options.isOcr || !shouldRetryWithOcr(firstError)) throw firstError;
    ctx.log?.warn?.("MinerU 普通解析未得到可用结构，正在使用 OCR 模式重试");
    try {
      const result = await parseMineruAttempt({
        buffer,
        normalizedFileName,
        ctx,
        options,
        isOcr: true,
        attemptIndex: 2,
      });
      return { ...result, ocrFallback: true, attemptCount: 2 };
    } catch (ocrError) {
      throw new Error(`普通解析失败，OCR 重试仍失败：${text(ocrError?.message, "MinerU 解析失败")}`);
    }
  }
}

export function readMineruAsset({ ctx, cacheId, assetPath }) {
  if (!/^[a-f0-9]{24}$/.test(String(cacheId || ""))) return null;
  const normalized = normalizeZipPath(assetPath);
  if (!normalized || !WEB_ASSET_EXTENSIONS.has(path.extname(normalized).toLowerCase())) return null;
  const cacheBase = path.resolve(ctx.dataDir, "mineru-cache");
  const root = path.resolve(cacheBase, cacheId.toLowerCase());
  const resolved = path.resolve(root, ...normalized.split("/"));
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes("..")) return null;
  if (!fs.existsSync(resolved)) return null;

  // Strict symlink and junction verification from resolved file up to cacheBase & dataDir
  try {
    verifyNoSymlinks(resolved, ctx.dataDir);
  } catch {
    return null;
  }

  // Open with O_NOFOLLOW / O_RDONLY check or verify file descriptor / lstat before and after
  try {
    const statBefore = fs.lstatSync(resolved);
    if (!statBefore.isFile() || statBefore.isSymbolicLink() || statBefore.size > MAX_ENTRY_BYTES) return null;
    const bytes = fs.readFileSync(resolved);
    const statAfter = fs.lstatSync(resolved);
    if (statAfter.isSymbolicLink()) return null;
    return {
      bytes,
      contentType: contentTypeForPath(resolved),
    };
  } catch {
    return null;
  }
}
