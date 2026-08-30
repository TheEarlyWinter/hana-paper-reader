import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeAuthors, normalizeDisplayText, normalizePaperMetadata, normalizeTags, normalizeYear } from "../lib/paper-metadata.js";
import { createPaperWorkspace } from "../lib/paper-workspace.js";
import registerApiRoutes from "../routes/api.js";

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
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

test("paper-metadata normalization handles scalar and malformed objects gracefully", () => {
  assert.equal(normalizeDisplayText("  Clean  "), "Clean");
  assert.equal(normalizeDisplayText({ malformed: true }, 100, "fallback"), "fallback");
  assert.equal(normalizeDisplayText(123), "123");

  assert.deepEqual(normalizeAuthors(["Alice", { evil: true }, "Bob"]), ["Alice", "Bob"]);
  assert.deepEqual(normalizeAuthors("Charlie, David；Eve"), ["Charlie", "David", "Eve"]);
  assert.deepEqual(normalizeAuthors({ bad: true }), []);

  assert.deepEqual(normalizeTags(["tag1", { evil: true }, "tag2"]), ["tag1", "tag2"]);
  assert.equal(normalizeYear("Published 2024 in Journal"), "2024");
  assert.equal(normalizeYear({ bad: 2024 }), null);

  const normalized = normalizePaperMetadata({
    title: { bad: 1 },
    authors: [{ evil: 2 }, "Valid Author"],
    year: { bad: 3 },
    doi: { bad: 4 },
    tags: ["good", { bad: 5 }],
  });
  assert.equal(normalized.title, "未命名论文");
  assert.deepEqual(normalized.authors, ["Valid Author"]);
  assert.equal(normalized.year, null);
  assert.equal(normalized.doi, null);
  assert.deepEqual(normalized.tags, ["good"]);
});

test("workspace listLibrary and search handle malformed metadata on disk without crashing", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "metadata-malformed-test-"));
  try {
    const ws = createPaperWorkspace({ dataDir: tempDir });
    const hash = "c".repeat(64);
    await ws.upsertPaper({
      paperHash: hash,
      title: "Initial Title",
      metadata: {
        title: { corrupted: true },
        authors: [{ bad: true }, "Good Author"],
        year: { bad: true },
        doi: { bad: true },
        tags: ["ai", { bad: true }],
      },
      blocks: [{ id: "b1", text: "Some text" }],
    });

    const items = ws.listLibrary({ query: "author" });
    assert.equal(items.length, 1);
    assert.equal(typeof items[0].title, "string");
    assert.deepEqual(items[0].authors, ["Good Author"]);
    assert.deepEqual(items[0].tags, ["ai"]);

    const sorted = ws.listLibrary({ sort: "title" });
    assert.equal(sorted.length, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("updatePaperMetadata updates authors and tags correctly across workspace, fallback and HTTP API", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "metadata-update-test-"));
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
    const hash = "e".repeat(64);
    await app.routes.get("POST /api/research/paper")(requestContext({
      paperHash: hash,
      metadata: { title: "Paper E", authors: ["Old Author"], tags: ["old"] },
      blocks: [{ id: "b1", text: "Body" }],
    }));

    // Update via HTTP route
    const initialPaper = app.routes.get("GET /api/research/paper")(requestContext({}, { paperHash: hash }));
    const initialRevision = initialPaper.value.paper.revision;
    const updateRes = await app.routes.get("POST /api/research/library/metadata")(requestContext({
      paperHash: hash.toUpperCase(), // Test case insensitivity
      authors: ["New Author 1", "New Author 2"],
      tags: ["new-tag"],
    }));
    assert.equal(updateRes.value.ok, true);
    assert.deepEqual(updateRes.value.metadata.authors, ["New Author 1", "New Author 2"]);
    assert.deepEqual(updateRes.value.metadata.tags, ["new-tag"]);
    assert.equal(updateRes.value.revision, initialRevision + 1);

    const staleSave = await app.routes.get("POST /api/research/paper")(requestContext({
      paperHash: hash,
      blocks: [{ id: "b1", text: "stale body" }],
      expectedRevision: initialRevision,
    }));
    assert.equal(staleSave.status, 409);
    assert.match(staleSave.value.error, /revision conflict/i);

    const freshSave = await app.routes.get("POST /api/research/paper")(requestContext({
      paperHash: hash,
      blocks: [{ id: "b1", text: "fresh body" }],
      expectedRevision: updateRes.value.revision,
    }));
    assert.equal(freshSave.status, 200);
    assert.equal(freshSave.value.paper.revision, updateRes.value.revision + 1);

    // Verify in library list
    const listRes = app.routes.get("GET /api/research/library")(requestContext({}));
    const found = listRes.value.items.find((item) => item.paperHash === hash);
    assert.ok(found);
    assert.deepEqual(found.authors, ["New Author 1", "New Author 2"]);
    assert.deepEqual(found.tags, ["new-tag"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
