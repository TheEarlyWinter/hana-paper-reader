import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import registerApiRoutes from "../routes/api.js";
import { createPaperWorkspace, sha256 } from "../lib/paper-workspace.js";

const paperHash = "c".repeat(64);

function paperInput() {
  return {
    paperHash,
    metadata: { title: "Research API fixture", authors: ["Ada"], year: 2026 },
    parser: { pageCount: 2, modelVersion: "vlm" },
    blocks: [
      { id: "b-heading", page: 1, type: "heading", level: 1, text: "Methods" },
      { id: "b-water", page: 1, type: "paragraph", text: "Water stress reduces crop yield.", bbox: [10, 20, 300, 400] },
      { id: "b-formula", page: 2, type: "equation", text: "Growth equation", latex: "y = ax" },
    ],
    translations: { "b-water": "水分胁迫降低作物产量。" },
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

function requestContext(body = {}, query = {}, params = {}) {
  return {
    req: {
      json: async () => body,
      query: (key) => query[key] || "",
      param: (key) => params[key] || "",
    },
    json(value, status = 200) { return { kind: "json", value, status }; },
    get() { return null; },
  };
}

function binaryRequestContext(bytes, query = {}) {
  const stream = new Response(bytes).body;
  return {
    req: {
      query: (key) => query[key] || "",
      header: (key) => String(key).toLowerCase() === "content-type" ? "application/pdf" : "",
      raw: { body: stream },
    },
    json(value, status = 200) { return { kind: "json", value, status }; },
    get() { return null; },
  };
}

async function readResponse(response) {
  return {
    text: await response.text(),
    contentType: response.headers.get("content-type"),
  };
}

test("registers research routes without changing the existing MinerU route surface", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "research-api-routes-"));
  const app = makeApp();
  const networkCalls = [];
  const ctx = {
    pluginId: "hana-paper-reader",
    dataDir: tempDir,
    config: { get: () => "", setMany() {} },
    log: { error() {}, warn() {} },
    bus: { request: async () => { throw new Error("model/network must not run"); } },
    network: { fetch: async (...args) => { networkCalls.push(args); throw new Error("remote call"); } },
  };
  try {
    registerApiRoutes(app, ctx);
    for (const route of [
      "GET /api/research/recent",
      "GET /api/research/paper",
      "POST /api/research/paper",
      "GET /api/research/snapshot",
      "GET /api/research/search",
      "GET /api/research/outline",
      "POST /api/research/notes",
      "GET /api/research/notes",
      "DELETE /api/research/notes/:id",
      "DELETE /api/research/notes",
      "POST /api/research/bookmarks",
      "GET /api/research/bookmarks",
      "DELETE /api/research/bookmarks/:id",
      "DELETE /api/research/bookmarks",
      "POST /api/research/progress",
      "GET /api/research/progress",
      "GET /api/research/glossary",
      "POST /api/research/glossary",
      "DELETE /api/research/glossary",
      "GET /api/research/translation-cache",
      "POST /api/research/translation-cache",
      "GET /api/research/parse-status/tasks",
      "POST /api/research/parse-status/tasks",
      "POST /api/research/parse-status/tasks/:taskId/update",
      "POST /api/research/parse-status/tasks/:taskId/cancel",
      "POST /api/research/export",
      "POST /api/research/evidence",
      "GET /api/research/parse-cache/check",
    ]) assert.equal(typeof app.routes.get(route), "function", `missing ${route}`);
    assert.equal(typeof app.routes.get("POST /api/parse-pdf"), "function");
    assert.equal(networkCalls.length, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("research CRUD routes persist paper data and serve bounded read APIs", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "research-api-crud-"));
  const app = makeApp();
  const ctx = {
    pluginId: "hana-paper-reader",
    dataDir: tempDir,
    config: { get: () => "", setMany() {} },
    log: { error() {}, warn() {} },
    bus: { request: async () => { throw new Error("model must not run"); } },
    network: { fetch: async () => { throw new Error("network must not run"); } },
  };
  try {
    registerApiRoutes(app, ctx);
    const postPaper = app.routes.get("POST /api/research/paper");
    const paperResponse = await postPaper(requestContext(paperInput()));
    assert.equal(paperResponse.status, 200);
    assert.equal(paperResponse.value.paper.metadata.title, "Research API fixture");
    assert.equal(paperResponse.value.paper.blocks[1].translatedText, "水分胁迫降低作物产量。");

    const getPaper = app.routes.get("GET /api/research/paper");
    const loadedPaper = getPaper(requestContext({}, { paperHash }));
    assert.equal(loadedPaper.value.ok, true);
    assert.equal(loadedPaper.value.paper.resources[0].id, "b-formula");
    assert.equal(loadedPaper.value.paper.translations["b-water"], "水分胁迫降低作物产量。");
    const recentPaper = app.routes.get("GET /api/research/recent")(requestContext());
    assert.equal(recentPaper.value.ok, true);
    assert.equal(recentPaper.value.paper.paperHash, paperHash);
    assert.equal(recentPaper.value.paper.blocks.length, 3);

    const mergedPaper = await postPaper(requestContext({ paperHash, translations: {} }));
    assert.equal(mergedPaper.value.paper.translations["b-water"], "水分胁迫降低作物产量。", "ordinary empty sync must preserve translations");
    const replacedPaper = await postPaper(requestContext({
      paperHash,
      blocks: paperInput().blocks,
      translations: {},
      translationGlossaryVersion: 1,
    }));
    assert.deepEqual(replacedPaper.value.paper.translations, {}, "glossary version change must replace stale translations");
    assert.equal(replacedPaper.value.paper.blocks[1].translatedText, "", "normalized block schema may retain an empty translatedText field");
    const updatedPaper = await postPaper(requestContext({
      paperHash,
      translations: { "b-water": "水分胁迫会降低作物产量。" },
      translationGlossaryVersion: 1,
    }));
    assert.equal(updatedPaper.value.paper.translations["b-water"], "水分胁迫会降低作物产量。");

    const snapshot = app.routes.get("GET /api/research/snapshot")(requestContext({}, { paperHash, limit: "2" }));
    assert.equal(snapshot.value.ok, true);
    assert.equal(snapshot.value.snapshot.paper.blockIndex.length, 2);
    assert.equal(snapshot.value.snapshot.paper.blocks, undefined);

    const search = app.routes.get("GET /api/research/search")(requestContext({}, { paperHash, q: "产量" }));
    assert.equal(search.value.results[0].matches.translated, true);
    const outline = app.routes.get("GET /api/research/outline")(requestContext({}, { paperHash }));
    assert.equal(outline.value.outline[0].title, "Methods");

    const note = await app.routes.get("POST /api/research/notes")(requestContext({ paperHash, blockId: "b-water", note: "Verify field result", tags: ["check"] }));
    const bookmark = await app.routes.get("POST /api/research/bookmarks")(requestContext({ paperHash, blockId: "b-formula", label: "Formula", page: 2 }));
    assert.equal(note.value.note.blockId, "b-water");
    assert.equal(bookmark.value.bookmark.label, "Formula");
    assert.equal(app.routes.get("GET /api/research/notes")(requestContext({}, { paperHash })).value.notes.length, 1);
    assert.equal(app.routes.get("GET /api/research/bookmarks")(requestContext({}, { paperHash })).value.bookmarks.length, 1);
    assert.equal((await app.routes.get("DELETE /api/research/notes/:id")(requestContext({}, {}, { id: note.value.note.id }))).value.deleted, true);

    const progress = await app.routes.get("POST /api/research/progress")(requestContext({ paperHash, page: 2, percent: 50 }));
    assert.equal(progress.value.progress.percent, 50);
    assert.equal(app.routes.get("GET /api/research/progress")(requestContext({}, { paperHash })).value.progress.page, 2);

    const glossary = await app.routes.get("POST /api/research/glossary")(requestContext({ paperHash, terms: { "water stress": "水分胁迫" } }));
    assert.equal(glossary.value.glossary.version, 1);
    assert.equal(app.routes.get("GET /api/research/glossary")(requestContext({}, { paperHash })).value.glossary.terms["water stress"], "水分胁迫");
    const deletedTerm = await app.routes.get("DELETE /api/research/glossary")(requestContext({}, { paperHash, term: "water stress" }));
    assert.equal(deletedTerm.value.deleted, true);

    const cached = await app.routes.get("POST /api/research/translation-cache")(requestContext({ paperHash, blockId: "b-water", glossaryVersion: 1, source: "Water stress", translation: "水分胁迫" }));
    assert.equal(cached.value.translation.glossaryVersion, 1);
    const cacheHit = app.routes.get("GET /api/research/translation-cache")(requestContext({}, { paperHash, blockId: "b-water", glossaryVersion: "1" }));
    assert.equal(cacheHit.value.hit, true);

    const task = await app.routes.get("POST /api/research/parse-status/tasks")(requestContext({ paperHash, id: "parse-1" }));
    assert.equal(task.value.task.state, "queued");
    const updated = await app.routes.get("POST /api/research/parse-status/tasks/:taskId/update")(requestContext({ state: "running", stage: "upload", progress: 20 }, {}, { taskId: "parse-1" }));
    assert.equal(updated.value.task.stage, "upload");
    const cancelled = await app.routes.get("POST /api/research/parse-status/tasks/:taskId/cancel")(requestContext({}, {}, { taskId: "parse-1" }));
    assert.equal(cancelled.value.task.state, "cancelled");
    assert.equal(app.routes.get("GET /api/research/parse-status/tasks")(requestContext({}, { paperHash })).value.tasks.length, 1);

    const cacheCheck = app.routes.get("GET /api/research/parse-cache/check")(requestContext({}, { paperHash }));
    assert.equal(cacheCheck.value.hit, true);
    assert.equal(cacheCheck.value.blockCount, 3);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("export and evidence routes stay local except for the explicitly mocked agent bus", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "research-api-agent-"));
  const app = makeApp();
  const calls = [];
  const sentPrompts = [];
  const histories = new Map();
  let sessionSequence = 0;
  const ctx = {
    pluginId: "hana-paper-reader",
    dataDir: tempDir,
    config: { get: () => "", setMany() {} },
    log: { error() {}, warn() {} },
    bus: {
      async request(type, payload) {
        calls.push({ type, payload });
        if (type === "agent:profile") return { profile: { name: "Fixture Agent", models: { chat: "fixture-model" } } };
        if (type === "session:create") {
          const sessionId = `fixture-session-${++sessionSequence}`;
          histories.set(sessionId, []);
          return { sessionId, sessionRef: { sessionId }, thinkingLevel: "max" };
        }
        if (type === "session:update") return { thinkingLevel: "max" };
        if (type === "session:send") {
          sentPrompts.push(payload.text);
          histories.set(payload.sessionId, [
            { role: "user", content: payload.text },
            { role: "assistant", content: "The result is supported by Page 99 / block bogus." },
          ]);
          return { accepted: true };
        }
        if (type === "session:history") return { messages: histories.get(payload.sessionId) || [] };
        throw new Error(`unexpected bus call: ${type}`);
      },
    },
    network: { fetch: async () => { throw new Error("remote network must not run"); } },
  };
  try {
    registerApiRoutes(app, ctx);
    await app.routes.get("POST /api/research/paper")(requestContext(paperInput()));
    const exported = await app.routes.get("POST /api/research/export")(requestContext({ paperHash }));
    const markdown = await readResponse(exported);
    assert.match(markdown.contentType, /^text\/markdown/);
    assert.match(markdown.text, /Research API fixture/);
    assert.match(markdown.text, /水分胁迫降低作物产量/);
    assert.match(markdown.text, /page:1 block:b-water/);

    const evidence = await app.routes.get("POST /api/research/evidence")(requestContext({ paperHash, agentId: "fixture-agent", question: "What affects yield?", blockIds: ["b-water"] }));
    assert.equal(evidence.value.ok, true);
    assert.match(evidence.value.answer, /Page 1 \/ block b-water/);
    assert.doesNotMatch(evidence.value.answer, /Page 99 \/ block bogus/);
    assert.match(sentPrompts.at(-1), /Page 1 \/ block b-water/);
    assert.match(sentPrompts.at(-1), /What affects yield/);

    const quote = await app.routes.get("POST /api/ask-agent")(requestContext({
      paperHash,
      blockId: "b-water",
      page: 99,
      paperTitle: "Research API fixture",
      agentId: "fixture-agent",
      quote: "Water stress reduces crop yield.",
      context: "Selected paragraph\n来源：Page 99 / block bogus",
      glossaryTerms: { "water stress": "水分胁迫" },
      questionType: "critique",
      thinkingLevel: "max",
    }));
    assert.equal(quote.value.ok, true);
    assert.equal(quote.value.citation, "Page 1 / block b-water");
    assert.match(quote.value.answer, /Page 1 \/ block b-water/);
    assert.doesNotMatch(quote.value.answer, /Page 99 \/ block bogus/);
    assert.match(sentPrompts.at(-1), /已由论文工作区核验的来源：Page 1 \/ block b-water/);
    assert.match(sentPrompts.at(-1), /water stress/);
    assert.match(sentPrompts.at(-1), /水分胁迫/);
    assert.doesNotMatch(sentPrompts.at(-1), /Page 99 \/ block bogus/);
    assert.equal(calls.some(({ type }) => type === "model:sample-text"), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
