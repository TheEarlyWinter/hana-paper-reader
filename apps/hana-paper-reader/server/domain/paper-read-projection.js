import { createHash } from "node:crypto";

const SEARCH_LANGUAGES = new Set(["both", "original", "translation"]);
const SEARCH_SCOPES = new Set(["all", "page", "section"]);
const MAX_SEARCH_ITEMS = 100;

function text(value, max = 50000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalizedPage(value) {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function normalizedBbox(value) {
  if (!Array.isArray(value) || value.length < 4) return null;
  const coords = value.slice(0, 4).map((item) => Number(item));
  return coords.every((item) => Number.isFinite(item)) ? coords : null;
}

export function fallbackEvidenceIdFor(paperHash, blockId) {
  return `ev_${createHash("sha256").update(`${paperHash}:${blockId}`).digest("hex").slice(0, 16)}`;
}

export function searchTypeGroup(block) {
  const kind = text(block?.type, 40).toLowerCase();
  if (["heading", "title", "section"].includes(kind) || Number(block?.level) > 0) return "title";
  if (["image", "chart", "figure", "caption"].includes(kind)) return "figure";
  if (kind === "table") return "table";
  if (kind === "equation" || text(block?.latex)) return "equation";
  return "body";
}

export function occurrenceCount(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while ((cursor = haystack.indexOf(needle, cursor)) >= 0) {
    count += 1;
    cursor += needle.length;
  }
  return count;
}

export function contextSnippet(value, needle, max = 240) {
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
  const limit = clamp(options.limit || MAX_SEARCH_ITEMS, 1, MAX_SEARCH_ITEMS);
  const sourceBlocks = array(blocks);
  const currentIndex = sourceBlocks.findIndex((block) => text(block?.id, 256) === currentBlockId);
  const paperHash = text(options.paperHash, 128);
  const normalizePage = options.normalizePage === true;
  const normalizeBounds = options.normalizeBbox === true;
  const resolveEvidence = typeof options.resolveEvidence === "function" ? options.resolveEvidence : null;

  return sourceBlocks.map((block, index) => {
    const original = text(block?.text || block?.caption || block?.latex);
    const translated = text(block?.translatedText);
    const originalLower = original.toLocaleLowerCase();
    const translatedLower = translated.toLocaleLowerCase();
    const originalCount = language === "translation" ? 0 : occurrenceCount(originalLower, needle);
    const translatedCount = language === "original" ? 0 : occurrenceCount(translatedLower, needle);
    const blockType = text(block?.type, 40).toLowerCase();
    const group = searchTypeGroup(block);
    const inScope = scope === "all"
      || (scope === "page" && currentPage > 0 && Number(block?.page) === currentPage)
      || (scope === "section" && currentSectionId && text(block?.sectionId, 256) === currentSectionId);
    const typeMatch = !types.size || types.has(group) || types.has(blockType);
    if (!inScope || !typeMatch || (!originalCount && !translatedCount)) return null;

    let score = Math.min(30, (originalCount + translatedCount) * 8);
    const reasons = [`命中 ${originalCount + translatedCount} 次`];
    if (group === "title") {
      score += 28;
      reasons.push("标题块 +28");
    } else if (["figure", "table", "equation"].includes(group)) {
      score += 12;
      reasons.push("视觉证据 +12");
    }
    if (originalLower.startsWith(needle) || translatedLower.startsWith(needle)) {
      score += 12;
      reasons.push("段首命中 +12");
    }
    if (text(block?.sectionTitle, 1000).toLocaleLowerCase().includes(needle)) {
      score += 10;
      reasons.push("章节标题命中 +10");
    }
    if (currentPage > 0 && Number(block?.page) === currentPage) {
      score += 8;
      reasons.push("当前页 +8");
    }
    if (currentIndex >= 0) {
      const proximity = Math.max(0, 10 - Math.min(10, Math.abs(index - currentIndex)));
      if (proximity) {
        score += proximity;
        reasons.push(`邻近当前块 +${proximity}`);
      }
    }
    const id = text(block?.id, 256);
    const evidenceId = text(block?.evidenceId, 128) || (paperHash ? fallbackEvidenceIdFor(paperHash, id) : null);
    const result = {
      id,
      evidenceId,
      page: normalizePage ? normalizedPage(block?.page) : block?.page,
      type: text(block?.type, 40) || "paragraph",
      typeGroup: group,
      text: original,
      translatedText: translated,
      sectionId: text(block?.sectionId, 256) || null,
      sectionTitle: text(block?.sectionTitle, 1000) || null,
      matches: {
        original: originalCount > 0,
        translated: translatedCount > 0,
        originalCount,
        translatedCount,
      },
      snippets: {
        original: originalCount ? contextSnippet(original, needle) : "",
        translation: translatedCount ? contextSnippet(translated, needle) : "",
      },
      score,
      scoreExplanation: reasons,
      bbox: normalizeBounds ? normalizedBbox(block?.bbox) : (block?.bbox || null),
      index,
    };
    if (resolveEvidence) {
      result.evidence = resolveEvidence(block, result);
    }
    return result;
  }).filter(Boolean)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(({ index: _index, ...result }) => result);
}

export function projectLibraryItem({
  paperHash,
  revision,
  paper = {},
  entry = {},
  metadata = {},
  progress = null,
  noteCount = 0,
  bookmarkCount = 0,
  hasGlossary = false,
} = {}) {
  const safeMeta = object(metadata);
  const safePaper = object(paper);
  const safeEntry = object(entry);
  const safeProgress = object(progress);
  const title = text(safeMeta.title, 500) || "未命名论文";
  const authors = Array.isArray(safeMeta.authors) ? safeMeta.authors : [];
  const tags = Array.isArray(safeMeta.tags) ? safeMeta.tags : [];
  const year = safeMeta.year || null;
  const doi = safeMeta.doi || null;
  const favorite = safeMeta.favorite === true || safePaper.favorite === true;
  const archived = safeMeta.archived === true || safePaper.archived === true;
  const lastReadAt = safeEntry.lastReadAt
    || safePaper.lastReadAt
    || safeMeta.lastReadAt
    || safeProgress.updatedAt
    || safePaper.updatedAt
    || safePaper.createdAt
    || null;
  const createdAt = safePaper.createdAt || safeEntry.createdAt || null;
  const updatedAt = safePaper.updatedAt || safeEntry.updatedAt || null;
  const blockCount = Number.isInteger(safePaper.blockCount) && safePaper.blockCount > 0
    ? safePaper.blockCount
    : (Number(safeEntry.blockCount)
      || (Array.isArray(safePaper.blocks) ? safePaper.blocks.length : (Array.isArray(safePaper.blockIndex) ? safePaper.blockIndex.length : 0)));
  const progressPercent = typeof safeProgress.percent === "number"
    ? safeProgress.percent
    : (typeof safeProgress.scrollRatio === "number"
      ? Math.round(safeProgress.scrollRatio * 100)
      : (safeProgress.blockId || safeProgress.lastBlockId ? 50 : 0));
  const blockId = safeProgress.blockId || safeProgress.lastBlockId || null;

  return {
    paperHash,
    revision,
    title,
    authors,
    year,
    doi,
    favorite,
    archived,
    tags,
    lastReadAt,
    createdAt,
    updatedAt,
    blockCount,
    noteCount: Number(noteCount) || 0,
    bookmarkCount: Number(bookmarkCount) || 0,
    hasGlossary: Boolean(hasGlossary),
    readingProgress: {
      percent: Number(progressPercent) || 0,
      blockId,
      lastBlockId: blockId,
      updatedAt: safeProgress.updatedAt || null,
      readingMode: safeProgress.readingMode || safePaper.readingMode || "bilingual",
    },
  };
}

export function filterAndSortLibraryItems(items, options = {}) {
  const query = text(options.query || options.q, 200).toLocaleLowerCase();
  const sortField = text(options.sort, 40) || "lastRead";
  const sortOrder = text(options.order, 10).toLowerCase() === "asc" ? "asc" : "desc";
  const filterFavorite = options.favorite === true || options.favorite === "true";
  const filterArchived = options.archived === "all" ? "all" : (options.archived === true || options.archived === "true");
  const filterTag = text(options.tag, 100).toLocaleLowerCase();

  const filtered = array(items).filter((item) => {
    if (filterArchived !== "all") {
      if (filterArchived === true && !item.archived) return false;
      if (filterArchived === false && item.archived) return false;
    }
    if (filterFavorite && !item.favorite) return false;
    if (filterTag && !array(item.tags).some((tag) => String(tag).toLocaleLowerCase().includes(filterTag))) return false;
    if (!query) return true;
    return [item.title, item.doi, item.paperHash, ...array(item.authors), ...array(item.tags)]
      .some((value) => String(value || "").toLocaleLowerCase().includes(query));
  });

  filtered.sort((left, right) => {
    let compare = 0;
    if (sortField === "title") {
      compare = String(left.title || "").localeCompare(String(right.title || ""), "zh-CN");
    } else if (sortField === "created") {
      compare = String(left.createdAt || "").localeCompare(String(right.createdAt || ""));
    } else if (sortField === "updated") {
      compare = String(left.updatedAt || "").localeCompare(String(right.updatedAt || ""));
    } else {
      const leftRead = String(left.lastReadAt || left.updatedAt || left.createdAt || "");
      const rightRead = String(right.lastReadAt || right.updatedAt || right.createdAt || "");
      compare = leftRead.localeCompare(rightRead);
    }
    return sortOrder === "asc" ? compare : -compare;
  });

  return filtered;
}
