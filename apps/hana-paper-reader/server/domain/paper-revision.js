import { assertPaperHash } from "./paper-identity.js";

function integrityError() {
  return Object.assign(new Error("论文版本历史无效，请检查工作区备份"), { code: "workspace_integrity_error", status: 503 });
}

export function paperRevisionOf(paper) {
  const revision = Number(paper?.revision);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

export function paperGenerationOf(paper) {
  const revision = paperRevisionOf(paper);
  if (paper?.generation === undefined) return revision;
  if (!Number.isSafeInteger(paper.generation) || paper.generation < 0 || paper.generation > revision) throw integrityError();
  return paper.generation;
}

export function assertPaperRevisionClock(clocks, paperHash, paper) {
  paperGenerationOf(paper);
  if (Object.hasOwn(clocks, paperHash) && clocks[paperHash] > paperRevisionOf(paper)) throw integrityError();
}

// Deleted papers retain only their hash and last allocated revision. Keeping
// this clock in the same index transaction prevents revision reuse on restart.
export function normalizeRevisionClocks(value, papers = {}) {
  const clocks = Object.create(null);
  if (value !== undefined) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw integrityError();
    for (const [key, revision] of Object.entries(value)) {
      let hash;
      try { hash = assertPaperHash(key); } catch { throw integrityError(); }
      if (Object.hasOwn(clocks, hash) || !Number.isSafeInteger(revision) || revision < 0) throw integrityError();
      clocks[hash] = revision;
    }
  }
  for (const [key, paper] of Object.entries(papers)) {
    let hash;
    try { hash = assertPaperHash(key); } catch { throw integrityError(); }
    const revision = paperRevisionOf(paper);
    assertPaperRevisionClock(clocks, hash, paper);
    clocks[hash] = revision;
  }
  return clocks;
}

export function advancePaperRevision(store, paperHash) {
  const hash = assertPaperHash(paperHash);
  const previous = Math.max(paperRevisionOf(store.papers[hash]), store.revisionClocks?.[hash] || 0);
  if (!Number.isSafeInteger(previous) || previous >= Number.MAX_SAFE_INTEGER) {
    throw Object.assign(new Error("论文版本号已达到上限，无法安全写入"), { code: "paper_revision_exhausted", status: 409 });
  }
  store.revisionClocks ||= Object.create(null);
  return store.revisionClocks[hash] = previous + 1;
}
