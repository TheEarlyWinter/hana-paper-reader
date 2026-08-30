import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createPaperWorkspace } from "../lib/paper-workspace.js";
import registerApiRoutes from "../routes/api.js";
import { saveFileToDisk } from "../routes/api.js";

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hpr-feedback2-test-"));
}

function samplePaper(hash, title = "Sample Paper", cacheId = "111111111111111111111111") {
  return {
    paperHash: hash,
    metadata: { title, authors: ["Author"], year: 2026 },
    blocks: [
      { id: "block_1", type: "image", page: 1, text: "Image 1", assetPath: "images/img1.png", assetRef: { cacheId, path: "images/img1.png" } },
      { id: "block_2", type: "text", page: 2, text: "Original text page 2" },
    ],
  };
}

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
    delete(route, handler) { routes.set(`DELETE ${route}`, handler); },
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function requestContext(body = {}, query = {}, params = {}) {
  return {
    req: {
      json: async () => body,
      query: (key) => query[key] ?? "",
      param: (key) => params[key] ?? "",
    },
    json(value, status = 200) { return { kind: "json", value, status }; },
    get() { return null; },
  };
}

function binaryRequestContext(bytes, query = {}) {
  return {
    req: {
      query: (key) => query[key] ?? "",
      header: (key) => String(key).toLowerCase() === "content-type" ? "application/pdf" : "",
      raw: { body: new Response(bytes).body },
    },
    json(value, status = 200) { return { kind: "json", value, status }; },
    get() { return null; },
  };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(files) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  const entries = Object.entries(files);
  for (const [name, value] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

test("clearPaperData('assets') clears assetRef and deletes unused cache directory", async (t) => {
  const tmpDir = createTmpDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const cacheId = "222222222222222222222222";
  const cacheDir = path.join(tmpDir, "mineru-cache", cacheId, "images");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "img1.png"), Buffer.from("fake-png"));

  const hash = "f".repeat(64);
  const ws = createPaperWorkspace({ dataDir: tmpDir });
  await ws.upsertPaper(samplePaper(hash, "Paper Asset Clear", cacheId));

  assert.equal(fs.existsSync(path.join(tmpDir, "mineru-cache", cacheId)), true);

  // Perform clear assets
  const cleared = await ws.clearPaperData(hash, "assets");
  assert.equal(cleared.action, "assets");

  // Paper block assetRef must now be null
  const updatedPaper = ws.getPaper(hash);
  assert.equal(updatedPaper.blocks[0].assetRef, null);

  // Since no other paper references this cache, directory must be removed from disk
  assert.equal(fs.existsSync(path.join(tmpDir, "mineru-cache", cacheId)), false);
});

test("updatePaperMetadata and restoreBackup advance paper revision", async (t) => {
  const tmpDir = createTmpDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const hash = "a".repeat(64);
  const ws = createPaperWorkspace({ dataDir: tmpDir });
  const initial = await ws.upsertPaper(samplePaper(hash, "Rev Advance Test"));
  assert.equal(initial.revision, 1);

  // Metadata update advances revision
  const metaUpdated = await ws.updatePaperMetadata(hash, { favorite: true });
  assert.equal(metaUpdated.revision, 2);

  // Backup and restore advances revision beyond previous
  const backup = ws.exportBackup(hash, { includeAssets: false });
  const restored = await ws.restoreBackup(backup);
  assert.equal(restored.revision >= 3, true);
});

test("all cleanup mutations advance paper revision and reject stale snapshots", async (t) => {
  const tmpDir = createTmpDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const hash = "3".repeat(64);
  const cacheId = "333333333333333333333333";
  const ws = createPaperWorkspace({ dataDir: tmpDir });
  const initial = await ws.upsertPaper({
    ...samplePaper(hash, "Cleanup Revision", cacheId),
    translations: { block_2: "AI translation" },
    translationStates: { block_2: { kind: "ai" } },
  });
  assert.equal(initial.revision, 1);

  const afterAi = await ws.clearPaperData(hash, "ai-translations");
  assert.equal(afterAi.paper.revision, 2);
  await assert.rejects(
    () => ws.upsertPaper(samplePaper(hash, "Stale after AI cleanup", cacheId), { expectedRevision: 1 }),
    /revision conflict/i,
  );

  const afterAssets = await ws.clearPaperData(hash, "assets");
  assert.equal(afterAssets.paper.revision, 3);
  assert.equal(afterAssets.paper.blocks[0].assetRef, null);

  const afterStructure = await ws.clearPaperData(hash, "structure-keep-notes");
  assert.equal(afterStructure.paper.revision, 4);
  assert.equal(afterStructure.paper.structureDetached, true);
  await assert.rejects(
    () => ws.upsertPaper(samplePaper(hash, "Stale after structure cleanup"), { expectedRevision: 1 }),
    /revision conflict/i,
  );
});

test("uncached PDF parse returns its committed revision for the next CAS sync", async (t) => {
  const tmpDir = createTmpDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const app = makeApp();
  const paperBytes = Buffer.from("%PDF-1.4\\nrevision fixture\\n%%EOF\\n");
  const resultZip = storedZip({
    "fixture/content_list_v2.json": JSON.stringify([{ type: "text", page_idx: 0, text: "Parsed paragraph" }]),
  });
  let dataId = "";
  const config = {
    mineruApiToken: "x".repeat(48),
    mineruApiBaseUrl: "https://mineru.net/api/v4",
    mineruModelVersion: "vlm",
    mineruLanguage: "en",
    mineruEnableFormula: true,
    mineruEnableTable: true,
    mineruOcr: true,
    mineruTimeoutSeconds: 60,
    mineruPollIntervalSeconds: 2,
  };
  const ctx = {
    pluginId: "hana-paper-reader",
    dataDir: tmpDir,
    config: { get: (key) => config[key], setMany() {} },
    log: { error() {}, warn() {} },
    bus: { request: async () => { throw new Error("model must not run"); } },
    network: {
      async fetch(url, init = {}) {
        if (url === "https://mineru.net/api/v4/file-urls/batch") {
          dataId = JSON.parse(init.body).files[0].data_id;
          return jsonResponse({ code: 0, data: { batch_id: "revision-batch", file_urls: ["https://mineru.oss-cn-shanghai.aliyuncs.com/revision-upload"] } });
        }
        if (url === "https://mineru.oss-cn-shanghai.aliyuncs.com/revision-upload") return new Response(null, { status: 200 });
        if (url === "https://mineru.net/api/v4/extract-results/batch/revision-batch") {
          return jsonResponse({ code: 0, data: { extract_result: [{ data_id: dataId, file_name: "revision.pdf", state: "done", full_zip_url: "https://cdn-mineru.openxlab.org.cn/revision/result.zip" }] } });
        }
        if (url === "https://cdn-mineru.openxlab.org.cn/revision/result.zip") return new Response(resultZip, { status: 200 });
        throw new Error(`unexpected URL: ${url}`);
      },
    },
  };

  registerApiRoutes(app, ctx);
  const parse = await app.routes.get("POST /api/parse-pdf")(
    binaryRequestContext(paperBytes, { parser: "mineru", fileName: "revision.pdf" }),
  );
  assert.equal(parse.status, 200);
  assert.equal(parse.value.ok, true);
  assert.equal(parse.value.revision, 1);

  const followUp = await app.routes.get("POST /api/research/paper")(
    requestContext({
      paperHash: parse.value.paperHash,
      metadata: { title: "revision.pdf" },
      parser: { kind: "mineru", pageCount: parse.value.pageCount },
      blocks: parse.value.blocks,
      expectedRevision: parse.value.revision,
    }),
  );
  assert.equal(followUp.status, 200);
  assert.equal(followUp.value.paper.revision, 2);
});

test("saveFileToDisk concurrent writes create non-overlapping unique files", async (t) => {
  const tmpDir = createTmpDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const contents = Array.from({ length: 20 }, (_, i) => `content_${i}`);
  const results = contents.map((c) => saveFileToDisk(c, "paper.md", tmpDir));

  const filenames = new Set(results.map((r) => r.fileName));
  assert.equal(filenames.size, 20, "All 20 concurrent export files must have distinct names");
  assert.ok(results.every((r) => r.filePath.startsWith(tmpDir)), "explicit fallback directory must isolate test exports from the real Downloads folder");

  for (const r of results) {
    assert.equal(fs.existsSync(r.filePath), true);
    assert.equal(fs.statSync(r.filePath).size > 0, true);
  }
});
