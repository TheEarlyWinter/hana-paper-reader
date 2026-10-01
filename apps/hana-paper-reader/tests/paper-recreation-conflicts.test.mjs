import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import registerApiRoutes from "../server/http/api-routes.js";
import { createPaperWorkspace } from "../server/domain/paper-workspace.js";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
async function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-storage-crash-recreation-"));
  const workspace = createPaperWorkspace({ dataDir });
  const old = await workspace.upsertPaper({ paperHash: HASH, metadata: { title: "Old synthetic paper" },
    blocks: [{ id: "b1", page: 1, type: "paragraph", text: "Synthetic evidence" }] });
  const backup = workspace.exportBackup(HASH);
  const index = path.join(dataDir, "paper-workspace.json");
  return { dataDir, index, workspace, old, backup, close() {
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("hpr-storage-crash-recreation-"));
    fs.rmSync(dataDir, { recursive: true, force: true });
  } };
}
function routesFor(dataDir) {
  const routes = new Map();
  const app = {};
  for (const method of ["get", "post", "delete"]) app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  registerApiRoutes(app, { dataDir });
  return routes;
}
function context(body) {
  const query = { paperHash: HASH, query: "Synthetic", blockId: "b1" };
  return { get: () => ({ principal: { id: "owned-recreation-test" } }),
    req: { query: key => query[key] || "", json: async () => body },
    json: (value, status = 200) => ({ value, status }) };
}
async function recreate(f) {
  await f.workspace.removePaper(HASH, { expectedRevision: f.old.revision });
  return createPaperWorkspace({ dataDir: f.dataDir }).upsertPaper({ paperHash: HASH, expectedRevision: 0,
    metadata: { title: "New synthetic paper" }, blocks: f.old.blocks });
}

for (const [route, payload] of [
  ["POST /api/research/paper", f => ({ ...f.old, expectedRevision: f.old.revision })],
  ["POST /api/research/library/metadata", f => ({ paperHash: HASH, title: "Stale title", expectedRevision: f.old.revision })],
  ["POST /api/research/cleanup", f => ({ paperHash: HASH, action: "structure-keep-notes", expectedRevision: f.old.revision })],
  ["DELETE /api/research/paper", f => ({ paperHash: HASH, expectedRevision: f.old.revision })],
  ["POST /api/research/restore", f => ({ ...f.backup, expectedRevision: f.old.revision })],
]) {
  test(`a deleted and recreated paper rejects an old-window request: ${route}`, async () => {
    const f = await fixture();
    try {
      await recreate(f);
      const before = fs.readFileSync(f.index);
      const response = await routesFor(f.dataDir).get(route)(context(payload(f)));
      assert.equal(response.status, 409, JSON.stringify(response.value));
      assert.equal(response.value.error.code, "paper_conflict");
      assert.deepEqual(fs.readFileSync(f.index), before);
      assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getPaper(HASH).metadata.title, "New synthetic paper");
    } finally { f.close(); }
  });
}

test("revision history survives deletion, workspace restart, restore and repeated recreation", async () => {
  const f = await fixture();
  try {
    const recreated = await recreate(f);
    assert.ok(recreated.revision > f.old.revision);
    const next = createPaperWorkspace({ dataDir: f.dataDir });
    const restored = await next.restoreBackup({ ...f.backup, expectedRevision: recreated.revision });
    assert.ok(restored.revision > recreated.revision);
    await next.removePaper(HASH);
    const afterDelete = JSON.parse(fs.readFileSync(f.index, "utf8"));
    assert.deepEqual(afterDelete.papers, {});
    assert.ok(!JSON.stringify(afterDelete).includes("synthetic paper"), "Deleted research text must not be retained in the index");
    const final = await createPaperWorkspace({ dataDir: f.dataDir }).upsertPaper({ paperHash: HASH, blocks: [] });
    assert.ok(final.revision > restored.revision);
  } finally { f.close(); }
});

test("a different process cannot reset a deleted paper's revision", async () => {
  const f = await fixture();
  try {
    await f.workspace.updatePaperMetadata(HASH, { title: "Second synthetic revision" });
    const previous = f.workspace.getPaper(HASH).revision;
    await f.workspace.removePaper(HASH);
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      'const {createPaperWorkspace}=await import(process.argv[1]); const paper=await createPaperWorkspace({dataDir:process.argv[2]}).upsertPaper({paperHash:process.argv[3],expectedRevision:0,blocks:[]}); process.stdout.write(JSON.stringify({revision:paper.revision}));',
      new URL("../server/domain/paper-workspace.js", import.meta.url).href, f.dataDir, HASH],
    { encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    assert.ok(JSON.parse(child.stdout).revision > previous);
  } finally { f.close(); }
});

test("legacy split and single-file workspaces seed the clock from their existing paper revision", async () => {
  for (const layout of ["split", "single"]) {
    const f = await fixture();
    try {
      const revision = 37;
      if (layout === "split") {
        const index = JSON.parse(fs.readFileSync(f.index, "utf8"));
        delete index.revisionClocks;
        fs.writeFileSync(f.index, JSON.stringify(index));
        const file = path.join(f.dataDir, "papers", HASH, "paper.json");
        const paper = JSON.parse(fs.readFileSync(file, "utf8"));
        paper.revision = revision;
        fs.writeFileSync(file, JSON.stringify(paper));
      } else {
        const legacy = f.workspace.load();
        delete legacy.revisionClocks;
        legacy.papers[HASH].revision = revision;
        fs.writeFileSync(f.index, JSON.stringify(legacy));
      }
      const workspace = createPaperWorkspace({ dataDir: f.dataDir });
      await workspace.removePaper(HASH, { expectedRevision: revision });
      const created = await createPaperWorkspace({ dataDir: f.dataDir }).upsertPaper({ paperHash: HASH, blocks: [] });
      assert.equal(created.revision, revision + 1);
    } finally { f.close(); }
  }
});

test("invalid revision history blocks public reads and writes without modifying storage", async () => {
  for (const clocks of [null, [], { [HASH]: "1" }, { [HASH]: -1 }, { [HASH]: 1.5 },
    { [HASH]: Number.MAX_SAFE_INTEGER + 1 }, { [HASH]: 2 }, { [HASH]: 1, [HASH.toUpperCase()]: 1 }, { "../private": 1 }]) {
    const f = await fixture();
    try {
      const index = JSON.parse(fs.readFileSync(f.index, "utf8"));
      index.revisionClocks = clocks;
      fs.writeFileSync(f.index, JSON.stringify(index));
      const before = fs.readFileSync(f.index);
      const routes = routesFor(f.dataDir);
      for (const route of ["GET /api/research/paper", "GET /api/research/recent", "GET /api/research/library",
        "GET /api/research/parse-cache/check", "GET /api/research/search", "GET /api/research/evidence", "GET /api/research/outline", "POST /api/research/paper"]) {
        const response = await routes.get(route)(context({ paperHash: HASH, blocks: [] }));
        assert.equal(response.status, 503, JSON.stringify(response.value));
        assert.equal(response.value.error.code, "workspace_integrity_error");
        assert.ok(!JSON.stringify(response.value).includes(f.dataDir));
        assert.deepEqual(fs.readFileSync(f.index), before);
      }
    } finally { f.close(); }
  }
});

test("an exhausted revision cannot wrap, overwrite or recreate a paper", async () => {
  const f = await fixture();
  try {
    const index = JSON.parse(fs.readFileSync(f.index, "utf8"));
    index.revisionClocks[HASH] = Number.MAX_SAFE_INTEGER;
    const file = path.join(f.dataDir, "papers", HASH, "paper.json");
    const paper = JSON.parse(fs.readFileSync(file, "utf8"));
    paper.revision = Number.MAX_SAFE_INTEGER;
    fs.writeFileSync(file, JSON.stringify(paper));
    fs.writeFileSync(f.index, JSON.stringify(index));
    const before = fs.readFileSync(f.index);
    for (const route of ["POST /api/research/paper", "POST /api/research/library/metadata", "POST /api/research/cleanup"]) {
      const response = await routesFor(f.dataDir).get(route)(context({ paperHash: HASH, title: "Overflow",
        action: "assets", expectedRevision: Number.MAX_SAFE_INTEGER }));
      assert.equal(response.status, 409, JSON.stringify(response.value));
      assert.equal(response.value.error.code, "paper_revision_exhausted");
      assert.deepEqual(fs.readFileSync(f.index), before);
    }
    await createPaperWorkspace({ dataDir: f.dataDir }).removePaper(HASH);
    const deleted = fs.readFileSync(f.index);
    await assert.rejects(createPaperWorkspace({ dataDir: f.dataDir }).upsertPaper({ paperHash: HASH }),
      error => error.code === "paper_revision_exhausted");
    assert.deepEqual(fs.readFileSync(f.index), deleted);
  } finally { f.close(); }
});

test("a failed index commit restores revision history and does not consume a revision", async () => {
  const f = await fixture();
  const rename = fs.renameSync;
  try {
    const before = fs.readFileSync(f.index);
    let injected = false;
    fs.renameSync = (source, destination) => {
      if (!injected && path.resolve(String(destination)) === f.index) {
        injected = true;
        throw Object.assign(new Error("Owned index failure"), { code: "EIO" });
      }
      return rename(source, destination);
    };
    await assert.rejects(f.workspace.upsertPaper({ ...f.old, expectedRevision: f.old.revision }));
    assert.equal(injected, true);
    assert.deepEqual(fs.readFileSync(f.index), before);
    fs.renameSync = rename;
    const saved = await createPaperWorkspace({ dataDir: f.dataDir }).upsertPaper({ ...f.old, expectedRevision: f.old.revision });
    assert.equal(saved.revision, f.old.revision + 1);
  } finally { fs.renameSync = rename; f.close(); }
});

test("one paper's recreation preserves another paper's revision and shard bytes", async () => {
  const f = await fixture();
  try {
    const other = await f.workspace.upsertPaper({ paperHash: OTHER, blocks: [], metadata: { title: "Unchanged" } });
    const files = ["paper.json", "research.json", "translations.json", "tasks.json"];
    const bytes = files.map(file => fs.readFileSync(path.join(f.dataDir, "papers", OTHER, file)));
    await recreate(f);
    files.forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(f.dataDir, "papers", OTHER, file)), bytes[i]));
    assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getPaper(OTHER).revision, other.revision);
  } finally { f.close(); }
});

for (const checkpoint of ["prepared", "paper", "index", "committed"]) {
  test(`interrupted restore keeps revision history consistent at ${checkpoint}`, async () => {
    const f = await fixture();
    try {
      const recreated = await recreate(f);
      const worker = fileURLToPath(new URL("./fixtures/storage-crash-worker.mjs", import.meta.url));
      const child = spawnSync(process.execPath, [worker, f.dataDir, HASH, checkpoint],
        { encoding: "utf8", timeout: 10000, windowsHide: true });
      assert.equal(child.status, 71, child.stderr);
      const next = createPaperWorkspace({ dataDir: f.dataDir });
      const recovered = next.getPaper(HASH);
      assert.equal(recovered.revision, recreated.revision + (checkpoint === "committed" ? 1 : 0));
      const index = JSON.parse(fs.readFileSync(f.index, "utf8"));
      assert.equal(index.revisionClocks[HASH], recovered.revision);
      await next.removePaper(HASH);
      const final = await createPaperWorkspace({ dataDir: f.dataDir }).upsertPaper({ paperHash: HASH, blocks: [] });
      assert.ok(final.revision > recovered.revision);
    } finally { f.close(); }
  });
}
