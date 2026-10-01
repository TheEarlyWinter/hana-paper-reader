import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import registerApiRoutes from "../server/http/api-routes.js";

function makeApp() {
  const routes = new Map();
  const add = (method) => (route, handler) => routes.set(`${method} ${route}`, handler);
  return { routes, get: add("GET"), post: add("POST"), delete: add("DELETE") };
}

function requestContext({ authorized = true, query = {}, params = {}, body = {} } = {}) {
  return {
    get(key) {
      if (key !== "appRequestContext") return undefined;
      return authorized ? { principal: { id: "phase2-write-test" } } : undefined;
    },
    req: {
      query(name) { return query[name]; },
      param(name) { return params[name]; },
      async json() { return body; },
    },
    json(value, status = 200) { return { value, status }; },
  };
}

const PAPER_HASH = "1".repeat(64);

test("Phase 2 write routes reuse the vendored workspace for research state", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-write-"));
  try {
    const app = makeApp();
    registerApiRoutes(app, { dataDir });

    const denied = await app.routes.get("POST /api/research/paper")(requestContext({ authorized: false }));
    assert.equal(denied.status, 403);

    const created = await app.routes.get("POST /api/research/paper")(requestContext({ body: {
      paperHash: PAPER_HASH,
      metadata: { title: "Write route fixture" },
      parser: { pageCount: 1 },
      blocks: [{ id: "b1", page: 1, type: "paragraph", text: "Writable evidence" }],
    } }));
    assert.equal(created.status, 200);
    assert.equal(created.value.paper.paperHash, PAPER_HASH);
    assert.equal(created.value.paper.revision, 1);

    const firstRevision = created.value.paper.revision;
    const firstUpdate = await app.routes.get("POST /api/research/paper")(requestContext({ body: {
      paperHash: PAPER_HASH,
      expectedRevision: firstRevision,
      metadata: { title: "First concurrent update" },
      blocks: [{ id: "b1", page: 1, type: "paragraph", text: "First writer" }],
    } }));
    assert.equal(firstUpdate.status, 200);
    assert.equal(firstUpdate.value.paper.revision, 2);

    const staleUpdate = await app.routes.get("POST /api/research/paper")(requestContext({ body: {
      paperHash: PAPER_HASH,
      expectedRevision: firstRevision,
      metadata: { title: "Stale update" },
      blocks: [{ id: "b1", page: 1, type: "paragraph", text: "Stale writer" }],
    } }));
    assert.equal(staleUpdate.status, 409);
    assert.equal(staleUpdate.value.error.code, "paper_conflict");

    const afterConflict = app.routes.get("GET /api/research/paper")(requestContext({ query: { paperHash: PAPER_HASH } }));
    assert.equal(afterConflict.status, 200);
    assert.equal(afterConflict.value.paper.blocks[0].text, "First writer");

    const cachedTranslation = await app.routes.get("POST /api/research/translation-cache")(requestContext({ body: {
      paperHash: PAPER_HASH,
      blockId: "b1",
      glossaryVersion: 0,
      promptVersion: "academic-translation-v1",
      inputHash: "input-hash-v1",
      source: "First writer",
      translation: "第一写入者",
    } }));
    assert.equal(cachedTranslation.status, 200);
    const cacheHit = app.routes.get("GET /api/research/translation-cache")(requestContext({ query: {
      paperHash: PAPER_HASH,
      blockId: "b1",
      glossaryVersion: 0,
      promptVersion: "academic-translation-v1",
      inputHash: "input-hash-v1",
    } }));
    assert.equal(cacheHit.value.hit, true);
    const inputMiss = app.routes.get("GET /api/research/translation-cache")(requestContext({ query: {
      paperHash: PAPER_HASH,
      blockId: "b1",
      glossaryVersion: 0,
      promptVersion: "academic-translation-v1",
      inputHash: "input-hash-v2",
    } }));
    assert.equal(inputMiss.value.hit, false);
    const promptMiss = app.routes.get("GET /api/research/translation-cache")(requestContext({ query: {
      paperHash: PAPER_HASH,
      blockId: "b1",
      glossaryVersion: 0,
      promptVersion: "academic-translation-v2",
      inputHash: "input-hash-v1",
    } }));
    assert.equal(promptMiss.value.hit, false);

    const note = await app.routes.get("POST /api/research/notes")(requestContext({ body: {
      paperHash: PAPER_HASH,
      blockId: "b1",
      note: "A verified finding",
      noteType: "finding",
    } }));
    assert.equal(note.status, 200);
    assert.equal(note.value.note.validationStatus, "verified");

    const bookmark = await app.routes.get("POST /api/research/bookmarks")(requestContext({ body: {
      paperHash: PAPER_HASH,
      blockId: "b1",
      label: "Important",
    } }));
    assert.equal(bookmark.status, 200);
    assert.equal(bookmark.value.bookmark.evidence.blockId, "b1");

    const progress = await app.routes.get("POST /api/research/progress")(requestContext({ body: {
      paperHash: PAPER_HASH,
      percent: 55,
      page: 1,
      readingMode: "bilingual",
    } }));
    assert.equal(progress.status, 200);
    assert.equal(progress.value.progress.percent, 55);

    const glossary = await app.routes.get("POST /api/research/glossary")(requestContext({ body: {
      paperHash: PAPER_HASH,
      terms: { evidence: "证据" },
    } }));
    assert.equal(glossary.status, 200);
    assert.equal(glossary.value.glossary.terms.evidence, "证据");

    const task = await app.routes.get("POST /api/research/parse-status/tasks")(requestContext({ body: {
      paperHash: PAPER_HASH,
      id: "task-1",
      stage: "parse",
    } }));
    assert.equal(task.status, 200);
    assert.equal(task.value.task.state, "queued");

    const running = await app.routes.get("POST /api/research/parse-status/tasks/:taskId")(requestContext({
      params: { taskId: "task-1" },
      body: { state: "running", progress: 25 },
    }));
    assert.equal(running.status, 200);
    assert.equal(running.value.task.state, "running");

    const notes = app.routes.get("GET /api/research/notes")(requestContext({ query: { paperHash: PAPER_HASH } }));
    assert.equal(notes.status, 200);
    assert.equal(notes.value.notes.length, 1);

    const tasks = app.routes.get("GET /api/research/parse-status/tasks")(requestContext({ query: { paperHash: PAPER_HASH } }));
    assert.equal(tasks.status, 200);
    assert.equal(tasks.value.tasks[0].state, "running");

    const paper = app.routes.get("GET /api/research/paper")(requestContext({ query: { paperHash: PAPER_HASH } }));
    assert.equal(paper.status, 200);
    assert.equal(paper.value.paper.metadata.title, "First concurrent update");

    const deleted = await app.routes.get("DELETE /api/research/notes/:id")(requestContext({ params: { id: note.value.note.id } }));
    assert.equal(deleted.status, 200);
    assert.equal(deleted.value.deleted, true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
