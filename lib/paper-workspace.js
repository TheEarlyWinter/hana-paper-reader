import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  annotateEvidenceBlocks,
  evidenceFromBlock,
  hydrateEvidenceRelation,
  listPaperEvidence,
  resolvePaperEvidence,
} from "./paper-evidence.js?hpr=0.6.1-r1";
import { createPaperStorage, STORAGE_LAYOUT } from "./paper-storage.js?hpr=0.6.1-r1";

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
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: now(),
    papers: {},
    tasks: {},
    notes: {},
    bookmarks: {},
    progress: {},
    glossaries: {},
    translationCache: {},
  };
}

function normalizeData(value) {
  const source = object(value);
  const data = emptyData();
  for (const key of Object.keys(data)) {
    if (key === "schemaVersion" || key === "updatedAt") continue;
    data[key] = object(source[key]);
  }
  data.papers = Object.fromEntries(Object.entries(object(source.papers)).flatMap(([key, value]) => {
    try {
      const paperHash = safePaperHash(value?.paperHash || key);
      const paper = rebuildDerivedIndexes({ ...object(value), paperHash });
      return [[paperHash, paper]];
    } catch {
      return [];
    }
  }));
  for (const collection of ["notes", "bookmarks"]) {
    data[collection] = Object.fromEntries(Object.entries(object(source[collection])).map(([key, value]) => {
      const { evidence: _derivedEvidence, ...record } = object(value);
      const paper = data.papers[record.paperHash];
      const evidence = paper ? resolvePaperEvidence(paper, record) : null;
      return [key, evidence ? {
        ...record,
        evidenceId: evidence.evidenceId,
        blockId: evidence.blockId,
        page: evidence.page,
        bbox: evidence.bbox,
        evidenceSnapshot: object(record.evidenceSnapshot).evidenceId ? record.evidenceSnapshot : evidence,
        validationStatus: "verified",
      } : { ...record, validationStatus: object(record.evidenceSnapshot).evidenceId ? "detached" : "missing" }];
    }));
  }
  data.schemaVersion = SCHEMA_VERSION;
  data.updatedAt = text(source.updatedAt) || now();
  return data;
}

function safePaperHash(value) {
  const hash = text(value, 128).toLowerCase();
  if (!/^[a-f0-9]{12,128}$/.test(hash)) throw new Error("paperHash must be a hexadecimal fingerprint");
  return hash;
}

function safeBlockId(value) {
  const id = text(value, 256);
  if (!id || id.includes("/") || id.includes("\\")) throw new Error("blockId is required");
  return id;
}

function safeId(value) {
  const id = text(value, 128);
  if (!id || !/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error("id is invalid");
  return id;
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

function assetCacheIds(paper) {
  return [...new Set(array(paper?.blocks).map((block) => text(block?.assetRef?.cacheId, 24)).filter((id) => /^[a-f0-9]{24}$/.test(id)))];
}

function safeBackupAssetPath(value) {
  const normalized = text(value, 1000).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("backup asset path is invalid");
  return normalized;
}

function timestampPatch(record, fields = {}) {
  const createdAt = text(record.createdAt) || now();
  return { ...record, ...fields, createdAt, updatedAt: now() };
}

function rebuildDerivedIndexes(paper) {
  const rawBlocks = array(paper.blocks).map((block, index) => ({
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
    assetRef: block.assetRef || null,
  }));
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
    const state = object(sourceStates[blockId]);
    const kind = state.kind === "final" ? "final" : "ai";
    return [blockId, {
      kind,
      locked: kind === "final" ? state.locked !== false : false,
      ...(text(state.updatedAt, 80) ? { updatedAt: text(state.updatedAt, 80) } : {}),
    }];
  }));
  paper.readingMode = ["original", "bilingual", "translation"].includes(paper.readingMode) ? paper.readingMode : "bilingual";
  paper.blocks = blocks;
  paper.blockIndex = blocks.map(({ id, evidenceId, page, type, text: body, translatedText, bbox, sectionId, sectionTitle }) => ({ id, evidenceId, page, type, text: body, translatedText, bbox, sectionId, sectionTitle }));
  paper.outline = buildOutline(blocks);
  paper.resources = blocks.filter((block) => ["chart", "equation", "image", "table"].includes(block.type)).map((block) => ({
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

export function createPaperWorkspace(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.cwd());
  const filePath = path.resolve(options.filePath || path.join(dataDir, DEFAULT_FILE_NAME));
  const storage = createPaperStorage({ filePath, schemaVersion: SCHEMA_VERSION });
  let data = null;
  let writeChain = Promise.resolve();

  function load() {
    if (data) return data;
    try {
      const loaded = storage.load();
      if (!loaded.source) {
        data = emptyData();
        return data;
      }
      data = normalizeData(loaded.source);
      if (!loaded.split || loaded.previousVersion < SCHEMA_VERSION) {
        try {
          const backupPath = `${filePath}.schema-v${loaded.previousVersion}-${Date.now()}.backup`;
          fs.copyFileSync(filePath, backupPath);
          storage.writeSync(data);
        } catch {}
      }
    } catch (error) {
      data = emptyData();
      if (error?.code !== "ENOENT") {
        try { fs.copyFileSync(filePath, `${filePath}.corrupt-${Date.now()}`); } catch {}
      }
    }
    return data;
  }

  function persist() {
    const snapshot = clone(data);
    writeChain = writeChain.then(() => storage.write(snapshot));
    return writeChain;
  }

  async function mutate(fn) {
    const result = fn(load());
    data.updatedAt = now();
    await persist();
    return clone(result);
  }

  function getPaper(paperHash) {
    const paper = load().papers[safePaperHash(paperHash)];
    return paper ? clone(paper) : null;
  }

  function removeUnusedAssetCaches(candidateIds = []) {
    const used = new Set(Object.values(load().papers).flatMap(assetCacheIds));
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
    async upsertPaper(input = {}) {
      const hash = safePaperHash(input.paperHash);
      return mutate((store) => {
        const previous = store.papers[hash] || { paperHash: hash, createdAt: now() };
        const paper = rebuildDerivedIndexes({ ...previous, ...object(input), paperHash: hash });
        paper.metadata = { ...object(previous.metadata), ...object(input.metadata) };
        paper.parser = { ...object(previous.parser), ...object(input.parser) };
        store.papers[hash] = timestampPatch(paper, { paperHash: hash });
        return store.papers[hash];
      });
    },
    getPaper,
    getRecentPaper: () => {
      const papers = Object.values(load().papers).filter((paper) => object(paper).paperHash);
      papers.sort((left, right) => {
        const updated = text(right.updatedAt).localeCompare(text(left.updatedAt));
        if (updated) return updated;
        return text(right.createdAt).localeCompare(text(left.createdAt));
      });
      return clone(papers[0] || null);
    },
    async removePaper(paperHash) {
      const hash = safePaperHash(paperHash);
      const paper = getPaper(hash);
      if (!paper) return false;
      const cacheIds = assetCacheIds(paper);
      await mutate((store) => {
        delete store.papers[hash];
        delete store.progress[hash];
        delete store.glossaries[hash];
        for (const collection of ["notes", "bookmarks", "translationCache", "tasks"]) {
          for (const [key, value] of Object.entries(store[collection])) {
            if (value.paperHash === hash) delete store[collection][key];
          }
        }
        return true;
      });
      storage.removePaper(hash);
      removeUnusedAssetCaches(cacheIds);
      return true;
    },
    async createTask(input = {}) {
      const hash = safePaperHash(input.paperHash);
      const id = safeId(input.id || randomUUID());
      return mutate((store) => {
        const timestamp = now();
        const inputState = input.state === undefined ? "queued" : text(input.state, 20);
        const task = { ...object(input), id, paperHash: hash, state: inputState, stage: text(input.stage, 80) || "queued", progress: clamp(input.progress, 0, 100), error: input.error == null ? null : text(input.error, 2000), createdAt: text(input.createdAt) || timestamp, updatedAt: timestamp, startedAt: text(input.startedAt) || null, finishedAt: text(input.finishedAt) || null };
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
    getTask: (id) => clone(load().tasks[safeId(id)] || null),
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
    async setProgress(input = {}) { const hash = safePaperHash(input.paperHash); return mutate((store) => { store.progress[hash] = timestampPatch(store.progress[hash] || { paperHash: hash, createdAt: now() }, { ...object(input), paperHash: hash, percent: clamp(input.percent, 0, 100), page: Math.max(0, Number(input.page) || 0), originalScrollTop: Math.max(0, Number(input.originalScrollTop) || 0), translationScrollTop: Math.max(0, Number(input.translationScrollTop) || 0), readingMode: ["original", "bilingual", "translation"].includes(input.readingMode) ? input.readingMode : (store.progress[hash]?.readingMode || "bilingual"), noteDraft: object(input.noteDraft), searchState: object(input.searchState) }); return store.progress[hash]; }); },
    getProgress: (paperHash) => clone(load().progress[safePaperHash(paperHash)] || null),
    getItem: (collection, id) => {
      if (!["notes", "bookmarks"].includes(collection)) throw new Error("unsupported collection");
      const key = safeId(id);
      const item = load()[collection][key];
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
    async deleteItem(collection, id) { if (!["notes", "bookmarks"].includes(collection)) throw new Error("unsupported collection"); const key = safeId(id); return mutate((store) => { const found = Object.values(store[collection]).some((item) => item.id === key); for (const hash of Object.keys(store[collection])) { if (store[collection][hash]?.id === key) delete store[collection][hash]; } return found; }); },
    async putGlossary(input = {}) { const hash = safePaperHash(input.paperHash); return mutate((store) => { const previous = store.glossaries[hash] || { paperHash: hash, version: 0, terms: {}, createdAt: now() }; const terms = { ...previous.terms, ...Object.fromEntries(Object.entries(object(input.terms)).map(([key, value]) => [text(key, 200), text(value, 500)]).filter(([key, value]) => key && value)) }; store.glossaries[hash] = timestampPatch(previous, { paperHash: hash, terms, version: previous.version + 1 }); return store.glossaries[hash]; }); },
    getGlossary: (paperHash) => clone(load().glossaries[safePaperHash(paperHash)] || { paperHash: safePaperHash(paperHash), version: 0, terms: {} }),
    async deleteGlossaryTerm(paperHash, term) { const hash = safePaperHash(paperHash); return mutate((store) => { const glossary = store.glossaries[hash]; if (!glossary) return false; delete glossary.terms[text(term, 200)]; glossary.version += 1; glossary.updatedAt = now(); return true; }); },
    async putTranslation(input = {}) { const hash = safePaperHash(input.paperHash); const blockId = safeBlockId(input.blockId); const glossaryVersion = Number.isInteger(input.glossaryVersion) ? input.glossaryVersion : 0; const key = `${hash}:${blockId}:${glossaryVersion}`; return mutate((store) => { store.translationCache[key] = timestampPatch(object(input), { key, paperHash: hash, blockId, glossaryVersion, source: text(input.source), translation: text(input.translation), createdAt: store.translationCache[key]?.createdAt || now() }); return store.translationCache[key]; }); },
    getTranslation: (paperHash, blockId, glossaryVersion) => clone(load().translationCache[`${safePaperHash(paperHash)}:${safeBlockId(blockId)}:${Number(glossaryVersion) || 0}`] || null),
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
      const paper = getPaper(hash);
      if (!paper) throw new Error("paper not found");
      if (action === "assets") {
        const cacheIds = assetCacheIds(paper);
        for (const cacheId of cacheIds) fs.rmSync(path.join(dataDir, "mineru-cache", cacheId), { recursive: true, force: true });
        return { action, removedCacheIds: cacheIds, paper: getPaper(hash) };
      }
      if (action === "ai-translations") {
        return mutate((store) => {
          const current = store.papers[hash];
          const preserved = Object.fromEntries(Object.entries(object(current.translations)).filter(([blockId]) => current.translationStates?.[blockId]?.kind === "final"));
          const states = Object.fromEntries(Object.keys(preserved).map((blockId) => [blockId, current.translationStates[blockId]]));
          current.translations = preserved;
          current.translationStates = states;
          current.blocks = array(current.blocks).map((block) => ({ ...block, translatedText: preserved[block.id] || "" }));
          for (const [key, value] of Object.entries(store.translationCache)) if (value.paperHash === hash) delete store.translationCache[key];
          store.papers[hash] = rebuildDerivedIndexes(current);
          return { action, preservedFinals: Object.keys(preserved).length, paper: store.papers[hash] };
        });
      }
      if (action === "structure-keep-notes") {
        const cacheIds = assetCacheIds(paper);
        const result = await mutate((store) => {
          const previous = store.papers[hash];
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
            createdAt: previous.createdAt,
          }, { paperHash: hash });
          delete store.progress[hash];
          for (const collection of ["bookmarks", "translationCache", "tasks"]) {
            for (const [key, value] of Object.entries(store[collection])) if (value.paperHash === hash) delete store[collection][key];
          }
          return { action, notesKept: Object.values(store.notes).filter((item) => item.paperHash === hash).length, paper: store.papers[hash] };
        });
        removeUnusedAssetCaches(cacheIds);
        return result;
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
          const stack = [root];
          while (stack.length) {
            const current = stack.pop();
            let entries = [];
            try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
            for (const entry of entries) {
              const target = path.join(current, entry.name);
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
    async restoreBackup(input = {}) {
      if (input?.format !== "hana-paper-reader-backup" || Number(input?.version) !== 1) throw new Error("backup format is invalid");
      const hash = safePaperHash(input.paperHash || input.paper?.paperHash);
      if (input.paper?.paperHash !== hash) throw new Error("backup paper hash mismatch");
      const validatedAssets = [];
      let totalAssetBytes = 0;
      if (array(input.assets).length > 2000) throw new Error("backup has too many assets");
      for (const asset of array(input.assets)) {
        const cacheId = text(asset?.cacheId, 24);
        if (!/^[a-f0-9]{24}$/.test(cacheId)) throw new Error("backup cache id is invalid");
        const relative = safeBackupAssetPath(asset?.path);
        const encoded = String(asset?.data || "");
        if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("backup asset encoding is invalid");
        const bytes = Buffer.from(encoded, "base64");
        if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new Error("backup asset is invalid");
        totalAssetBytes += bytes.length;
        if (totalAssetBytes > 256 * 1024 * 1024) throw new Error("backup assets exceed 256 MB");
        validatedAssets.push({ cacheId, relative, bytes });
      }
      const restored = await mutate((store) => {
        store.papers[hash] = rebuildDerivedIndexes({ ...object(input.paper), paperHash: hash });
        for (const collection of ["notes", "bookmarks", "translationCache", "tasks"]) {
          for (const [key, value] of Object.entries(store[collection])) if (value.paperHash === hash) delete store[collection][key];
        }
        for (const note of array(input.notes)) if (note?.id && note.paperHash === hash) store.notes[safeId(note.id)] = object(note);
        for (const bookmark of array(input.bookmarks)) if (bookmark?.id && bookmark.paperHash === hash) store.bookmarks[safeId(bookmark.id)] = object(bookmark);
        if (input.progress?.paperHash === hash) store.progress[hash] = object(input.progress);
        else delete store.progress[hash];
        if (input.glossary?.paperHash === hash) store.glossaries[hash] = object(input.glossary);
        else delete store.glossaries[hash];
        for (const item of array(input.translationCache)) {
          const key = text(item?.key, 600);
          if (key && item.paperHash === hash && key.startsWith(`${hash}:`)) store.translationCache[key] = object(item);
        }
        for (const task of array(input.tasks)) if (task?.id && task.paperHash === hash) store.tasks[safeId(task.id)] = object(task);
        return store.papers[hash];
      });
      for (const asset of validatedAssets) {
        const { cacheId, relative, bytes } = asset;
        const root = path.resolve(dataDir, "mineru-cache", cacheId);
        const output = path.resolve(root, ...relative.split("/"));
        if (!output.startsWith(`${root}${path.sep}`)) throw new Error("backup asset path escaped cache root");
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, bytes);
      }
      return restored;
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
