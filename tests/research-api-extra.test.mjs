import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import registerApiRoutes, { recentWorkspacePaper } from "../routes/api.js";
import { sha256 } from "../lib/paper-workspace.js";

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
    delete(route, handler) { routes.set(`DELETE ${route}`, handler); },
  };
}

function jsonContext(body = {}, query = {}, params = {}) {
  return {
    req: {
      json: async () => body,
      query: (key) => query[key] || "",
      param: (key) => params[key] || "",
    },
    json(value, status = 200) { return { value, status }; },
    get() { return null; },
  };
}

function binaryContext(bytes, query = {}) {
  return {
    req: {
      query: (key) => query[key] || "",
      header: (key) => String(key).toLowerCase() === "content-type" ? "application/pdf" : "",
      raw: { body: new Response(bytes).body },
    },
    json(value, status = 200) { return { value, status }; },
    get() { return null; },
  };
}

function baseContext(tempDir, overrides = {}) {
  return {
    pluginId: "hana-paper-reader",
    dataDir: tempDir,
    config: { get: () => "", setMany() {} },
    log: { error() {}, warn() {} },
    bus: { request: async () => { throw new Error("unexpected model call"); } },
    network: { fetch: async () => { throw new Error("unexpected network call"); } },
    ...overrides,
  };
}

test("recent paper lookup supports workspaces created by an older hot-reloaded module", () => {
  const oldStyleWorkspace = {
    load() {
      return {
        papers: {
          older: { paperHash: "a".repeat(64), metadata: { title: "Older" }, updatedAt: "2026-01-01T00:00:00.000Z" },
          newer: { paperHash: "b".repeat(64), metadata: { title: "Newer" }, updatedAt: "2026-08-22T00:00:00.000Z" },
        },
      };
    },
  };
  assert.equal(recentWorkspacePaper(oldStyleWorkspace).metadata.title, "Newer");
});

test("PDF parse route reuses the server SHA-256 cache without MinerU network access", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "research-api-cache-hit-"));
  const app = makeApp();
  const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
  const paperHash = sha256(pdf);
  let networkCalls = 0;
  const ctx = baseContext(tempDir, {
    network: { fetch: async () => { networkCalls += 1; throw new Error("MinerU must not run on cache hit"); } },
  });
  try {
    registerApiRoutes(app, ctx);
    const saved = await app.routes.get("POST /api/research/paper")(jsonContext({
      paperHash,
      metadata: { title: "Cached PDF" },
      parser: { kind: "mineru", modelVersion: "vlm", pageCount: 1 },
      blocks: [{ id: "cached-b1", page: 1, type: "paragraph", text: "Cached paragraph" }],
    }));
    assert.equal(saved.status, 200);

    const parsed = await app.routes.get("POST /api/parse-pdf")(binaryContext(pdf, { parser: "mineru", fileName: "cached.pdf" }));
    assert.equal(parsed.status, 200);
    assert.equal(parsed.value.ok, true);
    assert.equal(parsed.value.cached, true);
    assert.equal(parsed.value.paperHash, paperHash);
    assert.equal(parsed.value.blocks[0].id, "cached-b1");
    assert.equal(networkCalls, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("utility translation prompt carries bounded glossary terminology", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "research-api-glossary-prompt-"));
  const app = makeApp();
  let sampledPayload = null;
  const ctx = baseContext(tempDir, {
    bus: {
      async request(type, payload) {
        if (type !== "model:sample-text") throw new Error(`unexpected bus call: ${type}`);
        sampledPayload = payload;
        return { text: '["水分胁迫降低产量。"]' };
      },
    },
  });
  try {
    registerApiRoutes(app, ctx);
    const translated = await app.routes.get("POST /api/translate")(jsonContext({
      texts: ["Water stress reduces yield."],
      glossaryTerms: { "water stress": "水分胁迫", yield: "产量", ignored: "" },
    }));
    assert.equal(translated.status, 200);
    assert.deepEqual(translated.value.translations, ["水分胁迫降低产量。"]);
    const prompt = sampledPayload.messages[0].content;
    assert.match(prompt, /术语表/);
    assert.match(prompt, /water stress/);
    assert.match(prompt, /水分胁迫/);
    assert.match(prompt, /yield/);
    assert.doesNotMatch(prompt, /ignored/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
