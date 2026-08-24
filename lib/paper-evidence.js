import { createHash } from "node:crypto";

export const EVIDENCE_SCHEMA_VERSION = 1;

const VISUAL_TYPES = new Set(["image", "chart", "table", "equation"]);
const MAX_QUOTE_CHARS = 20000;

const plainText = (value, max = MAX_QUOTE_CHARS) => typeof value === "string" ? value.trim().slice(0, max) : "";
const asObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

function normalizedPage(value) {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

export function normalizeEvidenceBbox(value) {
  if (!Array.isArray(value) || value.length < 4) return null;
  const bbox = value.slice(0, 4).map(Number);
  return bbox.every(Number.isFinite) ? bbox : null;
}

export function evidenceIdFor(paperHash, blockId) {
  const hash = plainText(paperHash, 128).toLowerCase();
  const id = plainText(blockId, 256);
  if (!hash || !id) return "";
  const suffix = createHash("sha256").update(`${hash}\0${id}`).digest("hex").slice(0, 24);
  return `ev-${hash.slice(0, 12)}-${suffix}`;
}

function isSectionBlock(block) {
  const type = plainText(block?.type, 40).toLowerCase();
  return type === "heading" || type === "title" || type === "section" || Number(block?.level) > 0;
}

export function annotateEvidenceBlocks(paperHash, blocks) {
  let currentSection = null;
  return (Array.isArray(blocks) ? blocks : []).map((rawBlock) => {
    const block = { ...asObject(rawBlock) };
    if (isSectionBlock(block)) {
      currentSection = {
        id: plainText(block.id, 256),
        title: plainText(block.text, 1000) || "Untitled",
      };
    }
    return {
      ...block,
      evidenceId: evidenceIdFor(paperHash, block.id),
      evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
      sectionId: currentSection?.id || plainText(block.sectionId, 256) || null,
      sectionTitle: currentSection?.title || plainText(block.sectionTitle, 1000) || null,
    };
  });
}

function visualResource(block) {
  if (!VISUAL_TYPES.has(plainText(block?.type, 40).toLowerCase())) return null;
  return {
    type: plainText(block.type, 40),
    title: plainText(block.text, 2000),
    latex: plainText(block.latex, 20000),
    assetPath: plainText(block.assetPath, 500),
    assetRef: block.assetRef || null,
    crop: normalizeEvidenceBbox(block.crop),
    hasTableHtml: Boolean(plainText(block.tableHtml, 1)),
  };
}

export function evidenceFromBlock(paper, rawBlock, options = {}) {
  const block = asObject(rawBlock);
  const paperHash = plainText(paper?.paperHash, 128).toLowerCase();
  const blockId = plainText(block.id, 256);
  if (!paperHash || !blockId) return null;
  const blockType = plainText(block.type, 40) || "paragraph";
  const visual = visualResource(block);
  return {
    evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
    evidenceId: plainText(block.evidenceId, 128) || evidenceIdFor(paperHash, blockId),
    paperHash,
    blockId,
    blockType,
    sectionId: plainText(block.sectionId, 256) || null,
    sectionTitle: plainText(block.sectionTitle, 1000) || null,
    page: normalizedPage(block.page),
    bbox: normalizeEvidenceBbox(block.bbox),
    originalQuote: plainText(block.text || block.caption || block.latex),
    translation: plainText(block.translatedText),
    visualResource: visual,
    sourceKind: visual ? "visual-block" : "paper-block",
    usageKind: plainText(options.usageKind, 40) || "reference",
    validationStatus: "verified",
    createdAt: plainText(block.createdAt, 80) || plainText(paper?.createdAt, 80) || null,
    updatedAt: plainText(block.updatedAt, 80) || plainText(paper?.updatedAt, 80) || null,
  };
}

export function listPaperEvidence(paper, options = {}) {
  const limitValue = Number(options.limit);
  const limit = Number.isInteger(limitValue) && limitValue > 0 ? Math.min(limitValue, 500) : 100;
  const blockType = plainText(options.blockType || options.type, 40).toLowerCase();
  const sectionId = plainText(options.sectionId, 256);
  const usageKind = plainText(options.usageKind, 40) || "reference";
  return (Array.isArray(paper?.blocks) ? paper.blocks : [])
    .filter((block) => !blockType || plainText(block?.type, 40).toLowerCase() === blockType)
    .filter((block) => !sectionId || plainText(block?.sectionId, 256) === sectionId)
    .map((block) => evidenceFromBlock(paper, block, { usageKind }))
    .filter(Boolean)
    .slice(0, limit);
}

export function resolvePaperEvidence(paper, reference = {}, options = {}) {
  const evidenceId = plainText(typeof reference === "string" && reference.startsWith("ev-") ? reference : reference?.evidenceId, 128);
  const blockId = plainText(typeof reference === "string" && !reference.startsWith("ev-") ? reference : reference?.blockId, 256);
  const block = (Array.isArray(paper?.blocks) ? paper.blocks : []).find((item) => (
    (evidenceId && plainText(item?.evidenceId, 128) === evidenceId)
    || (blockId && plainText(item?.id, 256) === blockId)
  ));
  return block ? evidenceFromBlock(paper, block, options) : null;
}

export function hydrateEvidenceRelation(record, paper, usageKind) {
  const source = asObject(record);
  const evidence = resolvePaperEvidence(paper, source, { usageKind });
  if (!evidence) {
    const snapshot = asObject(source.evidenceSnapshot);
    const detachedEvidence = snapshot.evidenceId && snapshot.blockId ? {
      ...snapshot,
      usageKind: plainText(usageKind, 40) || snapshot.usageKind || "reference",
      validationStatus: "detached",
    } : null;
    return {
      ...source,
      evidence: detachedEvidence,
      validationStatus: detachedEvidence ? "detached" : "missing",
    };
  }
  return {
    ...source,
    evidenceId: evidence.evidenceId,
    blockId: evidence.blockId,
    page: evidence.page,
    bbox: evidence.bbox,
    evidence,
    validationStatus: evidence.validationStatus,
  };
}
