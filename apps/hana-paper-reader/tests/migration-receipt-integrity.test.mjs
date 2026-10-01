import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { createPaperWorkspace } from "../server/domain/paper-workspace.js";
import { createMigrationImporter } from "../server/migration/migration-import.js";
import registerMigrationRoutes from "../server/http/migration-routes.js";

const HASH = "a".repeat(64), SOURCE = "b".repeat(64), OWNER = "owned-migration-receipt-fixture";
const rejectsWith = (code, status) => error => error.code === code && error.status === status;
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function seal(state) { const { receiptChecksum, ...payload } = state;
  state.receiptChecksum = createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex"); return state; }
function legacy(state) { delete state.integrityVersion; delete state.receiptChecksum; return state; }
function bundle() {
  return { format: "hana-paper-reader-migration", version: 1, sourceFingerprint: SOURCE, sensitiveConfigPolicy: "manual-reentry",
    papers: [{ format: "hana-paper-reader-backup", version: 1, paperHash: HASH, assetMode: "omitted",
      paper: { paperHash: HASH, metadata: { title: "Owned receipt integrity" }, blocks: [{ id: "b1", page: 1, text: "Owned receipt evidence" }] },
      notes: [], bookmarks: [], tasks: [], assets: [], translationCache: [] }] };
}
function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-migration-receipt-29-"));
  const workspace = createPaperWorkspace({ dataDir }), runtime = { dataDir, workspace }, importer = createMigrationImporter(runtime);
  const f = { dataDir, workspace, runtime, importer };
  f.prepare = input => { const plan = importer.prepare(OWNER, input || bundle()); f.plan = plan;
    f.receiptPath = path.join(dataDir, "migration", "imports", plan.planId, "receipt.json"); return plan; };
  f.change = transform => { const state = JSON.parse(fs.readFileSync(f.receiptPath, "utf8")); transform(state); fs.writeFileSync(f.receiptPath, JSON.stringify(state)); };
  f.close = async () => { await workspace.close(); const target = path.resolve(dataDir);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith("hpr-migration-receipt-29-"));
    fs.rmSync(target, { recursive: true, force: true }); };
  return f;
}

test("a stored receipt with a changed target policy cannot commit or expose a source backup", async () => {
  const f = fixture();
  try { const plan = f.prepare(); f.change(state => { state.policy = "replace-target"; });
    await assert.rejects(f.importer.commit(OWNER, plan.planId), rejectsWith("migration_plan_invalid", 503));
    assert.throws(() => f.importer.isolated(OWNER, plan.planId, HASH), rejectsWith("migration_plan_invalid", 503));
    assert.equal(f.workspace.getPaper(HASH), null);
  } finally { await f.close(); }
});

test("a fabricated completed receipt without any accounted papers is rejected instead of reporting success", async () => {
  const f = fixture();
  try { const plan = f.prepare(); f.change(state => { state.state = "completed"; });
    assert.throws(() => f.importer.status(OWNER, plan.planId), rejectsWith("migration_plan_invalid", 503));
    assert.equal(f.workspace.getPaper(HASH), null);
  } finally { await f.close(); }
});

test("a changed well-formed source fingerprint cannot be published as the original plan", async () => {
  const f = fixture();
  try { const plan = f.prepare(); f.change(state => { state.sourceFingerprint = "c".repeat(64); });
    assert.throws(() => f.importer.status(OWNER, plan.planId), rejectsWith("migration_plan_invalid", 503));
  } finally { await f.close(); }
});

test("a changed preview title or count blocks import before any owned target writes", async () => {
  const f = fixture();
  try { const plan = f.prepare(); f.change(state => { state.rows[0].title = "Changed preview"; state.rows[0].notes = 1; });
    await assert.rejects(f.importer.commit(OWNER, plan.planId), rejectsWith("migration_plan_invalid", 503));
    assert.equal(f.workspace.getPaper(HASH), null);
  } finally { await f.close(); }
});

test("a structurally plausible but altered result list is not accepted after service recreation", async () => {
  const f = fixture();
  try { const plan = f.prepare(); f.change(state => { state.state = "completed"; state.imported = [HASH]; state.finishedAt = new Date().toISOString(); });
    const recreated = createMigrationImporter(f.runtime);
    assert.throws(() => recreated.status(OWNER, plan.planId), rejectsWith("migration_plan_invalid", 503));
    assert.equal(f.workspace.getPaper(HASH), null);
  } finally { await f.close(); }
});

test("an array masquerading as the source fingerprint is rejected before creating a plan", async () => {
  const f = fixture();
  try { const input = bundle(); input.sourceFingerprint = [SOURCE];
    assert.throws(() => f.importer.prepare(OWNER, input), rejectsWith("migration_invalid", 400));
    assert.equal(fs.existsSync(path.join(f.dataDir, "migration", "imports")), false);
  } finally { await f.close(); }
});

test("every normal checkpoint has a verifiable checksum while public results omit ownership and integrity fields", async () => {
  const f = fixture();
  try { const plan = f.prepare(); const initial = JSON.parse(fs.readFileSync(f.receiptPath, "utf8"));
    assert.equal(initial.integrityVersion, 1); assert.match(initial.receiptChecksum, /^[a-f0-9]{64}$/);
    assert.equal(seal(structuredClone(initial)).receiptChecksum, initial.receiptChecksum);
    const completed = await f.importer.commit(OWNER, plan.planId), stored = JSON.parse(fs.readFileSync(f.receiptPath, "utf8"));
    assert.notEqual(stored.receiptChecksum, initial.receiptChecksum); assert.equal(seal(structuredClone(stored)).receiptChecksum, stored.receiptChecksum);
    for (const result of [plan, completed, f.importer.status(OWNER, plan.planId)]) {
      for (const key of ["owner", "integrityVersion", "receiptChecksum"]) assert.equal(Object.hasOwn(result, key), false);
    }
    assert.deepEqual(createMigrationImporter(f.runtime).status(OWNER, plan.planId), completed);
  } finally { await f.close(); }
});

test("a changed unknown receipt field is covered and remains byte for byte after rejection", async () => {
  const f = fixture();
  try { const plan = f.prepare(); f.change(state => { state.extra = "Owned unexpected change"; }); const before = fs.readFileSync(f.receiptPath);
    assert.throws(() => f.importer.status(OWNER, plan.planId), rejectsWith("migration_plan_invalid", 503));
    await assert.rejects(f.importer.commit(OWNER, plan.planId), rejectsWith("migration_plan_invalid", 503));
    assert.deepEqual(fs.readFileSync(f.receiptPath), before); assert.equal(f.workspace.getPaper(HASH), null);
  } finally { await f.close(); }
});

test("missing, malformed or contradictory integrity markers cannot downgrade a modern receipt", async () => {
  const changes = [state => { delete state.receiptChecksum; }, state => { delete state.integrityVersion; },
    state => { state.integrityVersion = 2; }, state => { state.integrityVersion = "1"; },
    state => { state.receiptChecksum = "0".repeat(64); }, state => { state.receiptChecksum = [state.receiptChecksum]; }];
  for (const change of changes) { const f = fixture();
    try { const plan = f.prepare(); f.change(change); const before = fs.readFileSync(f.receiptPath);
      assert.throws(() => f.importer.status(OWNER, plan.planId), rejectsWith("migration_plan_invalid", 503));
      assert.deepEqual(fs.readFileSync(f.receiptPath), before); assert.equal(f.workspace.getPaper(HASH), null);
    } finally { await f.close(); }
  }
});

test("a valid legacy receipt reads without resealing and acquires a checksum only on explicit commit", async () => {
  const f = fixture();
  try { const plan = f.prepare(); f.change(legacy); const before = fs.readFileSync(f.receiptPath);
    assert.equal(f.importer.status(OWNER, plan.planId).state, "prepared"); assert.equal(f.importer.isolated(OWNER, plan.planId, HASH).paperHash, HASH);
    assert.deepEqual(fs.readFileSync(f.receiptPath), before); const completed = await f.importer.commit(OWNER, plan.planId);
    assert.equal(completed.state, "completed"); const stored = JSON.parse(fs.readFileSync(f.receiptPath, "utf8"));
    assert.equal(stored.integrityVersion, 1); assert.equal(seal(structuredClone(stored)).receiptChecksum, stored.receiptChecksum);
  } finally { await f.close(); }
});

test("legacy metadata still has to match the verified source bundle", async () => {
  const changes = [state => { state.sourceFingerprint = "c".repeat(64); }, state => { state.rows[0].title = "Changed legacy title"; },
    state => { state.rows[0].notes = 1; }, state => { state.rows[0].paperHash = "c".repeat(64); }];
  for (const change of changes) { const f = fixture();
    try { const plan = f.prepare(); f.change(state => { legacy(state); change(state); });
      await assert.rejects(f.importer.commit(OWNER, plan.planId), rejectsWith("migration_plan_invalid", 503));
      assert.equal(f.workspace.getPaper(HASH), null);
    } finally { await f.close(); }
  }
});

test("a legacy receipt with changed staged bytes cannot claim a verified status", async () => {
  const f = fixture();
  try { const plan = f.prepare(); f.change(legacy); const staged = path.join(path.dirname(f.receiptPath), "bundle.json");
    const data = JSON.parse(fs.readFileSync(staged, "utf8")); data.papers[0].paper.blocks[0].text = "Changed owned source";
    fs.writeFileSync(staged, JSON.stringify(data)); const before = fs.readFileSync(f.receiptPath);
    assert.throws(() => f.importer.status(OWNER, plan.planId), rejectsWith("migration_plan_changed", 409));
    assert.deepEqual(fs.readFileSync(f.receiptPath), before); assert.equal(f.workspace.getPaper(HASH), null);
  } finally { await f.close(); }
});

test("benign JSON object key reordering keeps the same receipt checksum and does not rewrite the file", async () => {
  const f = fixture();
  const reversed = value => Array.isArray(value) ? value.map(reversed)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reversed(value[key])])) : value;
  try { const plan = f.prepare(); const value = reversed(JSON.parse(fs.readFileSync(f.receiptPath, "utf8")));
    fs.writeFileSync(f.receiptPath, JSON.stringify(value)); const before = fs.readFileSync(f.receiptPath);
    assert.deepEqual(f.importer.status(OWNER, plan.planId), plan); assert.deepEqual(fs.readFileSync(f.receiptPath), before);
  } finally { await f.close(); }
});

test("a valid sealed interrupted checkpoint stays historical and cannot replay its pending paper", async () => {
  const f = fixture();
  try { const plan = f.prepare(); f.change(state => { state.state = "importing"; state.currentPaper = HASH; seal(state); });
    const before = fs.readFileSync(f.receiptPath), recreated = createMigrationImporter(f.runtime);
    assert.equal(recreated.status(OWNER, plan.planId).state, "interrupted");
    await recreated.commit(OWNER, plan.planId); assert.equal(f.workspace.getPaper(HASH), null);
    assert.deepEqual(fs.readFileSync(f.receiptPath), before);
  } finally { await f.close(); }
});

test("a recomputed checksum cannot make an invalid receipt state structurally valid", async () => {
  const variants = [state => { state.state = "completed"; }, state => { state.state = "partial"; },
    state => { state.rows.push(state.rows[0]); }, state => { state.rows[0].assets = -1; },
    state => { state.imported = [HASH]; state.kept = [HASH]; state.state = "completed"; },
    state => { state.currentPaper = "c".repeat(64); }, state => { state.state = "interrupted"; }];
  for (const change of variants) { const f = fixture();
    try { const plan = f.prepare(); f.change(state => { change(state); seal(state); });
      assert.throws(() => f.importer.status(OWNER, plan.planId), rejectsWith("migration_plan_invalid", 503));
      assert.equal(f.workspace.getPaper(HASH), null);
    } finally { await f.close(); }
  }
});

test("an empty valid bundle can produce an internally consistent completed receipt", async () => {
  const f = fixture();
  try { const input = bundle(); input.papers = []; const plan = f.prepare(input), result = await f.importer.commit(OWNER, plan.planId);
    assert.equal(result.state, "completed"); assert.deepEqual(result.rows, []); assert.deepEqual(result.imported, []);
    assert.deepEqual(f.importer.status(OWNER, plan.planId), result); assert.deepEqual(Object.keys(f.workspace.load().papers), []);
  } finally { await f.close(); }
});

test("a genuine completed receipt remains historical when its imported paper is explicitly removed later", async () => {
  const f = fixture();
  try { const plan = f.prepare(), result = await f.importer.commit(OWNER, plan.planId), before = fs.readFileSync(f.receiptPath);
    await f.workspace.removePaper(HASH); assert.equal(f.workspace.getPaper(HASH), null);
    assert.deepEqual(f.importer.status(OWNER, plan.planId), result); assert.deepEqual(fs.readFileSync(f.receiptPath), before);
  } finally { await f.close(); }
});

test("non-string and unsafe plan identities cannot dispatch filesystem lookup", async () => {
  const f = fixture();
  try { const plan = f.prepare(); const before = fs.readFileSync(f.receiptPath);
    for (const id of [[plan.planId], "../outside", plan.planId.toUpperCase(), null]) {
      assert.throws(() => f.importer.status(OWNER, id), rejectsWith("migration_plan_invalid", 400));
    }
    assert.deepEqual(fs.readFileSync(f.receiptPath), before);
  } finally { await f.close(); }
});

test("truncated JSON and null receipt files are retained and never treated as an absent plan", async () => {
  for (const text of ["{", "null"]) { const f = fixture();
    try { const plan = f.prepare(); fs.writeFileSync(f.receiptPath, text);
      await assert.rejects(f.importer.commit(OWNER, plan.planId), rejectsWith("migration_plan_invalid", 503));
      assert.equal(fs.readFileSync(f.receiptPath, "utf8"), text); assert.equal(f.workspace.getPaper(HASH), null);
    } finally { await f.close(); }
  }
});

test("authorization is checked before reading another owner's legacy bundle", async () => {
  const f = fixture();
  try { const plan = f.prepare(); f.change(legacy); fs.unlinkSync(path.join(path.dirname(f.receiptPath), "bundle.json"));
    assert.throws(() => f.importer.status("another-owned-principal", plan.planId), rejectsWith("migration_plan_invalid", 403));
    await assert.rejects(f.importer.commit("another-owned-principal", plan.planId), rejectsWith("migration_plan_invalid", 403));
  } finally { await f.close(); }
});

test("the actual routes reject a corrupt receipt with a safe error and no source disclosure", async () => {
  const f = fixture(), routes = new Map(), app = {};
  for (const method of ["get", "post"]) app[method] = (route, handler) => routes.set(method.toUpperCase() + " " + route, handler);
  registerMigrationRoutes(app, f.runtime);
  try { const plan = f.prepare(); f.change(state => { state.rows[0].notes++; });
    const context = { get: () => ({ principal: { id: OWNER } }), header() {}, req: { param: key => key === "planId" ? plan.planId : HASH },
      json: (value, status = 200) => ({ value, status }) };
    for (const route of ["GET /api/migration/:planId", "GET /api/migration/:planId/receipt", "POST /api/migration/:planId/commit", "GET /api/migration/:planId/papers/:paperHash"]) {
      const result = await routes.get(route)(context); assert.equal(result.status, 503); assert.equal(result.value.error.code, "migration_plan_invalid");
      assert.doesNotMatch(JSON.stringify(result.value), /Owned receipt evidence|receiptChecksum|integrityVersion|migration-receipt-29|owner/);
    }
    assert.equal(f.workspace.getPaper(HASH), null);
  } finally { await f.close(); }
});

test("invalid source fingerprint types fail before creating any migration files", async () => {
  const f = fixture();
  try { for (const value of [[], { value: SOURCE }, 1, true, null]) { const input = bundle(); input.sourceFingerprint = value;
    assert.throws(() => f.importer.prepare(OWNER, input), rejectsWith("migration_invalid", 400)); }
    assert.equal(fs.existsSync(path.join(f.dataDir, "migration", "imports")), false);
  } finally { await f.close(); }
});

test("checksum failure cannot alter existing target notes or replace its paper", async () => {
  const f = fixture();
  try { await f.workspace.upsertPaper({ paperHash: HASH, metadata: { title: "Keep owned target" }, blocks: [{ id: "b1", text: "Keep target" }] });
    await f.workspace.putNote({ paperHash: HASH, id: "keep-note", blockId: "b1", note: "Keep target note" });
    const before = f.workspace.load(), plan = f.prepare(); f.change(state => { state.receiptChecksum = "0".repeat(64); });
    await assert.rejects(f.importer.commit(OWNER, plan.planId), rejectsWith("migration_plan_invalid", 503));
    assert.deepEqual(f.workspace.load(), before);
  } finally { await f.close(); }
});

test("array-shaped identities in legacy receipts are rejected even if their string coercion looks valid", async () => {
  const f = fixture();
  try { const plan = f.prepare(); f.change(state => { legacy(state); state.sourceFingerprint = [SOURCE]; });
    assert.throws(() => f.importer.status(OWNER, plan.planId), rejectsWith("migration_plan_invalid", 503));
  } finally { await f.close(); }
});
