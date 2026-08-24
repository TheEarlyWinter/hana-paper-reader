import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const STORAGE_LAYOUT = "per-paper-v1";
const PAPER_DIR_NAME = "papers";

const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

function readJson(filePath, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; }
}

function atomicWriteSync(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

async function atomicWrite(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
    await fs.promises.rename(temporary, filePath);
  } finally {
    try { await fs.promises.unlink(temporary); } catch {}
  }
}

function paperDir(rootDir, paperHash) {
  return path.join(rootDir, PAPER_DIR_NAME, paperHash);
}

function paperFiles(rootDir, paperHash) {
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
  return Object.fromEntries(Object.entries(object(collection)).filter(([, value]) => value?.paperHash === paperHash));
}

function splitPaperData(data, paperHash) {
  const paper = object(data.papers?.[paperHash]);
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
      paperHash,
      notes: recordsForPaper(data.notes, paperHash),
      bookmarks: recordsForPaper(data.bookmarks, paperHash),
      progress: data.progress?.[paperHash] || null,
      glossary: data.glossaries?.[paperHash] || null,
      readingMode: paper.readingMode || "bilingual",
    },
    translations: {
      paperHash,
      translations: object(paper.translations),
      translationStates: object(paper.translationStates),
      translationGlossaryVersion: Number(paper.translationGlossaryVersion) || 0,
      cache: recordsForPaper(data.translationCache, paperHash),
    },
    tasks: {
      paperHash,
      tasks: recordsForPaper(data.tasks, paperHash),
    },
  };
}

function paperIndexEntry(paperHash, paper) {
  return {
    paperHash,
    metadata: object(paper.metadata),
    parser: object(paper.parser),
    createdAt: paper.createdAt || null,
    updatedAt: paper.updatedAt || null,
    blockCount: Array.isArray(paper.blocks) ? paper.blocks.length : 0,
    structureDetached: paper.structureDetached === true || paper.parser?.structureDetached === true,
    storagePath: `${PAPER_DIR_NAME}/${paperHash}`,
  };
}

function workspaceIndex(data, schemaVersion) {
  return {
    schemaVersion,
    storageLayout: STORAGE_LAYOUT,
    updatedAt: data.updatedAt,
    papers: Object.fromEntries(Object.entries(object(data.papers)).map(([paperHash, paper]) => [paperHash, paperIndexEntry(paperHash, paper)])),
  };
}

export function createPaperStorage(options = {}) {
  const indexPath = path.resolve(options.filePath);
  const rootDir = path.dirname(indexPath);
  const schemaVersion = Number(options.schemaVersion) || 3;

  function load() {
    let root;
    try {
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
      papers: {}, tasks: {}, notes: {}, bookmarks: {}, progress: {}, glossaries: {}, translationCache: {},
    };
    for (const [paperHash, indexEntry] of Object.entries(object(root.papers))) {
      const files = paperFiles(rootDir, paperHash);
      const structure = readJson(files.structure, indexEntry);
      const research = readJson(files.research, {});
      const translations = readJson(files.translations, {});
      const tasks = readJson(files.tasks, {});
      aggregate.papers[paperHash] = {
        ...object(indexEntry),
        ...object(structure),
        paperHash,
        readingMode: research.readingMode || structure.readingMode || "bilingual",
        translations: object(translations.translations),
        translationStates: object(translations.translationStates),
        translationGlossaryVersion: Number(translations.translationGlossaryVersion) || 0,
      };
      Object.assign(aggregate.notes, object(research.notes));
      Object.assign(aggregate.bookmarks, object(research.bookmarks));
      if (research.progress) aggregate.progress[paperHash] = research.progress;
      if (research.glossary) aggregate.glossaries[paperHash] = research.glossary;
      Object.assign(aggregate.translationCache, object(translations.cache));
      Object.assign(aggregate.tasks, object(tasks.tasks));
    }
    return { source: aggregate, previousVersion, split: true };
  }

  function writeSync(data) {
    for (const [paperHash] of Object.entries(object(data.papers))) {
      const files = paperFiles(rootDir, paperHash);
      const split = splitPaperData(data, paperHash);
      atomicWriteSync(files.structure, split.structure);
      atomicWriteSync(files.research, split.research);
      atomicWriteSync(files.translations, split.translations);
      atomicWriteSync(files.tasks, split.tasks);
    }
    atomicWriteSync(indexPath, workspaceIndex(data, schemaVersion));
  }

  async function write(data) {
    for (const [paperHash] of Object.entries(object(data.papers))) {
      const files = paperFiles(rootDir, paperHash);
      const split = splitPaperData(data, paperHash);
      await atomicWrite(files.structure, split.structure);
      await atomicWrite(files.research, split.research);
      await atomicWrite(files.translations, split.translations);
      await atomicWrite(files.tasks, split.tasks);
    }
    await atomicWrite(indexPath, workspaceIndex(data, schemaVersion));
  }

  function removePaper(paperHash) {
    fs.rmSync(paperDir(rootDir, paperHash), { recursive: true, force: true });
  }

  function fileSize(filePath) {
    try { const stat = fs.statSync(filePath); return stat.isFile() ? stat.size : 0; } catch { return 0; }
  }

  function stats(paperHash) {
    const files = paperFiles(rootDir, paperHash);
    const structureBytes = fileSize(files.structure);
    const translationBytes = fileSize(files.translations);
    const researchBytes = fileSize(files.research) + fileSize(files.tasks);
    return {
      paperHash,
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
