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
    assert.match(markdown, /!\[Figure 1 Architecture\]\(attachments\/images\/plot\.png\)/);

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
