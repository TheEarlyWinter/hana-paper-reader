import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMineruSettingsStore } from "../server/domain/mineru-settings.js";
import registerApiRoutes from "../server/http/api-routes.js";

function makeApp() {
  const routes = new Map();
  const add = (method) => (route, handler) => routes.set(`${method} ${route}`, handler);
  return { routes, get: add("GET"), post: add("POST"), delete: add("DELETE") };
}

function requestContext({ body = {}, authorized = true } = {}) {
  return {
    get(key) {
      if (key !== "appRequestContext") return undefined;
      return authorized ? { principal: { id: "workspace-settings-test" } } : undefined;
    },
    req: {
      async json() { return body; },
      query() { return ""; },
      param() { return ""; },
      header() { return ""; },
    },
    json(value, status = 200) { return { value, status }; },
  };
}

test("MinerU settings are owned by the paper workspace and keep the token out of the JSON file", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-workspace-settings-"));
  try {
    const syntheticToken = "synthetic-token-123456";
    const settings = createMineruSettingsStore(dataDir, {
      protect: async (value) => value ? "protected-value" : "",
      unprotect: async (value) => value === "protected-value" ? syntheticToken : value,
    });
    const app = makeApp();
    registerApiRoutes(app, { dataDir, settings, network: { fetch: async () => { throw new Error("network must not run"); } } });

    const initial = await app.routes.get("GET /api/mineru-settings")(requestContext());
    assert.equal(initial.status, 200);
    assert.equal(initial.value.configured, false);
    assert.equal(initial.value.token, undefined);

    const saved = await app.routes.get("POST /api/mineru-settings")(requestContext({
      body: {
        token: syntheticToken,
        apiBaseUrl: "https://mineru.net/api/v4",
        modelVersion: "pipeline",
        language: "en",
        ocr: true,
        timeoutSeconds: 120,
        pollIntervalSeconds: 3,
      },
    }));
    assert.equal(saved.status, 200);
    assert.equal(saved.value.configured, true);
    assert.equal(saved.value.apiBaseUrl, "https://mineru.net/api/v4");
    assert.equal(saved.value.modelVersion, "pipeline");
    assert.equal(saved.value.language, "en");
    assert.equal(saved.value.ocr, true);
    assert.equal(saved.value.timeoutSeconds, 120);
    assert.equal(saved.value.pollIntervalSeconds, 3);

    const rejected = await app.routes.get("POST /api/mineru-settings")(requestContext({ body: { apiBaseUrl: "https://evil.example/api" } }));
    assert.equal(rejected.status, 400);

    const raw = fs.readFileSync(path.join(dataDir, "mineru-settings.json"), "utf8");
    assert.equal(raw.includes("synthetic-token-123456"), false);
    assert.equal(await settings.get("mineruApiToken"), syntheticToken);

    const cleared = await app.routes.get("POST /api/mineru-settings")(requestContext({ body: { clearToken: true } }));
    assert.equal(cleared.status, 200);
    assert.equal(cleared.value.configured, false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
