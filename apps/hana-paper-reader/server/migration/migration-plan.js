import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const PAPER_HASH_RE = /^[a-f0-9]{12,128}$/i;
const MIGRATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_SHARD_BYTES = 128 * 1024 * 1024;
const REQUIRED_SHARDS = ["paper.json", "research.json", "translations.json", "tasks.json"];
const SENSITIVE_BASENAMES = new Set(["config.json"]);
const LEGACY_BACKUP_RE = /(?:\.backup|\.bak)$/i;

export const MIGRATION_STATES = Object.freeze([
  "not_started",
  "staging",
  "validated",
  "committed",
  "failed",
]);

export class MigrationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MigrationError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new MigrationError(code, message, details);
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function canonicalHash(value, label) {
  if (typeof value !== "string" || !PAPER_HASH_RE.test(value)) {
    fail("MIGRATION_SOURCE_INVALID", `${label} is not a valid paper hash`);
  }
  return value.toLowerCase();
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    fail("MIGRATION_PATH_INVALID", `${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function relativePath(root, target, label = "path") {
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    fail("MIGRATION_PATH_INVALID", `${label} escapes its root`);
  }
  return relative.replace(/\\/g, "/");
}

function safeRelativePath(value, label = "relative path") {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    fail("MIGRATION_PATH_INVALID", `${label} is invalid`);
  }
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    fail("MIGRATION_PATH_INVALID", `${label} must be relative`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    fail("MIGRATION_PATH_INVALID", `${label} contains traversal`);
  }
  return parts.join("/");
}

function safeJoin(root, relative, label = "path") {
  const normalized = safeRelativePath(relative, label);
  const target = path.resolve(root, ...normalized.split("/"));
  const actual = path.relative(path.resolve(root), target);
  if (!actual || actual.startsWith(`..${path.sep}`) || actual === ".." || path.isAbsolute(actual)) {
    fail("MIGRATION_PATH_INVALID", `${label} escapes its root`);
  }
  return target;
}

function lstat(filePath, label, sourceInvalid = false) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      fail(sourceInvalid ? "MIGRATION_SOURCE_INVALID" : "MIGRATION_STAGING_INVALID", `${label} is a symlink or junction`, { path: filePath });
    }
    return stat;
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    fail(sourceInvalid ? "MIGRATION_SOURCE_INVALID" : "MIGRATION_STAGING_INVALID", `${label} cannot be inspected`, { path: filePath, cause: error?.code || error?.message });
  }
}

function assertDirectory(filePath, label, sourceInvalid = false) {
  const stat = lstat(filePath, label, sourceInvalid);
  if (!stat.isDirectory()) {
    fail(sourceInvalid ? "MIGRATION_SOURCE_INVALID" : "MIGRATION_STAGING_INVALID", `${label} is not a directory`, { path: filePath });
  }
  return stat;
}

function assertFile(filePath, label, maxBytes, sourceInvalid = false) {
  const stat = lstat(filePath, label, sourceInvalid);
  if (!stat.isFile() || stat.size > maxBytes) {
    fail(sourceInvalid ? "MIGRATION_SOURCE_INVALID" : "MIGRATION_STAGING_INVALID", `${label} is not a valid regular file`, { path: filePath });
  }
  return stat;
}

function assertNoSymlinkAncestors(filePath, errorCode = "MIGRATION_PATH_INVALID") {
  let current = path.resolve(filePath);
  for (;;) {
    if (fs.existsSync(current)) {
      let stat;
      try { stat = fs.lstatSync(current); } catch (error) {
        fail(errorCode, "path cannot be inspected", { path: current, cause: error?.code || error?.message });
      }
      if (stat.isSymbolicLink()) fail(errorCode, "path contains a symlink or junction", { path: current });
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function readJson(filePath, label, maxBytes, sourceInvalid = false) {
  assertFile(filePath, label, maxBytes, sourceInvalid);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(sourceInvalid ? "MIGRATION_SOURCE_INVALID" : "MIGRATION_STAGING_INVALID", `${label} is not valid JSON`, { path: filePath, cause: error?.message });
  }
}

function writeJson(filePath, value) {
  assertNoSymlinkAncestors(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function hashFile(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function objectKeys(value) {
  return isRecord(value) ? Object.keys(value) : [];
}

function isExcluded(relative) {
  const basename = path.posix.basename(relative);
  if (SENSITIVE_BASENAMES.has(basename.toLowerCase())) return "sensitive_config";
  if (LEGACY_BACKUP_RE.test(basename)) return "legacy_backup";
  if (relative.split("/").some((part) => part.toLowerCase() === "backups")) return "legacy_backup";
  const top = relative.split("/")[0];
  if (!["paper-workspace.json", "papers", "mineru-cache"].includes(top)) return "outside_business_allowlist";
  return null;
}

function walkSource(root, current, files, excluded) {
  const directory = current ? safeJoin(root, current, "source directory") : root;
  assertDirectory(directory, current || "source root", true);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = current ? `${current}/${entry.name}` : entry.name;
    const normalized = safeRelativePath(relative, "source entry");
    const target = safeJoin(root, normalized, "source entry");
    const stat = lstat(target, `source entry ${normalized}`, true);
    const exclusion = isExcluded(normalized);
    if (exclusion) {
      excluded.push({ path: normalized, reason: exclusion, size: stat.isFile() ? stat.size : null });
      continue;
    }
    if (stat.isDirectory()) {
      walkSource(root, normalized, files, excluded);
      continue;
    }
    if (!stat.isFile()) {
      fail("MIGRATION_SOURCE_INVALID", `source entry ${normalized} is not a regular file or directory`, { path: normalized });
    }
    files.push({ path: normalized, size: stat.size, sha256: hashFile(target) });
  }
}

function assertShardPaperHash(shard, hash, label) {
  if (!isRecord(shard)) fail("MIGRATION_SOURCE_INVALID", `${label} must be an object`);
  if (shard.paperHash !== undefined && canonicalHash(shard.paperHash, `${label}.paperHash`) !== hash) {
    fail("MIGRATION_SOURCE_INVALID", `${label} has a mismatched paper hash`);
  }
}

function inspectPaper(root, hash, counts) {
  const paperDir = safeJoin(root, `papers/${hash}`, "paper directory");
  assertDirectory(paperDir, `papers/${hash}`, true);
  const shards = {};
  for (const name of REQUIRED_SHARDS) {
    const shardPath = safeJoin(paperDir, name, `papers/${hash}/${name}`);
    shards[name] = readJson(shardPath, `papers/${hash}/${name}`, MAX_SHARD_BYTES, true);
  }
  const paper = shards["paper.json"];
  assertShardPaperHash(paper, hash, `papers/${hash}/paper.json`);
  if (!Array.isArray(paper.blocks)) {
    fail("MIGRATION_SOURCE_INVALID", `papers/${hash}/paper.json blocks must be an array`);
  }
  const research = shards["research.json"];
  const translations = shards["translations.json"];
  const tasks = shards["tasks.json"];
  assertShardPaperHash(research, hash, `papers/${hash}/research.json`);
  assertShardPaperHash(translations, hash, `papers/${hash}/translations.json`);
  assertShardPaperHash(tasks, hash, `papers/${hash}/tasks.json`);
  counts.notes += objectKeys(research.notes).length;
  counts.bookmarks += objectKeys(research.bookmarks).length;
  counts.translations += objectKeys(translations.translations).length;
  counts.translationCache += objectKeys(translations.cache).length;
  counts.tasks += objectKeys(tasks.tasks).length;
  counts.glossaryTerms += objectKeys(research.glossary?.terms).length;
  counts.progress += research.progress ? 1 : 0;
  counts.evidence += paper.blocks.filter((block) => isRecord(block) && typeof block.id === "string" && block.id.trim()).length;
}

function validatePaperDirectories(root, expectedHashes) {
  const papersRoot = path.join(root, "papers");
  if (!fs.existsSync(papersRoot)) {
    if (expectedHashes.size > 0) fail("MIGRATION_SOURCE_INVALID", "papers directory is missing");
    return;
  }
  assertDirectory(papersRoot, "papers", true);
  const seen = new Set();
  for (const entry of fs.readdirSync(papersRoot, { withFileTypes: true })) {
    const child = path.join(papersRoot, entry.name);
    const stat = lstat(child, `papers/${entry.name}`, true);
    if (!stat.isDirectory()) fail("MIGRATION_SOURCE_INVALID", `papers/${entry.name} is not a directory`);
    const hash = canonicalHash(entry.name, `papers/${entry.name}`);
    if (seen.has(hash)) fail("MIGRATION_SOURCE_INVALID", `duplicate canonical paper hash ${hash}`);
    seen.add(hash);
    if (!expectedHashes.has(hash)) fail("MIGRATION_SOURCE_INVALID", `orphan paper directory ${entry.name}`);
  }
  for (const hash of expectedHashes) {
    if (!seen.has(hash)) fail("MIGRATION_SOURCE_INVALID", `paper directory ${hash} is missing`);
  }
}

function manifestFingerprint({ storageLayout, schemaVersion, paperHashes, counts, files, excluded }) {
  const payload = {
    manifestVersion: 1,
    storageLayout,
    schemaVersion,
    paperHashes,
    counts,
    files,
    excluded: excluded.map(({ path: relative, reason, size }) => ({ path: relative, reason, size })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function inspectMigrationSource(sourceDir) {
  const root = absolutePath(sourceDir, "sourceDir");
  assertNoSymlinkAncestors(root, "MIGRATION_SOURCE_INVALID");
  assertDirectory(root, "source root", true);
  const indexPath = path.join(root, "paper-workspace.json");
  const index = readJson(indexPath, "paper-workspace.json", MAX_INDEX_BYTES, true);
  if (!isRecord(index) || index.storageLayout !== "per-paper-v1") {
    fail("MIGRATION_SOURCE_INVALID", "source workspace must use per-paper-v1 storage");
  }
  const schemaVersion = Number(index.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 3) {
    fail("MIGRATION_SOURCE_INVALID", "source workspace schema version is unsupported");
  }
  if (!isRecord(index.papers)) fail("MIGRATION_SOURCE_INVALID", "source workspace papers must be an object");

  const paperHashes = [];
  const expectedHashes = new Set();
  const counts = {
    notes: 0,
    bookmarks: 0,
    evidence: 0,
    translations: 0,
    translationCache: 0,
    tasks: 0,
    glossaryTerms: 0,
    progress: 0,
  };
  for (const [rawHash, record] of Object.entries(index.papers)) {
    const hash = canonicalHash(rawHash, `paper index key ${rawHash}`);
    if (expectedHashes.has(hash)) fail("MIGRATION_SOURCE_INVALID", `duplicate canonical paper hash ${hash}`);
    if (isRecord(record) && record.paperHash !== undefined && canonicalHash(record.paperHash, `paper ${rawHash}`) !== hash) {
      fail("MIGRATION_SOURCE_INVALID", `paper ${rawHash} has a mismatched paper hash`);
    }
    expectedHashes.add(hash);
    paperHashes.push(hash);
  }
  paperHashes.sort();
  validatePaperDirectories(root, expectedHashes);
  for (const hash of paperHashes) inspectPaper(root, hash, counts);

  const files = [];
  const excluded = [];
  walkSource(root, "", files, excluded);
  files.sort((left, right) => left.path.localeCompare(right.path));
  excluded.sort((left, right) => left.path.localeCompare(right.path));
  const totalBytes = files.reduce((sum, entry) => sum + entry.size, 0);
  const manifest = {
    manifestVersion: 1,
    storageLayout: index.storageLayout,
    schemaVersion,
    paperHashes,
    paperCount: paperHashes.length,
    counts,
    files,
    excluded,
    totalBytes,
  };
  manifest.sourceFingerprint = manifestFingerprint(manifest);
  return manifest;
}

function rootsOverlap(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  const relA = path.relative(a, b);
  const relB = path.relative(b, a);
  return relA === "" || relB === "" || !relA.startsWith(`..${path.sep}`) && relA !== ".." || !relB.startsWith(`..${path.sep}`) && relB !== "..";
}

function assertRootsSeparated(sourceDir, targetDir, stagingRoot) {
  if (rootsOverlap(sourceDir, targetDir) || rootsOverlap(sourceDir, stagingRoot) || rootsOverlap(targetDir, stagingRoot)) {
    fail("MIGRATION_PATH_INVALID", "source, target and staging roots must be separate");
  }
}

function assertMigrationId(value) {
  if (typeof value !== "string" || !MIGRATION_ID_RE.test(value)) fail("MIGRATION_PATH_INVALID", "migrationId is invalid");
  return value;
}

export function validateMigrationApproval(approval, sourceDir) {
  const source = absolutePath(sourceDir, "sourceDir");
  if (!isRecord(approval)
    || approval.writeFreezeConfirmed !== true
    || approval.sourceReadConfirmed !== true
    || approval.v1BackupConfirmed !== true
    || approval.sensitiveConfigPolicy !== "manual-reentry"
    || typeof approval.approvedAt !== "string"
    || !approval.approvedAt.trim()
    || typeof approval.snapshotPath !== "string"
    || !path.isAbsolute(approval.snapshotPath)
    || path.resolve(approval.snapshotPath) !== source) {
    fail("MIGRATION_APPROVAL_REQUIRED", "explicit write-freeze, source-read, backup and sensitive-config approval is required");
  }
  return {
    snapshotPath: source,
    writeFreezeConfirmed: true,
    sourceReadConfirmed: true,
    v1BackupConfirmed: true,
    sensitiveConfigPolicy: "manual-reentry",
    approvedAt: approval.approvedAt,
  };
}

function readState(stagingDir) {
  const state = readJson(path.join(stagingDir, "state.json"), "migration state", 1024 * 1024, false);
  if (!isRecord(state) || !MIGRATION_STATES.includes(state.state)) fail("MIGRATION_STAGING_INVALID", "migration state is invalid");
  return state;
}

function writeState(stagingDir, state, now, details = {}) {
  writeJson(path.join(stagingDir, "state.json"), {
    state,
    migrationId: path.basename(stagingDir),
    updatedAt: typeof now === "string" ? now : new Date().toISOString(),
    ...details,
  });
}

function markFailed(stagingDir, now, error) {
  try {
    if (fs.existsSync(stagingDir) && fs.statSync(stagingDir).isDirectory()) {
      writeState(stagingDir, "failed", now, { error: { code: error?.code || "MIGRATION_FAILED", message: String(error?.message || error) } });
    }
  } catch {}
}

function compareStagedFiles(dataDir, manifest) {
  const observed = inspectMigrationSource(dataDir);
  const expectedPaths = manifest.files.map((entry) => entry.path).sort();
  const observedPaths = observed.files.map((entry) => entry.path).sort();
  if (JSON.stringify(expectedPaths) !== JSON.stringify(observedPaths)) {
    fail("MIGRATION_STAGING_INVALID", "staging file set differs from the source manifest");
  }
  const observedByPath = new Map(observed.files.map((entry) => [entry.path, entry]));
  for (const expected of manifest.files) {
    const actual = observedByPath.get(expected.path);
    if (!actual || actual.size !== expected.size || actual.sha256 !== expected.sha256) {
      fail("MIGRATION_STAGING_INVALID", `staging file changed: ${expected.path}`);
    }
  }
  if (observed.storageLayout !== manifest.storageLayout || observed.schemaVersion !== manifest.schemaVersion) {
    fail("MIGRATION_STAGING_INVALID", "staging workspace metadata differs from the source manifest");
  }
  if (JSON.stringify(observed.paperHashes) !== JSON.stringify(manifest.paperHashes) || JSON.stringify(observed.counts) !== JSON.stringify(manifest.counts)) {
    fail("MIGRATION_STAGING_INVALID", "staging workspace counts differ from the source manifest");
  }
  return observed;
}

export function stageMigration({ sourceDir, targetDir, stagingRoot, migrationId = randomUUID(), now, approval } = {}) {
  const source = absolutePath(sourceDir, "sourceDir");
  const target = absolutePath(targetDir, "targetDir");
  const staging = absolutePath(stagingRoot, "stagingRoot");
  assertRootsSeparated(source, target, staging);
  const id = assertMigrationId(migrationId);
  validateMigrationApproval(approval, source);
  const manifest = inspectMigrationSource(source);
  assertNoSymlinkAncestors(staging);
  fs.mkdirSync(staging, { recursive: true });
  const stagingDir = safeJoin(staging, id, "staging directory");
  if (fs.existsSync(stagingDir)) fail("MIGRATION_STAGING_EXISTS", `staging directory already exists: ${id}`);
  const dataDir = path.join(stagingDir, "data");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    writeJson(path.join(stagingDir, "manifest.json"), manifest);
    writeState(stagingDir, "staging", now, { sourceFingerprint: manifest.sourceFingerprint });
    for (const entry of manifest.files) {
      const sourceFile = safeJoin(source, entry.path, "source file");
      const targetFile = safeJoin(dataDir, entry.path, "staging file");
      assertNoSymlinkAncestors(targetFile);
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.copyFileSync(sourceFile, targetFile, fs.constants.COPYFILE_EXCL);
    }
    compareStagedFiles(dataDir, manifest);
    return { state: "staging", stagingDir, manifest };
  } catch (error) {
    markFailed(stagingDir, now, error);
    throw error;
  }
}

export function validateMigrationStage({ stagingDir, now } = {}) {
  const root = absolutePath(stagingDir, "stagingDir");
  assertDirectory(root, "staging directory");
  const state = readState(root);
  if (state.state !== "staging" && state.state !== "validated") {
    fail("MIGRATION_STAGING_INVALID", `staging state ${state.state} cannot be validated`);
  }
  const manifest = readJson(path.join(root, "manifest.json"), "migration manifest", 16 * 1024 * 1024, false);
  if (!isRecord(manifest) || manifest.manifestVersion !== 1 || typeof manifest.sourceFingerprint !== "string") {
    fail("MIGRATION_STAGING_INVALID", "migration manifest is invalid");
  }
  try {
    const observed = compareStagedFiles(path.join(root, "data"), manifest);
    writeState(root, "validated", now, { sourceFingerprint: manifest.sourceFingerprint, validatedAt: typeof now === "string" ? now : new Date().toISOString() });
    return { state: "validated", stagingDir: root, manifest, observed };
  } catch (error) {
    markFailed(root, now, error);
    if (error instanceof MigrationError) throw error;
    fail("MIGRATION_STAGING_INVALID", String(error?.message || error));
  }
}

function assertTargetEmpty(targetDir) {
  if (!fs.existsSync(targetDir)) return false;
  let stat;
  try { stat = fs.lstatSync(targetDir); } catch (error) {
    fail("MIGRATION_TARGET_INVALID", "target directory cannot be inspected", { cause: error?.code || error?.message });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("MIGRATION_TARGET_INVALID", "target path is not a regular directory");
  if (fs.readdirSync(targetDir).length > 0) fail("MIGRATION_TARGET_NOT_EMPTY", "target directory is not empty");
  return true;
}

function walkTargetFiles(root, current, files) {
  const directory = current ? safeJoin(root, current, "target directory") : root;
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (error) {
    fail("MIGRATION_TARGET_INVALID", "target directory cannot be listed", { cause: error?.code || error?.message });
  }
  for (const entry of entries) {
    const relative = current ? `${current}/${entry.name}` : entry.name;
    const normalized = safeRelativePath(relative, "target entry");
    if (normalized === "migration" || normalized.startsWith("migration/")) continue;
    const target = safeJoin(root, normalized, "target entry");
    let stat;
    try { stat = fs.lstatSync(target); } catch (error) {
      fail("MIGRATION_TARGET_INVALID", `target entry ${normalized} cannot be inspected`, { cause: error?.code || error?.message });
    }
    if (stat.isSymbolicLink()) fail("MIGRATION_TARGET_INVALID", `target entry ${normalized} is a symlink or junction`);
    if (stat.isDirectory()) {
      walkTargetFiles(root, normalized, files);
    } else if (stat.isFile()) {
      files.push({ path: normalized, size: stat.size, sha256: hashFile(target) });
    } else {
      fail("MIGRATION_TARGET_INVALID", `target entry ${normalized} is not a regular file or directory`);
    }
  }
}

export function previewMigrationTarget({ stagingDir, targetDir } = {}) {
  const staging = absolutePath(stagingDir, "stagingDir");
  const target = absolutePath(targetDir, "targetDir");
  const state = readState(staging);
  if (state.state !== "staging" && state.state !== "validated") {
    fail("MIGRATION_STAGING_INVALID", `staging state ${state.state} cannot be previewed`);
  }
  const manifest = readJson(path.join(staging, "manifest.json"), "migration manifest", 16 * 1024 * 1024, false);
  if (!isRecord(manifest) || !Array.isArray(manifest.files)) fail("MIGRATION_STAGING_INVALID", "migration manifest is invalid");
  const expected = [...manifest.files].sort((left, right) => left.path.localeCompare(right.path));
  if (!fs.existsSync(target)) {
    return {
      targetState: "missing",
      canCommit: true,
      missingInTarget: expected.map((entry) => entry.path),
      unchanged: [],
      conflicts: [],
      extraTargetFiles: [],
    };
  }
  const targetStat = fs.lstatSync(target);
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) fail("MIGRATION_TARGET_INVALID", "target path is not a regular directory");
  const actual = [];
  walkTargetFiles(target, "", actual);
  actual.sort((left, right) => left.path.localeCompare(right.path));
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  const missingInTarget = [];
  const unchanged = [];
  const conflicts = [];
  for (const entry of expected) {
    const current = actualByPath.get(entry.path);
    if (!current) {
      missingInTarget.push(entry.path);
    } else if (current.size === entry.size && current.sha256 === entry.sha256) {
      unchanged.push(entry.path);
    } else {
      conflicts.push(entry.path);
    }
  }
  const expectedPaths = new Set(expected.map((entry) => entry.path));
  const extraTargetFiles = actual.filter((entry) => !expectedPaths.has(entry.path)).map((entry) => entry.path);
  const targetState = actual.length ? "non_empty" : "empty";
  return {
    targetState,
    canCommit: targetState === "empty",
    missingInTarget,
    unchanged,
    conflicts,
    extraTargetFiles,
  };
}

function assertSameVolume(sourcePath, targetParent) {
  let sourceStat;
  let targetStat;
  try {
    sourceStat = fs.statSync(sourcePath);
    targetStat = fs.statSync(targetParent);
  } catch (error) {
    fail("MIGRATION_TARGET_INVALID", "staging and target volumes cannot be inspected", { cause: error?.code || error?.message });
  }
  if (typeof sourceStat.dev === "number" && typeof targetStat.dev === "number" && sourceStat.dev !== targetStat.dev) {
    fail("MIGRATION_CROSS_VOLUME", "staging and target must be on the same volume");
  }
}

export function commitMigration({ stagingDir, targetDir, now } = {}) {
  const staging = absolutePath(stagingDir, "stagingDir");
  const target = absolutePath(targetDir, "targetDir");
  const state = readState(staging);
  if (state.state !== "validated") fail("MIGRATION_NOT_VALIDATED", "only validated staging can be committed");
  const parent = path.dirname(target);
  assertDirectory(parent, "target parent");
  assertNoSymlinkAncestors(parent);
  const dataDir = path.join(staging, "data");
  let targetWasEmpty = false;
  let publishDir = null;
  let movedToPublish = false;
  let committed = false;
  try {
    targetWasEmpty = assertTargetEmpty(target);
    const validated = validateMigrationStage({ stagingDir: staging, now });
    assertSameVolume(validated.stagingDir, parent);
    const receipt = {
      format: "hana-paper-reader-migration-receipt",
      version: 1,
      state: "committed",
      migrationId: path.basename(staging),
      sourceFingerprint: validated.manifest.sourceFingerprint,
      sourceStorageLayout: validated.manifest.storageLayout,
      sourceSchemaVersion: validated.manifest.schemaVersion,
      sourceFileCount: validated.manifest.files.length,
      sourceTotalBytes: validated.manifest.totalBytes,
      excluded: validated.manifest.excluded.map(({ path: relative, reason, size }) => ({ path: relative, reason, size })),
      paperHashes: validated.manifest.paperHashes,
      counts: validated.manifest.counts,
      committedAt: typeof now === "string" ? now : new Date().toISOString(),
      sensitiveConfigCopied: false,
    };
    writeJson(path.join(dataDir, "migration", "receipt.json"), receipt);
    publishDir = path.join(parent, `.hana-paper-reader-migration-${path.basename(staging)}-${randomUUID()}`);
    assertNoSymlinkAncestors(publishDir);
    fs.renameSync(dataDir, publishDir);
    movedToPublish = true;
    if (targetWasEmpty) fs.rmdirSync(target);
    fs.renameSync(publishDir, target);
    committed = true;
    writeState(staging, "committed", now, { sourceFingerprint: receipt.sourceFingerprint, committedAt: receipt.committedAt });
    return receipt;
  } catch (error) {
    if (movedToPublish && !committed && publishDir && fs.existsSync(publishDir) && !fs.existsSync(dataDir)) {
      try { fs.renameSync(publishDir, dataDir); } catch {}
    }
    markFailed(staging, now, error);
    throw error;
  }
}
