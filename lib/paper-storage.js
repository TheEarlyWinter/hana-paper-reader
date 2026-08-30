import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertPaperHash, isSafePaperHash, normalizePaperHash } from "./paper-identity.js";
import { verifyNoSymlinks } from "./paper-path-guard.js";

export const STORAGE_LAYOUT = "per-paper-v1";
const PAPER_DIR_NAME = "papers";

const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

function readJson(filePath, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; }
}

export function paperDir(rootDir, paperHash) {
  const safeHash = assertPaperHash(paperHash);
  verifyNoSymlinks(rootDir);
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
  const deleted = {};
  for (const [rawHash, tomb] of Object.entries(object(data.deletedPapers))) {
    if (isSafePaperHash(rawHash)) {
      const safeHash = normalizePaperHash(rawHash);
      deleted[safeHash] = object(tomb);
    }
  }
  return {
    schemaVersion,
    storageLayout: STORAGE_LAYOUT,
    updatedAt: data.updatedAt,
    papers: entries,
    deletedPapers: deleted,
  };
}

export function createPaperStorage(options = {}) {
  const indexPath = path.resolve(options.filePath);
  const rootDir = path.dirname(indexPath);
  const schemaVersion = Number(options.schemaVersion) || 3;

  function load() {
    verifyNoSymlinks(rootDir);
    let root;
    try {
      verifyNoSymlinks(indexPath, rootDir);
      root = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return { source: null, previousVersion: schemaVersion, split: false };
      throw error;
    }
    const previousVersion = Number(root.schemaVersion) || 1;
    if (root.storageLayout !== STORAGE_LAYOUT) return { source: root, previousVersion, split: false };

    const aggregate = {
      schemaVersion,
      updatedAt: root.updatedAt || new Date().toISOString(),
      papers: {}, deletedPapers: {}, tasks: {}, notes: {}, bookmarks: {}, progress: {}, glossaries: {}, translationCache: {},
    };
    for (const [rawHash, tomb] of Object.entries(object(root.deletedPapers))) {
      if (isSafePaperHash(rawHash)) {
        const canonical = normalizePaperHash(rawHash);
        aggregate.deletedPapers[canonical] = object(tomb);
      }
    }
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
      } catch {
        // Skip corrupted or inaccessible single paper
      }
    }
    return { source: aggregate, previousVersion, split: true };
  }

  function preflightCheckPapers(data) {
    verifyNoSymlinks(rootDir);
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

  function executeMultiFileTransaction(preparedOperations) {
    verifyNoSymlinks(rootDir);
    const backups = [];
    const createdTmpFiles = [];
    const successfullySwapped = [];

    try {
      // Step 1: Record byte snapshots of all existing target files
      for (const op of preparedOperations) {
        verifyNoSymlinks(path.dirname(op.filePath), rootDir);
        if (fs.existsSync(op.filePath)) {
          verifyNoSymlinks(op.filePath, rootDir);
          backups.push({
            filePath: op.filePath,
            content: fs.readFileSync(op.filePath),
            existed: true,
          });
        } else {
          backups.push({
            filePath: op.filePath,
            content: null,
            existed: false,
          });
        }
      }

      // Step 2: Write all operations into temporary files
      const stagedList = [];
      for (const op of preparedOperations) {
        fs.mkdirSync(path.dirname(op.filePath), { recursive: true });
        const temporary = `${op.filePath}.${process.pid}.${randomUUID()}.tmp`;
        createdTmpFiles.push(temporary);
        fs.writeFileSync(temporary, op.content, "utf8");
        stagedList.push({ temporary, finalPath: op.filePath });
      }

      // Step 3: Atomic rename
      for (const { temporary, finalPath } of stagedList) {
        verifyNoSymlinks(path.dirname(finalPath), rootDir);
        fs.renameSync(temporary, finalPath);
        successfullySwapped.push(finalPath);
      }
    } catch (writeErr) {
      // Rollback on failure
      const fatalRollbackErrors = [];
      for (const backup of backups) {
        try {
          if (backup.existed) {
            fs.writeFileSync(backup.filePath, backup.content);
          } else {
            if (fs.existsSync(backup.filePath)) {
              fs.unlinkSync(backup.filePath);
            }
          }
        } catch (rollbackErr) {
          fatalRollbackErrors.push({ filePath: backup.filePath, error: rollbackErr.message });
        }
      }
      if (fatalRollbackErrors.length > 0) {
        const fatal = new Error(`FATAL: storage transaction rollback failed: ${JSON.stringify(fatalRollbackErrors)}`);
        fatal.cause = writeErr;
        throw fatal;
      }
      throw writeErr;
    } finally {
      // Always cleanup any remaining tmp files
      for (const tmp of createdTmpFiles) {
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch {}
      }
    }
  }

  function prepareWriteOperations(data, canonicalMap) {
    const operations = [];
    for (const [canonicalHash] of canonicalMap.entries()) {
      const files = paperFiles(rootDir, canonicalHash);
      const split = splitPaperData(data, canonicalHash);
      operations.push(
        { filePath: files.structure, content: JSON.stringify(split.structure, null, 2) },
        { filePath: files.research, content: JSON.stringify(split.research, null, 2) },
        { filePath: files.translations, content: JSON.stringify(split.translations, null, 2) },
        { filePath: files.tasks, content: JSON.stringify(split.tasks, null, 2) }
      );
    }
    operations.push({
      filePath: indexPath,
      content: JSON.stringify(workspaceIndex(data, schemaVersion), null, 2),
    });
    return operations;
  }

  function writeSync(data) {
    const canonicalMap = preflightCheckPapers(data);
    const operations = prepareWriteOperations(data, canonicalMap);
    executeMultiFileTransaction(operations);
  }

  async function write(data) {
    const canonicalMap = preflightCheckPapers(data);
    const operations = prepareWriteOperations(data, canonicalMap);
    executeMultiFileTransaction(operations);
  }

  function removePaper(paperHash) {
    const dir = paperDir(rootDir, paperHash);
    fs.rmSync(dir, { recursive: true, force: true });
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

  return { indexPath, rootDir, load, write, writeSync, removePaper, stats, paperFiles: (hash) => paperFiles(rootDir, hash) };
}
