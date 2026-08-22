import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const SCHEMA_VERSION = 1;
const DEFAULT_FILE_NAME = "paper-workspace.json";
const MAX_SNAPSHOT_ITEMS = 100;
const MAX_TEXT = 20000;
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
const clone = (value) => JSON.parse(JSON.stringify(value));

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

function timestampPatch(record, fields = {}) {
  const createdAt = text(record.createdAt) || now();
  return { ...record, ...fields, createdAt, updatedAt: now() };
}

function rebuildDerivedIndexes(paper) {
  const blocks = array(paper.blocks).map((block, index) => ({
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
  paper.blocks = blocks;
  paper.blockIndex = blocks.map(({ id, page, type, text: body, translatedText, bbox }) => ({ id, page, type, text: body, translatedText, bbox }));
  paper.outline = buildOutline(blocks);
  paper.resources = blocks.filter((block) => ["chart", "equation", "image", "table"].includes(block.type)).map((block) => ({
    id: block.id,
    type: block.type,
    page: block.page,
    title: block.text,
    latex: block.latex,
    assetRef: block.assetRef,
    bbox: block.bbox,
  }));
  return paper;
}

export function buildOutline(blocks) {
  return array(blocks).filter((block) => block?.type === "heading" || Number(block?.level) > 0)
    .map((block, index) => ({ id: block.id || `heading-${index + 1}`, title: text(block.text) || "Untitled", page: block.page || 0, level: clamp(block.level || 1, 1, 6) }));
}

export function searchBlocks(blocks, query, options = {}) {
  const needle = text(query, 200).toLocaleLowerCase();
  if (!needle) return [];
  const type = text(options.type, 40);
  const limit = clamp(options.limit || MAX_SNAPSHOT_ITEMS, 1, MAX_SNAPSHOT_ITEMS);
  return array(blocks).map((block, index) => {
    const original = text(block.text);
    const translated = text(block.translatedText);
    const originalHit = original.toLocaleLowerCase().includes(needle);
    const translatedHit = translated.toLocaleLowerCase().includes(needle);
    return { block, index, original, translated, originalHit, translatedHit };
  }).filter((item) => (item.originalHit || item.translatedHit) && (!type || item.block.type === type))
    .slice(0, limit).map(({ block, original, translated, originalHit, translatedHit }) => ({
      id: block.id, page: block.page, type: block.type, text: original, translatedText: translated,
      matches: { original: originalHit, translated: translatedHit }, bbox: block.bbox || null,
    }));
}

export function createPaperWorkspace(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.cwd());
  const filePath = path.resolve(options.filePath || path.join(dataDir, DEFAULT_FILE_NAME));
  let data = null;
  let writeChain = Promise.resolve();

  function load() {
    if (data) return data;
    try {
      data = normalizeData(JSON.parse(fs.readFileSync(filePath, "utf8")));
    } catch (error) {
      data = emptyData();
      if (error?.code !== "ENOENT") {
        try { fs.copyFileSync(filePath, `${filePath}.corrupt-${Date.now()}`); } catch {}
      }
    }
    return data;
  }

  function persist() {
    const snapshot = JSON.stringify(data, null, 2);
    writeChain = writeChain.then(async () => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fs.promises.writeFile(temporary, snapshot, "utf8");
        await fs.promises.rename(temporary, filePath);
      } finally {
        try { await fs.promises.unlink(temporary); } catch {}
      }
    });
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
      return mutate((store) => {
        delete store.papers[hash];
        for (const collection of ["notes", "bookmarks", "progress", "glossaries"]) delete store[collection][hash];
        for (const [key, value] of Object.entries(store.translationCache)) if (value.paperHash === hash) delete store.translationCache[key];
        for (const [key, value] of Object.entries(store.tasks)) if (value.paperHash === hash) delete store.tasks[key];
        return true;
      });
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
    search: (paperHash, query, options) => searchBlocks(getPaper(paperHash)?.blocks, query, options),
    outline: (paperHash) => clone(getPaper(paperHash)?.outline || []),
    async putNote(input = {}) { return putAnchored("notes", input, (value) => ({ note: text(value.note), tags: array(value.tags).map((tag) => text(tag, 80)).filter(Boolean).slice(0, 30) })); },
    async putBookmark(input = {}) { return putAnchored("bookmarks", input, (value) => ({ label: text(value.label, 200), page: Number(value.page) || 0, bbox: value.bbox || null })); },
    async setProgress(input = {}) { const hash = safePaperHash(input.paperHash); return mutate((store) => { store.progress[hash] = timestampPatch(store.progress[hash] || { paperHash: hash, createdAt: now() }, { ...object(input), paperHash: hash, percent: clamp(input.percent, 0, 100), page: Math.max(0, Number(input.page) || 0) }); return store.progress[hash]; }); },
    getProgress: (paperHash) => clone(load().progress[safePaperHash(paperHash)] || null),
    getItem: (collection, id) => {
      if (!["notes", "bookmarks"].includes(collection)) throw new Error("unsupported collection");
      const key = safeId(id);
      return clone(load()[collection][key] || null);
    },
    listItems: (collection, paperHash, limit = MAX_SNAPSHOT_ITEMS) => {
      if (!["notes", "bookmarks"].includes(collection)) throw new Error("unsupported collection");
      const hash = safePaperHash(paperHash);
      return Object.values(load()[collection]).filter((item) => item.paperHash === hash)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, clamp(limit, 1, MAX_SNAPSHOT_ITEMS)).map(clone);
    },
    async deleteItem(collection, id) { if (!["notes", "bookmarks"].includes(collection)) throw new Error("unsupported collection"); const key = safeId(id); return mutate((store) => { const found = Object.values(store[collection]).some((item) => item.id === key); for (const hash of Object.keys(store[collection])) { if (store[collection][hash]?.id === key) delete store[collection][hash]; } return found; }); },
    async putGlossary(input = {}) { const hash = safePaperHash(input.paperHash); return mutate((store) => { const previous = store.glossaries[hash] || { paperHash: hash, version: 0, terms: {}, createdAt: now() }; const terms = { ...previous.terms, ...Object.fromEntries(Object.entries(object(input.terms)).map(([key, value]) => [text(key, 200), text(value, 500)]).filter(([key, value]) => key && value)) }; store.glossaries[hash] = timestampPatch(previous, { paperHash: hash, terms, version: previous.version + 1 }); return store.glossaries[hash]; }); },
    getGlossary: (paperHash) => clone(load().glossaries[safePaperHash(paperHash)] || { paperHash: safePaperHash(paperHash), version: 0, terms: {} }),
    async deleteGlossaryTerm(paperHash, term) { const hash = safePaperHash(paperHash); return mutate((store) => { const glossary = store.glossaries[hash]; if (!glossary) return false; delete glossary.terms[text(term, 200)]; glossary.version += 1; glossary.updatedAt = now(); return true; }); },
    async putTranslation(input = {}) { const hash = safePaperHash(input.paperHash); const blockId = safeBlockId(input.blockId); const glossaryVersion = Number.isInteger(input.glossaryVersion) ? input.glossaryVersion : 0; const key = `${hash}:${blockId}:${glossaryVersion}`; return mutate((store) => { store.translationCache[key] = timestampPatch(object(input), { key, paperHash: hash, blockId, glossaryVersion, source: text(input.source), translation: text(input.translation), createdAt: store.translationCache[key]?.createdAt || now() }); return store.translationCache[key]; }); },
    getTranslation: (paperHash, blockId, glossaryVersion) => clone(load().translationCache[`${safePaperHash(paperHash)}:${safeBlockId(blockId)}:${Number(glossaryVersion) || 0}`] || null),
    snapshot(paperHash, options = {}) {
      const hash = safePaperHash(paperHash); const paper = getPaper(hash); if (!paper) return null; const limit = clamp(options.limit || MAX_SNAPSHOT_ITEMS, 1, MAX_SNAPSHOT_ITEMS);
      return { paper: { ...clone(paper), blocks: undefined, blockIndex: clone(paper.blockIndex.slice(0, limit)), resources: clone(paper.resources.slice(0, limit)), outline: clone(paper.outline.slice(0, limit)) }, tasks: api.listTasks(hash, limit), notes: Object.values(load().notes).filter((item) => item.paperHash === hash).slice(0, limit).map(clone), bookmarks: Object.values(load().bookmarks).filter((item) => item.paperHash === hash).slice(0, limit).map(clone), progress: api.getProgress(hash), glossary: api.getGlossary(hash), translationCount: Object.values(load().translationCache).filter((item) => item.paperHash === hash).length };
    },
  };

  async function putAnchored(collection, input, extra) {
    const hash = safePaperHash(input.paperHash); const blockId = safeBlockId(input.blockId); const id = safeId(input.id || randomUUID());
    return mutate((store) => { const record = timestampPatch({ ...object(input), ...extra(input), id, paperHash: hash, blockId }, { id, paperHash: hash, blockId }); store[collection][id] = record; return record; });
  }
  return api;
}

export function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
export { SCHEMA_VERSION, TASK_STATES };
