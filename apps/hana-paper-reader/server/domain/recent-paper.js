import fs from "node:fs";
import path from "node:path";
import { withStorageRead } from "./paper-storage-transaction.js";
import { storageStateFailure } from "./workspace-storage-errors.js";
import { normalizeRevisionClocks, assertPaperRevisionClock, paperGenerationOf } from "./paper-revision.js";

const PAPER_HASH_RE = /^[a-f0-9]{12,128}$/i;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_PAPER_BYTES = 128 * 1024 * 1024;
const PER_PAPER_STORAGE_LAYOUT = "per-paper-v1";
const REQUIRED_PER_PAPER_SHARDS = ["research.json", "translations.json", "tasks.json"];
const PUBLIC_READING_MODES = new Set(["original", "bilingual", "translation", "contrast"]);
const VISUAL_BLOCK_TYPES = new Set(["chart", "equation", "image", "table"]);

export class WorkspaceIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkspaceIntegrityError";
    this.code = "workspace_integrity_error";
  }
}

function assertDataDir(dataDir) {
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
    throw new WorkspaceIntegrityError("App data directory is unavailable");
  }
  return dataDir;
}

function readJsonFile(filePath, label, maxBytes) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new WorkspaceIntegrityError(`${label} cannot be read`);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) {
    throw new WorkspaceIntegrityError(`${label} is not a valid regular file`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new WorkspaceIntegrityError(`${label} is not valid JSON`);
  }
}

function assertDirectory(directoryPath, label) {
  try {
    const stat = fs.lstatSync(directoryPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new WorkspaceIntegrityError(`${label} is not a valid directory`);
    }
    return true;
  } catch (error) {
    if (error instanceof WorkspaceIntegrityError) throw error;
    if (error?.code === "ENOENT") return false;
    throw new WorkspaceIntegrityError(`${label} cannot be inspected`);
  }
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceIntegrityError(`${label} must be an object`);
  }
  return value;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function paperHashFor(key, value) {
  const candidate = typeof value?.paperHash === "string" ? value.paperHash : key;
  const normalized = candidate.trim().toLowerCase();
  if (!PAPER_HASH_RE.test(normalized)) {
    throw new WorkspaceIntegrityError("paper-workspace.json contains an invalid paper hash");
  }
  return normalized;
}

function timestampOf(value) {
  const candidates = [value?.updatedAt, value?.lastReadAt, value?.createdAt];
  for (const candidate of candidates) {
    const time = Date.parse(candidate);
    if (Number.isFinite(time)) return time;
  }
  return 0;
}

function selectRecentEntry(papers) {
  const entries = [];
  const seen = new Set();
  for (const [key, value] of Object.entries(papers)) {
    const record = assertRecord(value, `paper ${key}`);
    const paperHash = paperHashFor(key, record);
    if (seen.has(paperHash)) throw new WorkspaceIntegrityError(`duplicate canonical paper hash: ${paperHash}`);
    seen.add(paperHash);
    entries.push({ paperHash, record, updatedAt: timestampOf(record) });
  }
  entries.sort((left, right) => right.updatedAt - left.updatedAt || left.paperHash.localeCompare(right.paperHash));
  return entries[0] || null;
}

function paperDirectoryPath(dataDir, paperHash) {
  const papersDir = path.resolve(dataDir, "papers");
  const paperDir = path.resolve(papersDir, paperHash);
  const relative = path.relative(papersDir, paperDir);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || path.basename(paperDir) !== paperHash) {
    throw new WorkspaceIntegrityError("paper path escaped the App data directory");
  }
  return { papersDir, paperDir };
}

function paperFilePath(dataDir, paperHash, fileName = "paper.json") {
  if (!/^[A-Za-z0-9._-]+$/.test(fileName)) throw new WorkspaceIntegrityError("paper shard name is invalid");
  const { paperDir } = paperDirectoryPath(dataDir, paperHash);
  return path.join(paperDir, fileName);
}

function assertShardHash(shard, paperHash, label) {
  const record = assertRecord(shard, label);
  if (record.paperHash !== undefined && paperHashFor(paperHash, { paperHash: record.paperHash }) !== paperHash) {
    throw new WorkspaceIntegrityError(`${label} has a mismatched paper hash`);
  }
  return record;
}

function readRequiredShard(dataDir, paperHash, fileName) {
  const shard = readJsonFile(paperFilePath(dataDir, paperHash, fileName), `papers/${paperHash}/${fileName}`, MAX_PAPER_BYTES);
  if (!shard) throw new WorkspaceIntegrityError(`paper ${paperHash} is missing its ${fileName} shard`);
  return assertShardHash(shard, paperHash, `papers/${paperHash}/${fileName}`);
}

function resourcesFromBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block && (VISUAL_BLOCK_TYPES.has(String(block.type || "").toLowerCase()) || block.assetRef || block.crop || block.tableHtml))
    .map((block) => ({
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
}

function publicCachedPaper(paper) {
  const source = assertRecord(paper, "paper");
  const parser = object(source.parser);
  const glossaryTerms = object(source.glossaryTerms);
  return {
    paperHash: source.paperHash,
    generation: paperGenerationOf(source),
    revision: Number.isSafeInteger(Number(source.revision)) && Number(source.revision) >= 0 ? Number(source.revision) : 0,
    metadata: object(source.metadata),
    parser,
    blocks: Array.isArray(source.blocks) ? source.blocks : [],
    resources: Array.isArray(source.resources) ? source.resources : resourcesFromBlocks(source.blocks),
    translations: object(source.translations),
    translationStates: object(source.translationStates),
    readingMode: PUBLIC_READING_MODES.has(source.readingMode) ? source.readingMode : "bilingual",
    structureDetached: source.structureDetached === true || parser.structureDetached === true,
    glossaryVersion: Number.isInteger(Number(source.glossaryVersion)) ? Number(source.glossaryVersion) : 0,
    glossaryTerms,
    translationGlossaryVersion: Number.isInteger(Number(source.translationGlossaryVersion)) ? Number(source.translationGlossaryVersion) : 0,
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || null,
  };
}

function paperFilePathForExistingLayout(dataDir, paperHash) {
  const { papersDir, paperDir } = paperDirectoryPath(dataDir, paperHash);
  if (!assertDirectory(papersDir, "papers")) {
    throw new WorkspaceIntegrityError(`paper ${paperHash} is missing its paper directory`);
  }
  if (!assertDirectory(paperDir, `papers/${paperHash}`)) {
    throw new WorkspaceIntegrityError(`paper ${paperHash} is missing its paper directory`);
  }
  return paperFilePath(dataDir, paperHash);
}

function loadPaper(dataDir, entry, storageLayout) {
  const filePath = paperFilePathForExistingLayout(dataDir, entry.paperHash);
  const paper = readJsonFile(filePath, `papers/${entry.paperHash}/paper.json`, MAX_PAPER_BYTES);
  if (!paper) throw new WorkspaceIntegrityError(`paper ${entry.paperHash} is missing its paper.json shard`);
  const normalized = {
    ...assertShardHash(paper, entry.paperHash, `paper ${entry.paperHash}`),
    paperHash: entry.paperHash,
  };

  if (storageLayout === PER_PAPER_STORAGE_LAYOUT) {
    const research = readRequiredShard(dataDir, entry.paperHash, "research.json");
    const translations = readRequiredShard(dataDir, entry.paperHash, "translations.json");
    readRequiredShard(dataDir, entry.paperHash, "tasks.json");
    return publicCachedPaper({
      ...normalized,
      translations: { ...object(normalized.translations), ...object(translations.translations) },
      translationStates: { ...object(normalized.translationStates), ...object(translations.translationStates) },
      readingMode: research.readingMode || normalized.readingMode,
      glossaryVersion: research.glossary?.version,
      glossaryTerms: research.glossary?.terms,
      translationGlossaryVersion: translations.translationGlossaryVersion,
    });
  }

  return publicCachedPaper(normalized);
}

export function readRecentPaper(dataDir) {
  const root = assertDataDir(dataDir);
  return readCommittedWorkspace(root, () => {
    const indexPath = path.join(root, "paper-workspace.json");
    const index = readJsonFile(indexPath, "paper-workspace.json", MAX_INDEX_BYTES);
    if (!index) return null;
    assertRecord(index, "paper-workspace.json");
    if (Number(index.schemaVersion) !== 3) {
      throw new WorkspaceIntegrityError("paper-workspace.json has an unsupported schema version");
    }
    if (index.storageLayout !== undefined && index.storageLayout !== PER_PAPER_STORAGE_LAYOUT) {
      throw new WorkspaceIntegrityError("paper-workspace.json has an unsupported storage layout");
    }
    const papers = index.papers === undefined
      ? {}
      : assertRecord(index.papers, "paper-workspace.json papers");
    const clocks = normalizeRevisionClocks(index.revisionClocks);
    const recent = selectRecentEntry(papers);
    if (!recent) return null;
    const paper = loadPaper(root, recent, index.storageLayout);
    assertPaperRevisionClock(clocks, recent.paperHash, paper);
    return paper;
  });
}

export function readCommittedWorkspace(dataDir, read) {
  const root = assertDataDir(dataDir);
  try { return withStorageRead(root, path.join(root, "paper-workspace.json"), read); }
  catch (error) {
    if (error instanceof WorkspaceIntegrityError || storageStateFailure(error)) throw error;
    throw new WorkspaceIntegrityError("工作区存储不可用，无法读取已提交的数据");
  }
}

export { publicCachedPaper };
