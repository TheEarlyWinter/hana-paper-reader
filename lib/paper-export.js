const VISUAL_TYPES = new Set(["image", "chart", "table", "equation"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function plainText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function escapeInlineMarkdownRaw(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]<>])/g, "\\$1")
    .replace(/\|/g, "\\|");
}

function escapeInlineMarkdown(value) {
  return escapeInlineMarkdownRaw(plainText(value));
}

function escapeMarkdownTextFragment(value) {
  return escapeInlineMarkdownRaw(value)
    .replace(/^(\s{0,3})(#{1,6}|>|[-+])\s/gm, (_match, indent, marker) => `${indent}\\${marker} `)
    .replace(/^(\s{0,3})(\d+)([.)])\s/gm, (_match, indent, digits, marker) => `${indent}${digits}\\${marker} `);
}

function escapeMarkdown(value) {
  return plainText(value)
    .split(/(\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\r\n])+\$)/g)
    .map((fragment, index) => index % 2 === 1 ? fragment : escapeMarkdownTextFragment(fragment))
    .join("");
}

function escapeLinkLabel(value) {
  return escapeInlineMarkdown(value).replace(/\n+/g, " ");
}

function encodeMarkdownPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => encodeURIComponent(part).replace(/%3A/gi, ":"))
    .join("/")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

function joinAttachmentPath(basePath, assetPath) {
  const base = String(basePath || "attachments").replace(/\\/g, "/").replace(/\/+$/, "");
  const asset = String(assetPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  return encodeMarkdownPath([base, asset].filter(Boolean).join("/"));
}

function stableToken(value, fallback) {
  const token = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return token || fallback;
}

function blockAnchor(block, index) {
  const page = Number.isInteger(Number(block?.page)) && Number(block.page) > 0 ? Number(block.page) : 1;
  const id = stableToken(block?.id, `block-${index + 1}`);
  return `paper-p${page}-b-${id}`;
}

function headingLevel(block) {
  const raw = Number(block?.level ?? block?.headingLevel ?? block?.text_level);
  if (Number.isInteger(raw) && raw > 0) return Math.min(6, raw);
  const match = plainText(block?.text).match(/^\s*(\d+(?:\.\d+)*)[.)]?\s+/);
  if (match) return Math.min(6, match[1].split(".").length + 1);
  return 2;
}

function lookup(collection, key) {
  if (!key || collection == null) return undefined;
  if (collection instanceof Map) return collection.get(key);
  if (isRecord(collection)) return collection[key];
  return undefined;
}

function translationFor(translations, blockId) {
  const value = lookup(translations, blockId);
  if (isRecord(value)) return plainText(value.text ?? value.translation ?? value.value);
  return plainText(value);
}

function translationLabel(translationStates, blockId) {
  const state = lookup(translationStates, blockId);
  return isRecord(state) && state.kind === "final" ? "用户定稿" : "AI 译文";
}

function normalizeEntries(collection, kind) {
  if (Array.isArray(collection)) return collection.filter(isRecord);
  if (!isRecord(collection) && !(collection instanceof Map)) return [];
  const entries = collection instanceof Map ? [...collection.entries()] : Object.entries(collection);
  return entries.flatMap(([blockId, value]) => {
    const values = Array.isArray(value) ? value : [value];
    return values.map((item) => isRecord(item)
      ? { ...item, blockId: item.blockId ?? item.block_id ?? blockId }
      : { blockId, [kind === "note" ? "text" : "label"]: item });
  });
}

function assetIndex(assets) {
  const list = Array.isArray(assets) ? assets : asArray(assets?.items ?? assets?.assets);
  const byBlock = new Map();
  const byPath = new Map();
  for (const item of list) {
    if (!isRecord(item)) continue;
    const blockId = plainText(item.blockId ?? item.block_id);
    const sourcePath = plainText(item.assetPath ?? item.sourcePath ?? item.path);
    if (blockId) byBlock.set(blockId, item);
    if (sourcePath) byPath.set(sourcePath, item);
  }
  return { byBlock, byPath };
}

function resolveAsset(block, assets) {
  const direct = isRecord(block?.asset) ? block.asset : null;
  const sourcePath = plainText(block?.assetPath ?? block?.imagePath);
  return direct
    || assets.byBlock.get(plainText(block?.id))
    || assets.byPath.get(sourcePath)
    || (sourcePath ? { path: sourcePath } : null);
}

function renderMetadata(metadata, progress) {
  const fields = [
    ["作者", Array.isArray(metadata.authors) ? metadata.authors.join(", ") : metadata.authors],
    ["年份", metadata.year],
    ["期刊 / 会议", metadata.venue ?? metadata.journal],
    ["DOI", metadata.doi],
    ["来源", metadata.sourceUrl ?? metadata.url],
  ];
  const lines = fields
    .map(([label, value]) => [label, plainText(value)])
    .filter(([, value]) => value)
    .map(([label, value]) => `- **${label}：** ${escapeMarkdown(value)}`);

  if (isRecord(progress)) {
    const page = Number(progress.page ?? progress.currentPage);
    const totalPages = Number(progress.totalPages ?? progress.pageCount);
    const percent = Number(progress.percent ?? progress.percentage);
    if (Number.isFinite(page) && page > 0) lines.push(`- **阅读页：** ${page}${Number.isFinite(totalPages) && totalPages > 0 ? ` / ${totalPages}` : ""}`);
    if (Number.isFinite(percent)) lines.push(`- **阅读进度：** ${Math.max(0, Math.min(100, percent))}%`);
    const updatedAt = plainText(progress.updatedAt ?? progress.lastReadAt);
    if (updatedAt) lines.push(`- **最近阅读：** ${escapeMarkdown(updatedAt)}`);
  }
  return lines;
}

function renderOutline(blocks) {
  const headings = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block?.type === "heading" && plainText(block.text));
  if (!headings.length) return [];
  return [
    "## 大纲",
    "",
    ...headings.map(({ block, index }) => {
      const indent = "  ".repeat(Math.max(0, headingLevel(block) - 2));
      return `${indent}- [${escapeLinkLabel(block.text)}](#${blockAnchor(block, index)})`;
    }),
  ];
}

function renderVisual(block, asset, attachmentBasePath) {
  const type = plainText(block.type) || "image";
  const labels = { image: "图", chart: "图表", table: "表", equation: "公式" };
  const result = [`> **${labels[type] || "视觉块"}** · Page ${Number(block.page) > 0 ? Number(block.page) : 1}`];
  const assetPath = plainText(asset?.exportPath ?? asset?.relativePath ?? asset?.path ?? asset?.assetPath);
  if (assetPath) {
    const alt = plainText(asset?.alt ?? block.text) || labels[type] || "论文附件";
    result.push("", `![${escapeLinkLabel(alt)}](${joinAttachmentPath(attachmentBasePath, assetPath)})`);
  }
  if (type === "equation" && plainText(block.latex)) {
    const latex = plainText(block.latex).replace(/^\$\$|\$\$$/g, "").trim();
    result.push("", "$$", latex, "$$");
  }
  if (type === "table" && plainText(block.tableHtml)) {
    result.push("", "```html", plainText(block.tableHtml).replace(/```/g, "`\u200b``"), "```");
  }
  return result;
}

function renderBlock(block, index, translations, translationStates, assets, options) {
  if (!isRecord(block)) return [];
  const id = plainText(block.id);
  const evidenceId = plainText(block.evidenceId);
  const original = plainText(block.text);
  const translated = translationFor(translations, id);
  const translatedLabel = translationLabel(translationStates, id);
  const anchor = blockAnchor(block, index);
  const page = Number(block.page) > 0 ? Number(block.page) : 1;
  const lines = [
    `<a id="${anchor}"></a>`,
    `<!-- page:${page} block:${escapeMarkdown(id || String(index + 1))}${evidenceId ? ` evidence:${escapeMarkdown(evidenceId)}` : ""} -->`,
    "",
  ];

  if (block.type === "heading" && original) {
    lines.push(`${"#".repeat(headingLevel(block))} ${escapeInlineMarkdown(original)}`);
    if (translated && translated !== original) lines.push("", `> **${translatedLabel}：** ${escapeMarkdown(translated)}`);
    return lines;
  }

  if (VISUAL_TYPES.has(block.type)) {
    lines.push(...renderVisual(block, resolveAsset(block, assets), options.attachmentBasePath));
    if (original) lines.push("", `**原文：** ${escapeMarkdown(original)}`);
    if (translated) lines.push("", `**${translatedLabel}：** ${escapeMarkdown(translated)}`);
    return lines;
  }

  if (original) lines.push(escapeMarkdown(original));
  if (translated) lines.push("", `> **${translatedLabel}：** ${escapeMarkdown(translated)}`);
  if (!original && !translated) lines.push("_空结构块_");
  return lines;
}

function referenceFor(entry, blockMap) {
  const blockId = plainText(entry.blockId ?? entry.block_id);
  const target = blockMap.get(blockId);
  if (!target) return blockId ? `block ${escapeMarkdown(blockId)}` : "未关联段落";
  return `[Page ${target.page} · block ${escapeLinkLabel(blockId)}](#${target.anchor})`;
}

function renderNotes(notes, blockMap) {
  const entries = normalizeEntries(notes, "note");
  if (!entries.length) return [];
  const lines = ["## 研究笔记", ""];
  entries.forEach((entry, index) => {
    const title = plainText(entry.title) || `笔记 ${index + 1}`;
    const body = plainText(entry.text ?? entry.content ?? entry.note);
    lines.push(`### ${escapeInlineMarkdown(title)}`, "", `来源：${referenceFor(entry, blockMap)}`);
    if (body) lines.push("", escapeMarkdown(body));
    lines.push("");
  });
  return lines.slice(0, -1);
}

function renderBookmarks(bookmarks, blockMap) {
  const entries = normalizeEntries(bookmarks, "bookmark");
  if (!entries.length) return [];
  return [
    "## 书签",
    "",
    ...entries.map((entry) => {
      const label = plainText(entry.label ?? entry.title ?? entry.text) || "书签";
      return `- **${escapeInlineMarkdown(label)}**：${referenceFor(entry, blockMap)}`;
    }),
  ];
}

function normalizeGlossary(glossary) {
  if (Array.isArray(glossary)) return glossary.filter(isRecord);
  if (!isRecord(glossary) && !(glossary instanceof Map)) return [];
  const entries = glossary instanceof Map ? [...glossary.entries()] : Object.entries(glossary);
  return entries.map(([term, value]) => isRecord(value) ? { term, ...value } : { term, definition: value });
}

function renderGlossary(glossary) {
  const entries = normalizeGlossary(glossary);
  if (!entries.length) return [];
  const lines = ["## 术语表", ""];
  for (const entry of entries) {
    const term = plainText(entry.term ?? entry.source ?? entry.original);
    if (!term) continue;
    const translation = plainText(entry.translation ?? entry.target);
    const definition = plainText(entry.definition ?? entry.note ?? entry.description);
    const details = [translation, definition].filter(Boolean).map(escapeMarkdown).join("：");
    lines.push(`- **${escapeInlineMarkdown(term)}**${details ? `：${details}` : ""}`);
  }
  return lines.length > 2 ? lines : [];
}

/**
 * Generate a self-contained research-note Markdown document.
 *
 * @param {object} input
 * @param {object} [input.metadata] Paper metadata: title, authors, year, venue, doi, sourceUrl.
 * @param {Array<object>} [input.blocks] Unified MinerU/panel blocks.
 * @param {object|Map} [input.translations] Translation text keyed by block id.
 * @param {Array<object>|object|Map} [input.notes] Notes with blockId and text/content.
 * @param {Array<object>|object|Map} [input.bookmarks] Bookmarks with blockId and label/title.
 * @param {object} [input.progress] Reading page, totalPages, percent and updatedAt.
 * @param {Array<object>|object|Map} [input.glossary] Terms and definitions/translations.
 * @param {Array<object>|object} [input.assets] Asset metadata keyed by blockId or asset path.
 * @param {object} [input.options] Export options; attachmentBasePath defaults to "attachments".
 * @returns {string} UTF-8 compatible Markdown text.
 */
export function generatePaperMarkdown(input = {}) {
  const source = isRecord(input) ? input : {};
  const metadata = isRecord(source.metadata) ? source.metadata : {};
  const blocks = asArray(source.blocks).filter(isRecord);
  const translations = source.translations ?? {};
  const translationStates = source.translationStates ?? {};
  const options = isRecord(source.options) ? source.options : {};
  const assets = assetIndex(source.assets);
  const title = plainText(metadata.title ?? source.title) || "未命名论文";
  const blockMap = new Map();
  blocks.forEach((block, index) => {
    const id = plainText(block.id);
    if (id) blockMap.set(id, {
      anchor: blockAnchor(block, index),
      page: Number(block.page) > 0 ? Number(block.page) : 1,
    });
  });

  const sections = [[`# ${escapeInlineMarkdown(title)}`]];
  const metadataLines = renderMetadata(metadata, source.progress);
  if (metadataLines.length) sections.push(metadataLines);
  const outline = renderOutline(blocks);
  if (outline.length) sections.push(outline);
  if (blocks.length) {
    const body = ["## 正文", ""];
    blocks.forEach((block, index) => {
      body.push(...renderBlock(block, index, translations, translationStates, assets, options), "");
    });
    sections.push(body.slice(0, -1));
  }
  const notes = renderNotes(source.notes, blockMap);
  if (notes.length) sections.push(notes);
  const bookmarks = renderBookmarks(source.bookmarks, blockMap);
  if (bookmarks.length) sections.push(bookmarks);
  const glossary = renderGlossary(source.glossary);
  if (glossary.length) sections.push(glossary);

  return `${sections.map((section) => section.join("\n").trim()).filter(Boolean).join("\n\n")}\n`;
}

export { escapeMarkdown };
