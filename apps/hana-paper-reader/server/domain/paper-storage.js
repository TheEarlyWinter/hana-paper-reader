import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { assertCacheId, assertPaperHash, isSafePaperHash, normalizePaperHash, normalizeCacheId } from "./paper-identity.js";
import { verifyNoSymlinks } from "./paper-path-guard.js";
import { withStorageRead, runStorageTransaction, runStorageTransactionAsync } from "./paper-storage-transaction.js";
import { normalizeRevisionClocks } from "./paper-revision.js";

export const STORAGE_LAYOUT = "per-paper-v1";
const PAPER_DIR_NAME = "papers";

const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const integrity = new Error(`paper shard is unreadable: ${path.basename(filePath)}`);
    integrity.code = "workspace_integrity_error";
    integrity.cause = error;
    throw integrity;
  }
}

export function paperDir(rootDir, paperHash) {
  const safeHash = assertPaperHash(paperHash);
  verifyNoSymlinks(rootDir, rootDir);
  const papersRoot = path.resolve(rootDir, PAPER_DIR_NAME);
  const resolved = path.resolve(papersRoot, safeHash);
  const rel = path.relative(papersRoot, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes("..")) {
    throw new Error(`paper directory escapes storage root: "${paperHash}"`);
  }
  verifyNoSymlinks(resolved, rootDir);
  return resolved;
}

export function paperFiles(rootDir, paperHash) {
  const directory = paperDir(rootDir, paperHash);
  return {
    directory,
    structure: path.join(directory, "paper.json"),
    research: path.join(directory, "research.json"),
    translations: path.join(directory, "translations.json"),
    tasks: path.join(directory, "tasks.json"),
  };
}

function recordsForPaper(collection, paperHash) {
  const safeHash = normalizePaperHash(paperHash);
  return Object.fromEntries(Object.entries(object(collection)).filter(([, value]) => normalizePaperHash(value?.paperHash) === safeHash));
}

function splitPaperData(data, paperHash) {
  const safeHash = assertPaperHash(paperHash);
  let paper = object(data.papers?.[safeHash]);
  if (!paper || Object.keys(paper).length === 0) {
    for (const [k, v] of Object.entries(object(data.papers))) {
      if (normalizePaperHash(k) === safeHash) {
        paper = object(v);
        break;
      }
    }
  }
  const {
    translations: _translations,
    translationStates: _translationStates,
    translationGlossaryVersion: _translationGlossaryVersion,
    readingMode: _readingMode,
    blockIndex: _blockIndex,
    outline: _outline,
    resources: _resources,
    ...structure
  } = paper;
  return {
    structure,
    research: {
      paperHash: safeHash,
      notes: recordsForPaper(data.notes, safeHash),
      bookmarks: recordsForPaper(data.bookmarks, safeHash),
      progress: data.progress?.[safeHash] || null,
      glossary: data.glossaries?.[safeHash] || null,
      readingMode: paper.readingMode || "bilingual",
    },
    translations: {
      paperHash: safeHash,
      translations: object(paper.translations),
      translationStates: object(paper.translationStates),
      translationGlossaryVersion: Number(paper.translationGlossaryVersion) || 0,
      cache: recordsForPaper(data.translationCache, safeHash),
    },
    tasks: {
      paperHash: safeHash,
      tasks: recordsForPaper(data.tasks, safeHash),
    },
  };
}

function paperIndexEntry(paperHash, paper) {
  const safeHash = assertPaperHash(paperHash);
  return {
    paperHash: safeHash,
    metadata: object(paper.metadata),
    parser: object(paper.parser),
    createdAt: paper.createdAt || null,
    updatedAt: paper.updatedAt || null,
    lastReadAt: paper.lastReadAt || paper.metadata?.lastReadAt || null,
    blockCount: Array.isArray(paper.blocks) ? paper.blocks.length : (Array.isArray(paper.blockIndex) ? paper.blockIndex.length : (Number(paper.blockCount) || 0)),
    structureDetached: paper.structureDetached === true || paper.parser?.structureDetached === true,
    storagePath: `${PAPER_DIR_NAME}/${safeHash}`,
  };
}

function workspaceIndex(data, schemaVersion) {
  const entries = {};
  for (const [rawHash, paper] of Object.entries(object(data.papers))) {
    const safeHash = assertPaperHash(rawHash);
    entries[safeHash] = paperIndexEntry(safeHash, paper);
  }
  return {
    schemaVersion,
    storageLayout: STORAGE_LAYOUT,
    updatedAt: data.updatedAt,
    revisionClocks: normalizeRevisionClocks(data.revisionClocks, data.papers),
    papers: entries,
  };
}

export function createPaperStorage(options = {}) {
  const indexPath = path.resolve(options.filePath);
  const rootDir = path.dirname(indexPath);
  const schemaVersion = Number(options.schemaVersion) || 3;

  function loadOwned() {
    verifyNoSymlinks(rootDir, rootDir);
    let root;
    let token;
    let stamp;
    try {
      verifyNoSymlinks(indexPath, rootDir);
      const bytes = fs.readFileSync(indexPath);
      token = createHash("sha256").update(bytes).digest("hex");
      const stat = fs.statSync(indexPath);
      stamp = `${stat.mtimeMs}:${stat.size}`;
      root = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return { source: null, previousVersion: schemaVersion, split: false, token: "missing", stamp: "missing" };
      throw error;
    }
    const previousVersion = Number(root.schemaVersion) || 1;
    if (root.storageLayout !== STORAGE_LAYOUT) return { source: root, previousVersion, split: false, token, stamp };

    const aggregate = {
      schemaVersion,
      updatedAt: root.updatedAt || new Date().toISOString(),
      revisionClocks: root.revisionClocks,
      papers: {}, tasks: {}, notes: {}, bookmarks: {}, progress: {}, glossaries: {}, translationCache: {},
    };
    const seenHashes = new Set();
    for (const [rawHash, indexEntry] of Object.entries(object(root.papers))) {
      if (!isSafePaperHash(rawHash)) continue;
      const canonicalHash = normalizePaperHash(rawHash);
      if (seenHashes.has(canonicalHash)) continue;
      if (indexEntry?.paperHash && normalizePaperHash(indexEntry.paperHash) !== canonicalHash) continue;
      seenHashes.add(canonicalHash);

      try {
        const files = paperFiles(rootDir, canonicalHash);
        verifyNoSymlinks(files.directory, rootDir);
        const structure = readJson(files.structure, indexEntry);
        const research = readJson(files.research, {});
        const translations = readJson(files.translations, {});
        const tasks = readJson(files.tasks, {});
        aggregate.papers[canonicalHash] = {
          ...object(indexEntry),
          ...object(structure),
          paperHash: canonicalHash,
          readingMode: research.readingMode || structure.readingMode || "bilingual",
          translations: object(translations.translations),
          translationStates: object(translations.translationStates),
          translationGlossaryVersion: Number(translations.translationGlossaryVersion) || 0,
        };
        Object.assign(aggregate.notes, object(research.notes));
        Object.assign(aggregate.bookmarks, object(research.bookmarks));
        if (research.progress) aggregate.progress[canonicalHash] = research.progress;
        if (research.glossary) aggregate.glossaries[canonicalHash] = research.glossary;
        Object.assign(aggregate.translationCache, object(translations.cache));
        Object.assign(aggregate.tasks, object(tasks.tasks));
      } catch (error) {
        throw error;
      }
    }
    aggregate.revisionClocks = normalizeRevisionClocks(aggregate.revisionClocks, aggregate.papers);
    return { source: aggregate, previousVersion, split: true, token, stamp };
  }

  function load() { return withStorageRead(rootDir, indexPath, loadOwned); }

  function readSnapshot(project) {
    if (typeof project !== "function") throw new TypeError("A synchronous snapshot projection is required");
    return withStorageRead(rootDir, indexPath, () => project(loadOwned()));
  }

  function preflightCheckPapers(data) {
    verifyNoSymlinks(rootDir, rootDir);
    const papers = object(data?.papers);
    const canonicalMap = new Map();
    for (const [rawHash, paper] of Object.entries(papers)) {
      const canonical = assertPaperHash(rawHash);
      if (canonicalMap.has(canonical)) {
        throw new Error(`duplicate canonical paper hash in storage write: "${canonical}"`);
      }
      canonicalMap.set(canonical, paper);
      paperDir(rootDir, canonical);
    }
    return canonicalMap;
  }

  function prepareWriteOperations(data, canonicalMap, writeOptions = {}) {
    if (writeOptions.expectedIndexToken !== undefined) {
      const expected = writeOptions.expectedIndexToken;
      if (typeof expected !== "string" || !/^(?:missing|[a-f0-9]{64})$/.test(expected)) throw new Error("workspace snapshot token is invalid");
      verifyNoSymlinks(indexPath, rootDir);
      const current = fs.existsSync(indexPath) ? createHash("sha256").update(fs.readFileSync(indexPath)).digest("hex") : "missing";
      if (current !== expected) throw Object.assign(new Error("工作区快照已被其他写入者更新，请重新载入"), { code: "workspace_conflict", status: 409 });
    }
    const operations = [];
    if (writeOptions.assets !== undefined && !Array.isArray(writeOptions.assets)) throw new Error("paper asset operations are invalid");
    for (const asset of writeOptions.assets || []) {
      operations.push({ filePath: asset.finalDest, content: asset.bytes, requireAbsentOrIdentical: true });
    }
    let scope = null;
    if (writeOptions.paperHashes !== undefined) {
      if (!Array.isArray(writeOptions.paperHashes) || !writeOptions.paperHashes.length) throw new Error("paper write scope is invalid");
      scope = new Set(writeOptions.paperHashes.map(assertPaperHash));
    }
    for (const [canonicalHash] of canonicalMap.entries()) {
      if (scope && !scope.has(canonicalHash)) continue;
      const files = paperFiles(rootDir, canonicalHash);
      const split = splitPaperData(data, canonicalHash);
      operations.push(
        { filePath: files.structure, content: JSON.stringify(split.structure, null, 2) },
        { filePath: files.research, content: JSON.stringify(split.research, null, 2) },
        { filePath: files.translations, content: JSON.stringify(split.translations, null, 2) },
        { filePath: files.tasks, content: JSON.stringify(split.tasks, null, 2) }
      );
    }
    let index = workspaceIndex(data, schemaVersion);
    if (scope && fs.existsSync(indexPath)) {
      verifyNoSymlinks(indexPath, rootDir);
      const previous = readJson(indexPath);
      if (previous.storageLayout !== STORAGE_LAYOUT || !previous.papers || typeof previous.papers !== "object" || Array.isArray(previous.papers)) {
        throw new Error("scoped paper write requires a split workspace index");
      }
      // Existing index entries and shards are retained verbatim. Loading a
      // workspace adds derived metadata that must not rewrite other papers.
      const entries = { ...object(previous.papers) };
      for (const hash of scope) {
        if (index.papers[hash]) entries[hash] = index.papers[hash];
        else delete entries[hash];
      }
      index = { ...previous, schemaVersion, updatedAt: data.updatedAt, papers: entries, revisionClocks: index.revisionClocks };
    }
    operations.push({
      filePath: indexPath,
      content: JSON.stringify(index, null, 2),
    });
    return operations;
  }

  function writeSync(data, writeOptions = {}) {
    return runStorageTransaction(rootDir, indexPath, () => prepareWriteOperations(data, preflightCheckPapers(data), writeOptions));
  }

  async function write(data, writeOptions = {}) {
    return runStorageTransactionAsync(rootDir, indexPath, () => prepareWriteOperations(data, preflightCheckPapers(data), writeOptions));
  }

  function removePaper(paperHash) {
    const hash = assertPaperHash(paperHash);
    return withStorageRead(rootDir, indexPath, () => {
      // The index removal and physical cleanup have different commit points.
      // A newly created paper with this hash must keep all of its shards.
      if (loadOwned().source?.papers?.[hash]) return false;
      fs.rmSync(paperDir(rootDir, hash), { recursive: true, force: true });
      return true;
    });
  }

  function cleanupAssets(candidateIds = [], options = {}) {
    if (!Array.isArray(candidateIds)) throw new Error("cache cleanup candidates are invalid");
    const candidates = [...new Set(candidateIds.map(assertCacheId))];
    const empty = () => ({ removedCacheIds: [], preservedCacheIds: [], deferredCacheIds: [] });
    if (!candidates.length) return empty();
    const excluded = options.excludePaperHash ? assertPaperHash(options.excludePaperHash) : null;
    try {
      return withStorageRead(rootDir, indexPath, () => {
        const loaded = loadOwned();
        const papers = object(loaded.source?.papers);
        const result = empty();
        if (excluded && (!papers[excluded] || Number(papers[excluded].revision) !== options.expectedOwnerRevision
            || typeof options.expectedIndexToken !== "string" || loaded.token !== options.expectedIndexToken)) {
          return { ...result, deferredCacheIds: candidates, cleanupDeferred: true };
        }
        const used = new Set(Object.entries(papers).filter(([hash]) => hash !== excluded).flatMap(([, paper]) =>
          (Array.isArray(paper.blocks) ? paper.blocks : []).map(block => normalizeCacheId(block?.assetRef?.cacheId))
            .filter(id => /^[a-f0-9]{24}$/.test(id))));
        for (const id of candidates) {
          if (used.has(id)) { result.preservedCacheIds.push(id); continue; }
          const directory = path.resolve(rootDir, "mineru-cache", id);
          if (path.dirname(directory) !== path.join(rootDir, "mineru-cache")) throw new Error("cache cleanup path escapes root");
          try {
            verifyNoSymlinks(directory, rootDir);
            fs.rmSync(directory, { recursive: true, force: true });
            result.removedCacheIds.push(id);
          } catch { result.deferredCacheIds.push(id); }
        }
        if (result.deferredCacheIds.length) result.cleanupDeferred = true;
        return result;
      });
    } catch {
      // A live writer, uncertain recovery or unreadable references prevents all
      // deletion. Logical changes already committed must not be called undone.
      return { ...empty(), deferredCacheIds: candidates, cleanupDeferred: true };
    }
  }

  function fileSize(filePath) {
    try { const stat = fs.statSync(filePath); return stat.isFile() ? stat.size : 0; } catch { return 0; }
  }

  function stats(paperHash) {
    const canonicalHash = assertPaperHash(paperHash);
    const files = paperFiles(rootDir, canonicalHash);
    const structureBytes = fileSize(files.structure);
    const translationBytes = fileSize(files.translations);
    const researchBytes = fileSize(files.research) + fileSize(files.tasks);
    return {
      paperHash: canonicalHash,
      layout: STORAGE_LAYOUT,
      structureBytes,
      translationBytes,
      researchBytes,
      files: {
        structure: path.relative(rootDir, files.structure).replace(/\\/g, "/"),
        research: path.relative(rootDir, files.research).replace(/\\/g, "/"),
        translations: path.relative(rootDir, files.translations).replace(/\\/g, "/"),
        tasks: path.relative(rootDir, files.tasks).replace(/\\/g, "/"),
      },
    };
  }

  return { indexPath, rootDir, load, readSnapshot, write, writeSync, atomicTransactions: true, ownsAssetTransactions: true, removePaper, cleanupAssets, stats, paperFiles: (hash) => paperFiles(rootDir, hash) };
}
