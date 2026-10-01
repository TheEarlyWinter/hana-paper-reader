export function captureResearchOwner(paper, paperHash = paper?.paperHash) {
  const hash = typeof paperHash === "string" ? paperHash.trim().toLowerCase() : "";
  const actualHash = typeof paper?.paperHash === "string" ? paper.paperHash.trim().toLowerCase() : "";
  const generation = paper?.generation === undefined ? paper?.revision : paper.generation;
  if (!/^[a-f0-9]{12,128}$/.test(hash) || hash !== actualHash
      || !Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("论文尚未同步或已切换，请重新载入后再保存研究记录");
  }
  return Object.freeze({ paperHash: hash, generation });
}

export function withResearchOwner(payload, owner) {
  const valid = captureResearchOwner({ paperHash: owner?.paperHash, generation: owner?.generation });
  if (payload?.paperHash !== undefined && String(payload.paperHash).trim().toLowerCase() !== valid.paperHash) {
    throw new Error("研究记录与论文不匹配，请重新载入");
  }
  return { ...payload, paperHash: valid.paperHash, expectedGeneration: valid.generation };
}

export function researchOwnerIsCurrent(paper, owner) {
  try {
    const current = captureResearchOwner(paper, owner.paperHash);
    return current.generation === owner.generation;
  } catch { return false; }
}

export async function prepareResearchRequest(path, init = {}, options = {}) {
  if (!["POST", "DELETE"].includes(String(init.method || "GET").toUpperCase())
      || !/^\/api\/research\/(?:notes|bookmarks|progress|glossary|translation-cache|parse-status\/tasks)(?:[/?]|$)/.test(path)) return init;
  const payload = init.body ? JSON.parse(init.body) : {};
  const targetHash = payload.paperHash || new URL(path, "https://hana.local").searchParams.get("paperHash") || options.paper?.paperHash;
  const paper = options.paper;
  const owner = paper?.generation === undefined && paper?.revision === undefined
    ? captureResearchOwner(await options.prepare?.({ paperHash: targetHash }), targetHash)
    : captureResearchOwner(paper, targetHash);
  if (!researchOwnerIsCurrent(options.getPaper?.(), owner)) throw new Error("论文已切换或重新导入，请重新载入后再保存研究记录");
  return { ...init, headers: { ...init.headers, "Content-Type": "application/json" },
    body: JSON.stringify(withResearchOwner(payload, owner)) };
}
