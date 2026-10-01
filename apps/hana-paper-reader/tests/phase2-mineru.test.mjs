import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPaperWorkspace } from "../server/domain/paper-workspace.js";
import registerApiRoutes from "../server/http/api-routes.js";

function makeApp() {
  const routes = new Map();
  const add = (method) => (route, handler) => routes.set(`${method} ${route}`, handler);
  return { routes, get: add("GET"), post: add("POST"), delete: add("DELETE") };
}

function requestContext({ authorized = true, query = {}, body = {}, bytes = Buffer.alloc(0), contentType = "application/pdf", headers = {} } = {}) {
  return {
    get(key) {
      if (key !== "appRequestContext") return undefined;
      return authorized ? { principal: { id: "phase2-mineru-test" } } : undefined;
    },
    req: {
      query(name) { return query[name]; },
      param() { return ""; },
      header(name) { return headers[name.toLowerCase()] || (name.toLowerCase() === "content-type" ? contentType : ""); },
      async json() { return body; },
      async arrayBuffer() { return bytes; },
    },
    json(value, status = 200) { return { value, status }; },
    body(value, status = 200, responseHeaders = {}) { return { value, status, headers: responseHeaders }; },
  };
}

function makeConfig(overrides = {}) {
  const values = {
    mineruApiToken: "synthetic-token-123456",
    mineruApiBaseUrl: "https://mineru.net/api/v4",
    mineruModelVersion: "vlm",
    mineruLanguage: "en",
    mineruEnableFormula: true,
    mineruEnableTable: true,
    mineruOcr: false,
    mineruTimeoutSeconds: 60,
    mineruPollIntervalSeconds: 2,
    ...overrides,
  };
  return {
    values,
    async get(key) { return values[key]; },
    async setMany(patch) { Object.assign(values, patch); },
  };
}

function zipStored(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralOffset = offset;
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(value); },
    async arrayBuffer() { return Buffer.from(JSON.stringify(value)); },
  };
}

for (const change of ["recreated", "metadata", "created-during-parse"]) {
  test(`a delayed MinerU result cannot overwrite a paper ${change}`, async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-mineru-late-"));
    const pdf = Buffer.from("%PDF-1.7\nowned delayed fixture");
    const paperHash = createHash("sha256").update(pdf).digest("hex");
    const zip = zipStored([["content_list_v2.json", JSON.stringify([{ type: "text", page_idx: 0, text: "Delayed parsed evidence" }])]]);
    let before;
    try {
      const workspace = createPaperWorkspace({ dataDir });
      if (change !== "created-during-parse") await workspace.upsertPaper({ paperHash,
        metadata: { title: "Original fixture" }, blocks: [{ id: "b1", page: 1, text: "Original evidence" }] });
      const app = makeApp();
      registerApiRoutes(app, { dataDir, config: makeConfig(), network: { fetch: async (url, init = {}) => {
        if (init.method === "POST") {
          if (change === "recreated") await workspace.removePaper(paperHash);
          if (change === "metadata") await workspace.updatePaperMetadata(paperHash, { title: "New owner content" });
          else await workspace.upsertPaper({ paperHash, metadata: { title: "New owner content" }, blocks: [{ id: "new", page: 1, text: "New owner evidence" }] });
          before = fs.readFileSync(path.join(dataDir, "paper-workspace.json"));
          return jsonResponse({ code: 0, data: { batch_id: "owned-batch", file_urls: ["https://mineru.net/upload/fixture"] } });
        }
        if (init.method === "PUT") return { ok: true, status: 200 };
        if (url.includes("extract-results")) return jsonResponse({ code: 0, data: { extract_result: [{ state: "done", full_zip_url: "https://mineru.oss-cn-shanghai.aliyuncs.com/result.zip" }] } });
        return { ok: true, status: 200, async arrayBuffer() { return zip; } };
      } } });
      const response = await app.routes.get("POST /api/parse-pdf")(requestContext({ bytes: pdf, query: { force: "1" } }));
      assert.equal(response.status, 409, JSON.stringify(response.value));
      assert.deepEqual(fs.readFileSync(path.join(dataDir, "paper-workspace.json")), before);
      const current = createPaperWorkspace({ dataDir }).getPaper(paperHash);
      assert.equal(current.metadata.title, "New owner content");
      assert.ok(!current.blocks.some(block => block.text === "Delayed parsed evidence"));
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  });
}

test("MinerU rejects stale or malformed import ownership before contacting the service", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-mineru-owner-"));
  const pdf = Buffer.from("%PDF-1.7\nowned generation fixture");
  const paperHash = createHash("sha256").update(pdf).digest("hex");
  let calls = 0;
  try {
    const paper = await createPaperWorkspace({ dataDir }).upsertPaper({ paperHash, blocks: [{ id: "b1", text: "Cached evidence" }] });
    const app = makeApp();
    registerApiRoutes(app, { dataDir, config: makeConfig(), network: { fetch: async () => { calls++; throw new Error("No external call expected"); } } });
    for (const value of ["-1", "1.5", "null", " 1", "9007199254740992", String(paper.generation + 1)]) {
      const response = await app.routes.get("POST /api/parse-pdf")(requestContext({ bytes: pdf, headers: { "x-hana-paper-generation": value } }));
      assert.equal(response.status, value === String(paper.generation + 1) ? 409 : 400);
    }
    const hit = await app.routes.get("POST /api/parse-pdf")(requestContext({ bytes: pdf, headers: { "x-hana-paper-generation": String(paper.generation) } }));
    assert.equal(hit.status, 200);
    assert.equal(hit.value.generation, paper.generation);
    assert.equal(hit.value.revision, paper.revision);
    assert.equal(calls, 0);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

for (const cancel of [false, true]) {
  test(`initial PDF tasks and delayed parse ownership ${cancel ? "stop after cancellation" : "complete together"}`, async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-mineru-task-owner-"));
    const pdf = Buffer.from("%PDF-1.7\nowned first task fixture");
    const paperHash = createHash("sha256").update(pdf).digest("hex");
    const zip = zipStored([["content_list_v2.json", JSON.stringify([{ type: "text", page_idx: 0, text: "Initial parsed evidence" }])]]);
    const controller = new AbortController();
    try {
      const app = makeApp();
      registerApiRoutes(app, { dataDir, config: makeConfig(), network: { fetch: async (url, init = {}) => {
        if (init.method === "POST") return jsonResponse({ code: 0, data: { batch_id: "owned-initial-batch", file_urls: ["https://mineru.net/upload/fixture"] } });
        if (init.method === "PUT") return { ok: true, status: 200 };
        if (url.includes("extract-results")) return jsonResponse({ code: 0, data: { extract_result: [{ state: "done", full_zip_url: "https://mineru.oss-cn-shanghai.aliyuncs.com/result.zip" }] } });
        return { ok: true, status: 200, async arrayBuffer() { if (cancel) controller.abort(); return zip; } };
      } } });
      const created = await app.routes.get("POST /api/research/parse-status/tasks")(requestContext({ body: {
        paperHash, fileName: "First owned PDF.pdf", createPaperIfAbsent: true, expectedRevision: 0 } }));
      assert.equal(created.status, 200);
      const task = created.value.task;
      const running = await app.routes.get("POST /api/research/parse-status/tasks/:taskId")(requestContext({
        query: { taskId: task.id }, body: { state: "running", expectedGeneration: task.paperGeneration } }));
      assert.equal(running.status, 200);
      const before = fs.readFileSync(path.join(dataDir, "paper-workspace.json"));
      const ctx = requestContext({ bytes: pdf, headers: { "x-hana-paper-generation": String(task.paperGeneration) } });
      ctx.req.raw = { signal: controller.signal };
      const parsed = await app.routes.get("POST /api/parse-pdf")(ctx);
      if (cancel) {
        assert.equal(parsed.status, 499, JSON.stringify(parsed.value));
        assert.deepEqual(fs.readFileSync(path.join(dataDir, "paper-workspace.json")), before);
        assert.equal(createPaperWorkspace({ dataDir }).getPaper(paperHash).blocks.length, 0);
      } else {
        assert.equal(parsed.status, 200, JSON.stringify(parsed.value));
        assert.equal(parsed.value.generation, task.paperGeneration);
        const completed = await app.routes.get("POST /api/research/parse-status/tasks/:taskId")(requestContext({
          query: { taskId: task.id }, body: { state: "succeeded", expectedGeneration: task.paperGeneration } }));
        assert.equal(completed.status, 200);
        const next = createPaperWorkspace({ dataDir });
        assert.equal(next.getTask(task.id).state, "succeeded");
        assert.equal(next.getPaper(paperHash).blocks[0].text, "Initial parsed evidence");
      }
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  });
}

test("MinerU settings are redacted and PDF route rejects invalid input before network", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-mineru-settings-"));
  let networkCalls = 0;
  try {
    const config = makeConfig();
    const app = makeApp();
    registerApiRoutes(app, { dataDir, config, network: { fetch: async () => { networkCalls += 1; throw new Error("network must not run"); } } });

    const denied = await app.routes.get("GET /api/mineru-settings")(requestContext({ authorized: false }));
    assert.equal(denied.status, 403);

    const settings = await app.routes.get("GET /api/mineru-settings")(requestContext());
    assert.equal(settings.status, 200);
    assert.equal(settings.value.configured, true);
    assert.equal(settings.value.token, undefined);
    assert.equal(settings.value.language, "en");

    const updated = await app.routes.get("POST /api/mineru-settings")(requestContext({ body: { modelVersion: "pipeline", timeoutSeconds: 120 } }));
    assert.equal(updated.status, 200);
    assert.equal(updated.value.modelVersion, "pipeline");
    assert.equal(updated.value.timeoutSeconds, 120);

    const invalid = await app.routes.get("POST /api/parse-pdf")(requestContext({ bytes: Buffer.from("not-a-pdf") }));
    assert.equal(invalid.status, 400);
    assert.equal(networkCalls, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("MinerU adapter enforces the upload-poll-download flow and ZIP path safety", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-mineru-flow-"));
  const pdf = Buffer.from("%PDF-1.7\\nnetwork fixture");
  const zip = zipStored([
    ["content_list_v2.json", JSON.stringify([
      { type: "text", page_idx: 0, text: "parsed evidence" },
      { type: "image", page_idx: 0, img_path: "images/figure.png", image_caption: "Figure" },
    ])],
    ["images/figure.png", Buffer.from([1, 2, 3])],
    ["../escape.png", Buffer.from([9])],
  ]);
  const calls = [];
  try {
    const app = makeApp();
    registerApiRoutes(app, {
      dataDir,
      config: makeConfig(),
      network: { fetch: async (url, init = {}) => {
        calls.push({ url, method: init.method || "GET" });
        if (init.method === "POST") return jsonResponse({ code: 0, data: { batch_id: "batch-1", file_urls: ["https://mineru.net/upload/fixture"] } });
        if (init.method === "PUT") return { ok: true, status: 200 };
        if (url.includes("extract-results")) return jsonResponse({ code: 0, data: { extract_result: [{ data_id: "fixture", state: "done", full_zip_url: "https://mineru.oss-cn-shanghai.aliyuncs.com/result.zip" }] } });
        return {
          ok: true,
          status: 200,
          async text() { return ""; },
          async arrayBuffer() { return zip; },
        };
      } },
    });
    const response = await app.routes.get("POST /api/parse-pdf")(requestContext({ bytes: pdf, query: { fileName: "fixture.pdf" } }));
    assert.equal(response.status, 200);
    assert.equal(response.value.cached, false);
    assert.equal(response.value.blockCount, 2);
    assert.deepEqual(calls.map((call) => call.method), ["POST", "PUT", "GET", "GET"]);
    assert.ok(calls.every((call) => new URL(call.url).hostname.endsWith("mineru.net") || new URL(call.url).hostname.endsWith("mineru.oss-cn-shanghai.aliyuncs.com")));
    const cacheId = createHash("sha256").update(zip).digest("hex").slice(0, 24);
    assert.equal(fs.existsSync(path.join(dataDir, "mineru-cache", cacheId, "images", "figure.png")), true);
    assert.equal(fs.existsSync(path.join(dataDir, "escape.png")), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("MinerU adapter rejects an unallowlisted signed upload URL before PUT", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-mineru-allowlist-"));
  const calls = [];
  try {
    const app = makeApp();
    registerApiRoutes(app, {
      dataDir,
      config: makeConfig(),
      network: { fetch: async (url, init = {}) => {
        calls.push({ url, method: init.method || "GET" });
        return jsonResponse({ code: 0, data: { batch_id: "batch-evil", file_urls: ["https://evil.example/upload"] } });
      } },
    });
    const response = await app.routes.get("POST /api/parse-pdf")(requestContext({ bytes: Buffer.from("%PDF-1.7\\ninvalid remote") }));
    assert.equal(response.status, 502);
    assert.deepEqual(calls.map((call) => call.method), ["POST"]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("MinerU parse route returns a verified cache hit without recontacting the network", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-mineru-cache-"));
  const bytes = Buffer.from("%PDF-1.7\nsynthetic fixture");
  const paperHash = createHash("sha256").update(bytes).digest("hex");
  let networkCalls = 0;
  try {
    const workspace = createPaperWorkspace({ dataDir });
    await workspace.upsertPaper({
      paperHash,
      metadata: { title: "cached.pdf" },
      parser: { kind: "mineru", modelVersion: "vlm", pageCount: 1 },
      blocks: [{ id: "b1", page: 1, type: "paragraph", text: "cached" }],
    });
    await workspace.close();

    const app = makeApp();
    registerApiRoutes(app, {
      dataDir,
      config: makeConfig(),
      network: { fetch: async () => { networkCalls += 1; throw new Error("network must not run on cache hit"); } },
    });
    const response = await app.routes.get("POST /api/parse-pdf")(requestContext({ bytes, query: { fileName: "cached.pdf" } }));
    assert.equal(response.status, 200);
    assert.equal(response.value.cached, true);
    assert.equal(response.value.paperHash, paperHash);
    assert.equal(response.value.blocks[0].text, "cached");
    assert.equal(networkCalls, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
