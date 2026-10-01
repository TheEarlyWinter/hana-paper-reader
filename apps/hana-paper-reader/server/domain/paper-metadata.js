const MAX_TEXT_LENGTH = 1000;
const MAX_AUTHOR_COUNT = 100;
const MAX_TAG_COUNT = 100;

export function normalizeDisplayText(value, max = MAX_TEXT_LENGTH, fallback = "") {
  if (value == null) return fallback;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : fallback;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).slice(0, max);
  }
  return fallback;
}

export function normalizeAuthors(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : (typeof value === "string" ? value.split(/[,，;；]/) : []);
  const result = [];
  for (const item of list) {
    if (typeof item === "string" || typeof item === "number") {
      const clean = String(item).trim();
      if (clean) result.push(clean.slice(0, 200));
    }
    if (result.length >= MAX_AUTHOR_COUNT) break;
  }
  return result;
}

export function normalizeTags(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : (typeof value === "string" ? value.split(/[,，;；]/) : []);
  const result = [];
  for (const item of list) {
    if (typeof item === "string" || typeof item === "number") {
      const clean = String(item).trim();
      if (clean) result.push(clean.slice(0, 80));
    }
    if (result.length >= MAX_TAG_COUNT) break;
  }
  return result;
}

export function normalizeYear(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value === "string") {
    const match = value.match(/\b(19\d\d|20\d\d)\b/);
    return match ? match[1] : (value.trim().slice(0, 20) || null);
  }
  return null;
}

export function normalizePaperMetadata(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const authors = normalizeAuthors(source.authors || source.author);
  const tags = normalizeTags(source.tags);
  const title = normalizeDisplayText(source.title || source.filename, 500, "未命名论文");
  const year = normalizeYear(source.year || source.date);
  const doi = normalizeDisplayText(source.doi, 200, null);
  const favorite = source.favorite === true;
  const archived = source.archived === true;
  const lastReadAt = normalizeDisplayText(source.lastReadAt, 80, null);

  return {
    ...source,
    title,
    authors,
    tags,
    year,
    doi,
    favorite,
    archived,
    lastReadAt,
  };
}
