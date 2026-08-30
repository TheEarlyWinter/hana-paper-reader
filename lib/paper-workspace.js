import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  annotateEvidenceBlocks,
  evidenceFromBlock,
  hydrateEvidenceRelation,
  listPaperEvidence,
  resolvePaperEvidence,
} from "./paper-evidence.js?hpr=0.9.0-r1";
import { createPaperStorage, STORAGE_LAYOUT } from "./paper-storage.js?hpr=0.9.0-r1";
import { assertCacheId, assertPaperHash, isReservedKey, isSafeCacheId, isSafePaperHash, normalizeCacheId, normalizePaperHash, safeId } from "./paper-identity.js";
import { normalizeAuthors, normalizeDisplayText, normalizePaperMetadata, normalizeTags, normalizeYear } from "./paper-metadata.js";
import { verifyNoSymlinks } from "./paper-path-guard.js";

const SCHEMA_VERSION = 3;
const DEFAULT_FILE_NAME = "paper-workspace.json";
const MAX_SNAPSHOT_ITEMS = 100;
const MAX_TEXT = 20000;
const NOTE_TYPES = new Set(["finding", "method", "question", "limitation"]);
const SEARCH_LANGUAGES = new Set(["original", "translation", "both"]);
const SEARCH_SCOPES = new Set(["page", "section", "all"]);
const TASK_STATES = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);
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
  data.deletedPapers = Object.create(null);
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
  for (const key of ["tasks", "notes", "bookmarks", "progress", "glossaries", "translationCache", "deletedPapers"]) {
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
      papers[paperHash] = paper;
    } catch {
      // Ignore invalid paper hashes
    }
  }
  data.papers = papers;

  for (const collection of ["notes", "bookmarks"]) {
    const coll = Object.create(null);
    for (const [key, recordVal] of Object.entries(data[collection])) {
      if (isReservedKey(key)) continue;
      const { evidence: _derivedEvidence, ...record } = object(recordVal);
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
  const variant = translationCacheVariant(options);
  return variant ? `${base}:${variant}` : base;
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

function safeBackupAssetPath(value) {
  const raw = text(value, 1000).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!raw || raw.includes("\0")) throw new Error("backup asset path is invalid");
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) throw new Error("backup asset path is invalid");
  return parts.join("/");
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
  const filePath = path.resolve(options.filePath || path.join(options.dataDir || process.cwd(), DEFAULT_FILE_NAME));
  const dataDir = path.dirname(filePath);
  const storage = options.storage || createPaperStorage({ filePath, schemaVersion: SCHEMA_VERSION });
  let data = null;
  let dataStamp = null;
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
      const loaded = storage.load();
      if (!loaded.source) return { data: emptyData(), stamp: diskStamp() };
      const next = normalizeData(loaded.source);
      if (!loaded.split || loaded.previousVersion < SCHEMA_VERSION) {
        try {
          const backupPath = `${filePath}.schema-v${loaded.previousVersion}-${Date.now()}.backup`;
          fs.copyFileSync(filePath, backupPath);
          storage.writeSync(next);
        } catch {}
      }
      return { data: next, stamp: diskStamp() };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        try { fs.copyFileSync(filePath, `${filePath}.corrupt-${Date.now()}`); } catch {}
      }
      return { data: emptyData(), stamp: diskStamp() };
    }
  }

  function refreshFromDisk() {
    const loaded = readStorage();
    data = loaded.data;
    dataStamp = loaded.stamp;
    return data;
  }

  function load() {
    const stamp = diskStamp();
    if (!data || (!writeInFlight && dataStamp !== stamp)) {
      const loaded = readStorage();
      data = loaded.data;
      dataStamp = loaded.stamp;
    }
    return data;
  }

  async function persist() {
    if (!data) return;
    const snapshot = clone(data);
    writeInFlight = true;
    try {
      await storage.write(snapshot);
      dataStamp = diskStamp();
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
      const fresh = clone(refreshFromDisk());
      const result = fn(fresh);
      fresh.updatedAt = now();
      const previousData = data;
      try {
        data = fresh;
        await persist();
      } catch (persistError) {
        data = previousData;
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

  function removeUnusedAssetCaches(candidateIds = []) {
    const used = new Set(Object.values(refreshFromDisk().papers).flatMap(assetCacheIds));
    for (const cacheId of candidateIds) {
      if (used.has(cacheId)) continue;
      try { fs.rmSync(path.join(dataDir, "mineru-cache", cacheId), { recursive: true, force: true }); } catch {}
    }
  }

  function assetBytesForPaper(paper) {
    return assetCacheIds(paper).reduce((total, cacheId) => total + directorySize(path.join(dataDir, "mineru-cache", cacheId)), 0);
  }

  const api = {
    filePath,
    load: () => clone(load()),
    async close() { await writeChain; },
    async upsertPaper(input = {}, options = {}) {
      const hash = safePaperHash(input.paperHash);
      const operation = String(options.operation || input.operation || "autosave");
      return mutate((store) => {
        if (store.deletedPapers && store.deletedPapers[hash] && !["import", "restore", "force"].includes(operation)) {
          const err = new Error(`paper ${hash} has been deleted (tombstone)`);
          err.code = "paper_deleted";
          err.status = 409;
          throw err;
        }
        if (store.deletedPapers && store.deletedPapers[hash]) {
          delete store.deletedPapers[hash];
        }
        const previous = store.papers[hash] || { paperHash: hash, createdAt: now(), revision: 0 };
        const currentRev = Number.isInteger(previous.revision) ? previous.revision : 0;
        const expectedRev = options.expectedRevision ?? input.expectedRevision;
        if (expectedRev !== undefined && expectedRev !== null && Number(expectedRev) !== currentRev) {
          const err = new Error(`paper revision conflict: expected ${expectedRev}, found ${currentRev}`);
          err.code = "revision_conflict";
          err.status = 409;
          throw err;
        }
        const paper = rebuildDerivedIndexes({ ...previous, ...object(input), paperHash: hash });
        paper.metadata = normalizePaperMetadata({ ...object(previous.metadata), ...object(input.metadata) });
        paper.parser = { ...object(previous.parser), ...object(input.parser) };
        if (Array.isArray(input.blocks) && input.blocks.length > 0) {
          paper.structureDetached = false;
          if (paper.parser) paper.parser.structureDetached = false;
        }
        paper.revision = currentRev + 1;
        store.papers[hash] = timestampPatch(paper, { paperHash: hash, revision: paper.revision });
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
      return mutate((store) => {
        const paper = store.papers[hash];
        if (!paper) throw new Error("论文不存在");
        const metadata = { ...normalizePaperMetadata(paper.metadata) };
        // Preserve flags written by pre-library versions that stored them on
        // the paper record instead of metadata. A harmless lastReadAt update
        // must never silently un-favorite or un-archive such a paper.
        if (paper.favorite === true && metadata.favorite !== true) metadata.favorite = true;
        if (paper.archived === true && metadata.archived !== true) metadata.archived = true;
        if (patch.favorite !== undefined) {
          metadata.favorite = Boolean(patch.favorite);
          paper.favorite = metadata.favorite;
        }
        if (patch.archived !== undefined) {
          metadata.archived = Boolean(patch.archived);
          paper.archived = metadata.archived;
        }
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
        paper.revision = (Number.isInteger(paper.revision) ? paper.revision : 0) + 1;
        paper.updatedAt = now();
        store.papers[hash] = paper;
        return clone(paper);
      });
    },
    async removePaper(paperHash) {
      const hash = safePaperHash(paperHash);
      const operation = enqueueMutation(async () => {
        const fresh = clone(refreshFromDisk());
        const paper = fresh.papers[hash];
        if (!paper) return false;
        const cacheIds = assetCacheIds(paper);
        delete fresh.papers[hash];
        delete fresh.progress[hash];
        delete fresh.glossaries[hash];
        for (const collection of ["notes", "bookmarks", "translationCache", "tasks"]) {
          for (const [key, value] of Object.entries(fresh[collection])) {
            if (value.paperHash === hash) delete fresh[collection][key];
          }
        }
        fresh.deletedPapers ||= {};
        fresh.deletedPapers[hash] = {
          paperHash: hash,
          deletedAt: now(),
          generation: (fresh.deletedPapers[hash]?.generation || 0) + 1,
        };
        fresh.updatedAt = now();
        const previousData = data;
        try {
          data = fresh;
          await persist();
        } catch (persistError) {
          data = previousData;
          throw persistError;
        }
        try { storage.removePaper(hash); } catch {}
        removeUnusedAssetCaches(cacheIds);
        return true;
      });
      writeChain = operation.catch(() => {});
      return Boolean(await operation);
    },
    async createTask(input = {}) {
      const hash = safePaperHash(input.paperHash);
      const id = safeId(input.id || randomUUID());
      return mutate((store) => {
        if (store.tasks[id] && store.tasks[id].paperHash !== hash) {
          throw new Error("task id already exists for another paper");
        }
        const timestamp = now();
        const inputState = input.state === undefined ? "queued" : text(input.state, 20);
        const task = { ...object(input), id, paperHash: hash, state: inputState, stage: text(input.stage, 80) || "queued", progress: clamp(input.progress, 0, 100), error: input.error == null ? null : text(input.error, 2000), createdAt: text(input.createdAt) || timestamp, updatedAt: timestamp, startedAt: text(input.startedAt) || null, finishedAt: text(input.finishedAt) || null };
        if (!TASK_STATES.has(task.state)) throw new Error("invalid task state");
        store.tasks[id] = task;
        return task;
      });
    },
    async updateTask(id, patch = {}, expectedPaperHash = null) {
      const taskId = safeId(id);
      return mutate((store) => {
        const task = store.tasks[taskId];
        if (!task) throw new Error("task not found");
        if (expectedPaperHash != null) {
          const expectedHash = safePaperHash(expectedPaperHash);
          if (task.paperHash !== expectedHash) {
            throw new Error("task paperHash mismatch");
          }
        }
        const nextState = patch.state === undefined ? task.state : text(patch.state, 20);
        if (!TASK_STATES.has(nextState) || !ALLOWED_TASK_TRANSITIONS[task.state].has(nextState)) throw new Error("invalid task state transition");
        const timestamp = now();
        const next = { ...task, ...object(patch), state: nextState, stage: text(patch.stage ?? task.stage, 80), progress: clamp(patch.progress ?? task.progress, 0, 100), error: patch.error == null ? task.error : text(patch.error, 2000), updatedAt: timestamp };
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
        if (!store.papers[hash]) throw new Error("paper not found");
        store.progress[hash] = timestampPatch(store.progress[hash] || { paperHash: hash, createdAt: now() }, {
          ...object(input),
          paperHash: hash,
          percent: clamp(input.percent, 0, 100),
          page: Math.max(0, Number(input.page) || 0),
          originalScrollTop: Math.max(0, Number(input.originalScrollTop) || 0),
          translationScrollTop: Math.max(0, Number(input.translationScrollTop) || 0),
          contrastScrollTop: Math.max(0, Number(input.contrastScrollTop) || 0),
          readingMode: ["original", "bilingual", "translation", "contrast"].includes(input.readingMode) ? input.readingMode : (store.progress[hash]?.readingMode || "bilingual"),
          noteDraft: object(input.noteDraft),
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
      return clone(hydrateEvidenceRelation(item, load().papers[item.paperHash], collection === "notes" ? "note" : "bookmark"));
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
        .map((item) => clone(hydrateEvidenceRelation(item, paper, collection === "notes" ? "note" : "bookmark")));
    },
    async deleteItem(collection, id, paperHash) {
      if (!["notes", "bookmarks"].includes(collection)) throw new Error("unsupported collection");
      if (paperHash === undefined || paperHash === null) {
        throw new Error("paperHash required for deleteItem");
      }
      const hash = safePaperHash(paperHash);
      const key = safeId(id);
      return mutate((store) => {
        const item = store[collection][key];
        if (!item || item.paperHash !== hash) {
          return false;
        }
        delete store[collection][key];
        return true;
      });
    },
    async putGlossary(input = {}) {
      const hash = safePaperHash(input.paperHash);
      return mutate((store) => {
        if (!store.papers[hash]) throw new Error("paper not found");
        const previous = store.glossaries[hash] || { paperHash: hash, version: 0, terms: {}, createdAt: now() };
        const terms = {
          ...previous.terms,
          ...Object.fromEntries(Object.entries(object(input.terms)).map(([key, value]) => [text(key, 200), text(value, 500)]).filter(([key, value]) => key && value)),
        };
        store.glossaries[hash] = timestampPatch(previous, { paperHash: hash, terms, version: previous.version + 1 });
        return store.glossaries[hash];
      });
    },
    getGlossary: (paperHash) => clone(load().glossaries[safePaperHash(paperHash)] || { paperHash: safePaperHash(paperHash), version: 0, terms: {} }),
    async deleteGlossaryTerm(paperHash, term) {
      const hash = safePaperHash(paperHash);
      return mutate((store) => {
        if (!store.papers[hash]) throw new Error("paper not found");
        const glossary = store.glossaries[hash];
        if (!glossary) return false;
        delete glossary.terms[text(term, 200)];
        glossary.version += 1;
        glossary.updatedAt = now();
        return true;
      });
    },
    async putTranslation(input = {}) {
      const hash = safePaperHash(input.paperHash);
      const blockId = safeBlockId(input.blockId);
      const glossaryVersion = Number.isInteger(input.glossaryVersion) ? input.glossaryVersion : 0;
      const key = translationCacheKey(hash, blockId, glossaryVersion, input);
      return mutate((store) => {
        const paper = store.papers[hash];
        if (!paper) throw new Error("paper not found");
        if (!array(paper.blocks).some((block) => block.id === blockId)) throw new Error("block not found");
        store.translationCache[key] = timestampPatch(object(input), {
          key,
          paperHash: hash,
          blockId,
          glossaryVersion,
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
      const paper = getPaper(hash);
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
          notes: Object.values(load().notes).filter((item) => item.paperHash === hash).length,
          bookmarks: Object.values(load().bookmarks).filter((item) => item.paperHash === hash).length,
        },
      };
    },
    async clearPaperData(paperHash, action) {
      const hash = safePaperHash(paperHash);
      if (action === "assets") {
        return mutate((store) => {
          const paper = store.papers[hash];
          if (!paper) throw new Error("paper not found");
          const cacheIds = assetCacheIds(paper);
          const nextRevision = (Number.isInteger(paper.revision) ? paper.revision : 0) + 1;
          // Unbind asset references in the blocks so they are no longer claimed
          paper.blocks = array(paper.blocks).map((block) => ({
            ...block,
            assetRef: null,
            assetPath: null,
          }));
          paper.resources = array(paper.resources).map((res) => ({
            ...res,
            assetRef: null,
          }));
          store.papers[hash] = timestampPatch(rebuildDerivedIndexes(paper), {
            paperHash: hash,
            revision: nextRevision,
          });
          return { action, removedCacheIds: cacheIds, paper: clone(store.papers[hash]) };
        }, ({ result }) => {
          removeUnusedAssetCaches(result.removedCacheIds || []);
        });
      }
      if (action === "ai-translations") {
        return mutate((store) => {
          const current = store.papers[hash];
          if (!current) throw new Error("paper not found");
          const preserved = Object.fromEntries(Object.entries(object(current.translations)).filter(([blockId]) => current.translationStates?.[blockId]?.kind === "final"));
          const states = Object.fromEntries(Object.keys(preserved).map((blockId) => [blockId, current.translationStates[blockId]]));
          const nextRevision = (Number.isInteger(current.revision) ? current.revision : 0) + 1;
          current.translations = preserved;
          current.translationStates = states;
          current.blocks = array(current.blocks).map((block) => ({ ...block, translatedText: preserved[block.id] || "" }));
          for (const [key, value] of Object.entries(store.translationCache)) if (value.paperHash === hash) delete store.translationCache[key];
          store.papers[hash] = timestampPatch(rebuildDerivedIndexes(current), {
            paperHash: hash,
            revision: nextRevision,
          });
          return { action, preservedFinals: Object.keys(preserved).length, paper: store.papers[hash] };
        });
      }
      if (action === "structure-keep-notes") {
        return mutate((store) => {
          const previous = store.papers[hash];
          if (!previous) throw new Error("paper not found");
          const cacheIds = assetCacheIds(previous);
          const nextRevision = (Number.isInteger(previous.revision) ? previous.revision : 0) + 1;
          store.papers[hash] = timestampPatch({
            paperHash: hash,
            metadata: previous.metadata,
            parser: { ...object(previous.parser), structureDetached: true, pageCount: Number(previous.parser?.pageCount || 0) },
            blocks: [],
            translations: {},
            translationStates: {},
            translationGlossaryVersion: Number(previous.translationGlossaryVersion || 0),
            readingMode: previous.readingMode || "bilingual",
            structureDetached: true,
            revision: nextRevision,
            createdAt: previous.createdAt,
          }, { paperHash: hash, revision: nextRevision });
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
        }, ({ result }) => removeUnusedAssetCaches(result.removedCacheIds || []));
      }
      throw new Error("unsupported clear action");
    },
    exportBackup(paperHash, options = {}) {
      const hash = safePaperHash(paperHash);
      const paper = getPaper(hash);
      if (!paper) throw new Error("paper not found");
      const backup = {
        format: "hana-paper-reader-backup",
        version: 1,
        exportedAt: now(),
        paperHash: hash,
        paper,
        notes: Object.values(load().notes).filter((item) => item.paperHash === hash).map((item) => clone(hydrateEvidenceRelation(item, paper, "note"))),
        bookmarks: Object.values(load().bookmarks).filter((item) => item.paperHash === hash).map((item) => clone(hydrateEvidenceRelation(item, paper, "bookmark"))),
        progress: api.getProgress(hash),
        glossary: api.getGlossary(hash),
        translationCache: Object.values(load().translationCache).filter((item) => item.paperHash === hash).map(clone),
        tasks: Object.values(load().tasks).filter((item) => item.paperHash === hash).map(clone),
        assets: [],
      };
      if (options.includeAssets !== false) {
        for (const cacheId of assetCacheIds(paper)) {
          const root = path.join(dataDir, "mineru-cache", cacheId);
          try {
            verifyNoSymlinks(root, path.join(dataDir, "mineru-cache"));
          } catch {
            continue; // Skip symlinked or escaped cache directory
          }
          const stack = [root];
          while (stack.length) {
            const current = stack.pop();
            let entries = [];
            try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
            for (const entry of entries) {
              const target = path.join(current, entry.name);
              try {
                verifyNoSymlinks(target, root);
              } catch {
                continue; // Skip symlinked files or directories
              }
              if (entry.isDirectory()) stack.push(target);
              else if (entry.isFile()) {
                const relative = path.relative(root, target).replace(/\\/g, "/");
                backup.assets.push({ cacheId, path: relative, data: fs.readFileSync(target).toString("base64") });
              }
            }
          }
        }
      }
      return backup;
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
      if (input.paper?.paperHash && normalizePaperHash(input.paper.paperHash) !== hash) {
        const err = new Error("backup paper hash mismatch");
        err.code = "backup_invalid";
        throw err;
      }

      // Stage 1: Full validation and preflight of all IDs, assets and structures
      const currentStore = refreshFromDisk();
      const validatedNotes = [];
      for (const note of array(input.notes)) {
        if (note?.id && normalizePaperHash(note.paperHash) === hash) {
          const nid = safeId(note.id);
          const existing = currentStore.notes[nid];
          if (existing && existing.paperHash !== hash) {
            const err = new Error(`cannot restore note with id ${nid}: belongs to another paper`);
            err.code = "backup_invalid";
            throw err;
          }
          validatedNotes.push(object(note));
        }
      }
      const validatedBookmarks = [];
      for (const bm of array(input.bookmarks)) {
        if (bm?.id && normalizePaperHash(bm.paperHash) === hash) {
          const bid = safeId(bm.id);
          const existing = currentStore.bookmarks[bid];
          if (existing && existing.paperHash !== hash) {
            const err = new Error(`cannot restore bookmark with id ${bid}: belongs to another paper`);
            err.code = "backup_invalid";
            throw err;
          }
          validatedBookmarks.push(object(bm));
        }
      }
      const validatedTasks = [];
      for (const t of array(input.tasks)) {
        if (t?.id && normalizePaperHash(t.paperHash) === hash) {
          const tid = safeId(t.id);
          const existing = currentStore.tasks[tid];
          if (existing && existing.paperHash !== hash) {
            const err = new Error(`cannot restore task with id ${tid}: belongs to another paper`);
            err.code = "backup_invalid";
            throw err;
          }
          validatedTasks.push(object(t));
        }
      }

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
        const encoded = String(asset?.data || "");
        if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
          const err = new Error("backup asset encoding is invalid");
          err.code = "backup_invalid";
          throw err;
        }
        const bytes = Buffer.from(encoded, "base64");
        if (!bytes.length || bytes.length > 32 * 1024 * 1024) {
          const err = new Error("backup asset is invalid");
          err.code = "backup_invalid";
          throw err;
        }
        const assetKey = `${cacheId}:${relative}`;
        if (seenAssets.has(assetKey)) {
          if (!seenAssets.get(assetKey).bytes.equals(bytes)) {
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

      // Stage 2, 3 & 4: Transactional staging, atomic promotion and rollback
      const operation = enqueueMutation(async () => {
        const txRoot = path.join(dataDir, ".transactions");
        verifyNoSymlinks(txRoot, dataDir);
        const txId = `restore-${randomUUID()}`;
        const txDir = path.join(txRoot, txId);
        const stagingRoot = path.join(txDir, "mineru-cache");
        fs.mkdirSync(stagingRoot, { recursive: true });

        const previousData = clone(refreshFromDisk());
        const previousCacheIds = assetCacheIds(previousData.papers[hash]);
        const nextData = clone(previousData);

        if (nextData.deletedPapers && nextData.deletedPapers[hash]) {
          delete nextData.deletedPapers[hash];
        }
        const currentRev = previousData.papers[hash]?.revision || 0;
        candidatePaper.revision = Math.max(currentRev + 1, (Number(candidatePaper.revision) || 0) + 1);
        nextData.papers[hash] = candidatePaper;
        for (const collection of ["notes", "bookmarks", "translationCache", "tasks"]) {
          for (const [key, value] of Object.entries(nextData[collection])) if (value.paperHash === hash) delete nextData[collection][key];
        }
        for (const note of validatedNotes) nextData.notes[safeId(note.id)] = { ...object(note), paperHash: hash };
        for (const bookmark of validatedBookmarks) nextData.bookmarks[safeId(bookmark.id)] = { ...object(bookmark), paperHash: hash };
        if (input.progress && normalizePaperHash(input.progress.paperHash) === hash) nextData.progress[hash] = { ...object(input.progress), paperHash: hash };
        else delete nextData.progress[hash];
        if (input.glossary && normalizePaperHash(input.glossary.paperHash) === hash) nextData.glossaries[hash] = { ...object(input.glossary), paperHash: hash };
        else delete nextData.glossaries[hash];
        for (const item of array(input.translationCache)) {
          const key = text(item?.key, 600);
          if (key && normalizePaperHash(item.paperHash) === hash && key.startsWith(`${hash}:`)) nextData.translationCache[key] = { ...object(item), paperHash: hash };
        }
        for (const task of validatedTasks) nextData.tasks[safeId(task.id)] = { ...object(task), paperHash: hash };
        nextData.updatedAt = now();

        const promotedFiles = [];
        try {
          // Write all assets to staging directory first
          for (let i = 0; i < validatedAssets.length; i++) {
            if (typeof restoreOptions.beforeAssetWrite === "function") {
              restoreOptions.beforeAssetWrite(i, validatedAssets[i]);
            }
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
          data = nextData;
          await storage.write(nextData);
        } catch (error) {
          // Comprehensive byte-for-byte rollback on any failure
          for (const promoted of promotedFiles) {
            try { fs.rmSync(promoted, { force: true }); } catch {}
          }
          data = previousData;
          let fatalError = null;
          try {
            await storage.write(previousData);
          } catch (writeErr) {
            fatalError = writeErr;
          }
          try { fs.rmSync(txDir, { recursive: true, force: true }); } catch {}
          if (fatalError) {
            const fatal = new Error(`FATAL: 恢复失败且工作区状态回滚失败: ${fatalError.message}`);
            fatal.code = "restore_fatal";
            throw fatal;
          }
          const err = new Error(`恢复失败，原有数据未改变：${error.message}`);
          err.code = "restore_failed";
          throw err;
        } finally {
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
      const hash = safePaperHash(paperHash); const paper = getPaper(hash); if (!paper) return null; const limit = clamp(options.limit || MAX_SNAPSHOT_ITEMS, 1, MAX_SNAPSHOT_ITEMS);
      return { schemaVersion: SCHEMA_VERSION, paper: { ...clone(paper), blocks: undefined, blockIndex: clone(paper.blockIndex.slice(0, limit)), resources: clone(paper.resources.slice(0, limit)), outline: clone(paper.outline.slice(0, limit)) }, evidence: api.listEvidence(hash, { limit }), tasks: api.listTasks(hash, limit), notes: api.listItems("notes", hash, limit), bookmarks: api.listItems("bookmarks", hash, limit), progress: api.getProgress(hash), glossary: api.getGlossary(hash), translationCount: Object.values(load().translationCache).filter((item) => item.paperHash === hash).length };
    },
  };

  async function putAnchored(collection, input, extra) {
    const hash = safePaperHash(input.paperHash);
    const id = safeId(input.id || randomUUID());
    return mutate((store) => {
      const paper = store.papers[hash];
      if (!paper) throw new Error("paper not found");
      const previous = object(store[collection][id]);
      if (previous && previous.paperHash && previous.paperHash !== hash) {
        throw new Error(`id conflict: ${id} belongs to another paper`);
      }
      const verifiedEvidence = resolvePaperEvidence(paper, input, { usageKind: collection === "notes" ? "note" : "bookmark" });
      const snapshot = object(input.evidenceSnapshot).evidenceId ? object(input.evidenceSnapshot) : object(previous.evidenceSnapshot);
      const evidence = verifiedEvidence || (snapshot.evidenceId && snapshot.blockId ? { ...snapshot, validationStatus: "detached" } : null);
      if (!evidence) throw new Error("evidence not found");
      const { evidence: _derivedEvidence, ...source } = object(input);
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
      }, { id, paperHash: hash, evidenceId: evidence.evidenceId, blockId: evidence.blockId });
      store[collection][id] = record;
      return hydrateEvidenceRelation(record, paper, collection === "notes" ? "note" : "bookmark");
    });
  }
  return api;
}

export function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
export { SCHEMA_VERSION, TASK_STATES };
