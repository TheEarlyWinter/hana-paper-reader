import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { createPaperWorkspace } from "../server/domain/paper-workspace.js";
import { createMigrationImporter } from "../server/migration/migration-import.js";

const HASH = "a".repeat(64), SECOND = "c".repeat(64), OWNER = "owned-migration-progress";
const rejectsWith = (code, status) => error => error.code === code && error.status === status;
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function seal(state) { const { receiptChecksum, ...payload } = state;
  state.receiptChecksum = createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex"); return state; }
function bundle() { return { format: "hana-paper-reader-migration", version: 1, sourceFingerprint: "b".repeat(64), sensitiveConfigPolicy: "manual-reentry",
  papers: [HASH, SECOND].map(hash => ({ format: "hana-paper-reader-backup", version: 1, assetMode: "omitted", paperHash: hash,
    paper: { paperHash: hash, metadata: { title: "Owned progress " + hash[0] }, blocks: [{ id: "b1", text: "Owned progress evidence" }] },
    notes: [], bookmarks: [], tasks: [], assets: [], translationCache: [] })) }; }
function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-migration-progress-30-"));
  const workspace = createPaperWorkspace({ dataDir }), runtime = { dataDir, workspace }, importer = createMigrationImporter(runtime);
  const plan = importer.prepare(OWNER, bundle()), receiptPath = path.join(dataDir, "migration", "imports", plan.planId, "receipt.json");
  const entered = deferred(), release = deferred(), original = workspace.restoreBackup.bind(workspace);
  workspace.restoreBackup = async (...args) => { const result = await original(...args);
    if (args[0].paperHash === HASH) { entered.resolve(); await release.promise; } return result; };
  const f = { dataDir, runtime, workspace, importer, plan, receiptPath, entered, release };
  f.start = () => { f.operation = importer.commit(OWNER, plan.planId); void f.operation.catch(() => {}); return f.operation; };
  f.close = async () => { release.resolve(); if (f.operation) await Promise.allSettled([f.operation]); await workspace.close();
    const target = path.resolve(dataDir); assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith("hpr-migration-progress-30-")); fs.rmSync(target, { recursive: true, force: true }); };
  return f;
}

test("another service object reports an actually running migration as importing rather than interrupted", async () => {
  const f = fixture();
  try { f.start(); await f.entered.promise; const other = createMigrationImporter(f.runtime);
    assert.equal(other.status(OWNER, f.plan.planId).state, "importing");
    assert.equal((await other.commit(OWNER, f.plan.planId)).state, "importing");
    f.release.resolve(); const result = await f.operation; assert.equal(result.state, "completed");
    assert.deepEqual(result.imported, [HASH, SECOND]);
  } finally { await f.close(); }
});

test("a corrupt receipt changed during the first import is retained and cannot be silently resealed", async () => {
  const f = fixture();
  try { f.start(); await f.entered.promise; const value = JSON.parse(fs.readFileSync(f.receiptPath, "utf8")); value.rows[0].title = "Owned changed receipt";
    fs.writeFileSync(f.receiptPath, JSON.stringify(value)); const before = fs.readFileSync(f.receiptPath); f.release.resolve();
    await assert.rejects(f.operation, rejectsWith("migration_receipt_changed", 409)); assert.deepEqual(fs.readFileSync(f.receiptPath), before);
    assert.ok(f.workspace.getPaper(HASH)); assert.equal(f.workspace.getPaper(SECOND), null);
  } finally { await f.close(); }
});

test("a coherently resealed external receipt update still cannot be overwritten by the older running operation", async () => {
  const f = fixture();
  try { f.start(); await f.entered.promise; const value = JSON.parse(fs.readFileSync(f.receiptPath, "utf8")); value.externalNote = "Owned external change"; seal(value);
    fs.writeFileSync(f.receiptPath, JSON.stringify(value)); const before = fs.readFileSync(f.receiptPath); f.release.resolve();
    await assert.rejects(f.operation, rejectsWith("migration_receipt_changed", 409)); assert.deepEqual(fs.readFileSync(f.receiptPath), before);
    assert.ok(f.workspace.getPaper(HASH)); assert.equal(f.workspace.getPaper(SECOND), null);
  } finally { await f.close(); }
});

test("a deleted receipt during the first import cannot be recreated from an older in-memory checkpoint", async () => {
  const f = fixture();
  try { f.start(); await f.entered.promise; fs.unlinkSync(f.receiptPath); f.release.resolve();
    await assert.rejects(f.operation, rejectsWith("migration_receipt_changed", 409)); assert.equal(fs.existsSync(f.receiptPath), false);
    assert.ok(f.workspace.getPaper(HASH)); assert.equal(f.workspace.getPaper(SECOND), null);
  } finally { await f.close(); }
});
