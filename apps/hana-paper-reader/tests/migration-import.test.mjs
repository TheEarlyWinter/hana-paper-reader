// Fixtures never read a real v1 profile or write to an installed App.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPaperWorkspace } from "../server/domain/paper-workspace.js";
import { createMigrationImporter } from "../server/migration/migration-import.js";
import { MAX_TRANSLATION_CACHE_KEY_LENGTH } from "../server/domain/paper-identity.js";

const HASH = "b".repeat(64);
const EXISTING_HASH = "c".repeat(64);
const SOURCE = "d".repeat(64);
const CACHE = "a".repeat(24);
const OWNER = "synthetic-migration-owner";
const digest = value => createHash("sha256").update(value).digest("hex");
const canonicalCheckpoint = value => Array.isArray(value) ? value.map(canonicalCheckpoint)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalCheckpoint(value[key])])) : value;
const rejectsWith = (code, status) => error => error.code === code && error.status === status;

function backup(hash = HASH) {
  return { format: "hana-paper-reader-backup", version: 1, paperHash: hash,
    paper: { paperHash: hash, metadata: { title: "Source fixture" }, blocks: [{ id: "b1", page: 1, type: "paragraph", text: "Source text" }] },
    notes: [], bookmarks: [], tasks: [], translationCache: [], assets: [] };
}
function bundle(papers = [backup()]) {
  return { format: "hana-paper-reader-migration", version: 1, sourceFingerprint: SOURCE,
    sensitiveConfigPolicy: "manual-reentry", papers };
}
function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-migration-regression-"));
  const workspace = createPaperWorkspace({ dataDir });
  const importer = createMigrationImporter({ dataDir, workspace });
  return { dataDir, workspace, importer,
    close() {
      const resolved = path.resolve(dataDir);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith("hpr-migration-regression-"));
      fs.rmSync(resolved, { recursive: true, force: true });
    },
  };
}

test("existing papers remain unchanged; source notes are isolated and missing papers import", async () => {
  const f = fixture();
  try {
    await f.workspace.upsertPaper({ paperHash: EXISTING_HASH, metadata: { title: "Target title" },
      blocks: [{ id: "b1", page: 1, type: "paragraph", text: "Target evidence" }] });
    await f.workspace.putNote({ id: "shared-note", paperHash: EXISTING_HASH, blockId: "b1", note: "Keep target note" });
    const before = f.workspace.load();
    const missing = backup();
    missing.notes = [{ id: "shared-note", paperHash: HASH, blockId: "b1", note: "Source note" }];
    const plan = f.importer.prepare(OWNER, bundle([backup(EXISTING_HASH), missing]));
    assert.deepEqual(plan.rows.map(row => row.action), ["keep-target-isolate-source", "import"]);
    const result = await f.importer.commit(OWNER, plan.planId);
    assert.equal(result.state, "completed");
    assert.deepEqual(result.kept, [EXISTING_HASH]);
    assert.deepEqual(result.imported, [HASH]);
    const after = f.workspace.load();
    assert.deepEqual(after.papers[EXISTING_HASH], before.papers[EXISTING_HASH]);
    assert.deepEqual(after.notes["shared-note"], before.notes["shared-note"]);
    const sourceNote = Object.values(after.notes).find(item => item.paperHash === HASH);
    assert.equal(sourceNote.note, "Source note");
    assert.notEqual(sourceNote.id, "shared-note");
    assert.equal(f.importer.isolated(OWNER, plan.planId, EXISTING_HASH).paper.metadata.title, "Source fixture");
  } finally { f.close(); }
});

test("case-normalized cache references and asset bytes use the same isolated namespace", async () => {
  const f = fixture();
  try {
    const input = backup();
    input.paper.blocks[0].assetRef = { cacheId: CACHE.toUpperCase(), path: "figures/one.png" };
    input.assets = [{ cacheId: CACHE, path: "figures/one.png", data: Buffer.from("synthetic image bytes").toString("base64") }];
    const plan = f.importer.prepare(OWNER, bundle([input]));
    const exported = f.importer.isolated(OWNER, plan.planId, HASH);
    const isolatedId = exported.assets[0].cacheId;
    assert.notEqual(isolatedId, CACHE);
    assert.equal(exported.paper.blocks[0].assetRef.cacheId, isolatedId);
    const result = await f.importer.commit(OWNER, plan.planId);
    assert.equal(result.state, "completed");
    assert.equal(f.workspace.load().papers[HASH].blocks[0].assetRef.cacheId, isolatedId);
    assert.equal(fs.readFileSync(path.join(f.dataDir, "mineru-cache", isolatedId, "figures", "one.png"), "utf8"), "synthetic image bytes");
    assert.equal(fs.existsSync(path.join(f.dataDir, "mineru-cache", CACHE)), false);
  } finally { f.close(); }
});

for (const [label, change] of [
  ["Windows case alias", input => { input.assets = ["figures/One.png", "figures/one.png"].map(relative => ({ cacheId: CACHE, path: relative, data: "eA==" })); }],
  ["parent traversal", input => { input.assets = [{ cacheId: CACHE, path: "../outside.png", data: "eA==" }]; }],
  ["reserved device name", input => { input.assets = [{ cacheId: CACHE, path: "images/CON.png", data: "eA==" }]; }],
  ["trailing Windows alias", input => { input.assets = [{ cacheId: CACHE, path: "images/one.png.", data: "eA==" }]; }],
  ["invalid paper hash", input => { input.paper.paperHash = "invalid"; }],
  ["null block", input => { input.paper.blocks = [null]; }],
  ["duplicate normalized block IDs", input => { input.paper.blocks.push({ ...input.paper.blocks[0], id: " b1 " }); }],
]) {
  test(`prepare rejects ${label} before any paper is imported`, () => {
    const f = fixture();
    try {
      const input = backup(); change(input);
      assert.throws(() => f.importer.prepare(OWNER, bundle([input])), rejectsWith("migration_invalid", 400));
      assert.deepEqual(Object.keys(f.workspace.load().papers), []);
      assert.equal(fs.existsSync(path.join(f.dataDir, "migration", "imports")), false);
      assert.equal(fs.existsSync(path.join(f.dataDir, "mineru-cache")), false);
    } finally { f.close(); }
  });
}

test("changed staged content is rejected without beginning an import", async () => {
  const f = fixture();
  try {
    const plan = f.importer.prepare(OWNER, bundle());
    const staged = path.join(f.dataDir, "migration", "imports", plan.planId, "bundle.json");
    const changed = JSON.parse(fs.readFileSync(staged, "utf8"));
    changed.papers[0].paper.metadata.title = "Tampered staged title";
    fs.writeFileSync(staged, JSON.stringify(changed));
    await assert.rejects(f.importer.commit(OWNER, plan.planId), rejectsWith("migration_plan_changed", 409));
    assert.equal(f.importer.status(OWNER, plan.planId).state, "prepared");
    assert.deepEqual(Object.keys(f.workspace.load().papers), []);
  } finally { f.close(); }
});

test("changed staged content cannot be downloaded as a verified source backup", () => {
  const f = fixture();
  try {
    const plan = f.importer.prepare(OWNER, bundle());
    const staged = path.join(f.dataDir, "migration", "imports", plan.planId, "bundle.json");
    const changed = JSON.parse(fs.readFileSync(staged, "utf8"));
    changed.papers[0].paper.metadata.title = "Changed after migration preview";
    fs.writeFileSync(staged, JSON.stringify(changed));
    assert.throws(() => f.importer.isolated(OWNER, plan.planId, HASH), rejectsWith("migration_plan_changed", 409));
    assert.deepEqual(Object.keys(f.workspace.load().papers), []);
  } finally { f.close(); }
});

test("migration preserves distinct translation cache keys longer than 600 characters", async () => {
  const f = fixture();
  try {
    const input = backup();
    input.translationCache = ["one", "two"].map(suffix => ({
      paperHash: HASH, key: `${HASH}:${"x".repeat(600)}:${suffix}`, translation: suffix,
    }));
    const plan = f.importer.prepare(OWNER, bundle([input]));
    const result = await f.importer.commit(OWNER, plan.planId);
    assert.equal(result.state, "completed");
    const cache = f.workspace.load().translationCache;
    assert.equal(Object.keys(cache).length, 2);
    for (const item of input.translationCache) assert.equal(cache[item.key]?.translation, item.translation);
  } finally { f.close(); }
});

test("plans and source backups cannot be read or committed by another principal", async () => {
  const f = fixture();
  try {
    const plan = f.importer.prepare(OWNER, bundle());
    assert.throws(() => f.importer.status("another-owner", plan.planId), rejectsWith("migration_plan_invalid", 403));
    assert.throws(() => f.importer.isolated("another-owner", plan.planId, HASH), rejectsWith("migration_plan_invalid", 403));
    await assert.rejects(f.importer.commit("another-owner", plan.planId), rejectsWith("migration_plan_invalid", 403));
    assert.deepEqual(Object.keys(f.workspace.load().papers), []);
  } finally { f.close(); }
});

test("old queued tasks require retry and sensitive fields do not reach the imported store", async () => {
  const f = fixture();
  try {
    const input = backup();
    input.tasks = [{ id: "old-task", paperHash: HASH, state: "queued", token: "synthetic-secret", config: { credential: "synthetic-secret" } }];
    input.paper.metadata.authorization = "synthetic-secret";
    const plan = f.importer.prepare(OWNER, bundle([input]));
    const exported = f.importer.isolated(OWNER, plan.planId, HASH);
    assert.doesNotMatch(JSON.stringify(exported), /synthetic-secret/);
    assert.equal(exported.tasks[0].state, "failed");
    assert.equal(exported.tasks[0].needsRetry, true);
    const result = await f.importer.commit(OWNER, plan.planId);
    assert.equal(result.state, "completed");
    const task = Object.values(f.workspace.load().tasks).find(item => item.paperHash === HASH);
    assert.equal(task.state, "failed");
    assert.equal(task.needsRetry, true);
  } finally { f.close(); }
});

test("a paper created after preview is preserved by the restore write guard", async () => {
  const f = fixture();
  try {
    const plan = f.importer.prepare(OWNER, bundle());
    assert.equal(plan.rows[0].action, "import");
    const otherWriter = createPaperWorkspace({ dataDir: f.dataDir });
    await otherWriter.upsertPaper({ paperHash: HASH, metadata: { title: "Concurrent target" },
      blocks: [{ id: "b1", page: 1, type: "paragraph", text: "Concurrent evidence" }] });
    const result = await f.importer.commit(OWNER, plan.planId);
    assert.deepEqual(result.imported, []);
    assert.deepEqual(result.kept, [HASH]);
    const refreshed = createPaperWorkspace({ dataDir: f.dataDir });
    assert.equal(refreshed.load().papers[HASH].metadata.title, "Concurrent target");
    const txRoot = path.join(f.dataDir, ".transactions");
    assert.equal(fs.existsSync(txRoot) ? fs.readdirSync(txRoot).length : 0, 0);
  } finally { f.close(); }
});

test("partial import preserves completed papers and resumes through a fresh keep-target plan", async () => {
  const f = fixture();
  try {
    const second = "e".repeat(64);
    const third = "f".repeat(64);
    const input = bundle([backup(), backup(second), backup(third)]);
    const restore = f.workspace.restoreBackup;
    let attempts = 0;
    f.workspace.restoreBackup = async (...args) => {
      attempts++;
      if (args[0].paperHash === second) throw new Error("Synthetic disk failure");
      return restore(...args);
    };
    const plan = f.importer.prepare(OWNER, input);
    const partial = await f.importer.commit(OWNER, plan.planId);
    assert.equal(partial.state, "partial");
    assert.deepEqual(partial.imported, [HASH]);
    assert.equal(partial.failed[0].paperHash, second);
    assert.deepEqual(Object.keys(f.workspace.load().papers), [HASH]);
    await f.importer.commit(OWNER, plan.planId);
    assert.equal(attempts, 2); // No replay of the failed/interrupted plan.
    f.workspace.restoreBackup = restore;
    const retry = f.importer.prepare(OWNER, input);
    assert.deepEqual(retry.rows.map(row => row.action), ["keep-target-isolate-source", "import", "import"]);
    const done = await f.importer.commit(OWNER, retry.planId);
    assert.equal(done.state, "completed");
    assert.deepEqual(done.kept, [HASH]);
    assert.deepEqual(done.imported, [second, third]);
    assert.equal(Object.keys(f.workspace.load().papers).length, 3);
  } finally { f.close(); }
});

test("restart at a post-write checkpoint reports interruption and does not replay imports", async () => {
  const f = fixture();
  try {
    const second = "e".repeat(64);
    const input = bundle([backup(), backup(second)]);
    const plan = f.importer.prepare(OWNER, input);
    await f.workspace.restoreBackup(f.importer.isolated(OWNER, plan.planId, HASH));
    const receiptFile = path.join(f.dataDir, "migration", "imports", plan.planId, "receipt.json");
    const checkpoint = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
    checkpoint.state = "importing"; checkpoint.currentPaper = HASH;
    const { receiptChecksum, ...checkpointPayload } = checkpoint;
    checkpoint.receiptChecksum = digest(JSON.stringify(canonicalCheckpoint(checkpointPayload)));
    fs.writeFileSync(receiptFile, JSON.stringify(checkpoint));
    const restarted = createMigrationImporter({ dataDir: f.dataDir });
    assert.equal(restarted.status(OWNER, plan.planId).state, "interrupted");
    await restarted.commit(OWNER, plan.planId);
    assert.deepEqual(Object.keys(f.workspace.load().papers), [HASH]);
    const retry = restarted.prepare(OWNER, input);
    const done = await restarted.commit(OWNER, retry.planId);
    assert.equal(done.state, "completed");
    assert.deepEqual(done.kept, [HASH]);
    assert.deepEqual(done.imported, [second]);
  } finally { f.close(); }
});

test("concurrent commits of one migration plan import each paper once", async () => {
  const f = fixture();
  try {
    const restore = f.workspace.restoreBackup;
    let attempts = 0;
    f.workspace.restoreBackup = async (...args) => { attempts++; return restore(...args); };
    const plan = f.importer.prepare(OWNER, bundle());
    await Promise.all([f.importer.commit(OWNER, plan.planId), f.importer.commit(OWNER, plan.planId)]);
    assert.equal(attempts, 1);
    assert.equal(f.importer.status(OWNER, plan.planId).state, "completed");
    assert.deepEqual(Object.keys(f.workspace.load().papers), [HASH]);
  } finally { f.close(); }
});

test("regular backup restoration preserves long generated model variants and cache lookups", async () => {
  const f = fixture();
  try {
    await f.workspace.upsertPaper(backup().paper);
    const inputs = ["one", "two"].map(suffix => ({ paperHash: HASH, blockId: "b1", glossaryVersion: 0,
      agentId: "synthetic-agent", modelRef: `${"模型".repeat(150)}-${suffix}`, text: suffix, translation: suffix }));
    for (const input of inputs) await f.workspace.putTranslation(input);
    const original = f.workspace.exportBackup(HASH);
    assert.equal(original.translationCache.length, 2);
    assert.ok(original.translationCache.every(item => item.key.length > 600));
    original.expectedRevision = f.workspace.load().papers[HASH].revision;
    await f.workspace.restoreBackup(original);
    const restored = f.workspace.exportBackup(HASH);
    assert.deepEqual(restored.translationCache, original.translationCache);
    for (const input of inputs) assert.equal(f.workspace.getTranslation(HASH, "b1", 0, input)?.translation, input.translation);
  } finally { f.close(); }
});

for (const [label, key] of [
  ["oversized", `${HASH}:${"x".repeat(MAX_TRANSLATION_CACHE_KEY_LENGTH)}`],
  ["trailing whitespace", `${HASH}:b1:0 `],
  ["embedded NUL", `${HASH}:b1\0:0`],
]) {
  test(`invalid ${label} translation key is rejected before migration or restoration writes`, async () => {
    const f = fixture();
    try {
      const input = backup(); input.translationCache = [{ paperHash: HASH, key, translation: "synthetic" }];
      assert.throws(() => f.importer.prepare(OWNER, bundle([input])), rejectsWith("migration_invalid", 400));
      await assert.rejects(f.workspace.restoreBackup(input), error => error.code === "backup_invalid");
      assert.deepEqual(Object.keys(f.workspace.load().papers), []);
      assert.equal(fs.existsSync(path.join(f.dataDir, ".transactions")), false);
    } finally { f.close(); }
  });
}

test("offline preparation CLI and importer preserve an owned frozen fixture end to end", async () => {
  const f = fixture();
  try {
    const source = path.join(f.dataDir, "frozen-fixture");
    const shard = path.join(source, "papers", HASH);
    fs.mkdirSync(shard, { recursive: true });
    const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
    const paper = backup().paper;
    paper.metadata.token = "synthetic-secret";
    paper.blocks[0].assetRef = { cacheId: CACHE, path: "images/one.png" };
    write(path.join(source, "paper-workspace.json"), { schemaVersion: 3, storageLayout: "per-paper-v1", papers: { [HASH]: { paperHash: HASH } } });
    write(path.join(shard, "paper.json"), paper);
    write(path.join(shard, "research.json"), { paperHash: HASH, readingMode: "bilingual",
      notes: { note1: { id: "note1", paperHash: HASH, blockId: "b1", note: "Fixture note" } },
      bookmarks: { mark1: { id: "mark1", paperHash: HASH, blockId: "b1", page: 1 } },
      progress: { paperHash: HASH, page: 1, percent: 25 }, glossary: { paperHash: HASH, version: 1, terms: { evidence: "证据" } } });
    const key = `${HASH}:b1:1:academic-translation-v1:legacy`;
    write(path.join(shard, "translations.json"), { paperHash: HASH, translations: { b1: "合成证据" },
      translationStates: { b1: { kind: "ai" } }, translationGlossaryVersion: 1,
      cache: { [key]: { key, paperHash: HASH, blockId: "b1", translation: "合成证据" } } });
    write(path.join(shard, "tasks.json"), { paperHash: HASH, tasks: { task1: { id: "task1", paperHash: HASH, state: "running" } } });
    write(path.join(source, "config.json"), { token: "synthetic-secret" });
    const assetDir = path.join(source, "mineru-cache", CACHE, "images"); fs.mkdirSync(assetDir, { recursive: true });
    const bytes = Buffer.from([1, 2, 3, 4]); fs.writeFileSync(path.join(assetDir, "one.png"), bytes);
    const sourceBackup = path.join(f.dataDir, "fixture-source-backup"); fs.cpSync(source, sourceBackup, { recursive: true });
    const sourceBefore = fs.readFileSync(path.join(shard, "paper.json"));
    const approval = path.join(f.dataDir, "fixture-approval.json");
    write(approval, { snapshotPath: source, writeFreezeConfirmed: true, sourceReadConfirmed: true,
      v1BackupConfirmed: true, sensitiveConfigPolicy: "manual-reentry", approvedAt: new Date().toISOString(), fixtureOnly: true });
    const output = path.join(f.dataDir, "fixture.migration.json");
    const cli = fileURLToPath(new URL("../../../tools/prepare-migration.mjs", import.meta.url));
    const result = JSON.parse(execFileSync(process.execPath, [cli, "--source", source, "--approval", approval, "--out", output], { encoding: "utf8", timeout: 5000, windowsHide: true }));
    assert.equal(result.prepared, true); assert.equal(result.paperCount, 1);
    const input = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.doesNotMatch(JSON.stringify(input), /synthetic-secret/);
    await f.workspace.upsertPaper(backup(EXISTING_HASH).paper);
    const targetFiles = ["paper.json", "research.json", "translations.json", "tasks.json"];
    const targetBefore = targetFiles.map(name => fs.readFileSync(path.join(f.dataDir, "papers", EXISTING_HASH, name)));
    const plan = f.importer.prepare(OWNER, input);
    const done = await f.importer.commit(OWNER, plan.planId);
    assert.equal(done.state, "completed");
    const store = f.workspace.load();
    targetFiles.forEach((name, index) => assert.deepEqual(fs.readFileSync(path.join(f.dataDir, "papers", EXISTING_HASH, name)), targetBefore[index]));
    assert.equal(store.papers[HASH].translations.b1, "合成证据");
    assert.equal(store.progress[HASH].percent, 25);
    assert.equal(store.glossaries[HASH].terms.evidence, "证据");
    assert.equal(Object.values(store.notes).filter(item => item.paperHash === HASH).length, 1);
    assert.equal(Object.values(store.bookmarks).filter(item => item.paperHash === HASH).length, 1);
    assert.equal(Object.values(store.tasks).find(item => item.paperHash === HASH).needsRetry, true);
    const isolated = f.importer.isolated(OWNER, plan.planId, HASH);
    assert.deepEqual(fs.readFileSync(path.join(f.dataDir, "mineru-cache", isolated.assets[0].cacheId, "images", "one.png")), bytes);
    assert.deepEqual(fs.readFileSync(path.join(shard, "paper.json")), sourceBefore);
    assert.deepEqual(fs.readFileSync(path.join(sourceBackup, "papers", HASH, "paper.json")), sourceBefore);
    assert.equal(f.importer.prepare(OWNER, input).rows[0].action, "keep-target-isolate-source");
  } finally { f.close(); }
});
