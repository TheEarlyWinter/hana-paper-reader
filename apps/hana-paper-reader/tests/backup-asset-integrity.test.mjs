import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { createPaperWorkspace } from "../server/domain/paper-workspace.js";
import registerApiRoutes from "../server/http/api-routes.js";
import { createMigrationImporter } from "../server/migration/migration-import.js";
import { MAX_BACKUP_ASSET_BYTES } from "../server/domain/backup-assets.js";

const HASH = "a".repeat(64), CACHE = "c".repeat(24);
async function fixture({ createAsset = true, empty = false, ref } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-backup-asset-27-"));
  const workspace = createPaperWorkspace({ dataDir });
  const paper = await workspace.upsertPaper({ paperHash: HASH, metadata: { title: "Owned backup resources" },
    blocks: [{ id: "b1", page: 1, type: "image", text: "Owned figure", assetRef: ref || { cacheId: CACHE, path: "images/one.bin" } }] });
  await workspace.putNote({ id: "n1", paperHash: HASH, blockId: "b1", note: "Owned retained note" });
  const cache = path.join(dataDir, "mineru-cache", CACHE), file = path.join(cache, "images", "one.bin");
  if (createAsset) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, empty ? "" : "Owned asset bytes"); }
  const routes = new Map(), app = {};
  for (const method of ["get", "post", "delete"]) app[method] = (route, handler) => routes.set(method.toUpperCase() + " " + route, handler);
  registerApiRoutes(app, { dataDir, workspace });
  const targets = [];
  const f = { dataDir, workspace, paper, cache, file, routes };
  f.request = (body, query = {}) => routes.get((body === undefined ? "GET" : "POST") + " /api/research/backup")({
    get: () => ({ principal: { id: "owned-backup-resources" } }),
    req: { json: async () => ({ paperHash: HASH, ...body }), query: key => ({ paperHash: HASH, ...query })[key] || "" },
    json: (value, status = 200) => ({ value, status }),
  });
  f.bytes = () => ["paper-workspace.json", ...["paper.json", "research.json", "translations.json", "tasks.json"].map(name => path.join("papers", HASH, name))]
    .map(relative => fs.readFileSync(path.join(dataDir, relative)));
  f.target = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-backup-asset-27-"));
    const target = createPaperWorkspace({ dataDir: root }); targets.push({ root, target }); return { root, target };
  };
  f.close = async () => {
    for (const { root, target } of [...targets, { root: dataDir, target: workspace }]) {
      await target.close();
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith("hpr-backup-asset-27-"));
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  return f;
}

test("a missing referenced cache cannot be published as a complete backup", async () => {
  const f = await fixture({ createAsset: false });
  try {
    const before = f.bytes(), response = await f.request({ saveToDisk: true });
    assert.equal(response.status, 409); assert.equal(response.value.error.code, "backup_assets_unavailable");
    assert.equal(fs.existsSync(path.join(f.dataDir, "exports")), false); assert.deepEqual(f.bytes(), before);
    assert.ok(!JSON.stringify(response.value).includes(f.dataDir));
  } finally { await f.close(); }
});

test("an existing cache with another file cannot hide a missing required resource", async () => {
  const f = await fixture({ createAsset: false });
  try {
    fs.mkdirSync(f.cache, { recursive: true }); fs.writeFileSync(path.join(f.cache, "other.txt"), "Owned unrelated cache file");
    assert.equal((await f.request()).status, 409);
  } finally { await f.close(); }
});

test("a denied cache directory read fails the full backup without exposing the original path", async () => {
  const f = await fixture(), original = fs.readdirSync;
  try {
    fs.readdirSync = (file, ...args) => {
      if (String(file) === f.cache) throw Object.assign(new Error("Owned unreadable " + f.cache), { code: "EACCES" });
      return original(file, ...args);
    };
    const response = await f.request(); assert.equal(response.status, 409); assert.equal(response.value.error.code, "backup_assets_unavailable");
    assert.ok(!JSON.stringify(response.value).includes(f.cache));
  } finally { fs.readdirSync = original; await f.close(); }
});

test("an invalid referenced cache ID cannot be silently filtered out of a full backup", async () => {
  const f = await fixture({ createAsset: false, ref: { cacheId: "owned-invalid-cache", path: "one.bin" } });
  try { assert.equal((await f.request()).status, 409); } finally { await f.close(); }
});

test("an exported empty regular cache file can round-trip into a new owned workspace", async () => {
  const f = await fixture({ empty: true });
  try {
    const response = await f.request(); assert.equal(response.status, 200); const backup = JSON.parse(await response.text());
    const { root, target } = f.target();
    await target.restoreBackup({ ...backup, expectedRevision: 0 });
    assert.equal(fs.readFileSync(path.join(root, "mineru-cache", CACHE, "images", "one.bin")).length, 0);
    assert.equal(target.getItem("notes", "n1").note, "Owned retained note");
  } finally { await f.close(); }
});

test("a resource with an unchanged declared hash rejects altered embedded bytes before target writes", async () => {
  const f = await fixture();
  try {
    const backup = f.workspace.exportBackup(HASH), bytes = Buffer.from(backup.assets[0].data, "base64");
    backup.assets[0].size = bytes.length; backup.assets[0].sha256 = createHash("sha256").update(bytes).digest("hex");
    backup.assets[0].data = Buffer.from("Changed resource!").toString("base64");
    const { root, target } = f.target();
    await assert.rejects(target.restoreBackup({ ...backup, expectedRevision: 0 }), error => error.code === "backup_invalid");
    assert.equal(fs.existsSync(path.join(root, "paper-workspace.json")), false);
    assert.equal(fs.existsSync(path.join(root, "mineru-cache")), false);
  } finally { await f.close(); }
});

test("a modern full backup captures nested resources once and restores all hashes into a fresh target", async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.cache, "empty.txt"), "");
    await f.workspace.upsertPaper({ paperHash: HASH, blocks: [
      ...f.paper.blocks, { id: "b2", page: 2, type: "image", text: "Owned repeated ref", assetRef: { cacheId: CACHE, path: "images/one.bin" } },
    ] });
    const backup = f.workspace.exportBackup(HASH); assert.equal(backup.assetMode, "included"); assert.equal(backup.assets.length, 2);
    for (const asset of backup.assets) {
      const bytes = Buffer.from(asset.data, "base64");
      assert.equal(asset.size, bytes.length); assert.equal(asset.sha256, createHash("sha256").update(bytes).digest("hex"));
    }
    const { root, target } = f.target(); await target.restoreBackup({ ...backup, expectedRevision: 0 });
    for (const asset of backup.assets) assert.equal(createHash("sha256").update(fs.readFileSync(path.join(root, "mineru-cache", asset.cacheId, asset.path))).digest("hex"), asset.sha256);
    assert.equal(target.getPaper(HASH).blocks.length, 2);
  } finally { await f.close(); }
});

test("an explicitly resource-free backup works with missing resources and declares its limited scope", async () => {
  const f = await fixture({ createAsset: false });
  try {
    const response = await f.request({ includeAssets: false, saveToDisk: true }); assert.equal(response.status, 200);
    assert.equal(response.value.assetMode, "omitted");
    const backup = JSON.parse(fs.readFileSync(response.value.filePath, "utf8")); assert.equal(backup.assetMode, "omitted"); assert.deepEqual(backup.assets, []);
    const { root, target } = f.target(); await target.restoreBackup({ ...backup, expectedRevision: 0 });
    assert.equal(target.getItem("notes", "n1").note, "Owned retained note"); assert.equal(fs.existsSync(path.join(root, "mineru-cache")), false);
    assert.equal(target.getPaper(HASH).blocks[0].assetRef.path, "images/one.bin");
  } finally { await f.close(); }
});

test("a declared full backup missing its referenced asset rejects before any target publication", async () => {
  const f = await fixture();
  try {
    const backup = f.workspace.exportBackup(HASH); backup.assets = [];
    const { root, target } = f.target();
    await assert.rejects(target.restoreBackup({ ...backup, expectedRevision: 0 }), error => error.code === "backup_invalid");
    assert.equal(fs.existsSync(path.join(root, "paper-workspace.json")), false); assert.equal(fs.existsSync(path.join(root, ".storage-transactions")), false);
  } finally { await f.close(); }
});

test("invalid or contradictory resource modes cannot mutate an existing workspace", async () => {
  const f = await fixture();
  try {
    const backup = f.workspace.exportBackup(HASH), before = f.bytes();
    for (const assetMode of [null, true, {}, [], "unknown", "omitted"]) {
      await assert.rejects(f.workspace.restoreBackup({ ...backup, assetMode, expectedRevision: f.paper.revision }), error => error.code === "backup_invalid");
      assert.deepEqual(f.bytes(), before);
    }
    await assert.rejects(f.workspace.restoreBackup({ ...backup, assets: null }), error => error.code === "backup_invalid");
  } finally { await f.close(); }
});

test("a modern full backup requires each asset's size and checksum while a valid legacy backup stays compatible", async () => {
  const f = await fixture();
  try {
    const backup = f.workspace.exportBackup(HASH); delete backup.assets[0].size; delete backup.assets[0].sha256;
    const { root, target } = f.target();
    await assert.rejects(target.restoreBackup({ ...backup, expectedRevision: 0 }), error => error.code === "backup_invalid");
    assert.equal(fs.existsSync(path.join(root, "paper-workspace.json")), false);
    delete backup.assetMode;
    await target.restoreBackup({ ...backup, expectedRevision: 0 });
    assert.equal(fs.readFileSync(path.join(root, "mineru-cache", CACHE, "images", "one.bin"), "utf8"), "Owned asset bytes");
  } finally { await f.close(); }
});

test("eight malformed integrity fields cannot alter stored research or resources", async () => {
  const f = await fixture();
  try {
    const original = f.workspace.exportBackup(HASH), before = f.bytes();
    for (const fields of [{ size: -1 }, { size: 1.5 }, { size: original.assets[0].size + 1 }, { size: "17" },
      { sha256: "bad" }, { sha256: "0".repeat(64) }, { size: undefined }, { sha256: undefined }]) {
      const backup = structuredClone(original); Object.assign(backup.assets[0], fields);
      await assert.rejects(f.workspace.restoreBackup(backup), error => error.code === "backup_invalid");
      assert.deepEqual(f.bytes(), before); assert.equal(fs.readFileSync(f.file, "utf8"), "Owned asset bytes");
    }
  } finally { await f.close(); }
});

test("legacy noncanonical Base64 and empty unverified assets are rejected without writes", async () => {
  const f = await fixture();
  try {
    for (const data of ["ZE==", "", " eA==", "eA", "!!!!"]) {
      const backup = f.workspace.exportBackup(HASH); delete backup.assetMode;
      backup.assets = [{ cacheId: CACHE, path: "images/one.bin", data }];
      const { root, target } = f.target();
      await assert.rejects(target.restoreBackup({ ...backup, expectedRevision: 0 }), error => error.code === "backup_invalid");
      assert.equal(fs.existsSync(path.join(root, "paper-workspace.json")), false);
    }
  } finally { await f.close(); }
});

for (const location of ["cache", "nested"]) {
  test("a " + location + " junction prevents a complete backup without reading its owned external target", async () => {
    const f = await fixture({ createAsset: location === "nested" }), originalRead = fs.readFileSync; let touched = false;
    try {
      const external = path.join(f.dataDir, "owned-external"); fs.mkdirSync(external);
      const hidden = path.join(external, "private.bin"); fs.writeFileSync(hidden, "Owned must not be read");
      if (location === "cache") { fs.mkdirSync(path.dirname(f.cache), { recursive: true }); fs.symlinkSync(external, f.cache, "junction"); }
      else fs.symlinkSync(external, path.join(f.cache, "linked"), "junction");
      fs.readFileSync = (file, ...args) => { if (String(file) === hidden || String(file).includes("linked")) touched = true; return originalRead(file, ...args); };
      const response = await f.request({ saveToDisk: true }); assert.equal(response.status, 409); assert.equal(touched, false);
      assert.equal(fs.existsSync(path.join(f.dataDir, "exports")), false); assert.equal(originalRead(hidden, "utf8"), "Owned must not be read");
    } finally { fs.readFileSync = originalRead; await f.close(); }
  });
}

test("a required cache that is an ordinary file cannot become an empty full backup", async () => {
  const f = await fixture({ createAsset: false });
  try {
    fs.mkdirSync(path.dirname(f.cache), { recursive: true }); fs.writeFileSync(f.cache, "Owned non-directory cache");
    assert.equal((await f.request()).status, 409);
  } finally { await f.close(); }
});

test("an owned resource changed during its read fails without publishing an output", async () => {
  const f = await fixture(), originalRead = fs.readFileSync; let changed = false;
  try {
    fs.readFileSync = (file, ...args) => {
      const bytes = originalRead(file, ...args);
      if (String(file) === f.file && !changed) { changed = true; fs.appendFileSync(f.file, " changed outside the protocol"); }
      return bytes;
    };
    const response = await f.request({ saveToDisk: true }); assert.equal(response.status, 409); assert.equal(changed, true);
    assert.equal(fs.existsSync(path.join(f.dataDir, "exports")), false);
  } finally { fs.readFileSync = originalRead; await f.close(); }
});

test("twelve unsafe required paths are refused before any cache file read", async () => {
  const f = await fixture(), originalRead = fs.readFileSync; let reads = 0;
  try {
    fs.readFileSync = (file, ...args) => { if (String(file).startsWith(f.cache + path.sep)) reads++; return originalRead(file, ...args); };
    for (const relative of ["../outside.bin", "/outside.bin", "C:/outside.bin", "images/CON.bin", "images/one.bin.", "images/one.bin ",
      "./one.bin", "images//one.bin", "images/a\u0000.bin", "images/a:b.bin", "images/COM\u00b9.bin", "images/CONIN$.bin"]) {
      await f.workspace.upsertPaper({ paperHash: HASH, blocks: [{ id: "b1", page: 1, text: "Owned unsafe ref", assetRef: { cacheId: CACHE, path: relative } }] });
      const response = await f.request(); assert.equal(response.status, 409);
    }
    assert.equal(reads, 0);
  } finally { fs.readFileSync = originalRead; await f.close(); }
});

test("an actual oversized resource is rejected using metadata before allocating its contents", async () => {
  const f = await fixture(), originalRead = fs.readFileSync; let read = false;
  try {
    fs.truncateSync(f.file, MAX_BACKUP_ASSET_BYTES + 1);
    fs.readFileSync = (file, ...args) => { if (String(file) === f.file) read = true; return originalRead(file, ...args); };
    const response = await f.request({ saveToDisk: true }); assert.equal(response.status, 400);
    assert.equal(response.value.error.code, "backup_too_large"); assert.equal(read, false);
    assert.equal(fs.existsSync(path.join(f.dataDir, "exports")), false);
  } finally { fs.readFileSync = originalRead; await f.close(); }
});

test("2000 actual cache files can be backed up but the 2001st cannot be published", { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 1999; index++) fs.writeFileSync(path.join(f.cache, "asset-" + String(index).padStart(4, "0") + ".bin"), "x");
    const accepted = await f.request(); assert.equal(accepted.status, 200); assert.equal(JSON.parse(await accepted.text()).assets.length, 2000);
    fs.writeFileSync(path.join(f.cache, "asset-extra.bin"), "x");
    const refused = await f.request({ saveToDisk: true }); assert.equal(refused.status, 400); assert.equal(refused.value.error.code, "backup_too_large");
    assert.equal(fs.existsSync(path.join(f.dataDir, "exports")), false);
  } finally { await f.close(); }
});

test("Windows case aliases in legacy assets reject before ambiguous destination writes", async () => {
  const f = await fixture();
  try {
    const backup = f.workspace.exportBackup(HASH); delete backup.assetMode;
    backup.assets.push({ ...backup.assets[0], path: "images/One.bin" });
    const { root, target } = f.target();
    await assert.rejects(target.restoreBackup({ ...backup, expectedRevision: 0 }), error => error.code === "backup_invalid");
    assert.equal(fs.existsSync(path.join(root, "mineru-cache")), false);
  } finally { await f.close(); }
});

test("a modern backup normalizes archived reference separators without rewriting its source", async () => {
  const f = await fixture();
  try {
    await f.workspace.upsertPaper({ paperHash: HASH, blocks: [{ id: "b1", page: 1, text: "Owned ref", assetRef: { cacheId: CACHE, path: "images\\one.bin" } }] });
    const before = f.bytes(), backup = f.workspace.exportBackup(HASH);
    assert.equal(backup.paper.blocks[0].assetRef.path, "images/one.bin"); assert.equal(backup.paper.resources[0].assetRef.path, "images/one.bin");
    assert.deepEqual(f.bytes(), before);
  } finally { await f.close(); }
});

test("the migration protocol imports a modern empty resource and preserves its hash after cache isolation", async () => {
  const f = await fixture({ empty: true });
  try {
    const backup = f.workspace.exportBackup(HASH), { root, target } = f.target();
    const importer = createMigrationImporter({ dataDir: root, workspace: target }), principal = "owned-modern-migration";
    const bundle = { format: "hana-paper-reader-migration", version: 1, sourceFingerprint: "d".repeat(64), sensitiveConfigPolicy: "manual-reentry", papers: [backup] };
    const prepared = importer.prepare(principal, bundle);
    const receipt = await importer.commit(principal, prepared.planId);
    assert.equal(receipt.state, "completed");
    assert.deepEqual(receipt.imported, [HASH]); assert.deepEqual(receipt.failed, []);
    const restored = target.exportBackup(HASH); assert.equal(restored.assets[0].size, 0); assert.equal(restored.assets[0].sha256, backup.assets[0].sha256);
    assert.notEqual(restored.assets[0].cacheId, CACHE);
  } finally { await f.close(); }
});

test("a tampered modern resource or a missing full resource is rejected by migration preparation", async () => {
  const f = await fixture();
  try {
    for (const alter of [backup => { backup.assets[0].sha256 = "0".repeat(64); }, backup => { backup.assets = []; }]) {
      const backup = f.workspace.exportBackup(HASH); alter(backup);
      const { root, target } = f.target(), importer = createMigrationImporter({ dataDir: root, workspace: target });
      const bundle = { format: "hana-paper-reader-migration", version: 1, sourceFingerprint: "d".repeat(64), sensitiveConfigPolicy: "manual-reentry", papers: [backup] };
      assert.throws(() => importer.prepare("owned-modern-migration", bundle), error => error.code === "migration_invalid");
      assert.equal(fs.existsSync(path.join(root, "paper-workspace.json")), false);
    }
  } finally { await f.close(); }
});
