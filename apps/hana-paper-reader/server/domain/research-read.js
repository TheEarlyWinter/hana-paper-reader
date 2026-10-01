import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { publicCachedPaper, WorkspaceIntegrityError, readCommittedWorkspace } from "./recent-paper.js";
import { normalizeRevisionClocks, assertPaperRevisionClock } from "./paper-revision.js";
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

function occurrenceCount(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while ((cursor = haystack.indexOf(needle, cursor)) >= 0) {
    count += 1;
    cursor += needle.length;
  }
  return count;
}

function snippet(value, needle, max = 240) {
  const source = text(value);
  if (!source) return "";
  const index = source.toLocaleLowerCase().indexOf(needle);
  if (index < 0 || source.length <= max) return source.slice(0, max);
  const start = Math.max(0, index - Math.floor(max * 0.38));
  const end = Math.min(source.length, start + max);
  return `${start > 0 ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`;
}

function searchBlocks(paper, query, options = {}) {
  const needle = text(query, 200).toLocaleLowerCase();
  if (!needle) return [];
  const language = SEARCH_LANGUAGES.has(options.language) ? options.language : "both";
  const scope = SEARCH_SCOPES.has(options.scope) ? options.scope : "all";
  const page = Math.max(0, Number(options.page) || 0);
  const sectionId = text(options.sectionId, 256);
  const type = text(options.type || options.types, 100).toLowerCase();
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 100));
  return array(paper.blocks).map((block, index) => {
    const original = text(block?.text || block?.caption || block?.latex);
    const translation = text(block?.translatedText);
    const originalLower = original.toLocaleLowerCase();
    const translationLower = translation.toLocaleLowerCase();
    const originalCount = language === "translation" ? 0 : occurrenceCount(originalLower, needle);
    const translationCount = language === "original" ? 0 : occurrenceCount(translationLower, needle);
    const blockType = text(block?.type, 40).toLowerCase();
    const inScope = scope === "all"
      || (scope === "page" && page > 0 && Number(block?.page) === page)
      || (scope === "section" && sectionId && text(block?.sectionId, 256) === sectionId);
    if (!inScope || (type && blockType !== type) || (!originalCount && !translationCount)) return null;
    let score = Math.min(30, (originalCount + translationCount) * 8);
    const reasons = [`命中 ${originalCount + translationCount} 次`];
    if (["heading", "title", "section"].includes(blockType) || Number(block?.level) > 0) {
      score += 28;
      reasons.push("标题块 +28");
    }
    if (originalLower.startsWith(needle) || translationLower.startsWith(needle)) {
      score += 12;
      reasons.push("段首命中 +12");
    }
    return {
      id: text(block?.id, 256),
      evidenceId: text(block?.evidenceId, 128) || evidenceIdFor(paper.paperHash, text(block?.id, 256)),
      page: normalizedPage(block?.page),
      type: text(block?.type, 40) || "paragraph",
      text: original,
      translatedText: translation,
      sectionId: text(block?.sectionId, 256) || null,
      sectionTitle: text(block?.sectionTitle, 1000) || null,
      matches: { original: originalCount > 0, translated: translationCount > 0, originalCount, translatedCount: translationCount },
      snippets: { original: originalCount ? snippet(original, needle) : "", translation: translationCount ? snippet(translation, needle) : "" },
      score,
      scoreExplanation: reasons,
      bbox: normalizedBbox(block?.bbox),
      evidence: evidenceFromBlock(paper, block),
      index,
    };
  }).filter(Boolean)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(({ index: _index, ...result }) => result);
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
  const query = text(options.query || options.q, 200).toLocaleLowerCase();
  const filterFavorite = options.favorite === true || options.favorite === "true";
  const filterArchived = options.archived === "all" ? "all" : (options.archived === true || options.archived === "true");
  const filterTag = text(options.tag, 100).toLocaleLowerCase();
  const sortField = text(options.sort, 40) || "lastRead";
  const sortOrder = text(options.order, 10).toLowerCase() === "asc" ? "asc" : "desc";
  const items = Object.entries(index.papers).map(([rawHash, entry]) => {
    const paperHash = canonicalPaperHash(rawHash);
    if (!paperHash) throw new WorkspaceIntegrityError("paper-workspace.json contains an invalid paper hash");
    const bundle = readPaperBundleOwned(root, paperHash, index);
    if (!bundle) throw new WorkspaceIntegrityError(`paper ${paperHash} cannot be loaded`);
    const metadata = object(bundle.paper.metadata);
    const research = object(bundle.research);
    const notes = object(research.notes);
    const bookmarks = object(research.bookmarks);
    const progress = object(research.progress);
    const title = text(metadata.title, 500) || "未命名论文";
    const authors = Array.isArray(metadata.authors) ? metadata.authors : [];
    const tags = Array.isArray(metadata.tags) ? metadata.tags : [];
    return {
      paperHash,
      title,
      authors,
      doi: metadata.doi || null,
      year: metadata.year || null,
      tags,
      favorite: metadata.favorite === true,
      archived: metadata.archived === true,
      lastReadAt: entry.lastReadAt || bundle.paper.updatedAt || bundle.paper.createdAt || null,
      createdAt: bundle.paper.createdAt || entry.createdAt || null,
      updatedAt: bundle.paper.updatedAt || entry.updatedAt || null,
      blockCount: Number(entry.blockCount) || array(bundle.paper.blocks).length,
      noteCount: Object.keys(notes).length,
      bookmarkCount: Object.keys(bookmarks).length,
      readingProgress: {
        percent: Number(progress.percent) || 0,
        lastBlockId: progress.lastBlockId || null,
        readingMode: progress.readingMode || bundle.paper.readingMode || "bilingual",
      },
    };
  }).filter((item) => {
    if (filterFavorite && !item.favorite) return false;
    if (filterArchived === true && !item.archived) return false;
    if (filterArchived === false && item.archived) return false;
    if (filterTag && !item.tags.some((tag) => String(tag).toLocaleLowerCase().includes(filterTag))) return false;
    if (!query) return true;
    return [item.title, item.doi, item.paperHash, ...item.authors, ...item.tags]
      .some((value) => String(value || "").toLocaleLowerCase().includes(query));
  });
  items.sort((left, right) => {
    let compare;
    if (sortField === "title") compare = left.title.localeCompare(right.title, "zh-CN");
    else if (sortField === "created") compare = String(left.createdAt || "").localeCompare(String(right.createdAt || ""));
    else if (sortField === "updated") compare = String(left.updatedAt || "").localeCompare(String(right.updatedAt || ""));
    else compare = String(left.lastReadAt || "").localeCompare(String(right.lastReadAt || ""));
    return sortOrder === "asc" ? compare : -compare;
  });
  return items;
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
