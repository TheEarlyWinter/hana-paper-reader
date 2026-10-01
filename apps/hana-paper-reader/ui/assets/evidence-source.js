// Pure data contract shared by the browser and the server; no host or DOM APIs.
const text = (value, limit = 20000) => typeof value === "string" ? value.trim().slice(0, limit) : "";
const bbox = value => Array.isArray(value) && value.length >= 4 && value.slice(0, 4).map(Number).every(Number.isFinite)
  ? value.slice(0, 4).map(Number) : null;
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export function evidenceRequestBasis(paper, blockId = null) {
  let section = null;
  const annotated = (Array.isArray(paper?.blocks) ? paper.blocks : []).map(block => {
    if (["heading", "title", "section"].includes(text(block.type, 40).toLowerCase()) || Number(block.level) > 0) {
      section = { id: text(block.id, 256), title: text(block.text, 1000) || "Untitled" };
    }
    return { ...block, sectionId: section?.id || block.sectionId, sectionTitle: section?.title || block.sectionTitle };
  });
  const selected = annotated.filter(block => !blockId || block.id === blockId).slice(0, 12);
  return JSON.stringify(canonical({ version: 2, paperHash: text(paper?.paperHash, 128).toLowerCase(),
    generation: paper?.generation ?? paper?.revision ?? null, title: text(paper?.metadata?.title || paper?.title, 500),
    blocks: selected.map(block => {
      const originalQuote = text(block.text || block.caption || block.latex);
      // Evidence IDs are derived by storage from hash + block ID, not source input.
      return { id: text(block.id, 256),
        page: Number.isInteger(Number(block.page)) && Number(block.page) > 0 ? Number(block.page) : 1,
        type: text(block.type, 40) || "paragraph", bbox: bbox(block.bbox),
        sectionId: text(block.sectionId, 256), sectionTitle: text(block.sectionTitle, 1000),
        quote: originalQuote || text(paper?.translations?.[block.id] || block.translatedText),
        caption: text(block.caption), latex: text(block.latex), tableHtml: text(block.tableHtml),
        assetRef: block.assetRef || null, assetPath: text(block.assetPath, 500), crop: bbox(block.crop) };
    }) }));
}

export function selectionRequestBasis(paper, blockId) {
  const block = paper?.blocks?.find(item => item.id === blockId);
  return JSON.stringify(canonical({ version: 1, evidence: JSON.parse(evidenceRequestBasis(paper, blockId)),
    translation: text(paper?.translations?.[blockId] || block?.translatedText) }));
}
