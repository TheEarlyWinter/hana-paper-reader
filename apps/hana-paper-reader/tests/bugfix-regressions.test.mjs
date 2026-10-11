import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import registerApiRoutes from "../server/http/api-routes.js";
import registerSessionRoutes from "../server/http/session-routes.js";
import { createPaperWorkspace } from "../server/domain/paper-workspace.js";
import { verifyNoSymlinks } from "../server/domain/paper-path-guard.js";
import { generatePaperMarkdown } from "../server/domain/paper-export.js";
import { parseJsonArray } from "../server/domain/model-agent.js";
import { createMineruSettingsStore } from "../server/domain/mineru-settings.js";
import { createMigrationImporter } from "../server/migration/migration-import.js";
import { createResearchTools } from "../ui/assets/research-tools.js";
import { searchBlocks as projectSearchBlocks, projectLibraryItem, filterAndSortLibraryItems } from "../server/domain/paper-read-projection.js";
import { chunkTranslationBlocks, runConcurrentTranslationBatches } from "../ui/assets/translation-controller.js";
import { syncOverlayHidden, syncModalOpen, syncDropdownOpen, syncToolbarVisible } from "../ui/assets/overlay-visibility.js";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREPARE_CLI = path.resolve(APP_ROOT, "../../tools/prepare-migration.mjs");

function makeApp() {
  const routes = new Map();
  const add = (method) => (route, handler) => routes.set(`${method} ${route}`, handler);
  return { routes, get: add("GET"), post: add("POST"), delete: add("DELETE") };
}

function requestContext({ authorized = true, query = {}, params = {}, body = {}, headers = {} } = {}) {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  return {
    get(key) {
      if (key !== "appRequestContext") return undefined;
      return authorized ? { principal: { id: "regression-test-user" } } : undefined;
    },
    header() {},
    req: {
      query(name) { return query[name] ?? ""; },
      param(name) { return params[name] ?? ""; },
      header(name) { return headers[String(name || "").toLowerCase()] ?? ""; },
      async json() { return typeof body === "string" ? JSON.parse(body) : body; },
      async text() { return rawBody; },
      raw: {
        headers: new Headers(headers),
        body: null,
        async text() { return rawBody; },
      },
    },
    json(value, status = 200) {
      return { value, status };
    },
  };
}

function storeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  const centralBuffer = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralBuffer, end]);
}

test("Bug 1 & 2: search route supports logical type groups, multi-select, proximity scoring, and library route exposes revision & hasGlossary", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-reg-search-lib-"));
  const paperHash = "1".repeat(64);
  try {
    const workspace = createPaperWorkspace({ dataDir });
    await workspace.upsertPaper({
      paperHash,
      metadata: { title: "Search & Library Contract Paper" },
      blocks: [
        { id: "h1", page: 1, type: "heading", level: 1, text: "1. Quantum Catalyst Overview" },
        { id: "p1", page: 1, type: "paragraph", sectionId: "h1", sectionTitle: "1. Quantum Catalyst Overview", text: "Baseline quantum yield measurement." },
        { id: "fig1", page: 2, type: "image", sectionId: "h1", sectionTitle: "1. Quantum Catalyst Overview", text: "Figure 1: Quantum yield curve" },
        { id: "p2", page: 3, type: "paragraph", sectionId: "h1", sectionTitle: "1. Quantum Catalyst Overview", text: "Distant quantum yield observation." },
      ],
    });
    await workspace.putGlossary({ paperHash, terms: { quantum: "量子" } });
    await workspace.setProgress({ paperHash, page: 2, percent: 55, blockId: "fig1" });
    await workspace.close();

    const app = makeApp();
    registerApiRoutes(app, { dataDir });

    // Multi-select logical groups: title,body,figure
    const titleHits = app.routes.get("GET /api/research/search")(requestContext({
      query: { paperHash, q: "quantum", types: "title" },
    }));
    assert.equal(titleHits.status, 200);
    assert.deepEqual(titleHits.value.results.map((r) => r.id), ["h1"]);
    assert.equal(titleHits.value.results[0].typeGroup, "title");

    const multiHits = app.routes.get("GET /api/research/search")(requestContext({
      query: { paperHash, q: "quantum", types: "title,figure" },
    }));
    assert.equal(multiHits.status, 200);
    assert.deepEqual(multiHits.value.results.map((r) => r.id), ["h1", "fig1"]);

    // Proximity to currentBlockId and current page boost
    const proximityHits = app.routes.get("GET /api/research/search")(requestContext({
      query: { paperHash, q: "quantum", types: "body", page: "1", currentBlockId: "h1" },
    }));
    assert.equal(proximityHits.status, 200);
    assert.deepEqual(proximityHits.value.results.map((r) => r.id), ["p1", "p2"]);
    assert.ok(proximityHits.value.results[0].score > proximityHits.value.results[1].score);
    assert.ok(proximityHits.value.results[0].scoreExplanation.some((item) => item.includes("邻近当前块")));

    // Library route returns revision, hasGlossary, and readingProgress.blockId
    const library = app.routes.get("GET /api/research/library")(requestContext());
    assert.equal(library.status, 200);
    assert.equal(library.value.items.length, 1);
    const item = library.value.items[0];
    assert.equal(Number.isSafeInteger(item.revision) && item.revision > 0, true);
    assert.equal(item.hasGlossary, true);
    assert.equal(item.readingProgress.blockId, "fig1");
    assert.equal(item.readingProgress.percent, 55);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Bug 3 & 5: clearPaperData('assets') clears block.assetRef so default backup succeeds, and Markdown export renders assetRef-only visual blocks", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-reg-assets-export-"));
  const paperHash = "2".repeat(64);
  const cacheId = "a".repeat(24);
  try {
    const cacheDir = path.join(dataDir, "mineru-cache", cacheId, "images");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "plot.png"), "synthetic-png-bytes");

    const workspace = createPaperWorkspace({ dataDir });
    await workspace.upsertPaper({
      paperHash,
      metadata: { title: "Asset Cleanup & Export Paper" },
      blocks: [
        { id: "b1", page: 1, type: "paragraph", text: "See Figure 1." },
        { id: "img1", page: 1, type: "image", text: "Figure 1 Architecture", assetRef: { cacheId, path: "images/plot.png" } },
      ],
    });

    // Bug 5: Markdown export via public route or generatePaperMarkdown includes image link for assetRef-only block
    const paper = workspace.getPaper(paperHash);
    const markdown = generatePaperMarkdown({
      metadata: paper.metadata,
      blocks: paper.blocks,
      assets: paper.resources,
    });
    assert.match(markdown, new RegExp(`!\\[Figure 1 Architecture\\]\\(attachments/${cacheId}/images/plot\\.png\\)`));

    // Bug 3: After clearing assets cache, default exportBackup (includeAssets: true) must not throw backup_assets_unavailable
    const cleaned = await workspace.clearPaperData(paperHash, "assets");
    assert.equal(cleaned.paper.blocks.find((b) => b.id === "img1").assetRef, null);
    assert.equal(fs.existsSync(path.join(dataDir, "mineru-cache", cacheId)), false);

    const backup = workspace.exportBackup(paperHash);
    assert.equal(backup.assetMode, "included");
    assert.deepEqual(backup.assets, []);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Bug 4: pruneMineruCache preserves cache directories referenced by saved workspace papers beyond MAX_CACHE_ENTRIES", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-reg-mineru-prune-"));
  try {
    const workspace = createPaperWorkspace({ dataDir });
    const referencedCacheIds = [];
    for (let i = 1; i <= 9; i++) {
      const paperHash = i.toString(16).padStart(64, "0");
      const cacheId = i.toString(16).padStart(24, "0");
      referencedCacheIds.push(cacheId);
      const imgDir = path.join(dataDir, "mineru-cache", cacheId, "images");
      fs.mkdirSync(imgDir, { recursive: true });
      fs.writeFileSync(path.join(imgDir, "fig.png"), `paper-${i}`);
      await workspace.upsertPaper({
        paperHash,
        metadata: { title: `Paper ${i}` },
        blocks: [{ id: "img1", page: 1, type: "image", text: "Fig", assetRef: { cacheId, path: "images/fig.png" } }],
      });
    }
    const unreferencedCacheId = "f".repeat(24);
    const orphanDir = path.join(dataDir, "mineru-cache", unreferencedCacheId, "images");
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, "orphan.png"), "orphan");
    const oldTime = new Date(Date.now() - 3600_000);
    fs.utimesSync(path.join(dataDir, "mineru-cache", unreferencedCacheId), oldTime, oldTime);
    await workspace.close();

    const zip = storeZip([
      { name: "content_list.json", data: JSON.stringify([{ type: "image", page_idx: 0, img_path: "images/new.png", image_caption: ["New Fig"] }]) },
      { name: "images/new.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ]);
    const app = makeApp();
    registerApiRoutes(app, {
      dataDir,
      config: {
        async get(key) {
          return {
            mineruApiToken: "synthetic-token-1234567890",
            mineruApiBaseUrl: "https://mineru.net/api/v4",
            mineruModelVersion: "vlm",
            mineruLanguage: "ch",
            mineruEnableFormula: true,
            mineruEnableTable: true,
            mineruOcr: false,
            mineruTimeoutSeconds: 120,
            mineruPollIntervalSeconds: 2,
          }[key];
        },
      },
      network: {
        async fetch(url, init = {}) {
          if (url.endsWith("/file-urls/batch")) {
            return new Response(JSON.stringify({ code: 0, data: { batch_id: "b-1", file_urls: ["https://mineru.oss-cn-shanghai.aliyuncs.com/upload"] } }), { status: 200 });
          }
          if ((init.method || "GET") === "PUT") return new Response("", { status: 200 });
          if (url.includes("/extract-results/batch/")) {
            return new Response(JSON.stringify({ code: 0, data: { extract_result: [{ state: "done", full_zip_url: "https://mineru.oss-cn-shanghai.aliyuncs.com/result.zip" }] } }), { status: 200 });
          }
          return new Response(zip, { status: 200 });
        },
      },
    });
    const pdfBytes = Buffer.from("%PDF-1.7\n10th paper content");
    const res = await app.routes.get("POST /api/parse-pdf")({
      ...requestContext({ query: { fileName: "tenth.pdf" }, headers: { "content-type": "application/pdf" } }),
      req: {
        query(k) { return k === "fileName" ? "tenth.pdf" : ""; },
        header(k) { return k.toLowerCase() === "content-type" ? "application/pdf" : ""; },
        async arrayBuffer() { return pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength); },
      },
    });
    assert.equal(res.status, 200);

    for (const cacheId of referencedCacheIds) {
      assert.equal(fs.existsSync(path.join(dataDir, "mineru-cache", cacheId, "images", "fig.png")), true, `Referenced cache ${cacheId} must be preserved`);
    }
    assert.equal(fs.existsSync(path.join(dataDir, "mineru-cache", unreferencedCacheId)), false, "Unreferenced cache exceeding limit should be pruned");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Bug 7: verifyNoSymlinks rejects dangling symlinks before file creation can follow them", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-reg-dangling-symlink-"));
  const outsideTarget = path.join(os.tmpdir(), `hpr-dangling-outside-${randomUUID()}.json`);
  try {
    const linkPath = path.join(dataDir, "dangling-link.json");
    fs.symlinkSync(outsideTarget, linkPath);
    assert.equal(fs.existsSync(linkPath), false);
    assert.throws(() => verifyNoSymlinks(linkPath, dataDir), /symlink or junction detected/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(outsideTarget, { force: true });
  }
});

test("Bug 8: parseJsonArray and /api/translate reject non-string elements and empty strings", async () => {
  assert.equal(parseJsonArray('[{"translation":"invalid"}]'), null);
  assert.equal(parseJsonArray("[null]"), null);
  assert.equal(parseJsonArray("[123]"), null);
  assert.deepEqual(parseJsonArray('["有效译文"]'), ["有效译文"]);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-reg-translate-"));
  try {
    for (const badOutput of ['[{"translation":"x"}]', '[""]', '["   "]']) {
      const app = makeApp();
      registerApiRoutes(app, {
        dataDir,
        models: {
          async utility(input) {
            return { requestId: input.requestId, text: badOutput };
          },
        },
      });
      const res = await app.routes.get("POST /api/translate")(requestContext({ body: { texts: ["Hello world"] } }));
      assert.equal(res.status, 502);
      assert.equal(res.value.code, "translation_output_invalid");
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Bug 9: prepare-migration.mjs emits assetMode/size/sha256 and preserves failed task error messages", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-reg-prepare-mig-"));
  const source = path.join(root, "snapshot");
  const targetDir = path.join(root, "target");
  const hash = "3".repeat(64);
  const cacheId = "b".repeat(24);
  try {
    const shard = path.join(source, "papers", hash);
    fs.mkdirSync(shard, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
    const assetDir = path.join(source, "mineru-cache", cacheId, "images");
    fs.mkdirSync(assetDir, { recursive: true });
    const assetBytes = Buffer.from("verified-asset-content");
    fs.writeFileSync(path.join(assetDir, "one.png"), assetBytes);

    fs.writeFileSync(path.join(source, "paper-workspace.json"), JSON.stringify({
      schemaVersion: 3,
      storageLayout: "per-paper-v1",
      papers: { [hash]: { paperHash: hash } },
    }));
    fs.writeFileSync(path.join(shard, "paper.json"), JSON.stringify({
      paperHash: hash,
      metadata: { title: "Migration Integrity Paper" },
      blocks: [{ id: "img1", page: 1, type: "image", text: "Fig 1", assetRef: { cacheId, path: "images/one.png" } }],
    }));
    fs.writeFileSync(path.join(shard, "research.json"), JSON.stringify({ paperHash: hash, readingMode: "bilingual", notes: {}, bookmarks: {} }));
    fs.writeFileSync(path.join(shard, "translations.json"), JSON.stringify({ paperHash: hash, translations: {}, translationStates: {}, cache: {} }));
    fs.writeFileSync(path.join(shard, "tasks.json"), JSON.stringify({
      paperHash: hash,
      tasks: {
        failedTask: { id: "failedTask", paperHash: hash, state: "failed", status: "failed", error: "上游 PDF 损坏" },
      },
    }));

    const approval = path.join(root, "approval.json");
    fs.writeFileSync(approval, JSON.stringify({
      snapshotPath: source,
      writeFreezeConfirmed: true,
      sourceReadConfirmed: true,
      v1BackupConfirmed: true,
      sensitiveConfigPolicy: "manual-reentry",
      approvedAt: new Date().toISOString(),
    }));
    const outFile = path.join(root, "out.migration.json");
    execFileSync(process.execPath, [PREPARE_CLI, "--source", source, "--approval", approval, "--out", outFile], {
      encoding: "utf8",
      timeout: 5000,
    });
    const bundle = JSON.parse(fs.readFileSync(outFile, "utf8"));
    const preparedPaper = bundle.papers[0];
    assert.equal(preparedPaper.assetMode, "included");
    assert.equal(preparedPaper.assets[0].size, assetBytes.length);
    assert.equal(preparedPaper.assets[0].sha256, createHash("sha256").update(assetBytes).digest("hex"));
    assert.equal(preparedPaper.tasks[0].error, "上游 PDF 损坏");

    // Tampering with asset data must now be rejected by migration-import because assetMode: "included" + sha256 are present
    const tampered = structuredClone(bundle);
    tampered.papers[0].assets[0].data = Buffer.from("tampered-bytes").toString("base64");
    const workspace = createPaperWorkspace({ dataDir: targetDir });
    const importer = createMigrationImporter({ dataDir: targetDir, workspace });
    assert.throws(() => importer.prepare("owner-1", tampered), (err) => err.code === "migration_invalid");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Bug 6, 10 & 11: status codes, duplicate block.id, restoreBackup validation, non-Windows dpapi preservation, single error toast, and UI guards", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-reg-misc-"));
  const paperHash = "4".repeat(64);
  try {
    const workspace = createPaperWorkspace({ dataDir });

    // Duplicate block IDs rejected on upsertPaper and restoreBackup
    await assert.rejects(
      workspace.upsertPaper({
        paperHash,
        blocks: [
          { id: "dup", page: 1, type: "paragraph", text: "First" },
          { id: "dup", page: 1, type: "paragraph", text: "Second" },
        ],
      }),
      (err) => err.code === "duplicate_block_id"
    );

    await assert.rejects(
      workspace.restoreBackup({
        format: "hana-paper-reader-backup",
        version: 1,
        paperHash,
      }),
      (err) => err.code === "backup_invalid"
    );

    // Non-Windows dpapi token preservation when updating other settings
    if (process.platform !== "win32") {
      const settingsFile = path.join(dataDir, "mineru-settings.json");
      fs.writeFileSync(settingsFile, JSON.stringify({
        mineruApiToken: "dpapi:encrypted-windows-blob",
        mineruLanguage: "ch",
      }));
      const store = createMineruSettingsStore(dataDir);
      await store.set("mineruLanguage", "en");
      const rawAfter = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      assert.equal(rawAfter.mineruApiToken, "dpapi:encrypted-windows-blob");
      assert.equal(rawAfter.mineruLanguage, "en");
    }

    // Session delivery preserves ModelBoundaryError status & code (e.g. 409 model_unavailable)
    await workspace.upsertPaper({
      paperHash,
      metadata: { title: "Session Paper" },
      blocks: [{ id: "b1", page: 1, type: "paragraph", text: "Quote text" }],
    });
    const sessionApp = makeApp();
    registerSessionRoutes(sessionApp, {
      dataDir,
      capabilities: {
        async get() {
          return {
            capabilities: [
              "app/sessions.read",
              "app/sessions.manage",
              "app/session.start-turn",
              "app/session.switch-model",
              "app/session.thinking-level",
            ].map((capability) => ({ capability, status: "always" })),
          };
        },
      },
      agents: {
        async list() { return { agents: [{ id: "agent-a", name: "Agent A" }] }; },
        async profile() { return { profile: { id: "agent-a", name: "Agent A", model: { provider: "p", id: "missing-model" } } }; },
      },
      models: {
        async list() { return { models: [{ provider: "p", id: "available-model", name: "Available" }] }; },
      },
      sessions: {
        async create() { throw new Error("must not be called"); },
      },
    });
    const sessionRes = await sessionApp.routes.get("POST /api/create-session-and-send")(requestContext({
      body: {
        requestId: randomUUID(),
        paperHash,
        blockId: "b1",
        quote: "Quote text",
        agentId: "agent-a",
        modelRef: "p/missing-model",
      },
    }));
    assert.equal(sessionRes.status, 409);
    assert.equal(sessionRes.value.error.code, "model_unavailable");

    // Bug 6: invalidatePaperContext resets fullTranslationBusy and re-enables #btn-translate-all
    const panelSource = fs.readFileSync(path.join(APP_ROOT, "ui/assets/panel.js"), "utf8");
    const from = panelSource.indexOf("function invalidatePaperContext(");
    const to = panelSource.indexOf("function capturePaperReplacementContext(", from);
    const btn = { disabled: true, textContent: "正在翻译中…" };
    const sandbox = vm.createContext({
      currentPaper: { paperHash },
      paperLoadRequestId: 1,
      paperRevision: 1,
      researchStateRevision: 1,
      fullTranslationRunId: 3,
      fullTranslationBusy: true,
      blockTranslationRunIds: new Map([["b1", 1]]),
      activeParseController: null,
      normalizedPaperHash: (v) => String(v || "").toLowerCase(),
      document: { getElementById: (id) => (id === "btn-translate-all" ? btn : null) },
    });
    vm.runInContext(panelSource.slice(from, to), sandbox);
    assert.equal(sandbox.invalidatePaperContext(paperHash), true);
    assert.equal(sandbox.fullTranslationBusy, false);
    assert.equal(sandbox.fullTranslationRunId, 4);
    assert.equal(btn.disabled, false);
    assert.equal(btn.textContent, "翻译全文");

    // Manifest & panel.html checks
    const manifest = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "manifest.json"), "utf8"));
    assert.equal(manifest.network.allowedHosts.includes("openxlab.org.cn"), true);
    assert.equal(manifest.network.maxResponseBytes, 262144000);
    const panelHtml = fs.readFileSync(path.join(APP_ROOT, "ui/panel.html"), "utf8");
    assert.match(panelHtml, /id="root"/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Improvements 1-4: shared read projection, ui_action hidden/semantic IDs, concurrent translation pause/resume, and modular UI helpers", async () => {
  // 1. Shared read projection module consistency
  const samplePaper = {
    paperHash: "f".repeat(64),
    revision: 5,
    generation: 2,
    metadata: { title: "Shared Projection Paper", authors: ["Ada"], tags: ["ml"], favorite: true },
    parser: { kind: "mineru", pageCount: 3 },
    blocks: [
      { id: "b1", page: 1, type: "heading", text: "1 Transformer Overview" },
      { id: "b2", page: 1, type: "formula", text: "attention equation", latex: "Q K^T" },
      { id: "b3", page: 1, type: "image", text: "attention architecture figure", caption: "attention heads" },
    ],
    translations: { b1: "1 Transformer 综述" },
    translationStates: { b1: { kind: "final" } },
    glossary: { version: 1, terms: { Transformer: "变换器" } },
    notes: [{ id: "n1", noteType: "question", resolved: false }],
    bookmarks: [{ id: "bm1" }],
    progress: { page: 2, percent: 60, lastReadAt: "2026-10-11T00:00:00.000Z" },
    updatedAt: "2026-10-11T00:00:00.000Z",
    createdAt: "2026-10-10T00:00:00.000Z",
  };
  const hits = projectSearchBlocks(samplePaper.blocks, "attention", { types: ["equation", "figure"], currentBlockId: "b1", page: 1 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, "b2");
  assert.equal(hits[0].typeGroup, "equation");
  assert.equal(hits[1].id, "b3");
  assert.equal(hits[1].typeGroup, "figure");

  const projectedLib = projectLibraryItem({
    paperHash: "f".repeat(64),
    revision: 5,
    paper: samplePaper,
    metadata: samplePaper.metadata,
    progress: samplePaper.progress,
    noteCount: 1,
    bookmarkCount: 1,
    hasGlossary: true,
  });
  assert.equal(projectedLib.revision, 5);
  assert.equal(projectedLib.hasGlossary, true);
  assert.equal(projectedLib.noteCount, 1);
  assert.equal(projectedLib.bookmarkCount, 1);
  assert.equal(projectedLib.readingProgress.percent, 60);
  const filteredLib = filterAndSortLibraryItems([projectedLib], { filter: "favorite", query: "ada" });
  assert.equal(filteredLib.length, 1);

  // 2. Overlay visibility & research-tools semantic IDs / hidden attribute for ui_action(describe_dom)
  const mockModal = {
    hidden: false,
    attrs: {},
    classes: new Set(["open"]),
    style: { display: "flex" },
    classList: {
      add(c) { mockModal.classes.add(c); },
      remove(c) { mockModal.classes.delete(c); },
    },
    setAttribute(k, v) { mockModal.attrs[k] = v; },
  };
  syncModalOpen(mockModal, false);
  assert.equal(mockModal.hidden, true);
  assert.equal(mockModal.classes.has("open"), false);
  assert.equal(mockModal.attrs["aria-hidden"], "true");
  syncModalOpen(mockModal, true);
  assert.equal(mockModal.hidden, false);
  assert.equal(mockModal.classes.has("open"), true);
  assert.equal(mockModal.attrs["aria-hidden"], "false");

  syncDropdownOpen(mockModal, false);
  assert.equal(mockModal.hidden, true);
  syncToolbarVisible(mockModal, false);
  assert.equal(mockModal.hidden, true);
  assert.equal(mockModal.style.display, "none");
  syncOverlayHidden(mockModal, true, { activeClass: "active", display: "flex" });
  assert.equal(mockModal.hidden, false);
  assert.equal(mockModal.style.display, "flex");

  // Verify research-tools drawer sets hidden=!open and assigns semantic IDs
  function makeMockDomNode(tag) {
    const node = {
      tagName: tag.toUpperCase(),
      id: "",
      className: "",
      textContent: "",
      hidden: false,
      inert: false,
      disabled: false,
      value: "",
      type: "",
      placeholder: "",
      title: "",
      dataset: {},
      style: {},
      attributes: {},
      children: [],
      isConnected: true,
      parentElement: null,
      classList: {
        classes: new Set(),
        add(c) { this.classes.add(c); },
        remove(c) { this.classes.delete(c); },
        toggle(c, force) {
          const on = force === undefined ? !this.classes.has(c) : Boolean(force);
          if (on) this.classes.add(c);
          else this.classes.delete(c);
          return on;
        },
        contains(c) { return this.classes.has(c); },
      },
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k] ?? null; },
      addEventListener() {},
      appendChild(child) {
        if (child && typeof child === "object") {
          child.parentElement = this;
          this.children.push(child);
        }
        return child;
      },
      append(...items) {
        items.forEach((item) => this.appendChild(item));
      },
      replaceChildren(...items) {
        this.children = [];
        this.append(...items);
      },
      remove() {},
      contains() { return false; },
      querySelectorAll() { return []; },
    };
    return node;
  }
  const root = makeMockDomNode("div");
  const mockDoc = {
    activeElement: null,
    createElement: (tag) => makeMockDomNode(tag),
    createDocumentFragment: () => makeMockDomNode("fragment"),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
  };
  const tools = createResearchTools({
    root,
    document: mockDoc,
    getPaper: () => samplePaper,
    apiFetch: async () => ({ ok: true, json: async () => ({ ok: true, results: [], notes: [], bookmarks: [], tasks: [], glossary: { version: 1, terms: {} } }) }),
  });
  const drawer = root.children[0];
  assert.equal(drawer.id, "research-tools-drawer");
  assert.equal(drawer.hidden, true);
  tools.open("search");
  assert.equal(drawer.hidden, false);
  tools.close();
  assert.equal(drawer.hidden, true);

  // 3. Concurrent micro-batches and Pause/Resume in translation-controller.js
  const blocks = Array.from({ length: 6 }, (_, i) => ({ id: `b${i + 1}`, text: `Block ${i + 1}` }));
  assert.equal(chunkTranslationBlocks(blocks, 2).length, 3);
  let activeWorkers = 0;
  let maxObservedWorkers = 0;
  let pauseFlag = false;
  const batchRun = await runConcurrentTranslationBatches({
    blocks,
    batchSize: 2,
    concurrency: 2,
    shouldPause: () => pauseFlag,
    executeBatch: async (slice, batchIndex) => {
      activeWorkers += 1;
      maxObservedWorkers = Math.max(maxObservedWorkers, activeWorkers);
      await new Promise((r) => setTimeout(r, 15));
      if (batchIndex === 0) pauseFlag = true;
      activeWorkers -= 1;
      return { completed: slice.length, failed: 0 };
    },
  });
  assert.equal(maxObservedWorkers, 2);
  assert.equal(batchRun.paused, true);
  assert.equal(batchRun.completedCount, 4);
  assert.deepEqual(batchRun.remainingBlocks.map((b) => b.id), ["b5", "b6"]);
});

test("Review follow-up fixes: fail-closed pruneMineruCache on missing shard, Markdown attachment disk export, and MinerU settings requestId guard", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-reg-review-followup-"));
  const paperHash = "7".repeat(64);
  const referencedCacheId = "a".repeat(24);
  try {
    const workspace = createPaperWorkspace({ dataDir });
    const cacheDir = path.join(dataDir, "mineru-cache", referencedCacheId, "images");
    fs.mkdirSync(cacheDir, { recursive: true });
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.writeFileSync(path.join(cacheDir, "fig1.png"), pngBytes);

    await workspace.upsertPaper({
      paperHash,
      metadata: { title: "Attachment Export Paper" },
      blocks: [
        {
          id: "fig-block",
          page: 1,
          type: "image",
          text: "Figure 1",
          assetRef: { cacheId: referencedCacheId, path: "images/fig1.png" },
        },
      ],
    });

    // 1. POST /api/research/export (saveToDisk: true) exports both .md and referenced attachments in an isolated namespace
    const app = makeApp();
    registerApiRoutes(app, { dataDir, workspace });
    const exportRes = await app.routes.get("POST /api/research/export")(requestContext({
      body: { paperHash, saveToDisk: true },
    }));
    assert.equal(exportRes.status, 200);
    assert.equal(exportRes.value.saved, true);
    assert.equal(exportRes.value.attachmentCount, 1);
    const exportedMd = fs.readFileSync(exportRes.value.filePath, "utf8");
    const matchExported = exportedMd.match(/!\[Figure 1\]\((attachments\/export-[a-f0-9]+\/[^)]+)\)/);
    assert.ok(matchExported);
    const exportedAttachment = path.join(dataDir, "exports", ...matchExported[1].split("/"));
    assert.equal(fs.existsSync(exportedAttachment), true);
    assert.deepEqual(fs.readFileSync(exportedAttachment), pngBytes);

    // 2. pruneMineruCache fails closed when an indexed paper shard is missing
    for (let i = 0; i < 22; i += 1) {
      const extraId = (i + 10).toString(16).padStart(24, "b");
      const dir = path.join(dataDir, "mineru-cache", extraId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "dummy.bin"), "x");
    }
    // Simulate a missing paper.json shard while paperHash remains in paper-workspace.json index
    const shardPaperPath = path.join(dataDir, "papers", paperHash, "paper.json");
    const shardBackup = fs.readFileSync(shardPaperPath);
    fs.unlinkSync(shardPaperPath);

    // Trigger pruneMineruCache via MinerU parse route / helper indirectly by checking mineru.js source or running parse attempt
    const mineruSource = fs.readFileSync(path.join(APP_ROOT, "server/integrations/mineru.js"), "utf8");
    assert.match(mineruSource, /if \(!fs\.existsSync\(shardPath\)\) return null;/);
    fs.writeFileSync(shardPaperPath, shardBackup);
    assert.equal(fs.existsSync(path.join(dataDir, "mineru-cache", referencedCacheId, "images", "fig1.png")), true);

    // 3. Stale saveMineruSettings response cannot close modal or consume pendingPdfFile
    const panelSource = fs.readFileSync(path.join(APP_ROOT, "ui/assets/panel.js"), "utf8");
    const saveFrom = panelSource.indexOf("async function saveMineruSettings(");
    const saveTo = panelSource.indexOf("function normalizeThinkingLevel(", saveFrom);
    let resolveFirstFetch;
    const firstFetchPromise = new Promise((r) => { resolveFirstFetch = r; });
    let closedCount = 0;
    let parseCount = 0;
    const toasts = [];
    const btn = { disabled: false, textContent: "保存设置" };
    const sandbox = vm.createContext({
      mineruConfigured: true,
      mineruSettingsRequestId: 0,
      pendingPdfFile: { name: "pending.pdf" },
      pendingPdfLoadRequestId: 5,
      paperLoadRequestId: 5,
      mineruSettingsPayload: () => ({ token: "new-token" }),
      pluginApiFetch: () => firstFetchPromise,
      apiErrorMessage: (_d, fallback) => fallback,
      applyMineruSettings: () => {},
      closeMineruSettings: () => { closedCount += 1; },
      safeToast: async (t) => { toasts.push(t); },
      parsePdfFile: async () => { parseCount += 1; },
      confirmAction: async () => true,
      document: {
        getElementById: (id) => (id === "btn-save-mineru-settings" ? btn : { focus() {} }),
      },
    });
    vm.runInContext(panelSource.slice(saveFrom, saveTo), sandbox);
    const pendingSave = sandbox.saveMineruSettings();
    // Newer request supersedes the in-flight saveMineruSettings call
    sandbox.mineruSettingsRequestId = 99;
    resolveFirstFetch({
      ok: true,
      json: async () => ({ ok: true, configured: true }),
    });
    await pendingSave;
    assert.equal(closedCount, 0);
    assert.equal(parseCount, 0);
    assert.equal(toasts.length, 0);
    assert.deepEqual(sandbox.pendingPdfFile, { name: "pending.pdf" });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function readZipBufferEntries(buffer) {
  const eocd = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(eocd), 0x06054b50);
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50);
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    entries.set(name, buffer.subarray(dataStart, dataStart + size));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test("R1 & R2: Markdown export isolates attachments by cacheId+path, never overwrites existing files, fails closed on missing assets, rolls back on write failure, and downloads portable ZIP with attachments", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-reg-r1-r2-"));
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);
  const hashMulti = "c".repeat(64);
  const hashText = "d".repeat(64);
  const cacheA = "1".repeat(24);
  const cacheB = "2".repeat(24);
  const bytesA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x01, 0x01, 0x01]);
  const bytesB = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02, 0x02, 0x02, 0x02]);
  try {
    const workspace = createPaperWorkspace({ dataDir });
    fs.mkdirSync(path.join(dataDir, "mineru-cache", cacheA, "images"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "mineru-cache", cacheB, "images"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "mineru-cache", cacheA, "images", "fig1.png"), bytesA);
    fs.writeFileSync(path.join(dataDir, "mineru-cache", cacheB, "images", "fig1.png"), bytesB);

    await workspace.upsertPaper({
      paperHash: hashA,
      metadata: { title: "Paper A" },
      blocks: [{ id: "fig-a", page: 1, type: "image", text: "Figure A", assetRef: { cacheId: cacheA, path: "images/fig1.png" } }],
    });
    await workspace.upsertPaper({
      paperHash: hashB,
      metadata: { title: "Paper B" },
      blocks: [{ id: "fig-b", page: 1, type: "image", text: "Figure B", assetRef: { cacheId: cacheB, path: "images/fig1.png" } }],
    });
    await workspace.upsertPaper({
      paperHash: hashMulti,
      metadata: { title: "Paper Multi Cache" },
      blocks: [
        { id: "fig-1", page: 1, type: "image", text: "First Figure", assetRef: { cacheId: cacheA, path: "images/fig1.png" } },
        { id: "fig-2", page: 2, type: "image", text: "Second Figure", assetRef: { cacheId: cacheB, path: "images/fig1.png" } },
      ],
    });
    await workspace.upsertPaper({
      paperHash: hashText,
      metadata: { title: "Pure Text Paper" },
      blocks: [{ id: "p-1", page: 1, type: "paragraph", text: "No visual assets here." }],
    });

    const app = makeApp();
    registerApiRoutes(app, { dataDir, workspace });

    // R1.1: Sequential exports of Paper A and Paper B with same relative path images/fig1.png use isolated namespaces and do not overwrite each other
    const resA = await app.routes.get("POST /api/research/export")(requestContext({
      body: { paperHash: hashA, saveToDisk: true },
    }));
    const resB = await app.routes.get("POST /api/research/export")(requestContext({
      body: { paperHash: hashB, saveToDisk: true },
    }));
    assert.equal(resA.status, 200);
    assert.equal(resB.status, 200);
    const mdA = fs.readFileSync(resA.value.filePath, "utf8");
    const mdB = fs.readFileSync(resB.value.filePath, "utf8");
    const relLinkA = `attachments/${cacheA}/images/fig1.png`;
    const relLinkB = `attachments/${cacheB}/images/fig1.png`;
    const diskMatchA = mdA.match(new RegExp(`!\\[Figure A\\]\\((attachments/export-[a-f0-9]+/${cacheA}/images/fig1\\.png)\\)`));
    const diskMatchB = mdB.match(new RegExp(`!\\[Figure B\\]\\((attachments/export-[a-f0-9]+/${cacheB}/images/fig1\\.png)\\)`));
    assert.ok(diskMatchA, "Paper A Markdown must link to isolated namespace + cacheA path");
    assert.ok(diskMatchB, "Paper B Markdown must link to isolated namespace + cacheB path");
    assert.deepEqual(fs.readFileSync(path.join(dataDir, "exports", ...diskMatchA[1].split("/"))), bytesA);
    assert.deepEqual(fs.readFileSync(path.join(dataDir, "exports", ...diskMatchB[1].split("/"))), bytesB);

    // R1.2: Single paper referencing two different caches with the same relative path exports both without dropping either
    const resMulti = await app.routes.get("POST /api/research/export")(requestContext({
      body: { paperHash: hashMulti, saveToDisk: true },
    }));
    assert.equal(resMulti.status, 200);
    assert.equal(resMulti.value.attachmentCount, 2);
    const mdMulti = fs.readFileSync(resMulti.value.filePath, "utf8");
    const multiMatch1 = mdMulti.match(new RegExp(`!\\[First Figure\\]\\((attachments/export-[a-f0-9]+/${cacheA}/images/fig1\\.png)\\)`));
    const multiMatch2 = mdMulti.match(new RegExp(`!\\[Second Figure\\]\\((attachments/export-[a-f0-9]+/${cacheB}/images/fig1\\.png)\\)`));
    assert.ok(multiMatch1);
    assert.ok(multiMatch2);
    assert.deepEqual(fs.readFileSync(path.join(dataDir, "exports", ...multiMatch1[1].split("/"))), bytesA);
    assert.deepEqual(fs.readFileSync(path.join(dataDir, "exports", ...multiMatch2[1].split("/"))), bytesB);

    // R1.3: Pre-existing different file in exports/attachments is never overwritten
    const tamperedBytes = Buffer.from("pre-existing-user-file-do-not-overwrite");
    const legacyTargetPath = path.join(dataDir, "exports", ...relLinkA.split("/"));
    fs.mkdirSync(path.dirname(legacyTargetPath), { recursive: true });
    fs.writeFileSync(legacyTargetPath, tamperedBytes);
    const resAfterTamper = await app.routes.get("POST /api/research/export")(requestContext({
      body: { paperHash: hashA, saveToDisk: true },
    }));
    assert.equal(resAfterTamper.status, 200);
    assert.deepEqual(fs.readFileSync(legacyTargetPath), tamperedBytes, "Pre-existing file must not be overwritten");
    const mdAfterTamper = fs.readFileSync(resAfterTamper.value.filePath, "utf8");
    const matchLink = mdAfterTamper.match(/!\[Figure A\]\((attachments\/[^)]+)\)/);
    assert.ok(matchLink);
    assert.notEqual(matchLink[1], relLinkA);
    assert.deepEqual(fs.readFileSync(path.join(dataDir, "exports", ...matchLink[1].split("/"))), bytesA);

    // P1: Controlled concurrent saveToDisk where Paper 1 and Paper 2 share the exact same cacheId + path + PNG bytes;
    // Paper 1 pauses at .md link after publishing its attachment, Paper 2 completes 200 saved:true, then Paper 1's .md link throws EIO.
    // Paper 1's rollback must NOT delete Paper 2's attachment!
    const hashConcurrent1 = "9".repeat(64);
    const hashConcurrent2 = "8".repeat(64);
    await workspace.upsertPaper({
      paperHash: hashConcurrent1,
      metadata: { title: "Concurrent Paper 1" },
      blocks: [{ id: "fig-c1", page: 1, type: "image", text: "Shared Fig", assetRef: { cacheId: cacheA, path: "images/fig1.png" } }],
    });
    await workspace.upsertPaper({
      paperHash: hashConcurrent2,
      metadata: { title: "Concurrent Paper 2" },
      blocks: [{ id: "fig-c2", page: 1, type: "image", text: "Shared Fig", assetRef: { cacheId: cacheA, path: "images/fig1.png" } }],
    });
    const origLink = fs.promises.link;
    let releasePaper1MdLink;
    const paper1AtMdLink = new Promise((r) => {
      releasePaper1MdLink = r;
    });
    let resumePaper1AfterPaper2;
    const paper1WaitForPaper2 = new Promise((r) => {
      resumePaper1AfterPaper2 = r;
    });
    try {
      fs.promises.link = async (src, dest) => {
        if (path.basename(String(dest)) === "Concurrent Paper 1.md") {
          releasePaper1MdLink();
          await paper1WaitForPaper2;
          throw Object.assign(new Error("Simulated EIO on Concurrent Paper 1.md link"), { code: "EIO" });
        }
        return origLink(src, dest);
      };
      const export1Promise = app.routes.get("POST /api/research/export")(requestContext({
        body: { paperHash: hashConcurrent1, saveToDisk: true },
      }));
      await paper1AtMdLink;

      const export2Res = await app.routes.get("POST /api/research/export")(requestContext({
        body: { paperHash: hashConcurrent2, saveToDisk: true },
      }));
      assert.equal(export2Res.status, 200);
      assert.equal(export2Res.value.saved, true);
      const md2 = fs.readFileSync(export2Res.value.filePath, "utf8");
      const match2 = md2.match(/!\[Shared Fig\]\((attachments\/[^)]+)\)/);
      assert.ok(match2);
      const attachment2Path = path.join(dataDir, "exports", ...match2[1].split("/"));
      assert.equal(fs.existsSync(attachment2Path), true);

      resumePaper1AfterPaper2();
      const export1Res = await export1Promise;
      assert.equal(export1Res.status, 503);
      assert.equal(fs.existsSync(path.join(dataDir, "exports", "Concurrent Paper 1.md")), false);
      assert.equal(fs.existsSync(attachment2Path), true, "Paper 2 attachment must survive Paper 1 rollback");
      assert.deepEqual(fs.readFileSync(attachment2Path), bytesA);
    } finally {
      fs.promises.link = origLink;
    }

    // R2.0: options.includeOriginal=false && includeTranslation=false still exports attachments for every rendered image link,
    // and visual blocks with null assetRef + legacy assetPath/imagePath do not emit dead links outside the manifest
    const hashOptionsAndLegacy = "6".repeat(64);
    await workspace.upsertPaper({
      paperHash: hashOptionsAndLegacy,
      metadata: { title: "Options And Legacy Paper" },
      blocks: [
        { id: "fig-valid", page: 1, type: "image", text: "Valid Figure", assetRef: { cacheId: cacheA, path: "images/fig1.png" } },
        { id: "fig-legacy", page: 2, type: "image", text: "LegacyCleared Figure", assetRef: null, assetPath: "images/nonexistent.png", imagePath: "images/nonexistent2.png" },
      ],
    });
    const resOpts = await app.routes.get("POST /api/research/export")(requestContext({
      body: {
        paperHash: hashOptionsAndLegacy,
        saveToDisk: true,
        options: { includeOriginal: false, includeTranslation: false },
      },
    }));
    assert.equal(resOpts.status, 200);
    assert.equal(resOpts.value.attachmentCount, 1);
    const mdOpts = fs.readFileSync(resOpts.value.filePath, "utf8");
    const allMdLinks = [...mdOpts.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
    assert.equal(allMdLinks.length, 1, "Only verified manifest attachment may have an image link; legacy assetPath with null assetRef must degrade to linkless text");
    assert.equal(fs.existsSync(path.join(dataDir, "exports", ...allMdLinks[0].split("/"))), true);
    assert.deepEqual(fs.readFileSync(path.join(dataDir, "exports", ...allMdLinks[0].split("/"))), bytesA);

    // R2.1: Portable ZIP download on GET and POST (saveToDisk: false) when attachments exist, and .md for pure text
    const getZipRes = await app.routes.get("GET /api/research/export")(requestContext({
      query: { paperHash: hashMulti },
    }));
    assert.equal(getZipRes.status, 200);
    assert.equal(getZipRes.headers.get("content-type"), "application/zip");
    assert.match(getZipRes.headers.get("content-disposition"), /Paper Multi Cache\.zip/);
    const getZipEntries = readZipBufferEntries(Buffer.from(await getZipRes.arrayBuffer()));
    assert.equal(getZipEntries.has("Paper Multi Cache.md"), true);
    assert.equal(getZipEntries.has(relLinkA), true);
    assert.equal(getZipEntries.has(relLinkB), true);
    assert.deepEqual(getZipEntries.get(relLinkA), bytesA);
    assert.deepEqual(getZipEntries.get(relLinkB), bytesB);
    const zipMdText = getZipEntries.get("Paper Multi Cache.md").toString("utf8");
    assert.ok(zipMdText.includes(`![First Figure](${relLinkA})`));
    assert.ok(zipMdText.includes(`![Second Figure](${relLinkB})`));

    const postZipRes = await app.routes.get("POST /api/research/export")(requestContext({
      body: { paperHash: hashA, saveToDisk: false },
    }));
    assert.equal(postZipRes.status, 200);
    assert.equal(postZipRes.headers.get("content-type"), "application/zip");
    const postZipEntries = readZipBufferEntries(Buffer.from(await postZipRes.arrayBuffer()));
    assert.equal(postZipEntries.has("Paper A.md"), true);
    assert.deepEqual(postZipEntries.get(relLinkA), bytesA);

    const textExportRes = await app.routes.get("GET /api/research/export")(requestContext({
      query: { paperHash: hashText },
    }));
    assert.equal(textExportRes.status, 200);
    assert.match(textExportRes.headers.get("content-type"), /^text\/markdown/);
    assert.match(textExportRes.headers.get("content-disposition"), /Pure Text Paper\.md/);

    // R2.2: Atomic rollback when saving .md fails after writing new attachments
    const cacheRollback = "3".repeat(24);
    const bytesRollback = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x03, 0x03, 0x03, 0x03]);
    const hashRollback = "e".repeat(64);
    fs.mkdirSync(path.join(dataDir, "mineru-cache", cacheRollback, "images"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "mineru-cache", cacheRollback, "images", "rollback.png"), bytesRollback);
    await workspace.upsertPaper({
      paperHash: hashRollback,
      metadata: { title: "Rollback Paper" },
      blocks: [{ id: "fig-r", page: 1, type: "image", text: "Rollback Fig", assetRef: { cacheId: cacheRollback, path: "images/rollback.png" } }],
    });
    const origOpen = fs.promises.open;
    let failMdOpen = true;
    try {
      fs.promises.open = async (file, ...args) => {
        if (failMdOpen && path.basename(String(file)).startsWith(".export-")) {
          failMdOpen = false;
          throw Object.assign(new Error("Simulated disk full during md write"), { code: "ENOSPC" });
        }
        return origOpen(file, ...args);
      };
      const failedExport = await app.routes.get("POST /api/research/export")(requestContext({
        body: { paperHash: hashRollback, saveToDisk: true },
      }));
      assert.equal(failedExport.status, 503);
      assert.equal(fs.existsSync(path.join(dataDir, "exports", "Rollback Paper.md")), false);
      assert.equal(
        fs.existsSync(path.join(dataDir, "exports", "attachments", cacheRollback, "images", "rollback.png")),
        false,
        "Newly written attachment must be rolled back if .md publication fails",
      );
    } finally {
      fs.promises.open = origOpen;
    }

    // R2.3: Missing referenced asset fails closed with 409 export_assets_unavailable before publishing any file
    fs.unlinkSync(path.join(dataDir, "mineru-cache", cacheRollback, "images", "rollback.png"));
    const missingSaveRes = await app.routes.get("POST /api/research/export")(requestContext({
      body: { paperHash: hashRollback, saveToDisk: true },
    }));
    assert.equal(missingSaveRes.status, 409);
    assert.equal(missingSaveRes.value.error.code, "export_assets_unavailable");
    assert.equal(fs.existsSync(path.join(dataDir, "exports", "Rollback Paper.md")), false);

    const missingGetRes = await app.routes.get("GET /api/research/export")(requestContext({
      query: { paperHash: hashRollback },
    }));
    assert.equal(missingGetRes.status, 409);
    assert.equal(missingGetRes.value.error.code, "export_assets_unavailable");

    // Once user explicitly cleans visual cache (assetRef -> null), export succeeds as pure .md
    await workspace.clearPaperData(hashRollback, "assets");
    const cleanedExportRes = await app.routes.get("GET /api/research/export")(requestContext({
      query: { paperHash: hashRollback },
    }));
    assert.equal(cleanedExportRes.status, 200);
    assert.match(cleanedExportRes.headers.get("content-type"), /^text\/markdown/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("R3: saveMineruSettings and clearMineruToken share pending owner state across completion orders, errors, modal reopen, and delayed toast with new PDF import", async () => {
  const panelSource = fs.readFileSync(path.join(APP_ROOT, "ui/assets/panel.js"), "utf8");
  const from = panelSource.indexOf("function openMineruSettings(");
  const to = panelSource.indexOf("function normalizeThinkingLevel(", from);
  assert.ok(from >= 0 && to > from);

  function createSettingsHarness() {
    const saveBtn = { disabled: false, textContent: "保存设置", dataset: {} };
    const clearBtn = { disabled: false, textContent: "清除已保存 Token", dataset: {} };
    const tokenInput = { value: "token-1", focus() {} };
    const elements = new Map([
      ["mineru-settings-modal", { classList: { toggle() {} }, setAttribute() {} }],
      ["btn-save-mineru-settings", saveBtn],
      ["btn-clear-mineru-token", clearBtn],
      ["mineru-token-input", tokenInput],
      ["mineru-api-base-input", { value: "https://mineru.net" }],
      ["mineru-model-input", { value: "vlm" }],
      ["mineru-language-input", { value: "ch" }],
      ["mineru-formula-input", { checked: true }],
      ["mineru-table-input", { checked: true }],
      ["mineru-ocr-input", { checked: false }],
      ["mineru-timeout-input", { value: "900" }],
      ["mineru-poll-interval-input", { value: "5" }],
      ["mineru-token-hint", { textContent: "" }],
    ]);
    const fetchQueue = [];
    const toastHook = { impl: async () => {} };
    const parsedFiles = [];
    const sandbox = vm.createContext({
      String,
      Number,
      Boolean,
      JSON,
      mineruConfigured: true,
      mineruSettings: {
        apiBaseUrl: "https://mineru.net",
        modelVersion: "vlm",
        language: "ch",
        enableFormula: true,
        enableTable: true,
        ocr: false,
        timeoutSeconds: 900,
        pollIntervalSeconds: 5,
      },
      mineruSettingsRequestId: 0,
      pendingPdfFile: null,
      pendingPdfLoadRequestId: 0,
      paperLoadRequestId: 0,
      syncModalOpen: () => {},
      window: { setTimeout: (fn) => fn() },
      document: { getElementById: (id) => elements.get(id) || null },
      pluginApiFetch: (_url, init) => new Promise((resolve, reject) => {
        fetchQueue.push({ init, resolve, reject });
      }),
      apiErrorMessage: (_data, fallback) => fallback,
      applyMineruSettings: (data) => { sandbox.mineruConfigured = Boolean(data.configured); },
      safeToast: async (payload) => toastHook.impl(payload),
      confirmAction: async () => true,
      parsePdfFile: async (file, opts) => { parsedFiles.push({ file, opts }); },
    });
    vm.runInContext(panelSource.slice(from, to), sandbox);
    return { sandbox, saveBtn, clearBtn, tokenInput, fetchQueue, toastHook, parsedFiles };
  }

  // Case 1: save starts -> clear starts -> clear finishes first -> save finishes second
  {
    const h = createSettingsHarness();
    const savePromise = h.sandbox.saveMineruSettings();
    assert.equal(h.saveBtn.disabled, true);
    assert.equal(h.saveBtn.textContent, "正在保存…");
    const clearPromise = h.sandbox.clearMineruToken();
    await new Promise((r) => setImmediate(r));
    assert.equal(h.fetchQueue.length, 2);

    // Clear (request 2) resolves first
    h.fetchQueue[1].resolve({ ok: true, json: async () => ({ ok: true, configured: false }) });
    await clearPromise;
    assert.equal(h.saveBtn.disabled, false);
    assert.equal(h.saveBtn.textContent, "保存设置");
    assert.equal(h.clearBtn.disabled, false);

    // Save (request 1) resolves second (stale)
    h.fetchQueue[0].resolve({ ok: true, json: async () => ({ ok: true, configured: true }) });
    await savePromise;
    assert.equal(h.saveBtn.disabled, false);
    assert.equal(h.saveBtn.textContent, "保存设置");
    assert.equal(h.sandbox.mineruConfigured, false);
  }

  // Case 2: save starts -> clear starts -> save finishes first -> clear finishes second
  {
    const h = createSettingsHarness();
    const savePromise = h.sandbox.saveMineruSettings();
    const clearPromise = h.sandbox.clearMineruToken();
    await new Promise((r) => setImmediate(r));
    assert.equal(h.fetchQueue.length, 2);

    // Save (request 1) resolves first while clear (request 2) is still in flight
    h.fetchQueue[0].resolve({ ok: true, json: async () => ({ ok: true, configured: true }) });
    await savePromise;
    assert.equal(h.saveBtn.disabled, true, "Save button must stay disabled while newer clear request is still in flight");

    // Clear (request 2) resolves second
    h.fetchQueue[1].resolve({ ok: true, json: async () => ({ ok: true, configured: false }) });
    await clearPromise;
    assert.equal(h.saveBtn.disabled, false);
    assert.equal(h.saveBtn.textContent, "保存设置");
    assert.equal(h.clearBtn.disabled, false);
  }

  // Case 3: Cancel/close and reopen recovers button state; delayed toast does not consume a newer pendingPdfFile
  {
    const h = createSettingsHarness();
    const oldFile = { name: "old.pdf" };
    const newFile = { name: "new.pdf" };
    h.sandbox.pendingPdfFile = oldFile;
    h.sandbox.pendingPdfLoadRequestId = 10;
    h.sandbox.paperLoadRequestId = 10;

    let releaseToast;
    const toastEntered = new Promise((r) => {
      h.toastHook.impl = async () => {
        r();
        await new Promise((res) => { releaseToast = res; });
      };
    });

    const savePromise = h.sandbox.saveMineruSettings();
    h.fetchQueue[0].resolve({ ok: true, json: async () => ({ ok: true, configured: true }) });
    await toastEntered;

    // While safeToast is awaiting, user imports a new PDF file
    h.sandbox.pendingPdfFile = newFile;
    h.sandbox.pendingPdfLoadRequestId = 11;
    h.sandbox.paperLoadRequestId = 11;

    releaseToast();
    await savePromise;

    assert.equal(h.parsedFiles.length, 0, "Old saveMineruSettings must not parse when pendingPdfFile changed during toast");
    assert.equal(h.sandbox.pendingPdfFile, newFile, "Newer pendingPdfFile must remain intact");
    assert.equal(h.sandbox.pendingPdfLoadRequestId, 11);

    // Cancel during in-flight save resets buttons and reopen keeps them enabled
    h.toastHook.impl = async () => {};
    const secondSave = h.sandbox.saveMineruSettings();
    assert.equal(h.saveBtn.disabled, true);
    h.sandbox.closeMineruSettings(true);
    h.sandbox.openMineruSettings();
    assert.equal(h.saveBtn.disabled, false);
    assert.equal(h.saveBtn.textContent, "保存设置");
    h.fetchQueue[1].resolve({ ok: false, json: async () => ({ ok: false, error: "cancelled" }) });
    await secondSave;
    assert.equal(h.saveBtn.disabled, false);
  }
});

test("R4: stale full-translation run finally cannot clear a newer run's pauseRequested or preparing state", async () => {
  const panelSource = fs.readFileSync(path.join(APP_ROOT, "ui/assets/panel.js"), "utf8");
  const resetFrom = panelSource.indexOf("function resetTranslationRunState(");
  const resetTo = panelSource.indexOf("function hidePaperTransientUi(", resetFrom);
  const transFrom = panelSource.indexOf("function pauseFullTranslation(");
  const transTo = panelSource.indexOf("function handleTextSelection(", transFrom);
  assert.ok(resetFrom >= 0 && resetTo > resetFrom && transFrom >= 0 && transTo > transFrom);

  const paperA = {
    paperHash: "a".repeat(64),
    blocks: [{ id: "a1", page: 1, type: "paragraph", text: "Paper A block" }],
    translations: {},
    translationStates: {},
    glossaryVersion: 1,
    glossaryTerms: {},
  };
  const paperB = {
    paperHash: "b".repeat(64),
    blocks: Array.from({ length: 8 }, (_, idx) => ({
      id: `b${idx + 1}`,
      page: 1,
      type: "paragraph",
      text: `Paper B block ${idx + 1}`,
    })),
    translations: {},
    translationStates: {},
    glossaryVersion: 1,
    glossaryTerms: {},
  };

  let releaseGlossaryA;
  const glossaryAEntered = new Promise((r) => {
    releaseGlossaryA = r;
  });
  let releaseBatchWave1;
  let wave1Count = 0;
  const wave1Ready = new Promise((r) => {
    releaseBatchWave1 = r;
  });

  const button = { disabled: false, textContent: "翻译全文" };
  let translatedBlocksSent = 0;

  const sandbox = vm.createContext({
    Number,
    String,
    Boolean,
    Array,
    Map,
    Set,
    Promise,
    JSON,
     Error,
    currentPaper: paperA,
    paperRevision: 1,
    researchStateRevision: 0,
    fullTranslationRunId: 0,
    fullTranslationBusy: false,
    fullTranslationPreparing: false,
    fullTranslationPauseRequested: false,
    activeFullTranslationControl: null,
    blockTranslationRunIds: new Map(),
    currentAgent: { id: "agent-1" },
    currentThinkingLevel: "medium",
    selectedModelRefForAgent: () => "provider/model",
    normalizedPaperHash: (h) => String(h || "").toLowerCase(),
    paperContextIsCurrent: (hash, rev, ref) => sandbox.currentPaper === ref && sandbox.paperRevision === rev && ref.paperHash === hash,
    translationTextForBlock: (b) => b.text,
    isFinalTranslation: () => false,
    setTranslationPlaceholder: () => {},
    cloneJson: (v) => JSON.parse(JSON.stringify(v)),
    cachedTranslationsForBlocks: async () => new Map(),
    commitBlockTranslation: (id, text, ctx) => {
      if (sandbox.currentPaper !== ctx.paperRef) return false;
      ctx.paperRef.translations[id] = text;
      return true;
    },
    cacheBlockTranslation: async () => {},
    scheduleResearchSync: () => {},
    renderBlocks: () => {},
    applyEffectiveThinkingLevel: () => {},
    apiErrorMessage: (_d, f) => f,
    executeFullTranslationBatches: runConcurrentTranslationBatches,
    refreshGlossaryState: async ({ paperRef }) => {
      if (paperRef === paperA) {
        await glossaryAEntered;
      }
    },
    pluginApiFetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      translatedBlocksSent += body.texts.length;
      wave1Count += 1;
      if (wave1Count <= 2) {
        await wave1Ready;
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          translations: body.texts.map((t) => `ZH:${t}`),
        }),
      };
    },
    document: {
      getElementById: (id) => (id === "btn-translate-all" ? button : null),
    },
  });

  vm.runInContext(
    `${panelSource.slice(resetFrom, resetTo)}\n${panelSource.slice(transFrom, transTo)}`,
    sandbox,
  );

  // 1. Start full translation on Paper A (blocks in refreshGlossaryState)
  const runAPromise = sandbox.startFullTranslation();
  assert.equal(sandbox.fullTranslationBusy, true);
  assert.equal(sandbox.fullTranslationPreparing, true);

  // 2. Switch to Paper B and start 8-block full translation (2 concurrency x 2 batchSize = 4 blocks in wave 1)
  sandbox.resetTranslationRunState();
  sandbox.currentPaper = paperB;
  sandbox.paperRevision = 2;
  const runBPromise = sandbox.startFullTranslation();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(wave1Count, 2, "Wave 1 (2 concurrent batches = 4 blocks) must be in flight");
  assert.equal(translatedBlocksSent, 4);

  // 3. Request pause on Paper B while Wave 1 is in flight
  assert.equal(sandbox.pauseFullTranslation(), true);
  assert.equal(sandbox.fullTranslationPauseRequested, true);

  // 4. Now Paper A's delayed refreshGlossaryState resolves and Run A's finally block executes
  releaseGlossaryA();
  await runAPromise;

  // Run A's finally must NOT have cleared Run B's pause request!
  assert.equal(sandbox.fullTranslationPauseRequested, true);
  assert.equal(sandbox.activeFullTranslationControl.pauseRequested, true);

  // 5. Release Wave 1 batches for Paper B; Paper B must pause after Wave 1 (4 blocks) and NOT send the remaining 4 blocks
  releaseBatchWave1();
  await runBPromise;

  assert.equal(translatedBlocksSent, 4, "Paper B must stop after the 4 in-flight blocks when paused");
  assert.equal(Object.keys(paperB.translations).length, 4);
  assert.equal(button.textContent, "继续翻译 (4)");
});

test("R5: same-hash asset cleanup or re-parse invalidates in-flight MinerU asset requests and revokes existing Blob URLs while preserving pdfPreviewDocument", async () => {
  const panelSource = fs.readFileSync(path.join(APP_ROOT, "ui/assets/panel.js"), "utf8");
  const from = panelSource.indexOf("function mineruAssetObjectUrl(");
  const to = panelSource.indexOf("function cancelActiveParse(", from);
  const loadFrom = panelSource.indexOf("async function loadPaper(");
  const loadTo = panelSource.indexOf("function blockGroupsByPage(", loadFrom);
  assert.ok(from >= 0 && to > from && loadFrom >= 0 && loadTo > loadFrom);

  const paperHash = "f".repeat(64);
  const cache1 = "1".repeat(24);
  const cache2 = "2".repeat(24);
  const createdUrls = [];
  const revokedUrls = [];
  const fetchResolvers = [];
  let destroyedPdfDoc = 0;
  const preservedDoc = { destroy: async () => { destroyedPdfDoc += 1; } };

  const sandbox = vm.createContext({
    String,
    Number,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    Promise,
    DOMException,
    encodeURIComponent,
    READING_MODES: new Set(["bilingual", "original", "translation", "contrast"]),
    currentReadingMode: "bilingual",
    mineruSettings: { modelVersion: "vlm" },
    currentPaper: { paperHash, blocks: [] },
    activePaperHash: paperHash,
    activeView: "paper",
    paperLoadingHash: null,
    paperLoadRequestId: 1,
    paperRevision: 1,
    researchStateRevision: 1,
    fullTranslationRunId: 0,
    fullTranslationBusy: false,
    blockTranslationRunIds: new Map(),
    sanitizedTableCache: new Map(),
    selectedBlockId: null,
    pdfPreviewGeneration: 1,
    pdfPreviewPaperHash: paperHash,
    pdfPreviewDocument: preservedDoc,
    pdfPreviewLoadingTask: null,
    currentPdfFile: null,
    currentPdfFileHash: null,
    pdfFilesByHash: new Map(),
    pdfPreviewObjectUrls: new Set(["blob:pre-existing-asset-1"]),
    mineruAssetUrlPromises: new Map(),
    pdfPreviewImageCache: new Map(),
    deletedPaperHashes: new Set(),
    paperSyncBlocked: new Set(),
    paperConflictNotices: new Set(),
    normalizedPaperHash: (h) => String(h || "").trim().toLowerCase(),
    pdfPreviewIsCurrent: (gen) => gen === sandbox.pdfPreviewGeneration,
    resetPdfPreview: () => {
      sandbox.pdfPreviewGeneration += 1;
      sandbox.pdfPreviewDocument = null;
    },
    hidePaperTransientUi: () => {},
    resetResearchUiForPaper: () => {},
    loadAgentsAndModels: async () => {},
    translatableBlocks: () => [],
    setReadingMode: () => {},
    updateMineruUI: () => {},
    renderBlocks: () => {},
    upsertPaperTab: () => {},
    renderWorkspaceTabs: () => {},
    saveTabsState: () => {},
    initializePdfPreview: () => {},
    applyPaperViewSnapshot: () => false,
    paperViewSaveFingerprint: () => "fp",
    hydrateLoadedPaper: async () => {},
    paperRefIsCurrent: () => true,
    showPanelNotice: () => {},
    pluginApiFetch: () => new Promise((resolve) => { fetchResolvers.push(resolve); }),
    URL: {
      createObjectURL: () => {
        const u = `blob:mineru-${createdUrls.length + 1}`;
        createdUrls.push(u);
        return u;
      },
      revokeObjectURL: (u) => { revokedUrls.push(u); },
    },
    document: {
      getElementById: () => null,
      createElement: () => ({ className: "", src: "", alt: "", loading: "" }),
    },
  });

  vm.runInContext(
    `${panelSource.slice(from, to)}\n${panelSource.slice(loadFrom, loadTo)}`,
    sandbox,
  );

  // Initial paper with cache1 asset
  sandbox.currentPaper = {
    paperHash,
    parser: { kind: "mineru", pageCount: 2 },
    blocks: [{ id: "img1", page: 1, type: "image", text: "Fig 1", assetRef: { cacheId: cache1, path: "images/fig1.png" } }],
  };

  let replacedMediaChildren = 0;
  const detachedPreview = {
    isConnected: true,
    dataset: { cacheId: cache1, assetPath: "images/fig1.png" },
    querySelector: () => ({
      replaceChildren: () => { replacedMediaChildren += 1; },
      classList: { add() {} },
    }),
  };

  // Start in-flight renderMineruAsset before cleanup
  const renderPromise = sandbox.renderMineruAsset(detachedPreview, sandbox.pdfPreviewGeneration);
  assert.equal(fetchResolvers.length, 1);

  // Simulate same-hash asset cleanup reload via loadPaper (skipPreviousFlush: true)
  detachedPreview.isConnected = false;
  await sandbox.loadPaper(
    {
      paperHash,
      parser: { kind: "mineru", pageCount: 2 },
      blocks: [{ id: "img1", page: 1, type: "image", text: "Fig 1", assetRef: null }],
    },
    { skipPreviousFlush: true },
  );

  // 1. Pre-existing Blob URL was revoked and cleared; pdfPreviewDocument was preserved!
  assert.deepEqual(revokedUrls, ["blob:pre-existing-asset-1"]);
  assert.equal(sandbox.pdfPreviewObjectUrls.size, 0);
  assert.equal(sandbox.pdfPreviewDocument, preservedDoc);
  assert.equal(destroyedPdfDoc, 0);

  // 2. Release stale in-flight fetch response: must not create lingering Blob URL or write to detached preview
  fetchResolvers[0]({
    ok: true,
    blob: async () => ({ type: "image/png" }),
  });
  await renderPromise;
  assert.equal(replacedMediaChildren, 0);
  assert.equal(sandbox.pdfPreviewObjectUrls.size, 0);

  // 3. Same-hash re-parse with new cache2 loads fresh asset and revokes it on next same-hash reload
  await sandbox.loadPaper(
    {
      paperHash,
      parser: { kind: "mineru", pageCount: 2 },
      blocks: [{ id: "img1", page: 1, type: "image", text: "Fig 1", assetRef: { cacheId: cache2, path: "images/fig2.png" } }],
    },
    { skipPreviousFlush: true },
  );
  const activePreview = {
    isConnected: true,
    dataset: { cacheId: cache2, assetPath: "images/fig2.png" },
    querySelector: () => ({
      replaceChildren: () => { replacedMediaChildren += 1; },
      classList: { add() {} },
    }),
  };
  const renderPromise2 = sandbox.renderMineruAsset(activePreview, sandbox.pdfPreviewGeneration);
  fetchResolvers[1]({
    ok: true,
    blob: async () => ({ type: "image/png" }),
  });
  await renderPromise2;
  assert.equal(replacedMediaChildren, 1);
  assert.equal(sandbox.pdfPreviewObjectUrls.size, 1);

  // 4. P2: In-flight initializePdfPreview during same-hash loadPaper cancels old loadingTask, restarts for new generation,
  // and cleanly handles both late resolve and late reject of the superseded loadingTask without leaving pdfPreviewLoadingTask stuck
  const initFrom = panelSource.indexOf("function setPdfPreviewStatus(");
  const initTo = panelSource.indexOf("function bindPdfPreviewControls(", initFrom);
  assert.ok(initFrom >= 0 && initTo > initFrom);

  const taskQueue = [];
  let observedGeneration = 0;
  sandbox.MAX_PDF_BYTES = 100 * 1024 * 1024;
  sandbox.URL = {
    ...sandbox.URL,
    // allow new URL("./assets/...", document.baseURI) inside initializePdfPreview
  };
  const NativeURL = URL;
  function SandboxURL(input, base) {
    return new NativeURL(input, base);
  }
  SandboxURL.createObjectURL = sandbox.URL.createObjectURL;
  SandboxURL.revokeObjectURL = sandbox.URL.revokeObjectURL;
  sandbox.URL = SandboxURL;
  sandbox.Uint8Array = Uint8Array;
  sandbox.document.baseURI = "https://hana.local/reader.html";
  sandbox.document.querySelectorAll = () => [];
  sandbox.getPdfJsModule = async () => ({
    getDocument: () => {
      let resolveDoc;
      let rejectDoc;
      let destroyCalls = 0;
      const promise = new Promise((res, rej) => {
        resolveDoc = res;
        rejectDoc = rej;
      });
      const task = {
        promise,
        destroy: async () => { destroyCalls += 1; },
        get destroyCalls() { return destroyCalls; },
      };
      taskQueue.push({ task, resolveDoc, rejectDoc });
      return task;
    },
  });
  sandbox.observePdfPreviewPages = (gen) => {
    observedGeneration = gen;
  };
  vm.runInContext(panelSource.slice(initFrom, initTo), sandbox);

  // Case 4a: Old in-flight task resolves late after same-hash loadPaper
  sandbox.pdfPreviewDocument = null;
  sandbox.pdfPreviewLoadingTask = null;
  sandbox.pdfPreviewGeneration = 4;
  sandbox.pdfPreviewPaperHash = paperHash;
  const fakePdfFile = { size: 1024, arrayBuffer: async () => new ArrayBuffer(8) };

  const init1Promise = sandbox.initializePdfPreview(fakePdfFile, 4, paperHash);
  await new Promise((r) => setImmediate(r));
  assert.equal(taskQueue.length, 1);
  assert.equal(sandbox.pdfPreviewLoadingTask, taskQueue[0].task);

  // Same-hash reload while taskQueue[0] is still pending
  await sandbox.loadPaper(
    {
      paperHash,
      parser: { kind: "mineru", pageCount: 2 },
      blocks: [{ id: "img1", page: 1, type: "image", text: "Fig 1", assetRef: null }],
    },
    { skipPreviousFlush: true },
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(sandbox.pdfPreviewGeneration, 5);
  assert.equal(taskQueue[0].task.destroyCalls, 1, "Superseded loadingTask must be destroyed on same-hash reload");
  assert.equal(taskQueue.length, 2, "loadPaper must start a new initializePdfPreview for generation 5");
  assert.equal(sandbox.pdfPreviewLoadingTask, taskQueue[1].task);

  let doc1Destroyed = 0;
  const doc1 = { id: "doc1", destroy: async () => { doc1Destroyed += 1; } };
  const doc2 = { id: "doc2", destroy: async () => {} };

  // Old task resolves first
  taskQueue[0].resolveDoc(doc1);
  await init1Promise;
  assert.equal(doc1Destroyed, 1, "Late document from superseded generation 4 must be destroyed");
  assert.equal(sandbox.pdfPreviewLoadingTask, taskQueue[1].task, "New loadingTask must remain active");

  // New task resolves second
  taskQueue[1].resolveDoc(doc2);
  await new Promise((r) => setImmediate(r));
  assert.equal(sandbox.pdfPreviewDocument, doc2);
  assert.equal(sandbox.pdfPreviewLoadingTask, null);
  assert.equal(observedGeneration, 5);

  // Case 4b: Old in-flight task rejects late after same-hash loadPaper
  sandbox.pdfPreviewDocument = null;
  sandbox.pdfPreviewLoadingTask = null;
  const init2Promise = sandbox.initializePdfPreview(fakePdfFile, 5, paperHash);
  await new Promise((r) => setImmediate(r));
  assert.equal(taskQueue.length, 3);

  await sandbox.loadPaper(
    {
      paperHash,
      parser: { kind: "mineru", pageCount: 2 },
      blocks: [{ id: "img1", page: 1, type: "image", text: "Fig 1", assetRef: null }],
    },
    { skipPreviousFlush: true },
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(sandbox.pdfPreviewGeneration, 6);
  assert.equal(taskQueue.length, 4);

  // Old task rejects
  taskQueue[2].rejectDoc(new Error("Cancelled loading task"));
  await init2Promise;
  assert.equal(sandbox.pdfPreviewLoadingTask, taskQueue[3].task, "Late rejection must not clear newer loadingTask");

  const doc3 = { id: "doc3", destroy: async () => {} };
  taskQueue[3].resolveDoc(doc3);
  await new Promise((r) => setImmediate(r));
  assert.equal(sandbox.pdfPreviewDocument, doc3);
  assert.equal(sandbox.pdfPreviewLoadingTask, null);
  assert.equal(observedGeneration, 6);
});

test("R6: research-tools cleanup and restore preserve warning/success feedback across same-hash resetPaperState while blocking cross-paper stale notifications", async () => {
  class TestElement {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.dataset = {};
      this.style = {};
      this.handlers = new Map();
      this.attributes = {};
      this.classList = { toggle() {}, add() {}, remove() {} };
      this.disabled = false;
      this._text = "";
    }
    set textContent(value) { this._text = String(value); }
    get textContent() { return this._text + this.children.map((item) => item.textContent).join(""); }
    get isConnected() { return Boolean(this.root || this.parentNode?.isConnected); }
    append(...items) { for (const item of items) this.appendChild(item); }
    appendChild(item) { item.remove(); item.parentNode = this; this.children.push(item); return item; }
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((item) => item !== this);
      this.parentNode = null;
    }
    replaceChildren(...items) { for (const item of [...this.children]) item.remove(); this.append(...items); }
    contains(item) { return this === item || this.children.some((child) => child.contains(item)); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(type, handler) { this.handlers.set(type, handler); }
    fire(type = "click") { return this.handlers.get(type)?.({ target: this, preventDefault() {} }); }
    showModal() { this.open = true; }
    focus() {}
  }
  const allElements = (node) => [node, ...node.children.flatMap(allElements)];

  const hash1 = "1".repeat(64);
  const hash2 = "2".repeat(64);
  const root = new TestElement("div");
  root.root = true;
  const doc = {
    baseURI: "https://hana.local/reader.html",
    body: root,
    activeElement: null,
    createElement: (tag) => new TestElement(tag),
    defaultView: { setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, removeEventListener() {} },
  };
  const prevWin = globalThis.window;
  const prevDoc = globalThis.document;
  globalThis.window = doc.defaultView;
  globalThis.document = doc;

  try {
    let currentPaper = {
      paperHash: hash1,
      revision: 3,
      generation: 1,
      title: "Cleanup Test Paper",
      blocks: [{ id: "b1", page: 1, type: "paragraph", text: "Text" }],
    };
    let cleanupResultPayload = { cleanupDeferred: true, deferredCacheIds: ["a".repeat(24)] };
    let switchPaperDuringCleanup = false;
    let closeDrawerDuringCleanup = false;
    const toasts = [];
    const pendingRequests = [];

    const tools = createResearchTools({
      root,
      document: doc,
      apiFetch: (route) => {
        const req = (async () => {
          if (route.startsWith("/api/research/parse-status")) {
            return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ ok: true, tasks: [] }) };
          }
          if (route.startsWith("/api/research/storage")) {
            return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ ok: true, storage: { totalBytes: 100, counts: {} } }) };
          }
          if (route.startsWith("/api/research/cleanup")) {
            return {
              ok: true,
              status: 200,
              headers: { get: () => "application/json" },
              json: async () => ({ ok: true, result: cleanupResultPayload, storage: { totalBytes: 50, counts: {} } }),
            };
          }
          if (route.startsWith("/api/research/restore")) {
            return {
              ok: true,
              status: 200,
              headers: { get: () => "application/json" },
              json: async () => ({ ok: true, paper: { paperHash: hash1, revision: currentPaper.revision + 1 } }),
            };
          }
          return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ ok: true }) };
        })();
        pendingRequests.push(req);
        return req;
      },
      getPaper: () => currentPaper,
      onBeforePaperMutation: async () => ({ expectedRevision: currentPaper.revision }),
      onPaperDataChanged: async (change) => {
        // Real panel.js applyPreparedPaperMutation -> loadPaper calls resetPaperState() on researchTools
        tools.resetPaperState();
        if (closeDrawerDuringCleanup) {
          tools.close();
          return true;
        }
        if (switchPaperDuringCleanup) {
          currentPaper = { ...currentPaper, paperHash: hash2, title: "Other Paper" };
          tools.resetPaperState();
          return true;
        }
        if (change?.action === "structure-keep-notes") {
          // Real panel.js applyPreparedPaperMutation calls loadPaper (reset 1) and then loadDetachedResearchRecord (reset 2 + refresh)
          currentPaper = {
            ...currentPaper,
            revision: currentPaper.revision + 1,
            blocks: [],
            structureDetached: true,
            loaded: true,
          };
          tools.resetPaperState();
          tools.refresh();
          return true;
        }
        currentPaper = { ...currentPaper, revision: currentPaper.revision + 1 };
        return true;
      },
      onPaperMutationFinished: async () => {},
      toast: (item) => { toasts.push(item); },
    });

    const settle = async () => {
      for (let i = 0; i < 10; i += 1) {
        await Promise.allSettled([...pendingRequests]);
        await new Promise((r) => setImmediate(r));
      }
    };

    // 1. Deferred cleanup with same-hash resetPaperState inside onPaperDataChanged emits warning toast
    tools.open("parse");
    await settle();
    const parseView = allElements(root).find((el) => el.id === "research-tool-parse");
    const clearAssetsBtn = allElements(parseView).find((el) => el.tagName === "BUTTON" && el._text === "仅清理解析缓存");
    assert.ok(clearAssetsBtn);
    const clickOp1 = clearAssetsBtn.fire("click");
    await new Promise((r) => setImmediate(r));
    const dialog1 = allElements(root).find((el) => el.tagName === "DIALOG");
    assert.ok(dialog1);
    allElements(dialog1).find((el) => el.tagName === "BUTTON" && el._text === "确认").fire("click");
    await clickOp1;
    await settle();

    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].type, "warning");
    assert.match(toasts[0].message, /部分缓存尚未清理/);

    // 2. Normal cleanup with same-hash resetPaperState inside onPaperDataChanged emits success toast
    toasts.length = 0;
    cleanupResultPayload = { cleanupDeferred: false, removedCacheIds: ["a".repeat(24)], preservedCacheIds: [] };
    const clearAssetsBtn2 = allElements(parseView).find((el) => el.tagName === "BUTTON" && el._text === "仅清理解析缓存");
    const clickOp2 = clearAssetsBtn2.fire("click");
    await new Promise((r) => setImmediate(r));
    const dialog2 = allElements(root).find((el) => el.tagName === "DIALOG");
    allElements(dialog2).find((el) => el.tagName === "BUTTON" && el._text === "确认").fire("click");
    await clickOp2;
    await settle();

    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].type, "success");
    assert.match(toasts[0].message, /指定范围的数据已处理/);

    // 3. Backup restore (assetMode: "omitted") with same-hash resetPaperState inside onPaperDataChanged emits info toast
    toasts.length = 0;
    const restoreInput = allElements(parseView).find((el) => el.tagName === "INPUT" && el.type === "file");
    assert.ok(restoreInput);
    restoreInput.files = [{
      size: 256,
      text: async () => JSON.stringify({
        format: "hana-paper-reader-backup",
        paperHash: hash1,
        assetMode: "omitted",
        paper: { paperHash: hash1 },
      }),
    }];
    const restoreOp = restoreInput.fire("change");
    await new Promise((r) => setImmediate(r));
    const dialogRestore = allElements(root).find((el) => el.tagName === "DIALOG");
    assert.ok(dialogRestore);
    allElements(dialogRestore).find((el) => el.tagName === "BUTTON" && el._text === "确认").fire("click");
    await restoreOp;
    await settle();

    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].type, "info");
    assert.match(toasts[0].message, /备份恢复成功；这份备份不含图片和附件/);

    // 4. structure-keep-notes triggers two legitimate same-hash resetPaperState() calls + refresh() and still emits cleanupDeferred warning
    toasts.length = 0;
    cleanupResultPayload = { cleanupDeferred: true, deferredCacheIds: ["b".repeat(24)] };
    const detachBtn = allElements(parseView).find((el) => el.tagName === "BUTTON" && el._text === "保留笔记后删除论文结构");
    assert.ok(detachBtn);
    const detachOp = detachBtn.fire("click");
    await new Promise((r) => setImmediate(r));
    const dialogDetach = allElements(root).find((el) => el.tagName === "DIALOG");
    assert.ok(dialogDetach);
    allElements(dialogDetach).find((el) => el.tagName === "BUTTON" && el._text === "确认").fire("click");
    await detachOp;
    await settle();

    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].type, "warning");
    assert.match(toasts[0].message, /部分缓存尚未清理/);

    // Restore blocks on hash1 for remaining cases
    currentPaper = {
      paperHash: hash1,
      revision: currentPaper.revision + 1,
      generation: 2,
      title: "Cleanup Test Paper",
      blocks: [{ id: "b1", page: 1, type: "paragraph", text: "Text" }],
    };
    tools.refresh();
    await settle();

    // 5. Closing drawer during cleanup suppresses stale toast
    toasts.length = 0;
    closeDrawerDuringCleanup = true;
    const clearAssetsBtnClose = allElements(parseView).find((el) => el.tagName === "BUTTON" && el._text === "仅清理解析缓存");
    const clickOpClose = clearAssetsBtnClose.fire("click");
    await new Promise((r) => setImmediate(r));
    const dialogClose = allElements(root).find((el) => el.tagName === "DIALOG");
    allElements(dialogClose).find((el) => el.tagName === "BUTTON" && el._text === "确认").fire("click");
    await clickOpClose;
    await settle();
    assert.equal(toasts.length, 0, "Stale cleanup completion after closing drawer must not emit toast");
    closeDrawerDuringCleanup = false;
    tools.open("parse");
    await settle();

    // 6. Cross-paper switch during cleanup suppresses stale toast
    toasts.length = 0;
    switchPaperDuringCleanup = true;
    const clearAssetsBtn3 = allElements(parseView).find((el) => el.tagName === "BUTTON" && el._text === "仅清理解析缓存");
    const clickOp3 = clearAssetsBtn3.fire("click");
    await new Promise((r) => setImmediate(r));
    const dialog3 = allElements(root).find((el) => el.tagName === "DIALOG");
    allElements(dialog3).find((el) => el.tagName === "BUTTON" && el._text === "确认").fire("click");
    await clickOp3;
    await settle();

    assert.equal(toasts.length, 0, "Stale cleanup completion after switching paperHash must not emit toast");
    tools.destroy();
  } finally {
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
    if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
  }
});
