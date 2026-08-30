import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import registerApiRoutes from "../routes/api.js";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
    delete(path, handler) { routes.set(`DELETE ${path}`, handler); },
  };
}

function requestContext(body = {}, query = {}, params = {}) {
  return {
    req: {
      json: async () => body,
      query: (key) => query[key] ?? "",
      param: (key) => params[key] ?? "",
    },
    json: (value, status = 200) => ({ status, value }),
  };
}

function fixturePaper(hash, title, authors = [], tags = []) {
  return {
    paperHash: hash,
    metadata: { title, authors, tags },
    parser: { kind: "mineru", pageCount: 5 },
    blocks: [
      { id: "b1", page: 1, type: "heading", text: "Abstract" },
      { id: "b2", page: 1, type: "paragraph", text: "Paper content." },
    ],
  };
}

test("library API lists, filters, searches and updates paper metadata", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "library-api-test-"));
  const app = makeApp();
  const ctx = {
    pluginId: "hana-paper-reader",
    dataDir: tempDir,
    config: { get: () => "", setMany() {} },
    log: { error() {}, warn() {} },
    bus: { request: async () => { throw new Error("not called"); } },
    network: { fetch: async () => { throw new Error("not called"); } },
  };

  try {
    registerApiRoutes(app, ctx);
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    const hashC = "c".repeat(64);

    await app.routes.get("POST /api/research/paper")(requestContext(fixturePaper(hashA, "Quantum Computing Survey", ["Alice"], ["quantum", "physics"])));
    await app.routes.get("POST /api/research/paper")(requestContext(fixturePaper(hashB, "Neural Machine Translation", ["Bob"], ["ai", "nlp"])));
    await app.routes.get("POST /api/research/paper")(requestContext(fixturePaper(hashC, "CRISPR Gene Editing", ["Charlie"], ["bio"])));

    // Initial list
    const listRes = app.routes.get("GET /api/research/library")(requestContext({}));
    assert.equal(listRes.value.ok, true);
    assert.equal(listRes.value.total, 3);
    assert.equal(listRes.value.items.length, 3);

    // Search query
    const searchRes = app.routes.get("GET /api/research/library")(requestContext({}, { q: "quantum" }));
    assert.equal(searchRes.value.items.length, 1);
    assert.equal(searchRes.value.items[0].paperHash, hashA);

    // Filter by tag
    const tagRes = app.routes.get("GET /api/research/library")(requestContext({}, { tag: "nlp" }));
    assert.equal(tagRes.value.items.length, 1);
    assert.equal(tagRes.value.items[0].paperHash, hashB);

    // Update metadata: favorite
    const favRes = await app.routes.get("POST /api/research/library/metadata")(requestContext({ paperHash: hashA, favorite: true }));
    assert.equal(favRes.value.ok, true);
    assert.equal(favRes.value.metadata.favorite, true);

    const favList = app.routes.get("GET /api/research/library")(requestContext({}, { favorite: "true" }));
    assert.equal(favList.value.items.length, 1);
    assert.equal(favList.value.items[0].paperHash, hashA);

    // Opening the paper and recording last-read metadata must not clear the
    // favorite flag. Re-read through a fresh route/workspace instance too.
    const openRes = app.routes.get("GET /api/research/paper")(requestContext({}, { paperHash: hashA }));
    assert.equal(openRes.value.paper.metadata.favorite, true);
    const readRes = await app.routes.get("POST /api/research/library/metadata")(requestContext({ paperHash: hashA, lastReadAt: "2026-08-28T15:00:00.000Z" }));
    assert.equal(readRes.value.metadata.favorite, true);
    const freshApp = makeApp();
    registerApiRoutes(freshApp, ctx);
    const freshFavList = freshApp.routes.get("GET /api/research/library")(requestContext({}, { favorite: "true" }));
    assert.equal(freshFavList.value.items.length, 1);
    assert.equal(freshFavList.value.items[0].paperHash, hashA);

    // Update metadata: archive
    const archRes = await app.routes.get("POST /api/research/library/metadata")(requestContext({ paperHash: hashC, archived: true }));
    assert.equal(archRes.value.ok, true);
    assert.equal(archRes.value.metadata.archived, true);

    const activeList = app.routes.get("GET /api/research/library")(requestContext({}, { archived: "false" }));
    assert.equal(activeList.value.items.length, 2);

    const archivedList = app.routes.get("GET /api/research/library")(requestContext({}, { archived: "true" }));
    assert.equal(archivedList.value.items.length, 1);
    assert.equal(archivedList.value.items[0].paperHash, hashC);

    // Sort by title
    const sortTitle = app.routes.get("GET /api/research/library")(requestContext({}, { sort: "title", order: "asc", archived: "all" }));
    assert.equal(sortTitle.value.items[0].paperHash, hashC); // CRISPR
    assert.equal(sortTitle.value.items[1].paperHash, hashB); // Neural
    assert.equal(sortTitle.value.items[2].paperHash, hashA); // Quantum
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("executable panel.js tab & view state functions execute correctly across full lifecycle", () => {
  const panelSource = read("assets/panel.js");
  const panelCss = read("assets/panel.css");
  assert.match(panelSource, /id="action-confirm-modal"/);
  assert.match(panelSource, /requestActionConfirmation\(/);
  assert.match(panelSource, /data-delete-hash[\s\S]*?requestActionConfirmation/);
  assert.match(panelSource, /confirmAction: requestActionConfirmation/);
  assert.match(panelSource, /formatMath[\s\S]*?math-display/);
  assert.match(panelCss, /\.workspace-tabs-bar[\s\S]*?overflow-x: auto/);
  assert.match(panelCss, /\.math-display[\s\S]*?white-space: pre-wrap/);

  const storageMap = new Map();
  const mockLocalStorage = {
    getItem: (k) => storageMap.get(k) || null,
    setItem: (k, v) => storageMap.set(k, String(v)),
    removeItem: (k) => storageMap.delete(k),
    clear: () => storageMap.clear(),
  };

  const sandbox = {
    console,
    localStorage: mockLocalStorage,
    window: { location: { search: "" } },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    URLSearchParams,
    Set,
    Map,
    JSON,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Date,
  };

  vm.createContext(sandbox);

  const helperScript = `
    var openPaperTabs = [];
    var activeView = "library";
    var activePaperHash = null;
    var deletedPaperHashes = new Set();
    var paperSyncBlocked = new Set();
    var paperLoadRequestId = 0;
    var paperRevision = 0;
    var currentPaper = { paperHash: null, revision: 0, blocks: [] };
    var researchSyncScheduleCount = 0;
    var TABS_STATE_STORAGE_KEY = "hana-paper-reader-tabs-state-v1";

    function isPaperHash(value) {
      return typeof value === "string" && /^[a-f0-9]{12,128}$/i.test(value.trim());
    }
    function normalizedPaperHash(value) {
      return typeof value === "string" ? value.trim().toLowerCase() : "";
    }
    function scheduleResearchSync() {
      researchSyncScheduleCount += 1;
    }

    ${panelSource.match(/function saveTabsState\(\)[\s\S]*?^}/m)[0]}
    ${panelSource.match(/function restoreTabsState\(\)[\s\S]*?^}/m)[0]}
    ${panelSource.match(/function upsertPaperTab\(paper = {}\)[\s\S]*?^}/m)[0]}
    ${panelSource.match(/function removePaperTab\(hash\)[\s\S]*?^}/m)[0]}
    ${panelSource.match(/function paperLoadIsCurrent\(requestId, hash\)[\s\S]*?^}/m)[0]}
    ${panelSource.match(/function mergeServerPaperRevision\(data, hash, options = \{\}\)[\s\S]*?^}/m)[0]}
  `;

  vm.runInContext(helperScript, sandbox);

  const hash1 = "1".repeat(64);
  const hash2 = "2".repeat(64);

  // 1. Tab insertion & persistence
  vm.runInContext(`
    upsertPaperTab({ paperHash: "${hash1}", title: "Paper One", pageCount: 10, isPdf: true });
    upsertPaperTab({ paperHash: "${hash2}", title: "Paper Two", pageCount: 5 });
    saveTabsState();
  `, sandbox);

  const tabs = vm.runInContext("openPaperTabs", sandbox);
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].title, "Paper One");
  assert.equal(tabs[1].title, "Paper Two");

  // Verify persistence format in localStorage
  const savedJson = mockLocalStorage.getItem("hana-paper-reader-tabs-state-v1");
  assert.ok(savedJson);
  const parsed = JSON.parse(savedJson);
  assert.equal(parsed.openPaperTabs.length, 2);

  // 2. Clear in-memory state and restore
  vm.runInContext(`
    openPaperTabs = [];
    activePaperHash = null;
    activeView = "library";
    restoreTabsState();
  `, sandbox);

  const restoredTabs = vm.runInContext("openPaperTabs", sandbox);
  assert.equal(restoredTabs.length, 2);
  assert.equal(restoredTabs[0].paperHash, hash1);
  assert.equal(restoredTabs[1].paperHash, hash2);

  // 3. Request generation guard & tombstone validation
  vm.runInContext(`
    paperLoadRequestId = 42;
    activeView = "paper";
    activePaperHash = "${hash1}";
  `, sandbox);

  // Stale request ID
  assert.equal(vm.runInContext(`paperLoadIsCurrent(41, "${hash1}");`, sandbox), false);
  // Current request ID matching active hash
  assert.equal(vm.runInContext(`paperLoadIsCurrent(42, "${hash1}");`, sandbox), true);
  // Request ID matching inactive hash (A -> B switch)
  assert.equal(vm.runInContext(`paperLoadIsCurrent(42, "${hash2}");`, sandbox), false);

  // Mark as deleted tombstone
  vm.runInContext(`deletedPaperHashes.add("${hash1}");`, sandbox);
  assert.equal(vm.runInContext(`paperLoadIsCurrent(42, "${hash1}");`, sandbox), false);

  // 4. Tab removal & active state cleanup
  vm.runInContext(`removePaperTab("${hash1}");`, sandbox);
  const afterRemoveTabs = vm.runInContext("openPaperTabs", sandbox);
  assert.equal(afterRemoveTabs.length, 1);
  assert.equal(vm.runInContext("activePaperHash", sandbox), null);

  // A metadata response must advance the local server revision, while a late
  // response from an older request must never roll it back.
  vm.runInContext(`
    activeView = "paper";
    activePaperHash = "${hash2}";
    paperLoadRequestId = 42;
    currentPaper = { paperHash: "${hash2}", revision: 1, blocks: [{ id: "b" }] };
    researchSyncScheduleCount = 0;
  `, sandbox);
  assert.equal(vm.runInContext(`mergeServerPaperRevision({ revision: 2, lastReadAt: "2026-08-28T12:00:00.000Z" }, "${hash2}");`, sandbox), true);
  assert.equal(vm.runInContext("currentPaper.revision", sandbox), 2);
  assert.equal(vm.runInContext("currentPaper.lastReadAt", sandbox), "2026-08-28T12:00:00.000Z");
  assert.equal(vm.runInContext("researchSyncScheduleCount", sandbox), 1);
  assert.equal(vm.runInContext(`mergeServerPaperRevision({ revision: 1, lastReadAt: "2026-08-28T11:00:00.000Z" }, "${hash2}");`, sandbox), false);
  assert.equal(vm.runInContext("currentPaper.revision", sandbox), 2);
  assert.equal(vm.runInContext("currentPaper.lastReadAt", sandbox), "2026-08-28T12:00:00.000Z");
});

test("paper mutation and deletion API lifecycle preserves isolation and prevents resurrection", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "library-mutation-test-"));
  const app = makeApp();
  const ctx = {
    pluginId: "hana-paper-reader",
    dataDir: tempDir,
    config: { get: () => "", setMany() {} },
    log: { error() {}, warn() {} },
    bus: { request: async () => { throw new Error("not called"); } },
    network: { fetch: async () => { throw new Error("not called"); } },
  };

  try {
    registerApiRoutes(app, ctx);
    const hash = "d".repeat(64);
    await app.routes.get("POST /api/research/paper")(requestContext(fixturePaper(hash, "Test Paper", ["Author D"], ["test"])));
    await app.routes.get("POST /api/research/progress")(requestContext({ paperHash: hash, percent: 45, blockId: "b1" }));

    // Delete paper
    const delRes = await app.routes.get("DELETE /api/research/paper")(requestContext({}, { paperHash: hash }));
    assert.equal(delRes.value.ok, true);

    // Progress on deleted paper should fail (paper not found)
    const progRes = await app.routes.get("POST /api/research/progress")(requestContext({ paperHash: hash, percent: 60 }));
    assert.equal(progRes.value.ok, false);

    // Verify paper no longer in library
    const libRes = app.routes.get("GET /api/research/library")(requestContext({}));
    assert.equal(libRes.value.items.some((item) => item.paperHash === hash), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
