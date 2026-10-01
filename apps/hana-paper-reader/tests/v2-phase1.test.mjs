import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import entry from "../index.js";
import registerApiRoutes from "../server/http/api-routes.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(route, handler) {
      routes.set(`GET ${route}`, handler);
    },
    post(route, handler) {
      routes.set(`POST ${route}`, handler);
    },
    delete(route, handler) {
      routes.set(`DELETE ${route}`, handler);
    },
  };
}

function requestContext({ authorized = true, query = {}, params = {}, body = {} } = {}) {
  return {
    get(key) {
      if (key !== "appRequestContext") return undefined;
      return authorized ? { principal: { id: "phase1-test" } } : undefined;
    },
    req: {
      query(name) { return query[name]; },
      param(name) { return params[name]; },
      async json() { return body; },
    },
    json(value, status = 200) {
      return { value, status };
    },
  };
}

test("defineApp startup registers one Hono route registrar", async () => {
  const routeApps = [];
  const context = {
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-entry-")),
    bus: { request: async () => ({}) },
    logger: { info: async () => {} },
    models: {},
    tools: {},
    hooks: {},
    media: {},
    providers: {},
    storage: { global: {}, agent: () => ({}) },
    routes: {
      async register(registrar) {
        const app = { get(route, handler) { routeApps.push({ route, handler }); } };
        await registrar(app);
        return { ready: Promise.resolve() };
      },
    },
  };
  try {
    await entry.apply(context);
    assert.deepEqual(routeApps.map((item) => item.route).sort(), [
      "/api/mineru-asset",
      "/api/mineru-settings",
      "/api/research/evidence",
      "/api/research/library",
      "/api/research/outline",
      "/api/research/parse-cache/check",
      "/api/research/paper",
      "/api/research/recent",
      "/api/research/search",
      "/api/models",
      "/api/agents",
      "/api/agents/:agentId",
    ].sort());
  } finally {
    fs.rmSync(context.dataDir, { recursive: true, force: true });
  }
});

test("v2 package is a page App with one registered route source", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.manifestVersion, 2);
  assert.equal(manifest.id, "hana-paper-reader");
  assert.equal(manifest.entry, "index.js");
  assert.deepEqual(manifest.capabilities, ["app/models.infer", "app/agents.read", "app/resources.read", "app/process.spawn",
    "app/sessions.read", "app/sessions.manage", "app/session.start-turn", "app/session.switch-model", "app/session.thinking-level"]);
  assert.equal(manifest.network.methods.includes("GET"), true);
  assert.equal(manifest.network.methods.includes("POST"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(manifest.contributes, "settings"), false);
  assert.equal(manifest.contributes.cards[0].realization, "page");
  assert.equal(manifest.contributes.cards[0].siteNavEntry, true);
  assert.equal(manifest.contributes.cards[0].route, "/reader.html");
  assert.equal(manifest.contributes.cards[0].detached.route, "/reader.html");
  assert.equal(fs.existsSync(path.join(root, "routes")), false);
  assert.equal(fs.existsSync(path.join(root, "ui", "reader.html")), true);
});

test("MinerU settings stay inside the paper workspace UI", () => {
  const panel = read("ui/assets/panel.js");
  assert.match(panel, /id="mineru-settings-modal"/);
  assert.match(panel, /id="mineru-api-base-input"/);
  assert.match(panel, /id="mineru-timeout-input"/);
  assert.match(panel, /id="mineru-poll-interval-input"/);
  assert.match(panel, /pluginApiFetch\("\/api\/mineru-settings"/);
});

test("reader Page announces the host handshake before optional UI hydration", () => {
  const reader = read("ui/reader.html");
  const readyIndex = reader.search(/hana\.ready\(\{ surface: "reader" \}\)/);
  const panelIndex = reader.indexOf('src="./assets/panel.js"');
  assert.ok(readyIndex >= 0, "reader.html must have an early hana.ready handshake");
  assert.ok(panelIndex >= 0, "reader.html must load panel.js");
  assert.ok(readyIndex < panelIndex, "host readiness must not depend on panel.js finishing");
  assert.match(reader, /unhandledrejection/);
  assert.match(reader, /前端初始化失败/);
});

test("recent research route requires App request identity and reads only app data", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-phase1-"));
  const paperHash = "a".repeat(64);
  try {
    fs.mkdirSync(path.join(dataDir, "papers", paperHash), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "paper-workspace.json"), JSON.stringify({
      schemaVersion: 3,
      papers: { [paperHash]: { paperHash, updatedAt: "2026-09-29T10:00:00.000Z" } },
    }));
    fs.writeFileSync(path.join(dataDir, "papers", paperHash, "paper.json"), JSON.stringify({
      paperHash,
      updatedAt: "2026-09-29T10:00:00.000Z",
      metadata: { title: "Phase 1 fixture" },
      blocks: [{ id: "b1", page: 1, type: "paragraph", text: "Evidence" }],
    }));

    const app = makeApp();
    registerApiRoutes(app, { dataDir });
    const route = app.routes.get("GET /api/research/recent");
    assert.ok(route);

    const denied = route(requestContext({ authorized: false }));
    assert.equal(denied.status, 403);
    assert.equal(denied.value.error.code, "app_request_context_required");

    const allowed = route(requestContext());
    assert.equal(allowed.status, 200);
    assert.equal(allowed.value.ok, true);
    assert.equal(allowed.value.apiVersion, "1.0.0");
    assert.equal(allowed.value.paper.paperHash, paperHash);
    assert.equal(allowed.value.paper.metadata.title, "Phase 1 fixture");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("corrupt v2 index is an integrity error, never an empty workspace", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-corrupt-"));
  try {
    fs.writeFileSync(path.join(dataDir, "paper-workspace.json"), "{not-json");
    const app = makeApp();
    registerApiRoutes(app, { dataDir });
    const response = app.routes.get("GET /api/research/recent")(requestContext());
    assert.equal(response.status, 503);
    assert.equal(response.value.ok, false);
    assert.equal(response.value.error.code, "workspace_integrity_error");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("an index entry without its paper shard is an integrity error", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-missing-shard-"));
  const paperHash = "b".repeat(64);
  try {
    fs.writeFileSync(path.join(dataDir, "paper-workspace.json"), JSON.stringify({
      schemaVersion: 3,
      papers: { [paperHash]: { paperHash, updatedAt: "2026-09-29T10:00:00.000Z" } },
    }));
    const app = makeApp();
    registerApiRoutes(app, { dataDir });
    const response = app.routes.get("GET /api/research/recent")(requestContext());
    assert.equal(response.status, 503);
    assert.equal(response.value.error.code, "workspace_integrity_error");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("an explicitly null papers collection is not treated as an empty workspace", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-null-papers-"));
  try {
    fs.writeFileSync(path.join(dataDir, "paper-workspace.json"), JSON.stringify({ schemaVersion: 3, papers: null }));
    const app = makeApp();
    registerApiRoutes(app, { dataDir });
    const response = app.routes.get("GET /api/research/recent")(requestContext());
    assert.equal(response.status, 503);
    assert.equal(response.value.error.code, "workspace_integrity_error");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("v2 UI bridge has no v1 surface-session or parent-window transport", () => {
  const panel = read("ui/assets/panel.js");
  assert.match(panel, /hana\.api\.fetch/);
  assert.match(panel, /hana\.api\.url/);
  assert.doesNotMatch(panel, /pluginSurfaceSession/);
  assert.doesNotMatch(panel, /X-Hana-Plugin-Surface-Session/);
  assert.doesNotMatch(panel, /hana\.plugin\.ui/);
  assert.doesNotMatch(panel, /window\.parent/);
});

test("v2 UI enables the implemented research vertical slice", () => {
  const panel = read("ui/assets/panel.js");
  assert.match(panel, /const PHASE1_UI_ONLY = false/);
  assert.match(panel, /const PHASE2_RESEARCH_READ_ONLY = false/);
  assert.match(panel, /pluginApiFetch\("\/api\/research\/recent"\)/);
  assert.match(panel, /pluginApiFetch\("\/api\/models"\)/);
  assert.match(panel, /pluginApiFetch\("\/api\/agents"\)/);
});

test("v2 UI opts into host view-state recovery without making it required", () => {
  const panel = read("ui/assets/panel.js");
  assert.match(panel, /hana\.viewState/);
  assert.match(panel, /initializeHostViewState/);
  assert.match(panel, /VIEW_STATE_UNAVAILABLE/);
  assert.match(panel, /localStorage\.setItem\(TABS_STATE_STORAGE_KEY/);
  assert.match(panel, /\.then\(\(\) => restoreRecentPaper\(\)\)/);
});

test("direct sample/import loads hide the library before showing the reader", () => {
  const panel = read("ui/assets/panel.js");
  const start = panel.indexOf("function loadPaper(");
  const end = panel.indexOf("function blockGroupsByPage()", start);
  assert.ok(start >= 0 && end > start, "loadPaper function must remain discoverable");
  const loadPaper = panel.slice(start, end);
  assert.match(loadPaper, /const library = document\.getElementById\("library-view"\)/);
  assert.match(loadPaper, /if \(library\) library\.style\.display = "none"/);
});

test("v2 UI flushes a deduplicated paper snapshot on lifecycle hide", () => {
  const panel = read("ui/assets/panel.js");
  assert.match(panel, /visibilitychange/);
  assert.match(panel, /pagehide/);
  assert.match(panel, /flushForPageLifecycle/);
  assert.match(panel, /lifecycleFlushPromise/);
});

test("recent route aggregates a synthetic per-paper-v1 layout into the public paper contract", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-per-paper-v1-"));
  const paperHash = "c".repeat(12);
  try {
    fs.mkdirSync(path.join(dataDir, "papers", paperHash), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "paper-workspace.json"), JSON.stringify({
      schemaVersion: 3,
      storageLayout: "per-paper-v1",
      papers: { [paperHash]: { paperHash, updatedAt: "2026-09-29T10:00:00.000Z" } },
    }));
    fs.writeFileSync(path.join(dataDir, "papers", paperHash, "paper.json"), JSON.stringify({
      paperHash,
      metadata: { title: "Per-paper fixture" },
      parser: { kind: "mineru", pageCount: 2 },
      blocks: [{ id: "b1", page: 1, type: "equation", text: "x = 1", latex: "x=1" }],
      createdAt: "2026-09-29T09:00:00.000Z",
      updatedAt: "2026-09-29T10:00:00.000Z",
    }));
    fs.writeFileSync(path.join(dataDir, "papers", paperHash, "research.json"), JSON.stringify({
      paperHash,
      readingMode: "translation",
      glossary: { version: 2, terms: { evidence: "证据" } },
    }));
    fs.writeFileSync(path.join(dataDir, "papers", paperHash, "translations.json"), JSON.stringify({
      paperHash,
      translations: { b1: "x = 1 translated" },
      translationStates: { b1: { kind: "final", locked: true } },
      translationGlossaryVersion: 2,
    }));
    fs.writeFileSync(path.join(dataDir, "papers", paperHash, "tasks.json"), JSON.stringify({ paperHash, tasks: {} }));

    const app = makeApp();
    registerApiRoutes(app, { dataDir });
    const response = app.routes.get("GET /api/research/recent")(requestContext());
    assert.equal(response.status, 200);
    assert.equal(response.value.paper.paperHash, paperHash);
    assert.equal(response.value.paper.translations.b1, "x = 1 translated");
    assert.deepEqual(response.value.paper.translationStates.b1, { kind: "final", locked: true });
    assert.equal(response.value.paper.readingMode, "translation");
    assert.equal(response.value.paper.glossaryVersion, 2);
    assert.deepEqual(response.value.paper.glossaryTerms, { evidence: "证据" });
    assert.equal(response.value.paper.translationGlossaryVersion, 2);
    assert.equal(response.value.paper.resources.length, 1);
    assert.equal(response.value.paper.notes, undefined);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Phase 2 read-only research routes expose a synthetic per-paper workspace", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-research-read-") );
  const paperHash = "e".repeat(64);
  try {
    fs.mkdirSync(path.join(dataDir, "papers", paperHash), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "paper-workspace.json"), JSON.stringify({
      schemaVersion: 3,
      storageLayout: "per-paper-v1",
      papers: { [paperHash]: { paperHash, updatedAt: "2026-09-29T10:00:00.000Z", blockCount: 3 } },
    }));
    fs.writeFileSync(path.join(dataDir, "papers", paperHash, "paper.json"), JSON.stringify({
      paperHash,
      metadata: { title: "Read-only research fixture", authors: ["Tester"] },
      parser: { pageCount: 2 },
      blocks: [
        { id: "h1", page: 1, type: "heading", level: 1, text: "Introduction" },
        { id: "b1", page: 1, type: "paragraph", text: "Energy storage evidence", translatedText: "储能证据" },
        { id: "eq1", page: 2, type: "equation", text: "x = 1", latex: "x=1" },
      ],
    }));
    fs.writeFileSync(path.join(dataDir, "papers", paperHash, "research.json"), JSON.stringify({
      paperHash,
      readingMode: "bilingual",
      notes: { n1: { id: "n1", paperHash, noteType: "finding", text: "A finding" } },
      bookmarks: { bm1: { id: "bm1", paperHash, blockId: "b1" } },
      progress: { percent: 42, lastBlockId: "b1" },
      glossary: { version: 2, terms: { evidence: "证据" } },
    }));
    fs.writeFileSync(path.join(dataDir, "papers", paperHash, "translations.json"), JSON.stringify({
      paperHash,
      translations: { b1: "储能证据" },
      translationStates: { b1: { kind: "final", locked: true } },
      translationGlossaryVersion: 2,
    }));
    fs.writeFileSync(path.join(dataDir, "papers", paperHash, "tasks.json"), JSON.stringify({
      paperHash,
      tasks: { t1: { id: "t1", paperHash, state: "succeeded" } },
    }));

    const app = makeApp();
    registerApiRoutes(app, { dataDir });
    const denied = app.routes.get("GET /api/research/library")(requestContext({ authorized: false }));
    assert.equal(denied.status, 403);

    const library = app.routes.get("GET /api/research/library")(requestContext());
    assert.equal(library.status, 200);
    assert.equal(library.value.total, 1);
    assert.equal(library.value.items[0].paperHash, paperHash);
    assert.equal(library.value.items[0].title, "Read-only research fixture");

    const paper = app.routes.get("GET /api/research/paper")(requestContext({ query: { paperHash } }));
    assert.equal(paper.status, 200);
    assert.equal(paper.value.paper.translations.b1, "储能证据");
    assert.deepEqual(paper.value.paper.translationStates.b1, { kind: "final", locked: true });

    const search = app.routes.get("GET /api/research/search")(requestContext({ query: { paperHash, q: "energy", language: "original" } }));
    assert.equal(search.status, 200);
    assert.equal(search.value.results[0].id, "b1");

    const evidence = app.routes.get("GET /api/research/evidence")(requestContext({ query: { paperHash, blockId: "b1" } }));
    assert.equal(evidence.status, 200);
    assert.equal(evidence.value.evidence.blockId, "b1");
    assert.equal(evidence.value.evidence.originalQuote, "Energy storage evidence");

    const outline = app.routes.get("GET /api/research/outline")(requestContext({ query: { paperHash } }));
    assert.equal(outline.status, 200);
    assert.deepEqual(outline.value.outline[0], { id: "h1", title: "Introduction", page: 1, level: 1 });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("recent route accepts v1 paper hashes at both legal boundaries", () => {
  for (const [index, length] of [12, 128].entries()) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `hpr-v2-hash-boundary-${index}-`));
    const paperHash = "d".repeat(length);
    try {
      fs.mkdirSync(path.join(dataDir, "papers", paperHash), { recursive: true });
      fs.writeFileSync(path.join(dataDir, "paper-workspace.json"), JSON.stringify({
        schemaVersion: 3,
        papers: { [paperHash]: { paperHash, updatedAt: "2026-09-29T10:00:00.000Z" } },
      }));
      fs.writeFileSync(path.join(dataDir, "papers", paperHash, "paper.json"), JSON.stringify({
        paperHash,
        metadata: { title: `Hash ${length}` },
        blocks: [{ id: "b1", page: 1, type: "paragraph", text: "boundary" }],
      }));
      const app = makeApp();
      registerApiRoutes(app, { dataDir });
      const response = app.routes.get("GET /api/research/recent")(requestContext());
      assert.equal(response.status, 200);
      assert.equal(response.value.paper.paperHash, paperHash);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
});
