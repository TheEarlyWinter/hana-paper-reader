import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inspectMigrationSource,
  stageMigration,
  validateMigrationStage,
  commitMigration,
  previewMigrationTarget,
  MigrationError,
} from "../server/migration/migration-plan.js";

const PAPER_HASH = "a".repeat(64);

function approvalFor(source) {
  return {
    snapshotPath: source,
    writeFreezeConfirmed: true,
    sourceReadConfirmed: true,
    v1BackupConfirmed: true,
    sensitiveConfigPolicy: "manual-reentry",
    approvedAt: "2026-09-29T12:00:00.000Z",
  };
}

function writeJson(root, relativePath, value) {
  const filePath = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function createSource(options = {}) {
  const root = options.root || fs.mkdtempSync(path.join(os.tmpdir(), "hpr-migration-source-"));
  const hash = options.paperHash || PAPER_HASH;
  const paper = {
    paperHash: hash,
    metadata: { title: "Synthetic migration paper" },
    parser: { name: "fixture" },
    updatedAt: "2026-09-29T10:00:00.000Z",
    blocks: [
      { id: "b1", page: 1, type: "paragraph", text: "Original evidence" },
      { id: "b2", page: 2, type: "equation", text: "x = 1", latex: "x=1" },
    ],
  };
  const index = options.index || {
    schemaVersion: 3,
    storageLayout: "per-paper-v1",
    updatedAt: paper.updatedAt,
    papers: {
      [hash]: { paperHash: hash, updatedAt: paper.updatedAt, metadata: paper.metadata },
    },
  };
  writeJson(root, "paper-workspace.json", index);
  writeJson(root, `papers/${hash}/paper.json`, paper);
  writeJson(root, `papers/${hash}/research.json`, {
    paperHash: hash,
    notes: { note1: { id: "note1", paperHash: hash, note: "Synthetic note" } },
    bookmarks: { bookmark1: { id: "bookmark1", paperHash: hash, page: 1 } },
    progress: { paperHash: hash, percent: 25 },
    glossary: { version: 1, terms: { evidence: "证据" } },
  });
  writeJson(root, `papers/${hash}/translations.json`, {
    paperHash: hash,
    translations: { b1: "原始证据" },
    translationStates: { b1: "done" },
    translationGlossaryVersion: 1,
    cache: { cache1: { id: "cache1", paperHash: hash, blockId: "b1" } },
  });
  writeJson(root, `papers/${hash}/tasks.json`, {
    paperHash: hash,
    tasks: { task1: { id: "task1", paperHash: hash, state: "succeeded" } },
  });
  fs.mkdirSync(path.join(root, "mineru-cache", "cache1"), { recursive: true });
  fs.writeFileSync(path.join(root, "mineru-cache", "cache1", "asset.png"), Buffer.from([1, 2, 3, 4]));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ mineruApiToken: "synthetic-secret-do-not-copy" }), "utf8");
  fs.writeFileSync(path.join(root, "paper-workspace.json.schema-v1.backup"), "synthetic backup", "utf8");
  return root;
}

function makeTempRoots() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-migration-test-"));
  return {
    root,
    source: path.join(root, "source"),
    target: path.join(root, "target"),
    staging: path.join(root, "staging"),
  };
}

function assertMigrationError(error, code) {
  assert.ok(error instanceof MigrationError);
  assert.equal(error.code, code);
  return true;
}

test("source inspection creates a token-free manifest with integrity counts", () => {
  const source = createSource();
  try {
    const manifest = inspectMigrationSource(source);
    assert.equal(manifest.storageLayout, "per-paper-v1");
    assert.equal(manifest.paperCount, 1);
    assert.deepEqual(manifest.counts, {
      notes: 1,
      bookmarks: 1,
      evidence: 2,
      translations: 1,
      translationCache: 1,
      tasks: 1,
      glossaryTerms: 1,
      progress: 1,
    });
    assert.ok(manifest.files.some((entry) => entry.path === "paper-workspace.json"));
    assert.ok(!manifest.files.some((entry) => entry.path === "config.json"));
    assert.deepEqual(manifest.excluded.map((entry) => entry.path), [
      "config.json",
      "paper-workspace.json.schema-v1.backup",
    ]);
    assert.match(manifest.sourceFingerprint, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(manifest), /synthetic-secret/);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test("source inspection rejects a missing paper shard instead of treating it as empty", () => {
  const source = createSource();
  try {
    fs.rmSync(path.join(source, "papers", PAPER_HASH, "tasks.json"));
    assert.throws(() => inspectMigrationSource(source), (error) => assertMigrationError(error, "MIGRATION_SOURCE_INVALID"));
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test("source inspection rejects duplicate canonical paper hashes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-migration-duplicate-"));
  const upper = PAPER_HASH.toUpperCase();
  const source = createSource({
    root,
    index: {
      schemaVersion: 3,
      storageLayout: "per-paper-v1",
      papers: {
        [PAPER_HASH]: { paperHash: PAPER_HASH },
        [upper]: { paperHash: upper },
      },
    },
  });
  try {
    assert.throws(() => inspectMigrationSource(source), (error) => assertMigrationError(error, "MIGRATION_SOURCE_INVALID"));
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test("source inspection rejects symlinked source entries", (t) => {
  const source = createSource();
  const linkPath = path.join(source, "linked-papers");
  try {
    try {
      fs.symlinkSync(path.join(source, "papers"), linkPath, "junction");
    } catch (error) {
      t.skip(`symlink creation unavailable: ${error.code || error.message}`);
      return;
    }
    assert.throws(() => inspectMigrationSource(source), (error) => assertMigrationError(error, "MIGRATION_SOURCE_INVALID"));
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test("staging requires explicit migration approval", () => {
  const { root, source, target, staging } = makeTempRoots();
  createSource({ root: source });
  try {
    assert.throws(
      () => stageMigration({ sourceDir: source, targetDir: target, stagingRoot: staging, migrationId: "without-approval" }),
      (error) => assertMigrationError(error, "MIGRATION_APPROVAL_REQUIRED"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("staging validates byte identity and commits only into an empty target", () => {
  const { root, source, target, staging } = makeTempRoots();
  createSource({ root: source });
  try {
    const staged = stageMigration({ sourceDir: source, targetDir: target, stagingRoot: staging, migrationId: "fixture-001", now: "2026-09-29T11:00:00.000Z", approval: approvalFor(source) });
    assert.equal(staged.state, "staging");
    assert.equal(fs.existsSync(target), false);
    const validated = validateMigrationStage({ stagingDir: staged.stagingDir, now: "2026-09-29T11:01:00.000Z" });
    assert.equal(validated.state, "validated");
    const receipt = commitMigration({ stagingDir: staged.stagingDir, targetDir: target, now: "2026-09-29T11:02:00.000Z" });
    assert.equal(receipt.state, "committed");
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, "paper-workspace.json"), "utf8")).storageLayout, "per-paper-v1");
    assert.equal(fs.existsSync(path.join(target, "config.json")), false);
    assert.equal(fs.existsSync(path.join(target, "paper-workspace.json.schema-v1.backup")), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, "migration", "receipt.json"), "utf8")).state, "committed");
    assert.doesNotMatch(JSON.stringify(receipt), /synthetic-secret/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("commit refuses a non-empty target and preserves staging", () => {
  const { root, source, target, staging } = makeTempRoots();
  createSource({ root: source });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "user-sentinel.txt"), "must remain", "utf8");
  try {
    const staged = stageMigration({ sourceDir: source, targetDir: target, stagingRoot: staging, migrationId: "fixture-002", approval: approvalFor(source) });
    validateMigrationStage({ stagingDir: staged.stagingDir });
    assert.throws(() => commitMigration({ stagingDir: staged.stagingDir, targetDir: target }), (error) => assertMigrationError(error, "MIGRATION_TARGET_NOT_EMPTY"));
    assert.equal(fs.readFileSync(path.join(target, "user-sentinel.txt"), "utf8"), "must remain");
    assert.equal(fs.existsSync(path.join(staged.stagingDir, "data", "paper-workspace.json")), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(staged.stagingDir, "state.json"), "utf8")).state, "failed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("target preview reports conflicts and extras without modifying a non-empty target", () => {
  const { root, source, target, staging } = makeTempRoots();
  createSource({ root: source });
  try {
    const staged = stageMigration({ sourceDir: source, targetDir: target, stagingRoot: staging, migrationId: "fixture-preview", approval: approvalFor(source) });
    validateMigrationStage({ stagingDir: staged.stagingDir });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "paper-workspace.json"), JSON.stringify({ changed: true }), "utf8");
    fs.writeFileSync(path.join(target, "user-sentinel.txt"), "preserve", "utf8");
    const before = fs.readFileSync(path.join(target, "paper-workspace.json"), "utf8");

    const preview = previewMigrationTarget({ stagingDir: staged.stagingDir, targetDir: target });
    assert.equal(preview.targetState, "non_empty");
    assert.equal(preview.canCommit, false);
    assert.deepEqual(preview.conflicts, ["paper-workspace.json"]);
    assert.deepEqual(preview.extraTargetFiles, ["user-sentinel.txt"]);
    assert.ok(preview.missingInTarget.includes("papers/" + PAPER_HASH + "/paper.json"));
    assert.equal(fs.readFileSync(path.join(target, "paper-workspace.json"), "utf8"), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validation rejects tampered staging bytes and preserves the failed staging record", () => {
  const { root, source, target, staging } = makeTempRoots();
  createSource({ root: source });
  try {
    const staged = stageMigration({ sourceDir: source, targetDir: target, stagingRoot: staging, migrationId: "fixture-003", approval: approvalFor(source) });
    fs.appendFileSync(path.join(staged.stagingDir, "data", "mineru-cache", "cache1", "asset.png"), Buffer.from([9]));
    assert.throws(() => validateMigrationStage({ stagingDir: staged.stagingDir }), (error) => assertMigrationError(error, "MIGRATION_STAGING_INVALID"));
    assert.equal(JSON.parse(fs.readFileSync(path.join(staged.stagingDir, "state.json"), "utf8")).state, "failed");
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
