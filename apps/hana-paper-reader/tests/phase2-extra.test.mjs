import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import registerApiRoutes from "../server/http/api-routes.js";
import { generatePaperMarkdown } from "../server/domain/paper-export.js";

function makeApp() {
  const routes = new Map();
  const add = (method) => (route, handler) => routes.set(`${method} ${route}`, handler);
  return { routes, get: add("GET"), post: add("POST"), delete: add("DELETE") };
}

function requestContext({ authorized = true, query = {}, params = {}, body = {}, bodyError = false } = {}) {
  return {
    get(key) {
      if (key !== "appRequestContext") return undefined;
      return authorized ? { principal: { id: "phase2-extra-test" } } : undefined;
    },
    req: {
      query(name) { return query[name]; },
      param(name) { return params[name]; },
      async json() { if (bodyError) throw new Error("empty body"); return body; },
    },
    json(value, status = 200) { return { value, status }; },
  };
}

const PAPER_HASH = "2".repeat(64);

test("paper Markdown export preserves evidence anchors, translations and notes", () => {
  const markdown = generatePaperMarkdown({
    metadata: { title: "Export fixture", authors: ["A"], year: 2026 },
    blocks: [
      { id: "h1", page: 2, type: "heading", text: "1. Results", level: 1 },
      { id: "b1", page: 2, type: "paragraph", text: "Original result" },
      { id: "fig1", page: 3, type: "image", text: "Figure 1", assetPath: "figures/one.png" },
    ],
    translations: { b1: "结果译文" },
    translationStates: { b1: { kind: "final" } },
    notes: [{ id: "n1", blockId: "b1", title: "Finding", text: "A bounded note" }],
    bookmarks: [{ id: "m1", blockId: "b1", label: "Important" }],
    progress: { page: 2, totalPages: 3, percent: 66 },
    glossary: { result: "结果" },
    assets: [{ blockId: "fig1", path: "figures/one.png" }],
  });

  assert.match(markdown, /^# Export fixture/m);
  assert.match(markdown, /paper-p2-b-h1/);
  assert.match(markdown, /\*\*用户定稿：\*\* 结果译文/);
  assert.match(markdown, /!\[Figure 1\]\(attachments\/figures\/one\.png\)/);
  assert.match(markdown, /## 研究笔记/);
  assert.match(markdown, /## 术语表/);
});

test("research extra routes export and backup only inside App data", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-extra-"));
  try {
    const app = makeApp();
    registerApiRoutes(app, { dataDir });
    const created = await app.routes.get("POST /api/research/paper")(requestContext({ body: {
      paperHash: PAPER_HASH,
      metadata: { title: "Extra route fixture" },
      blocks: [{ id: "b1", page: 1, type: "paragraph", text: "Evidence text" }],
    } }));
    assert.equal(created.status, 200);

    const snapshot = app.routes.get("GET /api/research/snapshot")(requestContext({ query: { paperHash: PAPER_HASH } }));
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.value.snapshot.paper.metadata.title, "Extra route fixture");

    const storage = app.routes.get("GET /api/research/storage")(requestContext({ query: { paperHash: PAPER_HASH } }));
    assert.equal(storage.status, 200);
    assert.equal(storage.value.storage.counts.blocks, 1);

    const exported = await app.routes.get("GET /api/research/export")(requestContext({ query: { paperHash: PAPER_HASH } }));
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-disposition"), /attachment/);
    assert.match(await exported.text(), /Extra route fixture/);

    const backup = await app.routes.get("GET /api/research/backup")(requestContext({ query: { paperHash: PAPER_HASH, includeAssets: "false" } }));
    assert.equal(backup.status, 200);
    const backupPayload = JSON.parse(await backup.text());
    assert.equal(backupPayload.paperHash, PAPER_HASH);

    const concurrentUpdate = await app.routes.get("POST /api/research/paper")(requestContext({ body: {
      paperHash: PAPER_HASH,
      expectedRevision: created.value.paper.revision,
      metadata: { title: "Updated after backup" },
      blocks: [{ id: "b1", page: 1, type: "paragraph", text: "Newer evidence" }],
    } }));
    assert.equal(concurrentUpdate.status, 200);
    const staleRestore = await app.routes.get("POST /api/research/restore")(requestContext({ body: backupPayload }));
    assert.equal(staleRestore.status, 409);
    assert.equal(staleRestore.value.error.code, "paper_conflict");
    const afterRestoreConflict = app.routes.get("GET /api/research/paper")(requestContext({ query: { paperHash: PAPER_HASH } }));
    assert.equal(afterRestoreConflict.value.paper.metadata.title, "Updated after backup");

    const staleDelete = await app.routes.get("DELETE /api/research/paper")(requestContext({ bodyError: true, query: {
      paperHash: PAPER_HASH,
      expectedRevision: created.value.paper.revision,
    } }));
    assert.equal(staleDelete.status, 409);
    assert.equal(staleDelete.value.error.code, "paper_conflict");
    const staleCleanup = await app.routes.get("POST /api/research/cleanup")(requestContext({ body: {
      paperHash: PAPER_HASH,
      action: "ai-translations",
      expectedRevision: created.value.paper.revision,
    } }));
    assert.equal(staleCleanup.status, 409);
    assert.equal(staleCleanup.value.error.code, "paper_conflict");

    const saved = await app.routes.get("POST /api/research/export")(requestContext({ body: { paperHash: PAPER_HASH, saveToDisk: true } }));
    assert.equal(saved.status, 200);
    assert.equal(saved.value.saved, true);
    assert.equal(path.dirname(saved.value.filePath), path.join(dataDir, "exports"));
    assert.equal(fs.existsSync(saved.value.filePath), true);

    const session = await app.routes.get("GET /api/session-targets")(requestContext());
    assert.equal(session.status, 503);
    assert.equal(session.value.error.code, "session_delivery_not_enabled");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("extra routes map storage failures to safe 503 errors", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-extra-storage-"));
  try {
    const app = makeApp();
    registerApiRoutes(app, {
      dataDir,
      workspace: {
        exportBackup() { throw Object.assign(new Error("C:\\secret\\workspace"), { code: "EACCES" }); },
      },
    });
    const response = app.routes.get("GET /api/research/backup")(requestContext({ query: { paperHash: PAPER_HASH } }));
    assert.equal(response.status, 503);
    assert.equal(response.value.error.code, "workspace_storage_unavailable");
    assert.equal(response.value.error.message.includes("secret"), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("export and extra routes require App authorization", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-extra-auth-"));
  try {
    const app = makeApp();
    registerApiRoutes(app, { dataDir });
    const response = app.routes.get("GET /api/research/export")(requestContext({ authorized: false, query: { paperHash: PAPER_HASH } }));
    assert.equal(response.status, 403);
    assert.equal(response.value.error.code, "app_request_context_required");

    const evidence = await app.routes.get("POST /api/research/evidence")(requestContext({ authorized: false }));
    assert.equal(evidence.status, 403);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
