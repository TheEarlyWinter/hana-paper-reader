import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createQaLogger } from "../lib/qa-log.js";
import registerApiRoutes from "../routes/api.js";

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
  };
}

function requestContext(body = {}, query = {}) {
  return {
    req: {
      json: async () => body,
      query: (key) => query[key] ?? "",
    },
    json(value, status = 200) { return { value, status }; },
  };
}

test("QA logger writes bounded structured JSONL and redacts secrets", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-qa-log-"));
  try {
    const logger = createQaLogger({ dataDir: tempDir, maxBytes: 600 });
    logger.write("error", "mineru.request", {
      token: "Bearer secret-token-1234567890",
      authorization: "Bearer another-secret",
      nested: { apiToken: "sk-secret-value", message: "request failed" },
    });
    logger.write("info", "paper.open", { paperHash: "a".repeat(64), status: 200 });

    const lines = logger.read({ limit: 20 });
    assert.ok(lines.length >= 1);
    assert.ok(lines.every((entry) => entry.timestamp && entry.level && entry.event));
    const serialized = JSON.stringify(lines);
    assert.doesNotMatch(serialized, /secret-token|another-secret|sk-secret-value/);
    assert.match(serialized, /<REDACTED>/);
    assert.ok(fs.statSync(logger.filePath).size <= 600);

    const tiny = createQaLogger({ dataDir: tempDir, maxBytes: 256 });
    tiny.write("error", "oversized.details", { message: "测".repeat(10000) });
    assert.ok(fs.statSync(tiny.filePath).size <= 256);
    assert.equal(tiny.read({ limit: 1 })[0].event, "oversized.details");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("diagnostic log API accepts client events and returns recent entries without credentials", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-qa-route-"));
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
    const post = app.routes.get("POST /api/diagnostics/log");
    const get = app.routes.get("GET /api/diagnostics/log");
    assert.equal(typeof post, "function");
    assert.equal(typeof get, "function");

    const saved = await post(requestContext({
      level: "error",
      event: "ui.open-paper",
      details: { message: "打开失败", token: "Bearer hidden-token" },
    }));
    assert.equal(saved.status, 200);
    assert.equal(saved.value.ok, true);

    const result = await get(requestContext({}, { limit: "10" }));
    assert.equal(result.status, 200);
    assert.equal(result.value.ok, true);
    assert.equal(result.value.entries.length, 1);
    assert.equal(result.value.entries[0].event, "ui.open-paper");
    assert.doesNotMatch(JSON.stringify(result.value), /hidden-token/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
