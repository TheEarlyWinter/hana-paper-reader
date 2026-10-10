import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { publicCachedPaper, WorkspaceIntegrityError, readCommittedWorkspace } from "./recent-paper.js";
import { normalizeRevisionClocks, assertPaperRevisionClock } from "./paper-revision.js";
import { searchBlocks as searchProjectedBlocks, projectLibraryItem, filterAndSortLibraryItems } from "./paper-read-projection.js";
import { evidenceRequestBasis, selectionRequestBasis } from "../../ui/assets/evidence-source.js";

const PAPER_HASH_RE = /^[a-f0-9]{12,128}$/i;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_PAPER_BYTES = 128 * 1024 * 1024;
const STORAGE_LAYOUT = "per-paper-v1";
const RESEARCH_SHARDS = ["research.json", "translations.json", "tasks.json"];
const SEARCH_LANGUAGES = new Set(["original", "translation", "both"]);
const SEARCH_SCOPES = new Set(["page", "section", "all"]);
const VISUAL_TYPES = new Set(["image", "chart", "table", "equation"]);

const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const array = (value) => Array.isArray(value) ? value : [];
const text = (value, max = 20000) => typeof value === "string" ? value.trim().slice(0, max) : "";

function assertDataDir(dataDir) {
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
    throw new WorkspaceIntegrityError("App data directory is unavailable");
  }
  return dataDir;
}

function readJsonFile(filePath, label, maxBytes, { missing = null } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return missing;
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

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceIntegrityError(`${label} must be an object`);
  }
  return value;
}

function readIndex(dataDir) {
  const root = assertDataDir(dataDir);
  const index = readJsonFile(path.join(root, "paper-workspace.json"), "paper-workspace.json", MAX_INDEX_BYTES);
  if (!index) return { schemaVersion: 3, storageLayout: STORAGE_LAYOUT, papers: {} };
  assertRecord(index, "paper-workspace.json");
  if (Number(index.schemaVersion) !== 3) {
    throw new WorkspaceIntegrityError("paper-workspace.json has an unsupported schema version");
  }
  if (index.storageLayout !== undefined && index.storageLayout !== STORAGE_LAYOUT) {
    throw new WorkspaceIntegrityError("paper-workspace.json has an unsupported storage layout");
  }
  const papers = index.papers === undefined ? {} : assertRecord(index.papers, "paper-workspace.json papers");
  return { ...index, papers, revisionClocks: normalizeRevisionClocks(index.revisionClocks) };
}

export function isSafePaperHash(value) {
  return typeof value === "string" && PAPER_HASH_RE.test(value.trim());
}

function canonicalPaperHash(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return isSafePaperHash(normalized) ? normalized : "";
}

function paperDirectory(dataDir, paperHash) {
  const root = path.resolve(assertDataDir(dataDir), "papers");
  const directory = path.resolve(root, paperHash);
  const relative = path.relative(root, directory);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || path.basename(directory) !== paperHash) {
    throw new WorkspaceIntegrityError("paper path escaped the App data directory");
  }
  return directory;
}

function paperShardPath(dataDir, paperHash, fileName) {
  if (!/^[A-Za-z0-9._-]+$/.test(fileName)) throw new WorkspaceIntegrityError("paper shard name is invalid");
  return path.join(paperDirectory(dataDir, paperHash), fileName);
}

function requiredShard(dataDir, paperHash, fileName) {
  const shard = readJsonFile(
    paperShardPath(dataDir, paperHash, fileName),
    `papers/${paperHash}/${fileName}`,
    MAX_PAPER_BYTES,
  );
  if (!shard) throw new WorkspaceIntegrityError(`paper ${paperHash} is missing its ${fileName} shard`);
  return assertRecord(shard, `papers/${paperHash}/${fileName}`);
}

function assertShardHash(shard, paperHash, label) {
  const record = assertRecord(shard, label);
  if (record.paperHash !== undefined && canonicalPaperHash(record.paperHash) !== paperHash) {
    throw new WorkspaceIntegrityError(`${label} has a mismatched paper hash`);
  }
  return record;
}

function evidenceIdFor(paperHash, blockId) {
  const suffix = createHash("sha256").update(`${paperHash}\0${blockId}`).digest("hex").slice(0, 24);
  return `ev-${paperHash.slice(0, 12)}-${suffix}`;
}

function normalizedPage(value) {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function normalizedBbox(value) {
  if (!Array.isArray(value) || value.length < 4) return null;
  const bbox = value.slice(0, 4).map(Number);
  return bbox.every(Number.isFinite) ? bbox : null;
}

function evidenceFromBlock(paper, block, usageKind = "reference") {
  const source = object(block);
  const blockId = text(source.id, 256);
  if (!blockId) return null;
  const visual = VISUAL_TYPES.has(text(source.type, 40).toLowerCase()) ? {
    type: text(source.type, 40),
    title: text(source.text, 2000),
    latex: text(source.latex, 20000),
    assetRef: source.assetRef || null,
    crop: normalizedBbox(source.crop),
    hasTableHtml: Boolean(text(source.tableHtml, 1)),
  } : null;
  return {
    evidenceSchemaVersion: 1,
    evidenceId: text(source.evidenceId, 128) || evidenceIdFor(paper.paperHash, blockId),
    paperHash: paper.paperHash,
    blockId,
    blockType: text(source.type, 40) || "paragraph",
    sectionId: text(source.sectionId, 256) || null,
    sectionTitle: text(source.sectionTitle, 1000) || null,
    page: normalizedPage(source.page),
    bbox: normalizedBbox(source.bbox),
    originalQuote: text(source.text || source.caption || source.latex),
    translation: text(source.translatedText),
    visualResource: visual,
    sourceKind: visual ? "visual-block" : "paper-block",
    usageKind: text(usageKind, 40) || "reference",
    validationStatus: "verified",
    createdAt: text(source.createdAt, 80) || text(paper.createdAt, 80) || null,
    updatedAt: text(source.updatedAt, 80) || text(paper.updatedAt, 80) || null,
  };
}

function listEvidence(paper, options = {}) {
  const type = text(options.type || options.blockType, 40).toLowerCase();
  const sectionId = text(options.sectionId, 256);
  const usageKind = text(options.usageKind, 40) || "reference";
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 100));
  return array(paper.blocks)
    .filter((block) => !type || text(block?.type, 40).toLowerCase() === type)
    .filter((block) => !sectionId || text(block?.sectionId, 256) === sectionId)
    .map((block) => evidenceFromBlock(paper, block, usageKind))
    .filter(Boolean)
    .slice(0, limit);
}

function resolveEvidence(paper, options = {}) {
  const evidenceId = text(options.evidenceId, 128);
  const blockId = text(options.blockId, 256);
  const block = array(paper.blocks).find((item) => (
    (evidenceId && text(item?.evidenceId, 128) === evidenceId)
    || (blockId && text(item?.id, 256) === blockId)
  ));
  return block ? evidenceFromBlock(paper, block, options.usageKind) : null;
}

function searchBlocks(paper, query, options = {}) {
  return searchProjectedBlocks(paper?.blocks, query, {
    ...options,
    paperHash: paper?.paperHash,
    normalizePage: true,
    normalizeBbox: true,
    resolveEvidence: (block) => evidenceFromBlock(paper, block),
  });
}

function outlineFor(paper) {
  return array(paper.blocks)
    .filter((block) => text(block?.type, 40).toLowerCase() === "heading" || text(block?.type, 40).toLowerCase() === "title" || Number(block?.level) > 0)
    .map((block, index) => ({
      id: text(block?.id, 256) || `heading-${index + 1}`,
      title: text(block?.text, 1000) || "Untitled",
      page: normalizedPage(block?.page),
      level: Math.max(1, Math.min(6, Number(block?.level) || 1)),
    }));
}

function readPaperBundleOwned(dataDir, rawPaperHash, knownIndex = null) {
  const root = assertDataDir(dataDir);
  const paperHash = canonicalPaperHash(rawPaperHash);
  if (!paperHash) return null;
  const index = knownIndex || readIndex(root);
  const indexEntry = index.papers[paperHash] || index.papers[rawPaperHash];
  if (!indexEntry) return null;
  const paper = assertShardHash(requiredShard(root, paperHash, "paper.json"), paperHash, `papers/${paperHash}/paper.json`);
  const normalized = { ...paper, paperHash };
  assertPaperRevisionClock(index.revisionClocks, paperHash, normalized);
  let research = { paperHash, notes: {}, bookmarks: {}, progress: null, glossary: null, readingMode: normalized.readingMode };
  let translations = { paperHash, translations: {}, translationStates: {}, translationGlossaryVersion: 0, cache: {} };
  let tasks = { paperHash, tasks: {} };
  if (index.storageLayout === STORAGE_LAYOUT) {
    research = assertShardHash(requiredShard(root, paperHash, "research.json"), paperHash, `papers/${paperHash}/research.json`);
    translations = assertShardHash(requiredShard(root, paperHash, "translations.json"), paperHash, `papers/${paperHash}/translations.json`);
    tasks = assertShardHash(requiredShard(root, paperHash, "tasks.json"), paperHash, `papers/${paperHash}/tasks.json`);
  }
  const publicPaper = publicCachedPaper({
    ...normalized,
    translations: { ...object(normalized.translations), ...object(translations.translations) },
    translationStates: { ...object(normalized.translationStates), ...object(translations.translationStates) },
    readingMode: research.readingMode || normalized.readingMode,
    glossaryVersion: research.glossary?.version,
    glossaryTerms: research.glossary?.terms,
    translationGlossaryVersion: translations.translationGlossaryVersion,
  });
  return { paper: publicPaper, rawPaper: normalized, research, translations, tasks, indexEntry };
}

function listLibraryOwned(dataDir, options = {}) {
  const root = assertDataDir(dataDir);
  const index = readIndex(root);
  const items = Object.entries(index.papers).map(([rawHash, entry]) => {
    const paperHash = canonicalPaperHash(rawHash);
    if (!paperHash) throw new WorkspaceIntegrityError("paper-workspace.json contains an invalid paper hash");
    const bundle = readPaperBundleOwned(root, paperHash, index);
    if (!bundle) throw new WorkspaceIntegrityError(`paper ${paperHash} cannot be loaded`);
    const research = object(bundle.research);
    const glossaryTerms = object(research.glossary?.terms || bundle.paper.glossaryTerms);
    return projectLibraryItem({
      paperHash,
      revision: bundle.paper.revision,
      paper: bundle.paper,
      entry,
      metadata: object(bundle.paper.metadata),
      progress: object(research.progress),
      noteCount: Object.keys(object(research.notes)).length,
      bookmarkCount: Object.keys(object(research.bookmarks)).length,
      hasGlossary: Object.keys(glossaryTerms).length > 0,
    });
  });
  return filterAndSortLibraryItems(items, options);
}

export function readPaperBundle(dataDir, rawPaperHash) {
  return readCommittedWorkspace(dataDir, () => readPaperBundleOwned(dataDir, rawPaperHash));
}

export function listLibrary(dataDir, options = {}) {
  return readCommittedWorkspace(dataDir, () => listLibraryOwned(dataDir, options));
}

export function readResearchPaper(dataDir, paperHash) {
  return readPaperBundle(dataDir, paperHash);
}

export function searchResearchPaper(dataDir, paperHash, query, options = {}) {
  const bundle = readPaperBundle(dataDir, paperHash);
  return bundle ? searchBlocks(bundle.paper, query, options) : null;
}

export function listResearchEvidence(dataDir, paperHash, options = {}) {
  const bundle = readPaperBundle(dataDir, paperHash);
  return bundle ? listEvidence(bundle.paper, options) : null;
}

export function getResearchEvidence(dataDir, paperHash, options = {}) {
  const bundle = readPaperBundle(dataDir, paperHash);
  return bundle ? resolveEvidence(bundle.paper, options) : null;
}

export function readResearchEvidenceSnapshot(dataDir, paperHash, options = {}) {
  return readCommittedWorkspace(dataDir, () => {
    const bundle = readPaperBundleOwned(dataDir, paperHash);
    if (!bundle) return null;
    const paper = bundle.paper;
    const sourceKind = options.sourceKind === "selection" ? "selection" : "research-question";
    const reference = options.evidenceId || options.blockId;
    const selected = reference ? resolveEvidence(paper, { ...options, usageKind: sourceKind }) : null;
    if (reference && (!selected || options.blockId && selected.blockId !== options.blockId
        || options.evidenceId && selected.evidenceId !== options.evidenceId)) return { paper, evidence: [], sourceBasis: null };
    const evidence = reference ? [selected] : listEvidence(paper, { limit: 12, usageKind: "research-question" }).filter(item => item.originalQuote || item.translation);
    return { paper, evidence, sourceKind, sourceBasis: sourceKind === "selection"
      ? selectionRequestBasis(paper, selected?.blockId) : evidenceRequestBasis(paper, selected?.blockId || null) };
  });
}

export function researchOutline(dataDir, paperHash) {
  const bundle = readPaperBundle(dataDir, paperHash);
  return bundle ? outlineFor(bundle.paper) : null;
}

export { STORAGE_LAYOUT };
