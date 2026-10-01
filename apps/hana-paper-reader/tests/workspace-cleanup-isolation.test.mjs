import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPaperWorkspace } from "../server/domain/paper-workspace.js";
import { createPaperStorage } from "../server/domain/paper-storage.js";
import registerApiRoutes from "../server/http/api-routes.js";
import { paperDeletionRevision } from "../ui/assets/paper-deletion-result.js";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
const CACHE = "c".repeat(24);
const OTHER_CACHE = "d".repeat(24);
const shardNames = ["paper.json", "research.json", "translations.json", "tasks.json"];
const worker = fileURLToPath(new URL("./fixtures/storage-cleanup-worker.mjs", import.meta.url));
async function fixture(shared = false) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-cleanup-isolation-"));
  const workspace = createPaperWorkspace({ dataDir });
  for (const paperHash of [HASH, OTHER]) await workspace.upsertPaper({ paperHash,
    metadata: { title: `Synthetic ${paperHash[0]}` }, blocks: [
      { id: "b1", page: 1, type: "paragraph", text: "Synthetic evidence" },
      { id: "img", page: 1, type: "image", text: "Synthetic image",
        assetRef: { cacheId: paperHash === HASH || shared ? CACHE : OTHER_CACHE, path: "one.png" } },
    ] });
  for (const cacheId of [CACHE, OTHER_CACHE]) {
    const directory = path.join(dataDir, "mineru-cache", cacheId);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "one.png"), "owned synthetic asset");
  }
  return { dataDir, workspace, index: path.join(dataDir, "paper-workspace.json"),
    cache: path.join(dataDir, "mineru-cache", CACHE), close() {
      assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(dataDir).startsWith("hpr-cleanup-isolation-"));
      fs.rmSync(dataDir, { recursive: true, force: true });
    } };
}
function protectOther(f) {
  const index = JSON.parse(fs.readFileSync(f.index, "utf8"));
  index.papers[OTHER].fixtureMarker = "untouched index entry";
  fs.writeFileSync(f.index, JSON.stringify(index));
  const files = shardNames.map(name => path.join(f.dataDir, "papers", OTHER, name));
  for (const file of files) fs.writeFileSync(file, "\n" + fs.readFileSync(file, "utf8") + "\n");
  return { entry: index.papers[OTHER], files: new Map(files.map(file => [file, fs.readFileSync(file)])) };
}
function assertProtected(f, before) {
  for (const [file, bytes] of before.files) assert.deepEqual(fs.readFileSync(file), bytes, path.basename(file));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.index, "utf8")).papers[OTHER], before.entry);
}

const input = { paperHash: HASH, blockId: "b1" };
const cases = [
  ["note", null, f => f.workspace.putNote({ ...input, note: "New finding" }), w => assert.equal(w.listItems("notes", HASH).length, 1)],
  ["bookmark", null, f => f.workspace.putBookmark({ ...input, label: "Keep" }), w => assert.equal(w.listItems("bookmarks", HASH).length, 1)],
  ["progress", null, f => f.workspace.setProgress({ paperHash: HASH, percent: 25 }), w => assert.equal(w.getProgress(HASH).percent, 25)],
  ["glossary", null, f => f.workspace.putGlossary({ paperHash: HASH, terms: { evidence: "证据" } }), w => assert.equal(w.getGlossary(HASH).terms.evidence, "证据")],
  ["translation", null, f => f.workspace.putTranslation({ ...input, translation: "合成译文" }), w => assert.equal(w.getTranslation(HASH, "b1", 0).translation, "合成译文")],
  ["metadata", null, f => f.workspace.updatePaperMetadata(HASH, { title: "Changed target" }), w => assert.equal(w.getPaper(HASH).metadata.title, "Changed target")],
  ["paper", null, f => f.workspace.upsertPaper({ ...f.workspace.getPaper(HASH), metadata: { title: "Updated target" } }), w => assert.equal(w.getPaper(HASH).metadata.title, "Updated target")],
  ["task creation", null, f => f.workspace.createTask({ paperHash: HASH, id: "fixture-task" }), w => assert.equal(w.getTask("fixture-task").state, "queued")],
  ["task update", f => f.workspace.createTask({ paperHash: HASH, id: "fixture-task" }), f => f.workspace.updateTask("fixture-task", { state: "running" }), w => assert.equal(w.getTask("fixture-task").state, "running")],
  ["note deletion", f => f.workspace.putNote({ ...input, id: "fixture-note", note: "Delete" }), f => f.workspace.deleteItem("notes", "fixture-note"), w => assert.equal(w.getItem("notes", "fixture-note"), null)],
  ["glossary deletion", f => f.workspace.putGlossary({ paperHash: HASH, terms: { evidence: "证据" } }), f => f.workspace.deleteGlossaryTerm(HASH, "evidence"), w => assert.equal(w.getGlossary(HASH).terms.evidence, undefined)],
  ["AI cleanup", f => f.workspace.putTranslation({ ...input, translation: "Temporary" }), f => f.workspace.clearPaperData(HASH, "ai-translations"), w => assert.equal(w.getTranslation(HASH, "b1", 0), null)],
  ["structure cleanup", null, f => f.workspace.clearPaperData(HASH, "structure-keep-notes"), w => assert.equal(w.getPaper(HASH).blocks.length, 0)],
  ["paper deletion", null, f => f.workspace.removePaper(HASH), w => assert.equal(w.getPaper(HASH), null)],
];
for (const [name, prepare, run, verify] of cases) {
  test(`a ${name} operation keeps other paper files and index entries byte for byte`, async () => {
    const f = await fixture();
    try {
      if (prepare) await prepare(f);
      const before = protectOther(f);
      await run(f);
      assertProtected(f, before);
      verify(createPaperWorkspace({ dataDir: f.dataDir }));
    } finally { f.close(); }
  });
}

test("cache cleanup keeps assets referenced by another paper and reports their preservation", async () => {
  const f = await fixture(true);
  try {
    const before = protectOther(f);
    const result = await f.workspace.clearPaperData(HASH, "assets");
    assert.equal(fs.readFileSync(path.join(f.cache, "one.png"), "utf8"), "owned synthetic asset");
    assert.deepEqual(result.removedCacheIds, []);
    assert.deepEqual(result.preservedCacheIds, [CACHE]);
    assertProtected(f, before);
  } finally { f.close(); }
});

test("cache cleanup removes only exclusive assets while retaining notes and advancing revision", async () => {
  const f = await fixture();
  try {
    await f.workspace.putNote({ ...input, note: "Keep after cache deletion" });
    const before = protectOther(f);
    const revision = f.workspace.getPaper(HASH).revision;
    const result = await f.workspace.clearPaperData(HASH, "assets", { expectedRevision: revision });
    assert.equal(fs.existsSync(f.cache), false);
    assert.equal(fs.readFileSync(path.join(f.dataDir, "mineru-cache", OTHER_CACHE, "one.png"), "utf8"), "owned synthetic asset");
    assert.deepEqual(result.removedCacheIds, [CACHE]);
    assert.deepEqual(result.preservedCacheIds, []);
    assert.equal(result.paper.revision, revision + 1);
    assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).listItems("notes", HASH).length, 1);
    assertProtected(f, before);
  } finally { f.close(); }
});

test("a failed physical cleanup is reported as deferred rather than successful removal", async () => {
  const f = await fixture();
  const remove = fs.rmSync;
  try {
    let injected = false;
    fs.rmSync = (target, options) => {
      if (path.resolve(String(target)) === f.cache) {
        injected = true;
        throw Object.assign(new Error("Synthetic private storage failure"), { code: "EACCES" });
      }
      return remove(target, options);
    };
    const result = await f.workspace.clearPaperData(HASH, "assets");
    assert.equal(injected, true);
    assert.equal(result.cleanupDeferred, true);
    assert.deepEqual(result.removedCacheIds, []);
    assert.deepEqual(result.deferredCacheIds, [CACHE]);
    assert.ok(!JSON.stringify(result).includes("private storage failure"));
    assert.equal(fs.existsSync(f.cache), true);
  } finally { fs.rmSync = remove; f.close(); }
});

function competingProcess(f, mode) {
  const child = spawnSync(process.execPath, [worker, f.dataDir, mode], { encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test("physical paper cleanup cannot remove a paper recreated by a competing process", async () => {
  const f = await fixture();
  try {
    const storage = createPaperStorage({ filePath: f.index });
    let injected = false;
    const workspace = createPaperWorkspace({ dataDir: f.dataDir, storage: { ...storage,
      removePaper(hash) {
        injected = true;
        assert.equal(competingProcess(f, "recreate").saved, true);
        return storage.removePaper(hash);
      },
    } });
    const result = await workspace.removePaper(HASH, { returnReceipt: true });
    assert.equal(result.paperDirectory, "preserved");
    assert.equal(injected, true);
    const reopened = createPaperWorkspace({ dataDir: f.dataDir });
    assert.equal(reopened.getPaper(HASH).metadata.title, "Recreated synthetic paper");
    assert.equal(fs.readFileSync(path.join(f.cache, "one.png"), "utf8"), "owned synthetic asset");
  } finally { f.close(); }
});

test("cache reference checking and deletion cannot be crossed by a competing writer", async () => {
  const f = await fixture();
  const remove = fs.rmSync;
  try {
    let competitor;
    fs.rmSync = (target, options) => {
      if (!competitor && path.resolve(String(target)) === f.cache) competitor = competingProcess(f, "share");
      return remove(target, options);
    };
    await f.workspace.clearPaperData(HASH, "structure-keep-notes");
    assert.ok(competitor);
    const paper = createPaperWorkspace({ dataDir: f.dataDir }).getPaper(OTHER);
    const refersToCache = paper.blocks.some(block => block.assetRef?.cacheId === CACHE);
    assert.ok(!refersToCache || fs.existsSync(path.join(f.cache, "one.png")), "No committed paper may lose the cache it just referenced");
    assert.equal(competitor.busy, true);
  } finally { fs.rmSync = remove; f.close(); }
});

test("a task cannot claim successful persistence for a paper that does not exist", async () => {
  const f = await fixture();
  try {
    const before = fs.readFileSync(f.index);
    await assert.rejects(f.workspace.createTask({ paperHash: "e".repeat(64), id: "orphan-task" }),
      error => error.code === "paper_not_found" && error.status === 404);
    assert.deepEqual(fs.readFileSync(f.index), before);
    assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getTask("orphan-task"), null);
  } finally { f.close(); }
});

for (const [name, patch] of [["identity", { id: "replacement-task" }], ["ownership", { paperHash: OTHER }]]) {
  test(`a task status update cannot redirect its ${name}`, async () => {
    const f = await fixture();
    try {
      await f.workspace.createTask({ paperHash: HASH, id: "stable-task" });
      const before = fs.readFileSync(path.join(f.dataDir, "papers", HASH, "tasks.json"));
      await assert.rejects(f.workspace.updateTask("stable-task", patch));
      assert.deepEqual(fs.readFileSync(path.join(f.dataDir, "papers", HASH, "tasks.json")), before);
      const reopened = createPaperWorkspace({ dataDir: f.dataDir });
      assert.equal(reopened.getTask("stable-task").id, "stable-task");
      assert.equal(reopened.getTask("stable-task").paperHash, HASH);
    } finally { f.close(); }
  });
}

test("a no-op deletion does not rewrite any paper files or the workspace index", async () => {
  const f = await fixture();
  try {
    const protectedOther = protectOther(f);
    const before = fs.readFileSync(f.index);
    assert.equal(await f.workspace.deleteItem("notes", "missing-fixture-note"), false);
    assert.deepEqual(fs.readFileSync(f.index), before);
    assertProtected(f, protectedOther);
  } finally { f.close(); }
});

test("cache cleanup rejects traversal and leaves a linked external fixture untouched", async () => {
  const f = await fixture();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-cleanup-external-"));
  try {
    const storage = createPaperStorage({ filePath: f.index });
    assert.throws(() => storage.cleanupAssets(["../external"]));
    fs.writeFileSync(path.join(external, "sentinel.txt"), "owned external sentinel");
    fs.rmSync(f.cache, { recursive: true, force: true });
    fs.symlinkSync(external, f.cache, process.platform === "win32" ? "junction" : "dir");
    const result = await f.workspace.clearPaperData(HASH, "assets");
    assert.equal(result.cleanupDeferred, true);
    assert.deepEqual(result.deferredCacheIds, [CACHE]);
    assert.equal(fs.readFileSync(path.join(external, "sentinel.txt"), "utf8"), "owned external sentinel");
  } finally {
    f.close();
    assert.equal(path.dirname(path.resolve(external)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(external).startsWith("hpr-cleanup-external-"));
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test("guarded cleanup and paper deletion work under narrowly granted file permissions", async () => {
  const f = await fixture();
  try {
    await f.workspace.putNote({ ...input, note: "Keep under permission model" });
    const appRoot = path.resolve(path.dirname(worker), "../..");
    const workspaceUrl = pathToFileURL(path.join(appRoot, "server/domain/paper-workspace.js")).href;
    const script = `import fs from "node:fs";import path from "node:path";import {createPaperWorkspace} from ${JSON.stringify(workspaceUrl)};
      const dataDir=${JSON.stringify(f.dataDir)};
      let parentDenied=false;try{fs.lstatSync(path.dirname(dataDir));}catch(error){parentDenied=error.code==="ERR_ACCESS_DENIED";}
      const workspace=createPaperWorkspace({dataDir});
      await workspace.clearPaperData(${JSON.stringify(HASH)},"assets");
      await workspace.removePaper(${JSON.stringify(OTHER)});
      console.log(JSON.stringify({parentDenied,cacheRemoved:!fs.existsSync(${JSON.stringify(f.cache)}),
        otherPaperRemoved:!fs.existsSync(path.join(dataDir,"papers",${JSON.stringify(OTHER)})),
        notes:workspace.listItems("notes",${JSON.stringify(HASH)}).length,papers:workspace.listLibrary().length}));`;
    const child = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${appRoot}`,
      `--allow-fs-read=${f.dataDir}`, `--allow-fs-write=${f.dataDir}`, "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 5000, windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { parentDenied: true, cacheRemoved: true, otherPaperRemoved: true, notes: 1, papers: 1 });
  } finally { f.close(); }
});

test("paper deletion returns an incomplete cleanup receipt if its directory cannot be removed", async () => {
  const f = await fixture();
  const remove = fs.rmSync;
  try {
    fs.rmSync = (target, options) => {
      if (path.resolve(String(target)) === path.join(f.dataDir, "papers", HASH)) {
        throw Object.assign(new Error("Synthetic private paper directory failure"), { code: "EACCES" });
      }
      return remove(target, options);
    };
    const result = await f.workspace.removePaper(HASH, { returnReceipt: true });
    assert.equal(result.deleted, true);
    assert.equal(result.paperDirectory, "deferred");
    assert.equal(result.cleanupDeferred, true);
    assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getPaper(HASH), null);
    assert.equal(fs.existsSync(path.join(f.dataDir, "papers", HASH)), true);
    assert.ok(!JSON.stringify(result).includes("private paper directory failure"));
  } finally { fs.rmSync = remove; f.close(); }
});

test("the DELETE route preserves the deleted contract and exposes an accurate cleanup receipt", async () => {
  const f = await fixture();
  const remove = fs.rmSync;
  try {
    const routes = new Map();
    const app = {};
    for (const method of ["get", "post", "delete"]) app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
    registerApiRoutes(app, { dataDir: f.dataDir });
    fs.rmSync = (target, options) => {
      if (path.resolve(String(target)) === path.join(f.dataDir, "papers", HASH)) {
        throw Object.assign(new Error("Synthetic private delete failure"), { code: "EACCES" });
      }
      return remove(target, options);
    };
    const response = await routes.get("DELETE /api/research/paper")({
      get: () => ({ principal: { id: "owned-cleanup-route" } }),
      req: { query: () => "", json: async () => ({ paperHash: HASH }) },
      json: (value, status = 200) => ({ value, status }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.value.deleted, true);
    assert.equal(response.value.cleanup?.paperDirectory, "deferred");
    assert.equal(response.value.cleanup?.cleanupDeferred, true);
    assert.ok(!JSON.stringify(response.value).includes(f.dataDir));
    assert.ok(!JSON.stringify(response.value).includes("private delete failure"));
  } finally { fs.rmSync = remove; f.close(); }
});

test("UI deletion requires the intended paper and a valid revision before sending", () => {
  assert.equal(paperDeletionRevision({ paperHash: HASH, revision: 0 }, HASH), 0);
  assert.equal(paperDeletionRevision({ paperHash: HASH, revision: 5 }, HASH), 5);
  assert.throws(() => paperDeletionRevision({ paperHash: OTHER, revision: 5 }, HASH));
  for (const revision of [undefined, null, -1, 1.5, "5", NaN]) {
    assert.throws(() => paperDeletionRevision({ paperHash: HASH, revision }, HASH));
  }
});

test("cache cleanup preserves a replacement owner with a later revision", async () => {
  const f = await fixture();
  try {
    const storage = createPaperStorage({ filePath: f.index });
    let injected = false;
    const workspace = createPaperWorkspace({ dataDir: f.dataDir, storage: { ...storage,
      cleanupAssets(ids, options) {
        if (!injected && options?.excludePaperHash === HASH) {
          injected = true;
          assert.equal(competingProcess(f, "replace-owner").saved, true);
        }
        return storage.cleanupAssets(ids, options);
      },
    } });
    const result = await workspace.clearPaperData(HASH, "assets");
    assert.equal(injected, true);
    assert.equal(fs.readFileSync(path.join(f.cache, "one.png"), "utf8"), "replacement synthetic asset");
    assert.equal(result.cleanupDeferred, true);
    const paper = createPaperWorkspace({ dataDir: f.dataDir }).getPaper(HASH);
    assert.ok(paper.revision > result.paper.revision);
    assert.equal(paper.metadata.title, "Replacement owner at revision two");
  } finally { f.close(); }
});

test("cache cleanup defers when the index changes while the owner revision stays the same", async () => {
  const f = await fixture();
  try {
    const storage = createPaperStorage({ filePath: f.index });
    let injected = false;
    const workspace = createPaperWorkspace({ dataDir: f.dataDir, storage: { ...storage,
      cleanupAssets(ids, options) {
        if (!injected && options?.excludePaperHash === HASH) {
          injected = true;
          const before = createPaperWorkspace({ dataDir: f.dataDir }).getPaper(HASH).revision;
          assert.equal(competingProcess(f, "share").saved, true);
          assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getPaper(HASH).revision, before);
        }
        return storage.cleanupAssets(ids, options);
      },
    } });
    const result = await workspace.clearPaperData(HASH, "assets");
    assert.equal(injected, true);
    assert.equal(result.cleanupDeferred, true);
    assert.ok(fs.existsSync(path.join(f.cache, "one.png")));
  } finally { f.close(); }
});
