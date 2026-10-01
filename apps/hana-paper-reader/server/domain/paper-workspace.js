import fs from "node:fs";
import { storageStateFailure } from "./workspace-storage-errors.js";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  annotateEvidenceBlocks,
  evidenceFromBlock,
  hydrateEvidenceRelation,
  listPaperEvidence,
  resolvePaperEvidence,
} from "./paper-evidence.js?hpr=0.8.0-r2";
import { createPaperStorage, STORAGE_LAYOUT } from "./paper-storage.js?hpr=0.8.0-r2";
import { assertCacheId, assertPaperHash, assertTranslationCacheKey, isReservedKey, isSafeCacheId, isSafePaperHash, normalizeCacheId, normalizePaperHash, safeId } from "./paper-identity.js";
import { normalizeAuthors, normalizeDisplayText, normalizePaperMetadata, normalizeTags, normalizeYear } from "./paper-metadata.js";
import { verifyNoSymlinks } from "./paper-path-guard.js";
import { captureBackupAssets, safeBackupAssetPath, backupAssetKey, decodeBackupAsset, validateBackupAssetMode, validateBackupAssetCoverage } from "./backup-assets.js";
import { paperRevisionOf, paperGenerationOf, normalizeRevisionClocks, advancePaperRevision } from "./paper-revision.js";

const SCHEMA_VERSION = 3;
const DEFAULT_FILE_NAME = "paper-workspace.json";
const MAX_SNAPSHOT_ITEMS = 100;
const MAX_TEXT = 20000;
const NOTE_TYPES = new Set(["finding", "method", "question", "limitation"]);
const SEARCH_LANGUAGES = new Set(["original", "translation", "both"]);
const SEARCH_SCOPES = new Set(["page", "section", "all"]);
const TASK_STATES = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);
const DEFAULT_TRANSLATION_PROMPT_VERSION = "academic-translation-v1";
const TERMINAL_TASK_STATES = new Set(["succeeded", "failed", "cancelled"]);
const ALLOWED_TASK_TRANSITIONS = {
  queued: new Set(["queued", "running", "cancelled", "failed"]),
  running: new Set(["running", "succeeded", "failed", "cancelled"]),
  succeeded: new Set(["succeeded"]),
  failed: new Set(["failed", "queued"]),
  cancelled: new Set(["cancelled", "queued"]),
};

const workspaceMutationLocks = globalThis[Symbol.for("hana-paper-reader.workspace-mutation-locks")] ||= new Map();

const now = () => new Date().toISOString();
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const text = (value, max = MAX_TEXT) => typeof value === "string" ? value.trim().slice(0, max) : "";
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const array = (value) => Array.isArray(value) ? value : [];
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const translationText = (value) => {
  if (typeof value === "string") return text(value);
  const source = object(value);
  return text(source.translation ?? source.text ?? source.value);
};

function emptyData() {
  const data = Object.create(null);
  data.schemaVersion = SCHEMA_VERSION;
  data.updatedAt = now();
  data.papers = Object.create(null);
  data.revisionClocks = Object.create(null);
  data.tasks = Object.create(null);
  data.notes = Object.create(null);
  data.bookmarks = Object.create(null);
  data.progress = Object.create(null);
  data.glossaries = Object.create(null);
  data.translationCache = Object.create(null);
  return data;
}

function normalizeData(value) {
  const source = object(value);
  const data = emptyData();
  for (const key of ["tasks", "notes", "bookmarks", "progress", "glossaries", "translationCache"]) {
    const coll = Object.create(null);
    for (const [k, v] of Object.entries(object(source[key]))) {
      if (!isReservedKey(k)) coll[k] = object(v);
    }
    data[key] = coll;
  }
  const papers = Object.create(null);
  for (const [key, rawPaper] of Object.entries(object(source.papers))) {
    try {
      const paperHash = safePaperHash(rawPaper?.paperHash || key);
      const paper = rebuildDerivedIndexes({ ...object(rawPaper), paperHash });
      paper.metadata = normalizePaperMetadata(paper.metadata);
      paper.generation = paperGenerationOf(paper);
      papers[paperHash] = paper;
    } catch (error) {
      if (storageStateFailure(error)) throw error;
      // Ignore invalid paper hashes
    }
  }
  data.papers = papers;
  data.revisionClocks = normalizeRevisionClocks(source.revisionClocks, papers);

  for (const glossary of Object.values(data.glossaries)) {
    if (glossary.itemVersion !== undefined) itemVersionOf(glossary);
    if (!Number.isSafeInteger(glossary.version) || glossary.version < 0) {
      throw Object.assign(new Error("术语表版本无效"), { code: "workspace_integrity_error" });
    }
  }

  for (const collection of ["notes", "bookmarks"]) {
    const coll = Object.create(null);
    for (const [key, recordVal] of Object.entries(data[collection])) {
      if (isReservedKey(key)) continue;
      const { evidence: _derivedEvidence, ...record } = object(recordVal);
      if (record.itemVersion !== undefined) itemVersionOf(record);
      const paper = data.papers[record.paperHash];
      const evidence = paper ? resolvePaperEvidence(paper, record) : null;
      coll[key] = evidence ? {
        ...record,
        evidenceId: evidence.evidenceId,
        blockId: evidence.blockId,
        page: evidence.page,
        bbox: evidence.bbox,
        evidenceSnapshot: object(record.evidenceSnapshot).evidenceId ? record.evidenceSnapshot : evidence,
        validationStatus: "verified",
      } : { ...record, validationStatus: object(record.evidenceSnapshot).evidenceId ? "detached" : "missing" };
    }
    data[collection] = coll;
  }
  data.schemaVersion = SCHEMA_VERSION;
  data.updatedAt = text(source.updatedAt) || now();
  return data;
}

function safePaperHash(value) {
  return assertPaperHash(value);
}

function expectedPaperRevision(input = {}) {
  if (input.expectedRevision === undefined || input.expectedRevision === null || input.expectedRevision === "") return null;
  const revision = Number(input.expectedRevision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    const error = new Error("论文 revision 无效");
    error.code = "paper_revision_invalid";
    error.status = 400;
    throw error;
  }
  return revision;
}

function assertExpectedPaperRevision(paper, expectedRevision, action = "保存") {
  const actualRevision = paperRevisionOf(paper);
  if (expectedRevision !== null && expectedRevision !== actualRevision) {
    const error = new Error(`论文已在其他窗口更新，请重新载入后再${action}`);
    error.code = "paper_conflict";
    error.status = 409;
    error.expectedRevision = expectedRevision;
    error.actualRevision = actualRevision;
    throw error;
  }
  return actualRevision;
}

function assertExpectedPaperGeneration(paper, input = {}) {
  if (input.expectedGeneration === undefined) return;
  const value = input.expectedGeneration;
  const generation = Number(value);
  if (!(typeof value === "number" || typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value))
      || !Number.isSafeInteger(generation) || generation < 0) {
    throw Object.assign(new Error("论文导入版本无效"), { code: "paper_generation_invalid", status: 400 });
  }
  if (!paper || generation !== paperGenerationOf(paper)) {
    throw Object.assign(new Error("论文已被删除、恢复或重新导入，请重新载入"), { code: "paper_conflict", status: 409 });
  }
}

function researchPaper(store, hash, input = {}) {
  const paper = store.papers[hash];
  if (!paper) throw Object.assign(new Error("论文不存在"), { code: "paper_not_found", status: 404 });
  assertExpectedPaperRevision(paper, expectedPaperRevision(input));
  assertExpectedPaperGeneration(paper, input);
  return paper;
}

function researchInput(input) {
  const { expectedRevision, expectedGeneration, expectedItemVersion, createPaperIfAbsent, ...data } = object(input);
  return data;
}

function itemVersionOf(record) {
  if (record.itemVersion !== undefined) {
    if (typeof record.itemVersion !== "string" || !/^[a-f0-9]{64}$/.test(record.itemVersion)) {
      throw Object.assign(new Error("研究记录版本无效"), { code: "workspace_integrity_error" });
    }
    return record.itemVersion;
  }
  // Legacy records get a read-only deterministic token until their next write.
  const { evidence, validationStatus, ...stored } = record;
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(stored))).digest("hex");
}

function newItemVersion() { return createHash("sha256").update(randomUUID()).digest("hex"); }

function glossaryRecord(store, hash) {
  return store.glossaries[hash] || { paperHash: hash, version: 0, terms: {} };
}

function assertExpectedItemVersion(record, input = {}) {
  if (input.expectedItemVersion === undefined) return;
  const expected = input.expectedItemVersion;
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) {
    throw Object.assign(new Error("研究记录版本条件无效"), { code: "research_item_version_invalid", status: 400 });
  }
  if (!record || itemVersionOf(record) !== expected) {
    throw Object.assign(new Error("研究记录已被更新或删除，请保留本地修改后重新打开记录"), { code: "research_item_changed", status: 409 });
  }
}

function itemConflict() {
  return Object.assign(new Error("研究记录编号已存在或属于另一篇论文"), { code: "research_item_conflict", status: 409 });
}

function safeBlockId(value) {
  const id = text(value, 256);
  if (!id || id.includes("/") || id.includes("\\")) throw new Error("blockId is required");
  return id;
}

function translationCacheVariant(input = {}) {
  const agentId = text(input?.agentId, 128);
  const modelRef = text(input?.modelRef, 512);
  if (!agentId && !modelRef) return "";
  return `${encodeURIComponent(agentId || "unknown-agent")}:${encodeURIComponent(modelRef || "agent-default")}`;
}

function translationCacheKey(paperHash, blockId, glossaryVersion, options = {}) {
  const base = `${safePaperHash(paperHash)}:${safeBlockId(blockId)}:${Number(glossaryVersion) || 0}`;
  const promptVersion = encodeURIComponent(text(options?.promptVersion, 128) || DEFAULT_TRANSLATION_PROMPT_VERSION);
  const inputHash = encodeURIComponent(text(options?.inputHash, 128) || "legacy");
  const variant = translationCacheVariant(options);
  return `${base}:${promptVersion}:${inputHash}${variant ? `:${variant}` : ""}`;
}

function directorySize(directory) {
  let total = 0;
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile()) { try { total += fs.statSync(target).size; } catch {} }
    }
  }
  return total;
}

function canonicalizeAssetRef(assetRef) {
  if (!assetRef || typeof assetRef !== "object") return null;
  const normalized = { ...assetRef };
  if (normalized.cacheId) {
    normalized.cacheId = normalizeCacheId(normalized.cacheId);
  }
  return normalized;
}

function assetCacheIds(paper) {
  return [...new Set(array(paper?.blocks).map((block) => normalizeCacheId(block?.assetRef?.cacheId)).filter((id) => /^[a-f0-9]{24}$/.test(id)))];
}

function changedPaperHashes(previous, next) {
  const hashes = new Set();
  const mark = value => { if (isSafePaperHash(value)) hashes.add(normalizePaperHash(value)); };
  // Mutations operate on a JSON clone. Comparing values, rather than object
  // identity, covers record moves and deletions without rewriting other papers.
  for (const collection of ["papers", "revisionClocks", "notes", "bookmarks", "tasks", "progress", "glossaries", "translationCache"]) {
    const before = object(previous[collection]);
    const after = object(next[collection]);
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
      if (["papers", "revisionClocks", "progress", "glossaries"].includes(collection)) mark(key);
      mark(before[key]?.paperHash);
      mark(after[key]?.paperHash);
    }
  }
  return [...hashes];
}

function timestampPatch(record, fields = {}) {
  const createdAt = text(record.createdAt) || now();
  return { ...record, ...fields, createdAt, updatedAt: now() };
}

function rebuildDerivedIndexes(paper) {
  const rawBlocks = array(paper.blocks).map((block, index) => {
    const ref = canonicalizeAssetRef(block.assetRef);
    return {
      ...object(block),
      id: safeBlockId(block.id || `block-${index + 1}`),
      page: Number.isInteger(Number(block.page)) ? Number(block.page) : 0,
      type: text(block.type, 40) || "paragraph",
      text: text(block.text),
      translatedText: text(block.translatedText),
      latex: text(block.latex),
      level: Number.isInteger(Number(block.level)) ? Math.max(1, Math.min(6, Number(block.level))) : undefined,
      bbox: Array.isArray(block.bbox) ? block.bbox.slice(0, 4) : null,
      crop: Array.isArray(block.crop) ? block.crop.slice(0, 4) : null,
      tableHtml: text(block.tableHtml, 1000000),
      assetPath: text(block.assetPath, 500),
      assetRef: ref,
    };
  });
  const blockIds = new Set(rawBlocks.map((block) => block.id));
  const translations = {
    ...Object.fromEntries(rawBlocks.filter((block) => block.translatedText).map((block) => [block.id, block.translatedText])),
    ...Object.fromEntries(Object.entries(object(paper.translations)).map(([blockId, value]) => [text(blockId, 256), translationText(value)]).filter(([blockId, value]) => blockIds.has(blockId) && value)),
  };
  const normalizedBlocks = rawBlocks.map((block) => ({ ...block, translatedText: translations[block.id] || "" }));
  const blocks = annotateEvidenceBlocks(paper.paperHash, normalizedBlocks);
  const sourceStates = object(paper.translationStates);
  paper.translations = translations;
  paper.translationStates = Object.fromEntries(Object.keys(translations).map((blockId) => {
    const raw = sourceStates[blockId];
    const kind = raw?.kind === "final" ? "final" : "ai";
    return [blockId, { kind, locked: kind === "final" ? raw?.locked !== false : false, updatedAt: text(raw?.updatedAt) || now() }];
  }));
  paper.readingMode = ["original", "bilingual", "translation", "contrast"].includes(paper.readingMode) ? paper.readingMode : "bilingual";
  paper.blocks = blocks;
  paper.blockIndex = blocks.map(({ id, evidenceId, page, type, text: body, translatedText, bbox, sectionId, sectionTitle }) => ({ id, evidenceId, page, type, text: body, translatedText, bbox, sectionId, sectionTitle }));
  paper.outline = buildOutline(blocks);
  paper.resources = blocks.filter((block) => ["chart", "equation", "image", "table"].includes(block.type) || block.assetRef || block.crop || block.tableHtml).map((block) => ({
    id: block.id,
    evidenceId: block.evidenceId,
    type: block.type,
    page: block.page,
    title: block.text,
    latex: block.latex,
    assetRef: block.assetRef,
    bbox: block.bbox,
    sectionId: block.sectionId,
    sectionTitle: block.sectionTitle,
  }));
  return paper;
}

export function buildOutline(blocks) {
  return array(blocks).filter((block) => block?.type === "heading" || Number(block?.level) > 0)
    .map((block, index) => ({ id: block.id || `heading-${index + 1}`, title: text(block.text) || "Untitled", page: block.page || 0, level: clamp(block.level || 1, 1, 6) }));
}

function searchTypeGroup(block) {
  const kind = text(block?.type, 40).toLowerCase();
  if (["heading", "title", "section"].includes(kind) || Number(block?.level) > 0) return "title";
  if (["image", "chart", "figure", "caption"].includes(kind)) return "figure";
  if (kind === "table") return "table";
  if (kind === "equation" || text(block?.latex)) return "equation";
  return "body";
}

function occurrenceCount(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while ((cursor = haystack.indexOf(needle, cursor)) >= 0) { count += 1; cursor += needle.length; }
  return count;
}

function contextSnippet(value, needle, max = 240) {
  const source = text(value, 20000);
  if (!source) return "";
  const index = source.toLocaleLowerCase().indexOf(needle);
  if (index < 0 || source.length <= max) return source.slice(0, max);
  const start = Math.max(0, index - Math.floor(max * 0.38));
  const end = Math.min(source.length, start + max);
  return `${start > 0 ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`;
}

export function searchBlocks(blocks, query, options = {}) {
  const needle = text(query, 200).toLocaleLowerCase();
  if (!needle) return [];
  const language = SEARCH_LANGUAGES.has(options.language) ? options.language : "both";
  const scope = SEARCH_SCOPES.has(options.scope) ? options.scope : "all";
  const currentPage = Math.max(0, Number(options.page || options.currentPage) || 0);
  const currentSectionId = text(options.sectionId || options.currentSectionId, 256);
  const currentBlockId = text(options.currentBlockId, 256);
  const sourceTypes = Array.isArray(options.types) ? options.types : text(options.types || options.type, 200).split(",");
  const types = new Set(sourceTypes.map((value) => text(value, 40).toLowerCase()).filter(Boolean));
  const limit = clamp(options.limit || MAX_SNAPSHOT_ITEMS, 1, MAX_SNAPSHOT_ITEMS);
  const sourceBlocks = array(blocks);
  const currentIndex = sourceBlocks.findIndex((block) => block?.id === currentBlockId);

  return sourceBlocks.map((block, index) => {
    const original = text(block.text || block.caption || block.latex);
    const translated = text(block.translatedText);
    const originalLower = original.toLocaleLowerCase();
    const translatedLower = translated.toLocaleLowerCase();
    const originalCount = language === "translation" ? 0 : occurrenceCount(originalLower, needle);
    const translatedCount = language === "original" ? 0 : occurrenceCount(translatedLower, needle);
    const group = searchTypeGroup(block);
    const inScope = scope === "all"
      || (scope === "page" && currentPage > 0 && Number(block.page) === currentPage)
      || (scope === "section" && currentSectionId && block.sectionId === currentSectionId);
    const typeMatch = !types.size || types.has(group) || types.has(text(block.type, 40).toLowerCase());
    if (!inScope || !typeMatch || (!originalCount && !translatedCount)) return null;

    let score = Math.min(30, (originalCount + translatedCount) * 8);
    const reasons = [`命中 ${originalCount + translatedCount} 次`];
    if (group === "title") { score += 28; reasons.push("标题块 +28"); }
    else if (["figure", "table", "equation"].includes(group)) { score += 12; reasons.push("视觉证据 +12"); }
    if (originalLower.startsWith(needle) || translatedLower.startsWith(needle)) { score += 12; reasons.push("段首命中 +12"); }
    if (text(block.sectionTitle).toLocaleLowerCase().includes(needle)) { score += 10; reasons.push("章节标题命中 +10"); }
    if (currentPage > 0 && Number(block.page) === currentPage) { score += 8; reasons.push("当前页 +8"); }
    if (currentIndex >= 0) {
      const proximity = Math.max(0, 10 - Math.min(10, Math.abs(index - currentIndex)));
      if (proximity) { score += proximity; reasons.push(`邻近当前块 +${proximity}`); }
    }
    return {
      id: block.id,
      evidenceId: block.evidenceId || null,
      page: block.page,
      type: block.type,
      typeGroup: group,
      text: original,
      translatedText: translated,
      sectionId: block.sectionId || null,
      sectionTitle: block.sectionTitle || null,
      matches: { original: originalCount > 0, translated: translatedCount > 0, originalCount, translatedCount },
      snippets: {
        original: originalCount ? contextSnippet(original, needle) : "",
        translation: translatedCount ? contextSnippet(translated, needle) : "",
      },
      score,
      scoreExplanation: reasons,
      index,
      bbox: block.bbox || null,
    };
  }).filter(Boolean)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(({ index: _index, ...result }) => result);
}

function verifyNoSymlinksInPath(targetPath, boundaryPath) {
  let current = path.resolve(targetPath);
  const boundary = path.resolve(boundaryPath);
  while (true) {
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`symlink or junction detected: ${current}`);
      }
    }
    if (current === boundary) break;
    const parent = path.dirname(current);
    if (parent === current || current.length < boundary.length) break;
    current = parent;
  }
}

export function createPaperWorkspace(options = {}) {
  const requestedFilePath = options.filePath
    || (typeof options.dataDir === "string" && path.isAbsolute(options.dataDir)
      ? path.join(options.dataDir, DEFAULT_FILE_NAME)
      : "");
  if (!requestedFilePath || !path.isAbsolute(requestedFilePath)) {
    throw new Error("v2 paper workspace requires an absolute App data directory or file path");
  }
  const filePath = path.resolve(requestedFilePath);
  const dataDir = path.dirname(filePath);
  const storage = options.storage || createPaperStorage({ filePath, schemaVersion: SCHEMA_VERSION });
  let data = null;
  let dataStamp = null;
  let dataStorageToken = null;
  let writeInFlight = false;
  let writeChain = Promise.resolve();

  function diskStamp() {
    try {
      const stat = fs.statSync(filePath);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "missing";
    }
  }

  function readStorage() {
    try {
      let loaded = storage.load();
      if (!loaded.source) return { data: emptyData(), stamp: loaded.stamp ?? diskStamp(), token: loaded.token ?? null };
      const next = normalizeData(loaded.source);
      if (!loaded.split || loaded.previousVersion < SCHEMA_VERSION) {
        try {
          const backupPath = `${filePath}.schema-v${loaded.previousVersion}-${Date.now()}.backup`;
          fs.copyFileSync(filePath, backupPath);
          storage.writeSync(next, loaded.token ? { expectedIndexToken: loaded.token } : {});
          loaded = storage.load();
        } catch (error) { if (storageStateFailure(error)) throw error; }
      }
      return { data: next, stamp: loaded.stamp ?? diskStamp(), token: loaded.token ?? null };
    } catch (error) {
      if (error?.code === "ENOENT") return { data: emptyData(), stamp: diskStamp() };
      if (storageStateFailure(error)) throw error;
      const integrity = new Error("workspace storage is corrupt or incomplete");
      integrity.code = "workspace_integrity_error";
      integrity.cause = error;
      throw integrity;
    }
  }

  function refreshFromDisk() {
    const loaded = readStorage();
    data = loaded.data;
    dataStamp = loaded.stamp;
    dataStorageToken = loaded.token;
    return data;
  }

  function load() {
    const stamp = diskStamp();
    if (!data || (!writeInFlight && dataStamp !== stamp)) {
      const loaded = readStorage();
      data = loaded.data;
      dataStamp = loaded.stamp;
      dataStorageToken = loaded.token;
    }
    return data;
  }

  async function persist(nextData = data, writeOptions = {}) {
    if (!nextData) return;
    const snapshot = clone(nextData);
    writeInFlight = true;
    try {
      const committed = await storage.write(snapshot, { ...writeOptions,
        ...(dataStorageToken ? { expectedIndexToken: dataStorageToken } : {}) });
      data = nextData;
      dataStamp = committed?.stamp ?? diskStamp();
      dataStorageToken = committed?.indexToken ?? null;
    } finally {
      writeInFlight = false;
    }
  }

  function enqueueMutation(fn) {
    const previous = workspaceMutationLocks.get(filePath) || Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    workspaceMutationLocks.set(filePath, current);
    return current.finally(() => {
      if (workspaceMutationLocks.get(filePath) === current) workspaceMutationLocks.delete(filePath);
    });
  }

  async function mutate(fn, afterPersist = null) {
    const operation = enqueueMutation(async () => {
      const previous = refreshFromDisk();
      const fresh = clone(previous);
      const result = fn(fresh);
      const changed = changedPaperHashes(previous, fresh);
      fresh.updatedAt = now();
      try {
        if (changed.length) await persist(fresh, { paperHashes: changed });
      } catch (persistError) {
        data = null;
        dataStamp = null;
        dataStorageToken = null;
        throw persistError;
      }
      if (typeof afterPersist === "function") await afterPersist({ data: fresh, result });
      return clone(result);
    });
    writeChain = operation.catch(() => {});
    return operation;
  }

  function getPaper(paperHash) {
    if (!isSafePaperHash(paperHash)) return null;
    const paper = load().papers[safePaperHash(paperHash)];
    return paper ? clone(paper) : null;
  }

  function cleanupAssetCaches(candidateIds = [], options = {}) {
    const candidates = [...new Set(candidateIds.map(assertCacheId))];
    const guardedStorage = typeof storage.cleanupAssets === "function" ? storage : createPaperStorage({ filePath, schemaVersion: SCHEMA_VERSION });
    return guardedStorage.cleanupAssets(candidates, options);
  }

  function removeUnusedAssetCaches(candidateIds = []) { return cleanupAssetCaches(candidateIds); }

  function assetBytesForPaper(paper) {
    return assetCacheIds(paper).reduce((total, cacheId) => total + directorySize(path.join(dataDir, "mineru-cache", cacheId)), 0);
  }

  function committedSnapshot(project) {
    const capture = loaded => project(loaded.source ? normalizeData(loaded.source) : emptyData());
    // Production storage keeps one synchronous lease for all source shards and
    // asset reads. Custom storage substitutes can provide their own capture.
    return typeof storage.readSnapshot === "function" ? storage.readSnapshot(capture) : capture(storage.load());
  }

  function snapshotRecords(store, collection, hash) {
    const paper = store.papers[hash];
    return Object.values(store[collection]).filter(item => item.paperHash === hash)
      .map(item => clone(hydrateEvidenceRelation({ ...item, itemVersion: itemVersionOf(item) }, paper, collection === "notes" ? "note" : "bookmark")));
  }

  function snapshotGlossary(store, hash) {
    const record = glossaryRecord(store, hash);
    return clone({ ...record, itemVersion: itemVersionOf(record) });
  }

  const api = {
    filePath,
    load: () => clone(load()),
    async close() { await writeChain; },
    async upsertPaper(input = {}) {
      const hash = safePaperHash(input.paperHash);
      const expectedRevision = expectedPaperRevision(input);
      return mutate((store) => {
        const previous = store.papers[hash] || { paperHash: hash, createdAt: now() };
        assertExpectedPaperGeneration(store.papers[hash], input);
        const actualRevision = paperRevisionOf(previous);
        if (expectedRevision !== null && expectedRevision !== actualRevision) {
          const error = new Error("论文已在其他窗口更新，请重新载入后再保存");
          error.code = "paper_conflict";
          error.status = 409;
          error.expectedRevision = expectedRevision;
          error.actualRevision = actualRevision;
          throw error;
        }
        const { generation: _generation, ...paperInput } = researchInput(input);
        const paper = rebuildDerivedIndexes({ ...previous, ...paperInput, paperHash: hash });
        paper.metadata = normalizePaperMetadata({ ...object(previous.metadata), ...object(input.metadata) });
        paper.parser = { ...object(previous.parser), ...object(input.parser) };
        const revision = advancePaperRevision(store, hash);
        store.papers[hash] = timestampPatch(paper, { paperHash: hash, revision,
          generation: store.papers[hash] ? paperGenerationOf(previous) : revision });
        return store.papers[hash];
      });
    },
    getPaper,
    getRecentPaper: () => {
      const papers = Object.values(load().papers).filter((paper) => object(paper).paperHash);
      papers.sort((left, right) => {
        const leftTime = text(left.lastReadAt || left.updatedAt || left.createdAt);
        const rightTime = text(right.lastReadAt || right.updatedAt || right.createdAt);
        const readCompare = rightTime.localeCompare(leftTime);
        if (readCompare) return readCompare;
        const updated = text(right.updatedAt).localeCompare(text(left.updatedAt));
        if (updated) return updated;
        return text(right.createdAt).localeCompare(text(left.createdAt));
      });
      return clone(papers[0] || null);
    },
    listLibrary(options = {}) {
      const store = load();
      const rawPapers = Object.values(store.papers).filter((paper) => object(paper).paperHash);
      const query = String(options.query || options.q || "").trim().toLowerCase();
      const sortField = String(options.sort || "lastRead").trim();
      const sortOrder = String(options.order || "desc").toLowerCase();
      const filterFavorite = options.favorite === true || options.favorite === "true";
      const filterArchived = options.archived === "all" ? "all" : (options.archived === true || options.archived === "true");
      const filterTag = String(options.tag || "").trim().toLowerCase();

      const items = rawPapers.map((paper) => {
        const hash = paper.paperHash;
        const metadata = normalizePaperMetadata(paper.metadata);
        const progress = store.progress[hash] || null;
        const notes = Object.values(store.notes).filter((item) => item.paperHash === hash);
        const bookmarks = Object.values(store.bookmarks).filter((item) => item.paperHash === hash);
        const tags = metadata.tags;
        const favorite = metadata.favorite === true || paper.favorite === true;
        const archived = metadata.archived === true || paper.archived === true;
        const lastReadAt = paper.lastReadAt || metadata.lastReadAt || progress?.updatedAt || paper.updatedAt || paper.createdAt || null;
        const title = metadata.title || "未命名论文";
        const authors = metadata.authors;
        const year = metadata.year || null;
        const doi = metadata.doi || null;
        const blockCount = Number.isInteger(paper.blockCount)
          ? paper.blockCount
          : (Array.isArray(paper.blocks) ? paper.blocks.length : (Array.isArray(paper.blockIndex) ? paper.blockIndex.length : 0));
        const progressPercent = typeof progress?.percent === "number"
          ? progress.percent
          : (typeof progress?.scrollRatio === "number" ? Math.round(progress.scrollRatio * 100) : (progress?.blockId ? 50 : 0));

        return {
          paperHash: hash,
          revision: paperRevisionOf(paper),
          title,
          authors,
          year,
          doi,
          favorite,
          archived,
          tags,
          lastReadAt,
          createdAt: paper.createdAt || null,
          updatedAt: paper.updatedAt || null,
          blockCount,
          readingProgress: {
            percent: progressPercent,
            blockId: progress?.blockId || null,
            updatedAt: progress?.updatedAt || null,
          },
          noteCount: notes.length,
          bookmarkCount: bookmarks.length,
          hasGlossary: Boolean(store.glossaries[hash]?.terms && Object.keys(store.glossaries[hash].terms).length > 0),
        };
      });

      let filtered = items.filter((item) => {
        if (filterArchived !== "all") {
          if (filterArchived === true && !item.archived) return false;
          if (filterArchived === false && item.archived) return false;
        }
        if (filterFavorite && !item.favorite) return false;
        if (filterTag && !item.tags.some((t) => String(t).toLowerCase().includes(filterTag))) return false;
        if (query) {
          const matchTitle = String(item.title || "").toLowerCase().includes(query);
          const matchAuthors = Array.isArray(item.authors) && item.authors.some((a) => String(a).toLowerCase().includes(query));
          const matchDoi = String(item.doi || "").toLowerCase().includes(query);
          const matchHash = String(item.paperHash || "").toLowerCase().includes(query);
          const matchTags = Array.isArray(item.tags) && item.tags.some((t) => String(t).toLowerCase().includes(query));
          if (!matchTitle && !matchAuthors && !matchDoi && !matchHash && !matchTags) return false;
        }
        return true;
      });

      filtered.sort((a, b) => {
        let cmp = 0;
        if (sortField === "title") {
          cmp = String(a.title || "").localeCompare(String(b.title || ""), "zh-CN");
        } else if (sortField === "created") {
          cmp = String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
        } else if (sortField === "updated") {
          cmp = String(a.updatedAt || "").localeCompare(String(b.updatedAt || ""));
        } else {
          cmp = String(a.lastReadAt || a.updatedAt || a.createdAt || "").localeCompare(String(b.lastReadAt || b.updatedAt || b.createdAt || ""));
        }
        return sortOrder === "asc" ? cmp : -cmp;
      });

      return filtered;
    },
    async updatePaperMetadata(paperHash, patch = {}) {
      const hash = safePaperHash(paperHash);
      const expectedRevision = expectedPaperRevision(patch);
      const changesPaperRevision = ["favorite", "archived", "tags", "authors", "title"]
        .some((key) => patch[key] !== undefined);
      return mutate((store) => {
        const paper = store.papers[hash];
        if (!paper) throw new Error("论文不存在");
        const actualRevision = paperRevisionOf(paper);
        if (expectedRevision !== null && expectedRevision !== actualRevision) {
          const error = new Error("论文已在其他窗口更新，请重新载入后再保存");
          error.code = "paper_conflict";
          error.status = 409;
          throw error;
        }
        const metadata = { ...normalizePaperMetadata(paper.metadata) };
        if (patch.favorite !== undefined) metadata.favorite = Boolean(patch.favorite);
        if (patch.archived !== undefined) metadata.archived = Boolean(patch.archived);
        if (patch.tags !== undefined) metadata.tags = normalizeTags(patch.tags);
        if (patch.authors !== undefined) metadata.authors = normalizeAuthors(patch.authors);
        if (patch.title !== undefined) {
          const cleanTitle = normalizeDisplayText(patch.title, 500, "");
          if (cleanTitle) {
            metadata.title = cleanTitle;
            paper.title = cleanTitle;
          }
        }
        if (patch.lastReadAt !== undefined) {
          paper.lastReadAt = String(patch.lastReadAt || now());
          metadata.lastReadAt = paper.lastReadAt;
        }
        paper.metadata = normalizePaperMetadata(metadata);
        if (changesPaperRevision) paper.revision = advancePaperRevision(store, hash);
        paper.updatedAt = now();
        store.papers[hash] = paper;
        return clone(paper);
      });
    },
    async removePaper(paperHash, options = {}) {
      const hash = safePaperHash(paperHash);
      const expectedRevision = expectedPaperRevision(options);
      const operation = enqueueMutation(async () => {
        const fresh = clone(refreshFromDisk());
        const paper = fresh.papers[hash];
        if (!paper) return { deleted: false, paperDirectory: "not-present", removedCacheIds: [], preservedCacheIds: [], deferredCacheIds: [] };
        const actualRevision = paperRevisionOf(paper);
        if (expectedRevision !== null && expectedRevision !== actualRevision) {
          const error = new Error("论文已在其他窗口更新，请重新载入后再删除");
          error.code = "paper_conflict";
          error.status = 409;
          throw error;
        }
        const cacheIds = assetCacheIds(paper);
        delete fresh.papers[hash];
        delete fresh.progress[hash];
        delete fresh.glossaries[hash];
        for (const collection of ["notes", "bookmarks", "translationCache", "tasks"]) {
          for (const [key, value] of Object.entries(fresh[collection])) {
            if (value.paperHash === hash) delete fresh[collection][key];
          }
        }
        fresh.updatedAt = now();
        try {
          await persist(fresh, { paperHashes: [hash] });
        } catch (persistError) {
          data = null;
          dataStamp = null;
          dataStorageToken = null;
          throw persistError;
        }
        let paperDirectory = "removed";
        try { if (storage.removePaper(hash) === false) paperDirectory = "preserved"; }
        catch { paperDirectory = "deferred"; }
        const cleanup = removeUnusedAssetCaches(cacheIds);
        return { deleted: true, paperDirectory, ...cleanup,
          cleanupDeferred: paperDirectory === "deferred" || cleanup.cleanupDeferred === true };
      });
      writeChain = operation.catch(() => {});
      const receipt = await operation;
      return options.returnReceipt === true ? receipt : Boolean(receipt.deleted);
    },
    async createTask(input = {}) {
      const hash = safePaperHash(input.paperHash);
      const id = safeId(input.id || randomUUID());
      return mutate((store) => {
        if (!store.papers[hash] && input.createPaperIfAbsent === true) {
          assertExpectedPaperGeneration(null, input);
          assertExpectedPaperRevision(null, expectedPaperRevision(input));
          const revision = advancePaperRevision(store, hash);
          store.papers[hash] = timestampPatch(rebuildDerivedIndexes({ paperHash: hash,
            metadata: { title: text(input.fileName, 500) || "待解析 PDF" }, parser: { kind: "mineru", state: "queued" }, blocks: [] }),
          { revision, generation: revision, createdAt: now() });
        } else researchPaper(store, hash, input);
        if (store.tasks[id]) throw itemConflict();
        const paper = store.papers[hash];
        const timestamp = now();
        const inputState = input.state === undefined ? "queued" : text(input.state, 20);
        const task = { ...researchInput(input), id, paperHash: hash, paperGeneration: paperGenerationOf(paper), state: inputState, stage: text(input.stage, 80) || "queued", progress: clamp(input.progress, 0, 100), error: input.error == null ? null : text(input.error, 2000), createdAt: text(input.createdAt) || timestamp, updatedAt: timestamp, startedAt: text(input.startedAt) || null, finishedAt: text(input.finishedAt) || null };
        if (!TASK_STATES.has(task.state)) throw new Error("invalid task state");
        store.tasks[id] = task;
        return task;
      });
    },
    async updateTask(id, patch = {}) {
      const taskId = safeId(id);
      return mutate((store) => {
        const task = store.tasks[taskId];
        if (!task) throw new Error("task not found");
        const paper = researchPaper(store, task.paperHash, patch);
        assertExpectedPaperGeneration(paper, task.paperGeneration === undefined ? {} : { expectedGeneration: task.paperGeneration });
        if (patch.id !== undefined && patch.id !== task.id
            || patch.paperHash !== undefined && normalizePaperHash(patch.paperHash) !== task.paperHash) {
          throw new Error("任务标识和所属论文不能通过状态更新修改");
        }
        const nextState = patch.state === undefined ? task.state : text(patch.state, 20);
        if (!TASK_STATES.has(nextState) || !ALLOWED_TASK_TRANSITIONS[task.state].has(nextState)) throw new Error("invalid task state transition");
        const timestamp = now();
        const next = { ...task, ...researchInput(patch), id: task.id, paperHash: task.paperHash, paperGeneration: paperGenerationOf(paper), state: nextState, stage: text(patch.stage ?? task.stage, 80), progress: clamp(patch.progress ?? task.progress, 0, 100), error: patch.error == null ? task.error : text(patch.error, 2000), updatedAt: timestamp };
        if (nextState === "running" && !next.startedAt) next.startedAt = timestamp;
        if (TERMINAL_TASK_STATES.has(nextState)) { next.finishedAt = next.finishedAt || timestamp; if (nextState === "succeeded") next.progress = 100; }
        store.tasks[taskId] = next;
        return next;
      });
    },
    getTask: (id) => {
      const key = safeId(id);
      return clone(Object.prototype.hasOwnProperty.call(load().tasks, key) ? load().tasks[key] : null);
    },
    listTasks: (paperHash, limit = MAX_SNAPSHOT_ITEMS) => {
      const hash = safePaperHash(paperHash);
      return Object.values(load().tasks).filter((task) => task.paperHash === hash).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, clamp(limit, 1, MAX_SNAPSHOT_ITEMS)).map(clone);
    },
    search: (paperHash, query, options) => {
      const paper = getPaper(paperHash);
      return searchBlocks(paper?.blocks, query, options).map((hit) => ({
        ...hit,
        evidence: resolvePaperEvidence(paper, { evidenceId: hit.evidenceId, blockId: hit.id }, { usageKind: "search-result" }),
      }));
    },
    outline: (paperHash) => clone(getPaper(paperHash)?.outline || []),
    getEvidence: (paperHash, reference, options = {}) => clone(resolvePaperEvidence(getPaper(paperHash), reference, options)),
    listEvidence: (paperHash, options = {}) => clone(listPaperEvidence(getPaper(paperHash), options)),
    evidenceFromBlock: (paperHash, blockId, options = {}) => {
      const paper = getPaper(paperHash);
      const block = paper?.blocks?.find((item) => item.id === blockId);
      return clone(block ? evidenceFromBlock(paper, block, options) : null);
    },
    async putNote(input = {}) {
      return putAnchored("notes", input, (value, evidence) => {
        const noteType = NOTE_TYPES.has(value.noteType) ? value.noteType : "finding";
        return {
          note: text(value.note),
          noteType,
          resolved: noteType === "question" && value.resolved === true,
          tags: array(value.tags).map((tag) => text(tag, 80)).filter(Boolean).slice(0, 30),
          quote: text(value.quote) || evidence.originalQuote,
          translation: text(value.translation) || evidence.translation,
        };
      });
    },
    async putBookmark(input = {}) { return putAnchored("bookmarks", input, (value) => ({ label: text(value.label, 200), page: Number(value.page) || 0, bbox: value.bbox || null })); },
    async setProgress(input = {}) {
      const hash = safePaperHash(input.paperHash);
      return mutate((store) => {
        researchPaper(store, hash, input);
        store.progress[hash] = timestampPatch(store.progress[hash] || { paperHash: hash, createdAt: now() }, {
          ...researchInput(input),
          paperHash: hash,
          percent: clamp(input.percent, 0, 100),
          page: Math.max(0, Number(input.page) || 0),
          originalScrollTop: Math.max(0, Number(input.originalScrollTop) || 0),
          translationScrollTop: Math.max(0, Number(input.translationScrollTop) || 0),
          contrastScrollTop: Math.max(0, Number(input.contrastScrollTop) || 0),
          readingMode: ["original", "bilingual", "translation", "contrast"].includes(input.readingMode) ? input.readingMode : (store.progress[hash]?.readingMode || "bilingual"),
          noteDraft: object(input.noteDraft),
          glossaryDraft: object(input.glossaryDraft),
          evidenceDraft: object(input.evidenceDraft),
          searchState: object(input.searchState),
        });
        return store.progress[hash];
      });
    },
    getProgress: (paperHash) => clone(load().progress[safePaperHash(paperHash)] || null),
    getItem: (collection, id) => {
      if (!["notes", "bookmarks"].includes(collection)) throw new Error("unsupported collection");
      const key = safeId(id);
      const coll = load()[collection];
      if (!Object.prototype.hasOwnProperty.call(coll, key)) return null;
      const item = coll[key];
      if (!item) return null;
      return clone(hydrateEvidenceRelation({ ...item, itemVersion: itemVersionOf(item) }, load().papers[item.paperHash], collection === "notes" ? "note" : "bookmark"));
    },
    listItems: (collection, paperHash, limit = MAX_SNAPSHOT_ITEMS, filters = {}) => {
      if (!["notes", "bookmarks"].includes(collection)) throw new Error("unsupported collection");
      const hash = safePaperHash(paperHash);
      const paper = load().papers[hash];
      const noteType = text(filters.noteType, 40);
      const sectionId = text(filters.sectionId, 256);
      const tag = text(filters.tag, 80).toLocaleLowerCase();
      const unresolvedOnly = filters.unresolvedOnly === true;
      return Object.values(load()[collection]).filter((item) => item.paperHash === hash)
        .filter((item) => collection !== "notes" || !noteType || item.noteType === noteType)
        .filter((item) => !sectionId || item.evidenceSnapshot?.sectionId === sectionId || item.evidence?.sectionId === sectionId)
        .filter((item) => !tag || array(item.tags).some((value) => text(value, 80).toLocaleLowerCase() === tag))
        .filter((item) => !unresolvedOnly || item.noteType === "question" && item.resolved !== true)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, clamp(limit, 1, MAX_SNAPSHOT_ITEMS))
        .map((item) => clone(hydrateEvidenceRelation({ ...item, itemVersion: itemVersionOf(item) }, paper, collection === "notes" ? "note" : "bookmark")));
    },
    async deleteItem(collection, id, options = {}) {
      if (!["notes", "bookmarks"].includes(collection)) throw new Error("unsupported collection");
      const key = safeId(id);
      return mutate((store) => {
        const found = Object.prototype.hasOwnProperty.call(store[collection], key);
        assertExpectedItemVersion(found ? store[collection][key] : null, options);
        if (found) {
          const hash = store[collection][key].paperHash;
          if (options.paperHash !== undefined && normalizePaperHash(options.paperHash) !== hash) throw itemConflict();
          researchPaper(store, hash, options);
          delete store[collection][key];
          return true;
        }
        return false;
      });
    },
    async putGlossary(input = {}) {
      const hash = safePaperHash(input.paperHash);
      return mutate((store) => {
        researchPaper(store, hash, input);
        const previous = glossaryRecord(store, hash);
        assertExpectedItemVersion(previous, input);
        if (previous.version === Number.MAX_SAFE_INTEGER) throw Object.assign(new Error("术语表版本已达到上限"), { code: "workspace_integrity_error" });
        const terms = {
          ...previous.terms,
          ...Object.fromEntries(Object.entries(object(input.terms)).map(([key, value]) => [text(key, 200), text(value, 500)]).filter(([key, value]) => key && value)),
        };
        store.glossaries[hash] = timestampPatch(previous, { paperHash: hash, terms, version: previous.version + 1, itemVersion: newItemVersion() });
        return store.glossaries[hash];
      });
    },
    getGlossary(paperHash) {
      const record = glossaryRecord(load(), safePaperHash(paperHash));
      return clone({ ...record, itemVersion: itemVersionOf(record) });
    },
    async deleteGlossaryTerm(paperHash, term, options = {}) {
      const hash = safePaperHash(paperHash);
      return mutate((store) => {
        researchPaper(store, hash, options);
        assertExpectedItemVersion(glossaryRecord(store, hash), options);
        const glossary = store.glossaries[hash];
        if (!glossary || !Object.prototype.hasOwnProperty.call(glossary.terms, text(term, 200))) {
          return options.includeReceipt === true ? { deleted: false, glossary: { ...glossaryRecord(store, hash), itemVersion: itemVersionOf(glossaryRecord(store, hash)) } } : false;
        }
        if (glossary.version === Number.MAX_SAFE_INTEGER) throw Object.assign(new Error("术语表版本已达到上限"), { code: "workspace_integrity_error" });
        delete glossary.terms[text(term, 200)];
        glossary.version += 1;
        glossary.itemVersion = newItemVersion();
        glossary.updatedAt = now();
        return options.includeReceipt === true ? { deleted: true, glossary } : true;
      });
    },
    async putTranslation(input = {}) {
      const hash = safePaperHash(input.paperHash);
      const blockId = safeBlockId(input.blockId);
      const glossaryVersion = Number.isInteger(input.glossaryVersion) ? input.glossaryVersion : 0;
      const key = translationCacheKey(hash, blockId, glossaryVersion, input);
      return mutate((store) => {
        const paper = researchPaper(store, hash, input);
        if (!array(paper.blocks).some((block) => block.id === blockId)) throw new Error("block not found");
        store.translationCache[key] = timestampPatch(researchInput(input), {
          key,
          paperHash: hash,
          blockId,
          glossaryVersion,
          promptVersion: text(input.promptVersion, 128) || DEFAULT_TRANSLATION_PROMPT_VERSION,
          inputHash: text(input.inputHash, 128) || null,
          agentId: text(input.agentId, 128) || null,
          modelRef: text(input.modelRef, 512) || null,
          source: text(input.source),
          translation: text(input.translation),
          createdAt: store.translationCache[key]?.createdAt || now(),
        });
        return store.translationCache[key];
      });
    },
    getTranslation: (paperHash, blockId, glossaryVersion, options = {}) => clone(load().translationCache[translationCacheKey(paperHash, blockId, glossaryVersion, options)] || null),
    storageStats(paperHash) {
      const hash = safePaperHash(paperHash);
      return committedSnapshot(store => {
        const paper = store.papers[hash];
        if (!paper) return null;
        const split = storage.stats(hash);
        const assetsBytes = assetBytesForPaper(paper);
        const structureBytes = split.structureBytes;
        const translationBytes = split.translationBytes;
        const researchBytes = split.researchBytes;
        return {
          ...split,
          assetsBytes,
          totalBytes: structureBytes + assetsBytes + translationBytes + researchBytes,
          assetCacheIds: assetCacheIds(paper),
          counts: {
            blocks: array(paper.blocks).length,
            visualBlocks: array(paper.blocks).filter((block) => ["image", "chart", "table", "equation"].includes(block?.type)).length,
            translations: Object.keys(object(paper.translations)).length,
            finalTranslations: Object.values(object(paper.translationStates)).filter((state) => state?.kind === "final").length,
            notes: Object.values(store.notes).filter((item) => item.paperHash === hash).length,
            bookmarks: Object.values(store.bookmarks).filter((item) => item.paperHash === hash).length,
          },
        };
      });
    },
    async clearPaperData(paperHash, action, options = {}) {
      const hash = safePaperHash(paperHash);
      const expectedRevision = expectedPaperRevision(options);
      if (action === "assets") {
        return mutate((store) => {
          const paper = store.papers[hash];
          if (!paper) throw new Error("paper not found");
          assertExpectedPaperRevision(paper, expectedRevision, "清理");
          const cacheIds = assetCacheIds(paper);
          paper.revision = advancePaperRevision(store, hash);
          paper.updatedAt = now();
          return { action, removedCacheIds: [], candidateCacheIds: cacheIds, paper: clone(paper) };
        }, ({ result }) => {
          Object.assign(result, cleanupAssetCaches(result.candidateCacheIds, {
            excludePaperHash: hash, expectedOwnerRevision: result.paper.revision, expectedIndexToken: dataStorageToken,
          }));
          delete result.candidateCacheIds;
        });
      }
      if (action === "ai-translations") {
        return mutate((store) => {
          const current = store.papers[hash];
          if (!current) throw new Error("paper not found");
          assertExpectedPaperRevision(current, expectedRevision, "清理");
          const preserved = Object.fromEntries(Object.entries(object(current.translations)).filter(([blockId]) => current.translationStates?.[blockId]?.kind === "final"));
          const states = Object.fromEntries(Object.keys(preserved).map((blockId) => [blockId, current.translationStates[blockId]]));
          current.translations = preserved;
          current.translationStates = states;
          current.blocks = array(current.blocks).map((block) => ({ ...block, translatedText: preserved[block.id] || "" }));
          current.revision = advancePaperRevision(store, hash);
          current.updatedAt = now();
          for (const [key, value] of Object.entries(store.translationCache)) if (value.paperHash === hash) delete store.translationCache[key];
          store.papers[hash] = rebuildDerivedIndexes(current);
          return { action, preservedFinals: Object.keys(preserved).length, paper: store.papers[hash] };
        });
      }
      if (action === "structure-keep-notes") {
        return mutate((store) => {
          const previous = store.papers[hash];
          if (!previous) throw new Error("paper not found");
          assertExpectedPaperRevision(previous, expectedRevision, "清理");
          const cacheIds = assetCacheIds(previous);
          const revision = advancePaperRevision(store, hash);
          store.papers[hash] = timestampPatch({
            paperHash: hash,
            revision, generation: revision,
            metadata: previous.metadata,
            parser: { ...object(previous.parser), structureDetached: true, pageCount: Number(previous.parser?.pageCount || 0) },
            blocks: [],
            translations: {},
            translationStates: {},
            translationGlossaryVersion: Number(previous.translationGlossaryVersion || 0),
            readingMode: previous.readingMode || "bilingual",
            structureDetached: true,
            createdAt: previous.createdAt,
          }, { paperHash: hash });
          delete store.progress[hash];
          for (const collection of ["bookmarks", "translationCache", "tasks"]) {
            for (const [key, value] of Object.entries(store[collection])) if (value.paperHash === hash) delete store[collection][key];
          }
          return {
            action,
            notesKept: Object.values(store.notes).filter((item) => item.paperHash === hash).length,
            paper: store.papers[hash],
            removedCacheIds: cacheIds,
          };
        }, ({ result }) => Object.assign(result, removeUnusedAssetCaches(result.removedCacheIds || [])));
      }
      throw new Error("unsupported clear action");
    },
    exportBackup(paperHash, options = {}) {
      const hash = safePaperHash(paperHash);
      return committedSnapshot(store => {
        const paper = clone(store.papers[hash]);
        if (!paper) throw Object.assign(new Error("paper not found"), { code: "paper_not_found" });
        const backup = {
          format: "hana-paper-reader-backup",
          version: 1,
          exportedAt: now(),
          paperHash: hash,
          paper,
          notes: snapshotRecords(store, "notes", hash),
          bookmarks: snapshotRecords(store, "bookmarks", hash),
          progress: clone(store.progress[hash] || null),
          glossary: snapshotGlossary(store, hash),
          translationCache: Object.values(store.translationCache).filter((item) => item.paperHash === hash).map(clone),
          tasks: Object.values(store.tasks).filter((item) => item.paperHash === hash).map(clone),
          assets: [],
        };
        Object.assign(backup, captureBackupAssets({ dataDir, paper, includeAssets: options.includeAssets !== false }));
        if (backup.assetMode === "included") {
          for (const block of [...paper.blocks, ...paper.resources]) {
            if (block.assetRef) block.assetRef.path = safeBackupAssetPath(block.assetRef.path);
          }
        }
        return backup;
      });
    },
    async restoreBackup(input = {}, restoreOptions = {}) {
      if (input?.format !== "hana-paper-reader-backup" || Number(input?.version) !== 1) {
        const err = new Error("backup format is invalid");
        err.code = "backup_invalid";
        throw err;
      }
      const rawHash = input.paperHash || input.paper?.paperHash;
      if (!isSafePaperHash(rawHash)) {
        const err = new Error("backup paper hash is invalid");
        err.code = "backup_invalid";
        throw err;
      }
      const hash = normalizePaperHash(rawHash);
      const expectedRevision = input.expectedRevision !== undefined
        ? expectedPaperRevision(input)
        : input.paper?.revision !== undefined
          ? expectedPaperRevision({ expectedRevision: input.paper.revision })
          : null;
      if (input.paper?.paperHash && normalizePaperHash(input.paper.paperHash) !== hash) {
        const err = new Error("backup paper hash mismatch");
        err.code = "backup_invalid";
        throw err;
      }

      // Stage 1: Full validation and preflight of all IDs, assets and structures
      if (input.glossary && normalizePaperHash(input.glossary.paperHash) === hash) {
        if (!Number.isSafeInteger(input.glossary.version) || input.glossary.version < 0) {
          throw Object.assign(new Error("backup glossary version is invalid"), { code: "backup_invalid" });
        }
        if (input.glossary.itemVersion !== undefined) {
          try { itemVersionOf(input.glossary); } catch { throw Object.assign(new Error("backup glossary condition is invalid"), { code: "backup_invalid" }); }
        }
      }
      const validatedNotes = [];
      for (const note of array(input.notes)) {
        if (note?.id && normalizePaperHash(note.paperHash) === hash) {
          safeId(note.id);
          if (note.itemVersion !== undefined) {
            try { itemVersionOf(note); } catch { throw Object.assign(new Error("backup note version is invalid"), { code: "backup_invalid" }); }
          }
          validatedNotes.push(object(note));
        }
      }
      const validatedBookmarks = [];
      for (const bm of array(input.bookmarks)) {
        if (bm?.id && normalizePaperHash(bm.paperHash) === hash) {
          safeId(bm.id);
          if (bm.itemVersion !== undefined) {
            try { itemVersionOf(bm); } catch { throw Object.assign(new Error("backup bookmark version is invalid"), { code: "backup_invalid" }); }
          }
          validatedBookmarks.push(object(bm));
        }
      }
      const validatedTasks = [];
      for (const t of array(input.tasks)) {
        if (t?.id && normalizePaperHash(t.paperHash) === hash) {
          safeId(t.id);
          validatedTasks.push(object(t));
        }
      }

      const validatedTranslations = [];
      const translationKeys = new Set();
      for (const item of array(input.translationCache)) {
        if (normalizePaperHash(item?.paperHash) !== hash) continue;
        let key;
        try { key = assertTranslationCacheKey(item.key, hash); }
        catch { throw Object.assign(new Error("backup translation cache key is invalid"), { code: "backup_invalid" }); }
        if (translationKeys.has(key)) throw Object.assign(new Error("duplicate translation cache key in backup"), { code: "backup_invalid" });
        translationKeys.add(key);
        validatedTranslations.push({ ...object(item), key, paperHash: hash });
      }

      validateBackupAssetMode(input);
      const seenAssets = new Map();
      let totalAssetBytes = 0;
      if (array(input.assets).length > 2000) {
        const err = new Error("backup has too many assets");
        err.code = "backup_invalid";
        throw err;
      }
      const cacheBaseDir = path.resolve(dataDir, "mineru-cache");
      for (const asset of array(input.assets)) {
        const cacheId = assertCacheId(asset?.cacheId);
        const relative = safeBackupAssetPath(asset?.path);
        const bytes = decodeBackupAsset(asset, { requireIntegrity: input.assetMode === "included" });
        const assetKey = backupAssetKey(cacheId, relative);
        if (seenAssets.has(assetKey)) {
          if (seenAssets.get(assetKey).relative !== relative || !seenAssets.get(assetKey).bytes.equals(bytes)) {
            const err = new Error("conflicting duplicate asset in backup");
            err.code = "backup_invalid";
            throw err;
          }
          continue;
        }
        totalAssetBytes += bytes.length;
        if (totalAssetBytes > 256 * 1024 * 1024) {
          const err = new Error("backup assets exceed 256 MB");
          err.code = "backup_invalid";
          throw err;
        }

        // Strict symlink and junction verification for destination path
        const targetRoot = path.resolve(cacheBaseDir, cacheId);
        const finalDest = path.resolve(targetRoot, ...relative.split("/"));
        const rel = path.relative(targetRoot, finalDest);
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes("..")) {
          const err = new Error("backup asset path escaped cache root");
          err.code = "backup_invalid";
          throw err;
        }
        verifyNoSymlinksInPath(path.dirname(finalDest), dataDir);
        if (fs.existsSync(finalDest)) {
          const stat = fs.lstatSync(finalDest);
          if (stat.isSymbolicLink()) {
            const err = new Error("backup asset target is a symlink or junction");
            err.code = "backup_invalid";
            throw err;
          }
          const existingBytes = fs.readFileSync(finalDest);
          if (!existingBytes.equals(bytes)) {
            const err = new Error(`cannot overwrite conflicting cache asset: ${cacheId}/${relative}`);
            err.code = "backup_invalid";
            throw err;
          }
        }
        seenAssets.set(assetKey, { cacheId, relative, bytes, finalDest });
      }
      const validatedAssets = [...seenAssets.values()];

      const candidatePaper = rebuildDerivedIndexes({ ...object(input.paper), paperHash: hash });
      candidatePaper.metadata = normalizePaperMetadata(candidatePaper.metadata);
      validateBackupAssetCoverage(input, candidatePaper, seenAssets);

      // Stage 2, 3 & 4: Transactional staging, atomic promotion and rollback
      const operation = enqueueMutation(async () => {
        const txRoot = path.join(dataDir, ".transactions");
        verifyNoSymlinks(txRoot, dataDir);
        const txId = `restore-${randomUUID()}`;
        const txDir = path.join(txRoot, txId);
        const stagingRoot = path.join(txDir, "mineru-cache");

        const previousData = clone(refreshFromDisk());
        const previousPaper = previousData.papers[hash];
        if (restoreOptions.requireAbsent === true && previousPaper) {
          const error = new Error("迁移保留已有论文，不允许覆盖");
          error.code = "paper_conflict";
          error.status = 409;
          throw error;
        }
        const actualRevision = paperRevisionOf(previousPaper);
        if (expectedRevision !== null && expectedRevision !== actualRevision) {
          const error = new Error("论文已在其他窗口更新，请重新载入后再恢复");
          error.code = "paper_conflict";
          error.status = 409;
          throw error;
        }
        const previousCacheIds = assetCacheIds(previousPaper);
        const nextData = clone(previousData);

        candidatePaper.revision = advancePaperRevision(nextData, hash);
        candidatePaper.generation = candidatePaper.revision;
        candidatePaper.updatedAt = now();
        nextData.papers[hash] = candidatePaper;
        for (const collection of ["notes", "bookmarks", "translationCache", "tasks"]) {
          for (const [key, value] of Object.entries(nextData[collection])) if (value.paperHash === hash) delete nextData[collection][key];
        }
        for (const note of validatedNotes) {
          const key = safeId(note.id);
          if (nextData.notes[key] && nextData.notes[key].paperHash !== hash) throw Object.assign(new Error("笔记 ID 冲突"), { code: "backup_invalid" });
          nextData.notes[key] = { ...researchInput(note), paperHash: hash, itemVersion: newItemVersion() };
        }
        for (const bookmark of validatedBookmarks) {
          const key = safeId(bookmark.id);
          if (nextData.bookmarks[key] && nextData.bookmarks[key].paperHash !== hash) throw Object.assign(new Error("书签 ID 冲突"), { code: "backup_invalid" });
          nextData.bookmarks[key] = { ...researchInput(bookmark), paperHash: hash, itemVersion: newItemVersion() };
        }
        if (input.progress && normalizePaperHash(input.progress.paperHash) === hash) {
          nextData.progress[hash] = clone({ ...object(input.progress), paperHash: hash });
          const draft = object(nextData.progress[hash].noteDraft);
          const archivedNote = validatedNotes.find(note => note.id === draft.id);
          if (archivedNote && draft.paperHash === hash && draft.itemVersion === itemVersionOf(archivedNote)) {
            draft.itemVersion = nextData.notes[draft.id].itemVersion;
          }
        }
        else delete nextData.progress[hash];
        if (input.glossary && normalizePaperHash(input.glossary.paperHash) === hash) {
          nextData.glossaries[hash] = { ...researchInput(input.glossary), paperHash: hash, itemVersion: newItemVersion() };
          const draft = object(nextData.progress[hash]?.glossaryDraft);
          if (draft.paperHash === hash && draft.itemVersion === itemVersionOf(input.glossary)) {
            draft.itemVersion = nextData.glossaries[hash].itemVersion;
          }
        }
        else delete nextData.glossaries[hash];
        for (const item of validatedTranslations) nextData.translationCache[item.key] = item;
        for (const task of validatedTasks) {
          const key = safeId(task.id);
          if (nextData.tasks[key] && nextData.tasks[key].paperHash !== hash) throw Object.assign(new Error("任务 ID 冲突"), { code: "backup_invalid" });
          nextData.tasks[key] = { ...object(task), paperHash: hash, paperGeneration: candidatePaper.generation };
        }
        nextData.updatedAt = now();

        const promotedFiles = [];
        const journalAssets = storage.ownsAssetTransactions === true;
        try {
          // Rejected revisions and ID collisions must not leave empty restore
          // transactions behind. Create staging only after all store preflight.
          if (!journalAssets) fs.mkdirSync(stagingRoot, { recursive: true });
          // Write all assets to staging directory first
          for (let i = 0; i < validatedAssets.length; i++) {
            if (typeof restoreOptions.beforeAssetWrite === "function") {
              restoreOptions.beforeAssetWrite(i, validatedAssets[i]);
            }
            if (journalAssets) continue;
            const { cacheId, relative, bytes } = validatedAssets[i];
            const stagedFile = path.resolve(stagingRoot, cacheId, ...relative.split("/"));
            fs.mkdirSync(path.dirname(stagedFile), { recursive: true });
            fs.writeFileSync(stagedFile, bytes);
          }

          // Atomically promote staged files to destination cache
          for (const { cacheId, relative, bytes, finalDest } of validatedAssets) {
            if (typeof restoreOptions.beforeAssetPromote === "function") {
              restoreOptions.beforeAssetPromote({ cacheId, relative });
            }
            if (journalAssets) continue;
            // TOCTOU verification immediately before promotion
            verifyNoSymlinks(path.dirname(finalDest), dataDir);
            if (fs.existsSync(finalDest)) {
              verifyNoSymlinks(finalDest, dataDir);
              const existingBytes = fs.readFileSync(finalDest);
              if (existingBytes.equals(bytes)) {
                continue; // Identical, reuse safely
              }
              throw new Error(`cannot overwrite conflicting cache asset: ${cacheId}/${relative}`);
            }
            // Track promoted file in promotedFiles BEFORE writing so it's always cleaned on write failure
            promotedFiles.push(finalDest);
            fs.mkdirSync(path.dirname(finalDest), { recursive: true });
            fs.writeFileSync(finalDest, bytes);
          }

          if (typeof restoreOptions.beforePersist === "function") {
            restoreOptions.beforePersist();
          }

          // Persist workspace data
          writeInFlight = true;
          const committed = await storage.write(nextData, { paperHashes: [hash],
            ...(dataStorageToken ? { expectedIndexToken: dataStorageToken } : {}),
            ...(journalAssets ? { assets: validatedAssets } : {}) });
          data = nextData;
          dataStamp = committed?.stamp ?? diskStamp();
          dataStorageToken = committed?.indexToken ?? null;
        } catch (error) {
          // Comprehensive byte-for-byte rollback on any failure
          for (const promoted of promotedFiles) {
            try { fs.rmSync(promoted, { force: true }); } catch {}
          }
          data = null;
          dataStamp = null;
          dataStorageToken = null;
          let fatalError = null;
          if (storage.atomicTransactions === true) {
            // The storage transaction already restores exact original bytes.
            // Re-serializing previousData would rewrite loaded/derived fields.
            if (["workspace_rollback_failed", "workspace_commit_uncertain"].includes(error?.code)) fatalError = error;
          } else {
            try { await storage.write(previousData); }
            catch (writeErr) { fatalError = writeErr; }
          }
          try { fs.rmSync(txDir, { recursive: true, force: true }); } catch {}
          if (fatalError) {
            data = null;
            const fatal = new Error(error?.code === "workspace_commit_uncertain"
              ? "恢复写入结果待核对；请保留事务记录并重新检查工作区"
              : "恢复失败且工作区回滚未完成，请保留数据目录并检查备份");
            fatal.code = "restore_fatal";
            fatal.cause = fatalError;
            throw fatal;
          }
          if (error?.code === "workspace_conflict") throw error;
          const err = new Error("恢复未完成，请重新载入工作区核对结果");
          err.code = "restore_failed";
          err.cause = error;
          throw err;
        } finally {
          writeInFlight = false;
          try { fs.rmSync(txDir, { recursive: true, force: true }); } catch {}
        }

        try {
          const restoredCacheIds = validatedAssets.map((asset) => asset.cacheId);
          removeUnusedAssetCaches([...previousCacheIds, ...restoredCacheIds]);
        } catch {}

        return clone(candidatePaper);
      });
      writeChain = operation.catch(() => {});
      return operation;
    },
    snapshot(paperHash, options = {}) {
      const hash = safePaperHash(paperHash);
      return committedSnapshot(store => {
        const paper = store.papers[hash]; if (!paper) return null;
        const limit = clamp(options.limit || MAX_SNAPSHOT_ITEMS, 1, MAX_SNAPSHOT_ITEMS);
        const byRecent = (a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
        return { schemaVersion: SCHEMA_VERSION,
          paper: { ...clone(paper), blocks: undefined, blockIndex: clone(paper.blockIndex.slice(0, limit)), resources: clone(paper.resources.slice(0, limit)), outline: clone(paper.outline.slice(0, limit)) },
          evidence: clone(listPaperEvidence(paper, { limit })),
          tasks: Object.values(store.tasks).filter(item => item.paperHash === hash).sort(byRecent).slice(0, limit).map(clone),
          notes: snapshotRecords(store, "notes", hash).sort(byRecent).slice(0, limit),
          bookmarks: snapshotRecords(store, "bookmarks", hash).sort(byRecent).slice(0, limit),
          progress: clone(store.progress[hash] || null), glossary: snapshotGlossary(store, hash),
          translationCount: Object.values(store.translationCache).filter(item => item.paperHash === hash).length };
      });
    },
  };

  async function putAnchored(collection, input, extra) {
    const hash = safePaperHash(input.paperHash);
    const id = safeId(input.id || randomUUID());
    return mutate((store) => {
      const paper = researchPaper(store, hash, input);
      const previous = object(store[collection][id]);
      if (previous.paperHash && previous.paperHash !== hash) throw itemConflict();
      assertExpectedItemVersion(Object.prototype.hasOwnProperty.call(store[collection], id) ? previous : null, input);
      const verifiedEvidence = resolvePaperEvidence(paper, input, { usageKind: collection === "notes" ? "note" : "bookmark" });
      const snapshot = object(input.evidenceSnapshot).evidenceId ? object(input.evidenceSnapshot) : object(previous.evidenceSnapshot);
      const evidence = verifiedEvidence || (snapshot.evidenceId && snapshot.blockId ? { ...snapshot, validationStatus: "detached" } : null);
      if (!evidence) throw new Error("evidence not found");
      const { evidence: _derivedEvidence, ...source } = researchInput(input);
      const record = timestampPatch({
        ...previous,
        ...source,
        ...extra(input, evidence),
        id,
        paperHash: hash,
        evidenceId: evidence.evidenceId,
        blockId: evidence.blockId,
        page: evidence.page,
        bbox: evidence.bbox,
        evidenceSnapshot: evidence,
        validationStatus: verifiedEvidence ? "verified" : "detached",
      }, { id, paperHash: hash, evidenceId: evidence.evidenceId, blockId: evidence.blockId, itemVersion: newItemVersion() });
      store[collection][id] = record;
      return hydrateEvidenceRelation(record, paper, collection === "notes" ? "note" : "bookmark");
    });
  }
  return api;
}

export function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
export { DEFAULT_TRANSLATION_PROMPT_VERSION, SCHEMA_VERSION, TASK_STATES };
