import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { createPaperWorkspace } from "../server/domain/paper-workspace.js";
import { createPaperStorage } from "../server/domain/paper-storage.js";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
const CACHE = "c".repeat(24);
const shards = ["paper.json", "research.json", "translations.json", "tasks.json"];

async function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-restore-isolation-"));
  const workspace = createPaperWorkspace({ dataDir });
  for (const paperHash of [OTHER, HASH]) await workspace.upsertPaper({ paperHash,
    metadata: { title: `Synthetic ${paperHash[0]}` }, blocks: [{ id: "b1", page: 1, type: "paragraph", text: "Synthetic evidence" }] });
  const indexFile = path.join(dataDir, "paper-workspace.json");
  const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  index.papers[OTHER].fixtureMarker = "must survive a scoped restore";
  fs.writeFileSync(indexFile, JSON.stringify(index));
  const input = workspace.exportBackup(HASH);
  input.paper.metadata.title = "Restored target";
  input.assets = [{ cacheId: CACHE, path: "images/one.png", data: "eA==", size: 1, sha256: createHash("sha256").update("x").digest("hex") }];
  input.paper.blocks[0].assetRef = { cacheId: CACHE, path: "images/one.png" };
  return { dataDir, workspace, input, indexFile,
    close() {
      const root = path.resolve(dataDir);
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith("hpr-restore-isolation-"));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function capture(f) {
  const files = [f.indexFile, ...[HASH, OTHER].flatMap(hash => shards.map(name => path.join(f.dataDir, "papers", hash, name)))];
  return new Map(files.map(file => [file, fs.readFileSync(file)]));
}

function assertOriginalBytes(before) {
  for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes, path.basename(file));
}

function assertRetired(f) {
  assert.equal(fs.existsSync(path.join(f.dataDir, "mineru-cache", CACHE, "images", "one.png")), false);
  const tx = path.join(f.dataDir, ".transactions");
  assert.equal(fs.existsSync(tx) ? fs.readdirSync(tx).length : 0, 0);
}

test("restoring one paper preserves other shards and existing index entries", async () => {
  const f = await fixture();
  try {
    const otherBefore = shards.map(name => fs.readFileSync(path.join(f.dataDir, "papers", OTHER, name)));
    const entryBefore = JSON.parse(fs.readFileSync(f.indexFile, "utf8")).papers[OTHER];
    await f.workspace.restoreBackup(f.input);
    shards.forEach((name, i) => assert.deepEqual(fs.readFileSync(path.join(f.dataDir, "papers", OTHER, name)), otherBefore[i]));
    assert.deepEqual(JSON.parse(fs.readFileSync(f.indexFile, "utf8")).papers[OTHER], entryBefore);
    assert.equal(f.workspace.load().papers[HASH].metadata.title, "Restored target");
    assert.equal(fs.readFileSync(path.join(f.dataDir, "mineru-cache", CACHE, "images", "one.png"), "utf8"), "x");
  } finally { f.close(); }
});

test("a failure before workspace persistence keeps original files byte for byte", async () => {
  const f = await fixture();
  try {
    const before = capture(f);
    await assert.rejects(f.workspace.restoreBackup(f.input, {
      beforePersist() { throw new Error("Synthetic pre-persist failure"); },
    }), error => error.code === "restore_failed");
    assertOriginalBytes(before);
    assertRetired(f);
  } finally { f.close(); }
});

test("a failure after swapping some shards restores exact bytes and removes new assets", async () => {
  const f = await fixture();
  const rename = fs.renameSync;
  try {
    const before = capture(f);
    const failAt = f.indexFile;
    let injected = false;
    fs.renameSync = (source, destination) => {
      if (!injected && path.resolve(String(destination)) === failAt) {
        injected = true; throw Object.assign(new Error("Synthetic rename failure"), { code: "EIO" });
      }
      return rename(source, destination);
    };
    await assert.rejects(f.workspace.restoreBackup(f.input), error => error.code === "restore_failed");
    assert.equal(injected, true);
    assertOriginalBytes(before);
    assertRetired(f);
    assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).load().papers[HASH].metadata.title, "Synthetic a");
  } finally { fs.renameSync = rename; f.close(); }
});

test("incomplete storage rollback is reported as fatal rather than unchanged data", async () => {
  const f = await fixture();
  const rename = fs.renameSync;
  try {
    const failAt = f.indexFile;
    const rollbackAt = path.join(f.dataDir, "papers", HASH, "paper.json");
    let renameFailed = false;
    let rollbackFailed = false;
    fs.renameSync = (source, destination) => {
      if (!renameFailed && path.resolve(String(destination)) === failAt) {
        renameFailed = true; throw Object.assign(new Error("Synthetic rename failure"), { code: "EIO" });
      }
      if (renameFailed && !rollbackFailed && path.resolve(String(destination)) === rollbackAt) {
        rollbackFailed = true; throw Object.assign(new Error("Synthetic rollback failure"), { code: "EACCES" });
      }
      return rename(source, destination);
    };
    await assert.rejects(f.workspace.restoreBackup(f.input), error => error.code === "restore_fatal" && !error.message.includes(f.dataDir));
    assert.equal(renameFailed, true);
    assert.equal(rollbackFailed, true);
    assertRetired(f);
  } finally { fs.renameSync = rename; f.close(); }
});

for (const mode of ["mutation", "restore"]) {
  test(`readers keep the committed revision while an asynchronous ${mode} is pending`, async () => {
    const f = await fixture();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let started;
    const checkpoint = new Promise(resolve => { started = resolve; });
    const storage = createPaperStorage({ filePath: f.indexFile });
    let first = true;
    const workspace = createPaperWorkspace({ dataDir: f.dataDir, storage: { ...storage,
      async write(...args) {
        if (first) { first = false; started(); await gate; }
        return storage.write(...args);
      },
    } });
    let operation;
    try {
      const before = workspace.load().papers[HASH];
      operation = mode === "restore" ? workspace.restoreBackup(f.input) : workspace.upsertPaper({
        ...before, expectedRevision: before.revision, metadata: { ...before.metadata, title: "Committed mutation" },
      });
      await checkpoint;
      assert.equal(workspace.load().papers[HASH].metadata.title, before.metadata.title);
      assert.equal(workspace.load().papers[HASH].revision, before.revision);
      const queued = workspace.upsertPaper({ ...before, expectedRevision: before.revision,
        metadata: { ...before.metadata, title: "Stale second writer" } });
      const conflict = assert.rejects(queued, error => error.code === "paper_conflict");
      release(); await operation; await conflict;
      assert.equal(workspace.load().papers[HASH].revision, before.revision + 1);
      assert.equal(workspace.load().papers[HASH].metadata.title, mode === "restore" ? "Restored target" : "Committed mutation");
    } finally { release(); if (operation) await operation.catch(() => {}); f.close(); }
  });
}
