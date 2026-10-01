import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import registerApiRoutes from "../server/http/api-routes.js";
import { createPaperWorkspace } from "../server/domain/paper-workspace.js";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const original = ["A measured result supports this finding.", "The method uses a controlled comparison."];
const translated = ["测量结果支持这项发现。", "该方法使用受控比较。"];
const figure = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=", "base64");

// Synthetic document bytes and parser/model replies belong to this fixture.
// This exercises the real local route/storage pipeline, not a native PDF viewer.
function documentBytes() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...original.map(text => { const stream = `BT /F1 12 Tf 50 700 Td (${text}) Tj ET\n`; return `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`; }),
  ];
  let content = "%PDF-1.7\n", offsets = [0];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(content)); content += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  content += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(content + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name), data = Buffer.from(value), checksum = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, data);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42); centrals.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const central = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

function request({ query = {}, params = {}, body = {}, bytes = Buffer.alloc(0) } = {}) {
  return {
    get: key => key === "appRequestContext" ? { principal: { id: "owned-core-workflow" } } : undefined,
    req: { query: key => query[key], param: key => params[key], header: key => key.toLowerCase() === "content-type" ? "application/pdf" : "",
      json: async () => body, arrayBuffer: async () => bytes },
    json: (value, status = 200) => ({ value, status }),
    body: (value, status = 200, headers = {}) => ({ value, status, headers }),
  };
}

function application(runtime) {
  const routes = new Map(), add = method => (route, handler) => routes.set(`${method} ${route}`, handler);
  registerApiRoutes({ get: add("GET"), post: add("POST"), delete: add("DELETE") }, runtime);
  return async (method, route, options) => {
    assert.ok(routes.has(`${method} ${route}`), `Missing real route: ${method} ${route}`);
    const response = await routes.get(`${method} ${route}`)(request(options));
    assert.equal(response.status, 200, `${method} ${route}: ${JSON.stringify(response.value)}`);
    return response;
  };
}

test("one normal reading workflow parses, translates, persists research, reloads, exports and restores its own paper", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-core-workflow-30-"));
  const workspaces = new Set(), stages = [], networkCalls = [], modelCalls = [];
  const pdf = documentBytes(), paperHash = digest(pdf);
  const zip = storedZip([["content_list_v2.json", JSON.stringify([
    { type: "text", text_level: 1, page_idx: 0, text: "Results" },
    { type: "text", page_idx: 0, text: original[0] },
    { type: "image", page_idx: 0, img_path: "images/figure.png", image_caption: "Owned measured figure" },
    { type: "text", text_level: 1, page_idx: 1, text: "Method" },
    { type: "text", page_idx: 1, text: original[1] },
  ])], ["images/figure.png", figure]]);
  const settings = { mineruApiToken: "owned-synthetic-token", mineruApiBaseUrl: "https://mineru.net/api/v4", mineruModelVersion: "vlm",
    mineruLanguage: "en", mineruEnableFormula: true, mineruEnableTable: true, mineruOcr: false, mineruTimeoutSeconds: 60, mineruPollIntervalSeconds: 2 };
  const json = value => ({ ok: true, status: 200, text: async () => JSON.stringify(value), arrayBuffer: async () => Buffer.from(JSON.stringify(value)) });
  const runtimeFor = dataDir => {
    const workspace = createPaperWorkspace({ dataDir }); workspaces.add(workspace);
    return { dataDir, workspace, config: { get: async key => settings[key] },
      models: { utility: async input => { modelCalls.push(input); return { requestId: input.requestId, text: JSON.stringify(translated) }; } },
      network: { fetch: async (url, init = {}) => {
        networkCalls.push({ url, method: init.method || "GET" });
        if (init.method === "POST") return json({ code: 0, data: { batch_id: "owned-core-batch", file_urls: ["https://mineru.net/upload/owned-core"] } });
        if (init.method === "PUT") { assert.deepEqual(Buffer.from(init.body), pdf); return { ok: true, status: 200 }; }
        if (url.includes("extract-results")) return json({ code: 0, data: { extract_result: [{ state: "done", full_zip_url: "https://mineru.oss-cn-shanghai.aliyuncs.com/owned-core.zip" }] } });
        assert.equal(url, "https://mineru.oss-cn-shanghai.aliyuncs.com/owned-core.zip");
        return { ok: true, status: 200, arrayBuffer: async () => zip };
      } } };
  };
  try {
    let runtime = runtimeFor(path.join(root, "source")), call = application(runtime);
    const parsed = (await call("POST", "/api/parse-pdf", { bytes: pdf, query: { fileName: "Owned core workflow.pdf" } })).value;
    assert.equal(parsed.paperHash, paperHash); assert.equal(parsed.pageCount, 2); assert.equal(parsed.blockCount, 5);
    assert.deepEqual(networkCalls.map(item => item.method), ["POST", "PUT", "GET", "GET"]);
    stages.push("parse-and-save");
    const library = (await call("GET", "/api/research/library")).value;
    assert.equal(library.total, 1); assert.equal(library.items[0].paperHash, paperHash);
    const outline = (await call("GET", "/api/research/outline", { query: { paperHash } })).value.outline;
    assert.deepEqual(outline.map(item => [item.title, item.page]), [["Results", 1], ["Method", 2]]);
    const search = (await call("GET", "/api/research/search", { query: { paperHash, q: "measured", language: "original" } })).value.results;
    assert.ok(search.some(item => item.text === original[0])); stages.push("library-outline-search");

    let paper = (await call("GET", "/api/research/paper", { query: { paperHash } })).value.paper;
    const paragraphs = paper.blocks.filter(block => block.type === "paragraph");
    assert.deepEqual(paragraphs.map(block => block.text), original);
    const image = paper.blocks.find(block => block.type === "image");
    const asset = await call("GET", "/api/mineru-asset", { query: { cacheId: image.assetRef.cacheId, path: image.assetRef.path } });
    assert.deepEqual(asset.value, figure); stages.push("figure-read");
    const glossary = (await call("POST", "/api/research/glossary", { body: { paperHash, terms: { measured: "测量", comparison: "比较" } } })).value.glossary;
    const translations = (await call("POST", "/api/translate", { body: { texts: paragraphs.map(block => block.text), glossaryTerms: glossary.terms } })).value.translations;
    assert.deepEqual(translations, translated); assert.equal(modelCalls.length, 1);
    assert.match(modelCalls[0].messages[0].content, /comparison/);
    const translationMap = Object.fromEntries(paragraphs.map((block, index) => [block.id, translations[index]]));
    const translationStates = Object.fromEntries(paragraphs.map(block => [block.id, { kind: "ai" }]));
    paper = (await call("POST", "/api/research/paper", { body: { ...paper, expectedRevision: paper.revision, expectedGeneration: paper.generation,
      translations: translationMap, translationStates, blocks: paper.blocks.map(block => ({ ...block, translatedText: translationMap[block.id] || "" })) } })).value.paper;
    for (const block of paragraphs) await call("POST", "/api/research/translation-cache", { body: { paperHash, blockId: block.id,
      glossaryVersion: glossary.version, promptVersion: "academic-translation-v1", inputHash: digest(block.text), source: block.text, translation: translationMap[block.id] } });
    stages.push("glossary-translation-and-save");

    const note = (await call("POST", "/api/research/notes", { body: { paperHash, blockId: paragraphs[0].id, note: "Owned normal workflow finding", noteType: "finding" } })).value.note;
    const bookmark = (await call("POST", "/api/research/bookmarks", { body: { paperHash, blockId: paragraphs[1].id, label: "Owned method bookmark" } })).value.bookmark;
    assert.equal(note.validationStatus, "verified"); assert.equal(bookmark.evidence.blockId, paragraphs[1].id);
    await call("POST", "/api/research/progress", { body: { paperHash, page: 2, percent: 66, readingMode: "bilingual" } });
    stages.push("notes-bookmark-progress");

    await runtime.workspace.close(); workspaces.delete(runtime.workspace);
    runtime = runtimeFor(path.join(root, "source")); call = application(runtime);
    const reopened = (await call("GET", "/api/research/paper", { query: { paperHash } })).value.paper;
    assert.deepEqual(reopened.translations, translationMap);
    assert.equal((await call("GET", "/api/research/notes", { query: { paperHash } })).value.notes[0].id, note.id);
    assert.equal((await call("GET", "/api/research/bookmarks", { query: { paperHash } })).value.bookmarks[0].id, bookmark.id);
    const progress = (await call("GET", "/api/research/progress", { query: { paperHash } })).value.progress;
    assert.equal(progress.page, 2); assert.equal(progress.percent, 66); assert.equal(progress.readingMode, "bilingual");
    assert.equal((await call("GET", "/api/research/glossary", { query: { paperHash } })).value.glossary.terms.comparison, "比较");
    const cache = (await call("GET", "/api/research/translation-cache", { query: { paperHash, blockId: paragraphs[0].id,
      glossaryVersion: String(glossary.version), promptVersion: "academic-translation-v1", inputHash: digest(original[0]) } })).value;
    assert.equal(cache.hit, true); assert.equal(cache.translation.translation, translated[0]); stages.push("fresh-workspace-reload");
    const cached = (await call("POST", "/api/parse-pdf", { bytes: pdf })).value;
    assert.equal(cached.cached, true); assert.equal(networkCalls.length, 4); stages.push("cached-reopen");
    const translatedSearch = (await call("GET", "/api/research/search", { query: { paperHash, q: "受控比较", language: "translation" } })).value.results;
    assert.ok(translatedSearch.some(item => item.translatedText === translated[1])); stages.push("translation-search");

    const markdownResponse = await call("GET", "/api/research/export", { query: { paperHash } }), markdown = await markdownResponse.text();
    for (const text of [...original, ...translated, "Owned normal workflow finding", "Owned method bookmark", "比较"]) assert.ok(markdown.includes(text), `Missing exported content: ${text}`);
    const saved = (await call("POST", "/api/research/export", { body: { paperHash, saveToDisk: true,
      expectedRevision: reopened.revision, expectedGeneration: reopened.generation } })).value;
    assert.equal(saved.saved, true); assert.equal(fs.readFileSync(saved.filePath, "utf8"), markdown);
    assert.equal(saved.sha256, digest(Buffer.from(markdown))); assert.equal(saved.size, Buffer.byteLength(markdown)); stages.push("markdown-download-and-save");
    const backupResponse = await call("GET", "/api/research/backup", { query: { paperHash } }), backup = await backupResponse.json();
    assert.equal(backup.assetMode, "included"); assert.equal(backup.assets.length, 1); assert.equal(backup.notes.length, 1);
    assert.equal(backup.bookmarks.length, 1); assert.equal(backup.translationCache.length, 2); stages.push("full-backup");

    const restoredRuntime = runtimeFor(path.join(root, "restored")), restoredCall = application(restoredRuntime);
    await restoredCall("POST", "/api/research/restore", { body: { ...backup, expectedRevision: 0 } });
    await restoredRuntime.workspace.close(); workspaces.delete(restoredRuntime.workspace);
    const restoredFresh = runtimeFor(path.join(root, "restored")), freshCall = application(restoredFresh);
    const finalPaper = (await freshCall("GET", "/api/research/paper", { query: { paperHash } })).value.paper;
    assert.deepEqual(finalPaper.translations, translationMap); assert.deepEqual(finalPaper.blocks.map(block => block.text), reopened.blocks.map(block => block.text));
    assert.equal((await freshCall("GET", "/api/research/notes", { query: { paperHash } })).value.notes[0].id, note.id);
    assert.equal((await freshCall("GET", "/api/research/bookmarks", { query: { paperHash } })).value.bookmarks[0].id, bookmark.id);
    const finalProgress = (await freshCall("GET", "/api/research/progress", { query: { paperHash } })).value.progress;
    assert.deepEqual([finalProgress.percent, finalProgress.page, finalProgress.readingMode], [66, 2, "bilingual"]);
    assert.deepEqual((await freshCall("GET", "/api/research/glossary", { query: { paperHash } })).value.glossary.terms, glossary.terms);
    const finalCache = (await freshCall("GET", "/api/research/translation-cache", { query: { paperHash, blockId: paragraphs[1].id,
      glossaryVersion: String(glossary.version), promptVersion: "academic-translation-v1", inputHash: digest(original[1]) } })).value;
    assert.equal(finalCache.hit, true); assert.equal(finalCache.translation.translation, translated[1]);
    const finalImage = finalPaper.blocks.find(block => block.type === "image");
    assert.deepEqual((await freshCall("GET", "/api/mineru-asset", { query: { cacheId: finalImage.assetRef.cacheId, path: finalImage.assetRef.path } })).value, figure);
    const restoredMarkdown = await (await freshCall("GET", "/api/research/export", { query: { paperHash } })).text();
    assert.equal(restoredMarkdown, markdown); stages.push("restore-and-fresh-reload");
    assert.equal(networkCalls.length, 4); assert.equal(modelCalls.length, 1);
    t.diagnostic(`Completed normal stages: ${stages.join(" -> ")}`);
  } finally {
    for (const workspace of workspaces) await workspace.close();
    const resolved = path.resolve(root); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("hpr-core-workflow-30-")); fs.rmSync(resolved, { recursive: true, force: true });
  }
});
