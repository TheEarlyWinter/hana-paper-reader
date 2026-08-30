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
      "GET /api/research/library",
      "POST /api/research/library/metadata",
      "GET /api/research/paper",
      "POST /api/research/paper",
      "GET /api/research/snapshot",
      "GET /api/research/storage",
      "POST /api/research/cleanup",
      "DELETE /api/research/paper",
      "POST /api/research/backup",
      "GET /api/research/backup",
      "POST /api/research/restore",
      "GET /api/research/search",
      "GET /api/research/evidence",
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
      "POST /api/research/parse-status/tasks/:taskId",
      "POST /api/research/parse-status/tasks/:taskId/update",
      "POST /api/research/parse-status/tasks/:taskId/cancel",
      "POST /api/research/export",
      "GET /api/research/export",
      "POST /api/research/csv",
      "GET /api/research/csv",
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
      translationStates: { "b-water": { kind: "ai", locked: false } },
      translationGlossaryVersion: 1,
      readingMode: "translation",
    }));
    assert.equal(updatedPaper.value.paper.translations["b-water"], "水分胁迫会降低作物产量。");
    assert.equal(updatedPaper.value.paper.translationStates["b-water"].kind, "ai");
    assert.equal(updatedPaper.value.paper.readingMode, "translation");

    const finalizedPaper = await postPaper(requestContext({
      paperHash,
      translations: { "b-water": "水分胁迫降低作物产量（用户定稿）。" },
      translationStates: { "b-water": { kind: "final", locked: true } },
      translationGlossaryVersion: 1,
    }));
    assert.equal(finalizedPaper.value.paper.translationStates["b-water"].kind, "final");

    const glossaryChanged = await postPaper(requestContext({
      paperHash,
      translations: {},
      translationStates: {},
      translationGlossaryVersion: 2,
      replaceTranslations: true,
    }));
    assert.equal(glossaryChanged.value.paper.translations["b-water"], "水分胁迫降低作物产量（用户定稿）。", "glossary changes must preserve user finals");
    assert.equal(glossaryChanged.value.paper.translationStates["b-water"].kind, "final");

    const staleAiSync = await postPaper(requestContext({
      paperHash,
      translations: { "b-water": "过期客户端尝试覆盖" },
      translationStates: { "b-water": { kind: "ai", locked: false } },
      translationGlossaryVersion: 2,
    }));
    assert.equal(staleAiSync.value.paper.translations["b-water"], "水分胁迫降低作物产量（用户定稿）。", "AI state must not overwrite an existing final");
    assert.equal(staleAiSync.value.paper.translationStates["b-water"].kind, "final");

    const evidenceList = app.routes.get("GET /api/research/evidence")(requestContext({}, { paperHash, limit: "2" }));
    assert.equal(evidenceList.value.ok, true);
    assert.equal(evidenceList.value.evidence.length, 2);
    assert.match(evidenceList.value.evidence[1].evidenceId, /^ev-/);
    const evidenceRecord = app.routes.get("GET /api/research/evidence")(requestContext({}, { paperHash, blockId: "b-water" }));
    assert.equal(evidenceRecord.value.evidence.originalQuote, "Water stress reduces crop yield.");
    assert.equal(evidenceRecord.value.evidence.validationStatus, "verified");

    const snapshot = app.routes.get("GET /api/research/snapshot")(requestContext({}, { paperHash, limit: "2" }));
    assert.equal(snapshot.value.ok, true);
    assert.equal(snapshot.value.snapshot.paper.blockIndex.length, 2);
    assert.equal(snapshot.value.snapshot.paper.blocks, undefined);

    const search = app.routes.get("GET /api/research/search")(requestContext({}, { paperHash, q: "产量", scope: "page", page: "1", language: "translation", types: "body", currentBlockId: "b-water" }));
    assert.equal(search.value.results[0].matches.translated, true);
    assert.equal(search.value.options.scope, "page");
    assert.match(search.value.ranking, /词频/);
    assert.ok(search.value.results[0].scoreExplanation.length > 0);
    const outline = app.routes.get("GET /api/research/outline")(requestContext({}, { paperHash }));
    assert.equal(outline.value.outline[0].title, "Methods");

    const libraryBeforeMeta = app.routes.get("GET /api/research/library")(requestContext({}));
    assert.equal(libraryBeforeMeta.value.ok, true);
    assert.equal(libraryBeforeMeta.value.total, 1);
    assert.equal(libraryBeforeMeta.value.items[0].paperHash, paperHash);
    assert.equal(libraryBeforeMeta.value.items[0].favorite, false);

    const metaUpdate = await app.routes.get("POST /api/research/library/metadata")(requestContext({ paperHash, favorite: true, tags: ["important"] }));
    assert.equal(metaUpdate.value.ok, true);
    assert.equal(metaUpdate.value.metadata.favorite, true);
    assert.deepEqual(metaUpdate.value.metadata.tags, ["important"]);

    const libraryAfterMeta = app.routes.get("GET /api/research/library")(requestContext({}, { favorite: "true" }));
    assert.equal(libraryAfterMeta.value.items.length, 1);
    assert.equal(libraryAfterMeta.value.items[0].favorite, true);

    const note = await app.routes.get("POST /api/research/notes")(requestContext({ paperHash, blockId: "b-water", note: "Verify field result", noteType: "question", tags: ["check"] }));
    const bookmark = await app.routes.get("POST /api/research/bookmarks")(requestContext({ paperHash, blockId: "b-formula", label: "Formula", page: 2 }));
    assert.equal(note.value.note.blockId, "b-water");
    assert.equal(note.value.note.noteType, "question");
    assert.equal(note.value.note.quote, "Water stress reduces crop yield.");
    assert.equal(bookmark.value.bookmark.label, "Formula");
    assert.equal(app.routes.get("GET /api/research/notes")(requestContext({}, { paperHash })).value.notes.length, 1);
    assert.equal(app.routes.get("GET /api/research/notes")(requestContext({}, { paperHash, noteType: "question", unresolvedOnly: "true" })).value.notes.length, 1);
    assert.equal(app.routes.get("GET /api/research/bookmarks")(requestContext({}, { paperHash })).value.bookmarks.length, 1);
    assert.equal((await app.routes.get("DELETE /api/research/notes/:id")(requestContext({}, { paperHash }, { id: note.value.note.id }))).value.deleted, true);

    const progress = await app.routes.get("POST /api/research/progress")(requestContext({ paperHash, page: 2, percent: 50 }));
    assert.equal(progress.value.progress.percent, 50);
    assert.equal(app.routes.get("GET /api/research/progress")(requestContext({}, { paperHash })).value.progress.page, 2);

    const glossary = await app.routes.get("POST /api/research/glossary")(requestContext({ paperHash, terms: { "water stress": "水分胁迫" } }));
    assert.equal(glossary.value.glossary.version, 1);
    assert.equal(app.routes.get("GET /api/research/glossary")(requestContext({}, { paperHash })).value.glossary.terms["water stress"], "水分胁迫");
    const paperWithGlossary = app.routes.get("GET /api/research/paper")(requestContext({}, { paperHash }));
    assert.equal(paperWithGlossary.value.paper.glossaryVersion, 1);
    assert.equal(paperWithGlossary.value.paper.glossaryTerms["water stress"], "水分胁迫");
    const deletedTerm = await app.routes.get("DELETE /api/research/glossary")(requestContext({}, { paperHash, term: "water stress" }));
    assert.equal(deletedTerm.value.deleted, true);

    const cached = await app.routes.get("POST /api/research/translation-cache")(requestContext({ paperHash, blockId: "b-water", glossaryVersion: 1, source: "Water stress", translation: "水分胁迫" }));
    assert.equal(cached.value.translation.glossaryVersion, 1);
    const cacheHit = app.routes.get("GET /api/research/translation-cache")(requestContext({}, { paperHash, blockId: "b-water", glossaryVersion: "1" }));
    assert.equal(cacheHit.value.hit, true);

    const task = await app.routes.get("POST /api/research/parse-status/tasks")(requestContext({ paperHash, id: "parse-1" }));
    assert.equal(task.value.task.state, "queued");
    const updated = await app.routes.get("POST /api/research/parse-status/tasks/:taskId")(requestContext({ state: "running", stage: "upload", progress: 20 }, {}, { taskId: "parse-1" }), async () => {});
    assert.equal(updated.value.task.stage, "upload", "Hono next callback must not be mistaken for a forced task state");
    const cancelled = await app.routes.get("POST /api/research/parse-status/tasks/:taskId/cancel")(requestContext({}, {}, { taskId: "parse-1" }));
    assert.equal(cancelled.value.task.state, "cancelled");
    assert.equal(app.routes.get("GET /api/research/parse-status/tasks")(requestContext({}, { paperHash })).value.tasks.length, 1);

    const cacheCheck = app.routes.get("GET /api/research/parse-cache/check")(requestContext({}, { paperHash }));
    assert.equal(cacheCheck.value.hit, true);
    assert.equal(cacheCheck.value.blockCount, 3);

    const storage = app.routes.get("GET /api/research/storage")(requestContext({}, { paperHash }));
    assert.equal(storage.value.ok, true);
    assert.equal(storage.value.storage.layout, "per-paper-v1");
    assert.equal(storage.value.storage.counts.notes, 0, "the note was deleted earlier in this test");

    const backupResponse = await app.routes.get("POST /api/research/backup")(requestContext({ paperHash, includeAssets: false }));
    const backupText = await readResponse(backupResponse);
    const backup = JSON.parse(backupText.text);
    assert.equal(backup.format, "hana-paper-reader-backup");
    assert.equal(backup.paperHash, paperHash);
    assert.match(backupResponse.headers.get("content-disposition"), /attachment/);
    assert.match(backupResponse.headers.get("content-disposition"), /filename\*=UTF-8''/);

    const nativeBackup = await app.routes.get("GET /api/research/backup")(requestContext({}, { paperHash, includeAssets: "false" }));
    assert.equal(nativeBackup.status, 200);
    assert.equal(JSON.parse(await nativeBackup.text()).paperHash, paperHash);
    assert.match(nativeBackup.headers.get("content-disposition"), /hana-paper-reader-cccccccccccc\.backup\.json/);
    assert.equal(nativeBackup.headers.get("cache-control"), "private, no-store");
    assert.equal(nativeBackup.headers.get("x-paper-hash"), paperHash);

    const cleared = await app.routes.get("POST /api/research/cleanup")(requestContext({ paperHash, action: "ai-translations" }));
    assert.equal(cleared.value.ok, true);
    assert.equal(cleared.value.result.preservedFinals, 1);
    const restored = await app.routes.get("POST /api/research/restore")(requestContext(backup));
    assert.equal(restored.value.ok, true);
    assert.equal(restored.value.paper.paperHash, paperHash);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("saveToDisk export and backup use an isolated Downloads directory and avoid overwrites", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "research-api-downloads-"));
  const previousUserProfile = process.env.USERPROFILE;
  const previousHome = process.env.HOME;
  process.env.USERPROFILE = tempHome;
  process.env.HOME = tempHome;
  const app = makeApp();
  const ctx = {
    pluginId: "hana-paper-reader",
    dataDir: path.join(tempHome, "plugin-data"),
    config: { get: () => "", setMany() {} },
    log: { error() {}, warn() {} },
    bus: { request: async () => { throw new Error("model must not run"); } },
    network: { fetch: async () => { throw new Error("network must not run"); } },
  };
  try {
    registerApiRoutes(app, ctx);
    await app.routes.get("POST /api/research/paper")(requestContext({
      ...paperInput(),
      metadata: { ...paperInput().metadata, title: "Research: API? fixture" },
    }));
    const exportRoute = app.routes.get("POST /api/research/export");
    const firstExport = await exportRoute(requestContext({ paperHash, saveToDisk: true }));
    const secondExport = await exportRoute(requestContext({ paperHash, saveToDisk: true }));
    const backupRoute = app.routes.get("POST /api/research/backup");
    const firstBackup = await backupRoute(requestContext({ paperHash, includeAssets: false, saveToDisk: true }));
    const secondBackup = await backupRoute(requestContext({ paperHash, includeAssets: false, saveToDisk: true }));
    const downloads = path.join(tempHome, "Downloads");
    assert.equal(firstExport.value.saved, true);
    assert.equal(firstExport.value.fileName, "Research_ API_ fixture.md");
    assert.equal(secondExport.value.fileName, "Research_ API_ fixture (1).md");
    assert.equal(firstBackup.value.fileName, `hana-paper-reader-${paperHash.slice(0, 12)}.backup.json`);
    assert.equal(secondBackup.value.fileName, `hana-paper-reader-${paperHash.slice(0, 12)}.backup (1).json`);
    for (const result of [firstExport, secondExport, firstBackup, secondBackup]) {
      assert.equal(path.dirname(result.value.filePath), downloads);
      assert.equal(fs.existsSync(result.value.filePath), true);
      assert.equal(result.value.size, fs.statSync(result.value.filePath).size);
    }
    assert.match(fs.readFileSync(firstExport.value.filePath, "utf8"), /Research: API\? fixture/);
    assert.equal(JSON.parse(fs.readFileSync(firstBackup.value.filePath, "utf8")).paperHash, paperHash);
  } finally {
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
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
    assert.match(exported.headers.get("content-disposition"), /attachment/);
    assert.match(exported.headers.get("content-disposition"), /Research API fixture\.md/);
    assert.match(markdown.text, /Research API fixture/);

    const nativeExport = await app.routes.get("GET /api/research/export")(requestContext({}, { paperHash }));
    assert.equal(nativeExport.status, 200);
    const nativeMarkdown = await readResponse(nativeExport);
    assert.match(nativeMarkdown.text, /Research API fixture/);
    assert.match(nativeExport.headers.get("content-disposition"), /Research API fixture\.md/);
    assert.match(markdown.text, /水分胁迫降低作物产量/);
    assert.match(markdown.text, /page:1 block:b-water evidence:ev-/);
    assert.match(markdown.text, /AI 译文/);

    const evidence = await app.routes.get("POST /api/research/evidence")(requestContext({ paperHash, agentId: "fixture-agent", question: "What affects yield?", blockIds: ["b-water"] }));
    assert.equal(evidence.value.ok, true);
    assert.match(evidence.value.answer, /Page 1 \/ block b-water/);
    assert.match(evidence.value.evidence[0].evidenceId, /^ev-/);
    assert.equal(evidence.value.evidence[0].validationStatus, "verified");
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
