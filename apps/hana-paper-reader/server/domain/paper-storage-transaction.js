import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { verifyNoSymlinks } from "./paper-path-guard.js";

const JOURNALS = ".storage-transactions";
const LOCK = ".storage-write-lock.json";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHARD = /^papers\/[a-f0-9]{12,128}\/(?:paper|research|translations|tasks)\.json$/;
const CACHE = /^mineru-cache\/[a-f0-9]{24}\/(.+)$/;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const error = (code, message) => Object.assign(new Error(message), { code, status: 503 });
const recoveryError = () => error("workspace_recovery_required", "工作区事务无法自动恢复，原记录已保留，请检查备份和存储权限");

function syncFile(file) {
  const descriptor = fs.openSync(file, "r+");
  try { fs.fsyncSync(descriptor); }
  catch (cause) {
    // The host's Permission Model forbids only the synchronous fd API.
    // Synchronous startup recovery retains its process-crash journal ordering;
    // normal writes await the permitted FileHandle.sync API below.
    if (cause.code !== "ERR_ACCESS_DENIED" || !/fsync API is disabled when Permission Model is enabled/.test(cause.message)) throw cause;
  } finally { fs.closeSync(descriptor); }
}

function drainSync(steps) {
  let next = steps.next();
  while (!next.done) {
    try { syncFile(next.value); next = steps.next(); }
    catch (cause) { next = steps.throw(cause); }
  }
  return next.value;
}

async function drainAsync(steps) {
  let next = steps.next();
  while (!next.done) {
    try {
      const handle = await fs.promises.open(next.value, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      next = steps.next();
    } catch (cause) { next = steps.throw(cause); }
  }
  return next.value;
}

function fileHash(file) {
  const descriptor = fs.openSync(file, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(256 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes));
    return hash.digest("hex");
  } finally { fs.closeSync(descriptor); }
}

function allowedRelative(relative, indexName) {
  if (typeof relative !== "string" || relative.length > 1200 || /[\\:\x00-\x1f<>"|?*]/.test(relative)) throw recoveryError();
  const parts = relative.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[. ]$/.test(part)
    || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) throw recoveryError();
  if (relative !== indexName && !SHARD.test(relative) && !CACHE.test(relative)) throw recoveryError();
  return relative;
}

function resolveTarget(root, relative, indexName) {
  allowedRelative(relative, indexName);
  const target = path.resolve(root, ...relative.split("/"));
  if (!target.startsWith(root + path.sep)) throw recoveryError();
  verifyNoSymlinks(target, root);
  return target;
}

function lockOwner(file, root) {
  verifyNoSymlinks(file, root);
  if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 4096) throw recoveryError();
  let owner;
  try { owner = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw recoveryError(); }
  if (owner?.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || !UUID.test(owner.id || "")) throw recoveryError();
  return owner;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (cause) { return cause.code !== "ESRCH"; } // Unknown liveness fails closed.
}

function acquire(root) {
  verifyNoSymlinks(root, root);
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, LOCK);
  const owner = { version: 1, pid: process.pid, id: randomUUID() };
  const temporary = path.join(root, `.storage-write-lock.${owner.pid}.${owner.id}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(owner), { flag: "wx" });
    syncFile(temporary);
    for (let attempt = 0; attempt < 3; attempt++) {
      verifyNoSymlinks(file, root);
      try { fs.linkSync(temporary, file); return { file, owner }; }
      catch (cause) {
        if (cause.code !== "EEXIST") throw cause;
        let prior;
        try { prior = lockOwner(file, root); }
        catch (readError) { if (readError.code === "ENOENT") continue; throw readError; }
        if (processAlive(prior.pid)) throw error("workspace_storage_busy", "工作区正在写入，请稍后重试");
        // Serialize reclamation for this exact dead lease. Without this ticket
        // two reclaimers could delete a newly acquired live writer's lock.
        const ticket = path.join(root, `.storage-reclaim-${prior.id}.json`);
        verifyNoSymlinks(ticket, root);
        try { fs.linkSync(temporary, ticket); }
        catch (ticketError) {
          if (ticketError.code !== "EEXIST") throw ticketError;
          const claimant = lockOwner(ticket, root);
          if (processAlive(claimant.pid)) throw error("workspace_storage_busy", "工作区正在接管已退出的写入进程，请稍后重试");
          throw recoveryError(); // An interrupted reclamation needs inspection.
        }
        try {
          let current;
          try { current = lockOwner(file, root); } catch (readError) { if (readError.code !== "ENOENT") throw readError; }
          if (current && current.id !== prior.id) continue;
          if (current && processAlive(current.pid)) throw error("workspace_storage_busy", "工作区正在写入，请稍后重试");
          if (current) fs.unlinkSync(file);
          try { fs.linkSync(temporary, file); return { file, owner }; }
          catch (linkError) { if (linkError.code !== "EEXIST") throw linkError; }
        } finally { if (lockOwner(ticket, root).id === owner.id) fs.unlinkSync(ticket); }
      }
    }
    throw error("workspace_storage_busy", "工作区写入锁正在变化，请稍后重试");
  } finally { if (fs.existsSync(temporary)) { verifyNoSymlinks(temporary, root); fs.unlinkSync(temporary); } }
}

function release(root, lock) {
  if (lockOwner(lock.file, root).id !== lock.owner.id) throw recoveryError();
  fs.unlinkSync(lock.file);
}

function journalPath(root, id) {
  if (!UUID.test(id || "")) throw recoveryError();
  const parent = path.join(root, JOURNALS);
  const directory = path.resolve(parent, id);
  if (path.dirname(directory) !== parent) throw recoveryError();
  verifyNoSymlinks(directory, root);
  return directory;
}

function cleanJournal(root, id) {
  const directory = journalPath(root, id);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^(?:\d+\.(?:before|after)|manifest\.json(?:\.tmp)?)$/.test(entry.name)) throw recoveryError();
    const file = path.join(directory, entry.name); verifyNoSymlinks(file, root); fs.unlinkSync(file);
  }
  fs.rmdirSync(directory);
  try { fs.rmdirSync(path.join(root, JOURNALS)); } catch (cause) { if (!["ENOTEMPTY", "ENOENT", "EEXIST"].includes(cause.code)) throw cause; }
}

function* publishSteps(directory, manifest, onPublished = null) {
  const temporary = path.join(directory, "manifest.json.tmp");
  fs.writeFileSync(temporary, JSON.stringify(manifest)); yield temporary;
  const final = path.join(directory, "manifest.json");
  fs.renameSync(temporary, final);
  if (onPublished) onPublished();
  yield final;
}

function publishManifest(directory, manifest) { drainSync(publishSteps(directory, manifest)); }

function readManifest(root, id, indexName) {
  const directory = journalPath(root, id);
  const file = path.join(directory, "manifest.json");
  if (!fs.existsSync(file)) return null; // No targets are changed before publishing this file.
  verifyNoSymlinks(file, root);
  if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 32 * 1024 * 1024) throw recoveryError();
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw recoveryError(); }
  if (manifest?.version !== 1 || manifest.id !== id || !["prepared", "committed", "rolled-back"].includes(manifest.state)
      || !Array.isArray(manifest.operations) || !Array.isArray(manifest.createdDirectories)) throw recoveryError();
  const seen = new Set();
  for (const [number, op] of manifest.operations.entries()) {
    resolveTarget(root, op?.path, indexName);
    if (seen.has(op.path.toLowerCase()) || typeof op.existed !== "boolean" || !/^[a-f0-9]{64}$/.test(op.afterHash || "") || !op.existed && op.beforeHash !== null
        || op.existed && !/^[a-f0-9]{64}$/.test(op.beforeHash || "")) throw recoveryError();
    seen.add(op.path.toLowerCase());
    for (const suffix of op.existed ? ["before", "after"] : ["after"]) {
      const bytes = path.join(directory, `${number}.${suffix}`); verifyNoSymlinks(bytes, root);
      if (!fs.existsSync(bytes)) { if (manifest.state === "prepared") throw recoveryError(); else continue; }
      if (!fs.lstatSync(bytes).isFile() || fileHash(bytes) !== op[`${suffix}Hash`]) throw recoveryError();
    }
  }
  for (const relative of manifest.createdDirectories) {
    if (typeof relative !== "string" || !manifest.operations.some(op => op.path.startsWith(relative + "/"))) throw recoveryError();
    // Validate through one of its declared file descendants before rmdir.
    resolveTarget(root, manifest.operations.find(op => op.path.startsWith(relative + "/")).path, indexName);
  }
  return manifest;
}

function destinationHash(root, op, indexName) {
  const file = resolveTarget(root, op.path, indexName);
  if (!fs.existsSync(file)) return null;
  if (!fs.lstatSync(file).isFile()) throw recoveryError();
  return fileHash(file);
}

function targetTemporary(root, op, id, indexName) {
  return `${resolveTarget(root, op.path, indexName)}.storage-${id}.tmp`;
}

function retireTemporary(root, op, id, indexName) {
  const file = targetTemporary(root, op, id, indexName); verifyNoSymlinks(file, root);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

function* rollbackSteps(root, manifest, indexName) {
  // Validate ALL destinations before restoring any, preserving unrelated edits.
  const directory = journalPath(root, manifest.id);
  for (const [number, op] of manifest.operations.entries()) {
    if (op.existed && fileHash(path.join(directory, `${number}.before`)) !== op.beforeHash) throw recoveryError();
  }
  for (const op of manifest.operations) {
    const current = destinationHash(root, op, indexName);
    if (current !== null && current !== op.afterHash && (!op.existed || current !== op.beforeHash)) throw recoveryError();
  }
  for (const [number, op] of manifest.operations.entries()) {
    const target = resolveTarget(root, op.path, indexName);
    retireTemporary(root, op, manifest.id, indexName);
    if (op.existed) {
      if (destinationHash(root, op, indexName) === op.beforeHash) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temporary = targetTemporary(root, op, manifest.id, indexName);
      fs.copyFileSync(path.join(directory, `${number}.before`), temporary, fs.constants.COPYFILE_EXCL); yield temporary;
      fs.renameSync(temporary, target); yield target;
    } else if (fs.existsSync(target)) fs.unlinkSync(target);
  }
  for (const relative of [...manifest.createdDirectories].sort((a, b) => b.length - a.length)) {
    const directory = path.resolve(root, ...relative.split("/"));
    if (!directory.startsWith(root + path.sep)) throw recoveryError();
    verifyNoSymlinks(directory, root);
    try { fs.rmdirSync(directory); } catch (cause) { if (!["ENOTEMPTY", "ENOENT", "EEXIST"].includes(cause.code)) throw cause; }
  }
}

function rollback(root, manifest, indexName) { drainSync(rollbackSteps(root, manifest, indexName)); }

function recoverOwned(root, indexName) {
  const parent = path.join(root, JOURNALS); verifyNoSymlinks(parent, root);
  if (!fs.existsSync(parent)) return;
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) throw recoveryError();
    const manifest = readManifest(root, entry.name, indexName);
    if (manifest?.state === "prepared") {
      rollback(root, manifest, indexName);
      manifest.state = "rolled-back"; publishManifest(journalPath(root, manifest.id), manifest);
    }
    if (manifest?.state === "committed") {
      for (const op of manifest.operations) {
        if (destinationHash(root, op, indexName) !== op.afterHash) throw recoveryError();
        retireTemporary(root, op, manifest.id, indexName);
      }
    }
    if (manifest?.state === "rolled-back") {
      for (const op of manifest.operations) {
        if (destinationHash(root, op, indexName) !== op.beforeHash) throw recoveryError();
        retireTemporary(root, op, manifest.id, indexName);
      }
    }
    cleanJournal(root, entry.name);
  }
}

export function recoverStorageTransactions(rootDir, indexPath) {
  const root = path.resolve(rootDir);
  if (!fs.existsSync(path.join(root, JOURNALS)) && !fs.existsSync(path.join(root, LOCK))) return;
  const lock = acquire(root);
  try { recoverOwned(root, path.basename(indexPath)); } finally { release(root, lock); }
}

export function withStorageRead(rootDir, indexPath, read) {
  const root = path.resolve(rootDir);
  verifyNoSymlinks(root, root);
  if (!fs.existsSync(root)) return read();
  // Keep a single synchronous snapshot across the index and every shard.
  // A live writer is busy; a dead writer is recovered before any data escapes.
  const lock = acquire(root);
  try {
    recoverOwned(root, path.basename(indexPath));
    return read();
  } finally { release(root, lock); }
}

function* transactionSteps(rootDir, indexPath, prepare) {
  const root = path.resolve(rootDir);
  const indexName = path.basename(indexPath);
  const lock = acquire(root);
  let manifest = null;
  let id = null;
  let committed = false;
  let failure = null;
  try {
    yield lock.file;
    recoverOwned(root, indexName);
    const operations = prepare();
    id = randomUUID();
    const directory = journalPath(root, id); fs.mkdirSync(directory, { recursive: true });
    const entries = [];
    const missingDirectories = new Set();
    const seen = new Set();
    for (const operation of operations) {
      const relative = path.relative(root, operation.filePath).split(path.sep).join("/");
      const target = resolveTarget(root, relative, indexName);
      if (seen.has(relative.toLowerCase())) throw recoveryError(); seen.add(relative.toLowerCase());
      const existed = fs.existsSync(target);
      if (existed && !fs.lstatSync(target).isFile()) throw recoveryError();
      const beforeHash = existed ? fileHash(target) : null;
      const afterHash = sha(operation.content);
      if (operation.requireAbsentOrIdentical && existed && beforeHash !== afterHash) throw error("backup_asset_conflict", "已有缓存资源不同，无法覆盖");
      if (existed && beforeHash === afterHash) continue;
      const number = entries.length;
      const staged = path.join(directory, `${number}.after`);
      fs.writeFileSync(staged, operation.content, { flag: "wx" }); yield staged;
      if (existed) {
        const prior = path.join(directory, `${number}.before`); fs.copyFileSync(target, prior, fs.constants.COPYFILE_EXCL); yield prior;
        if (fileHash(prior) !== beforeHash) throw recoveryError();
      }
      for (let parent = path.dirname(target); parent !== root && !fs.existsSync(parent); parent = path.dirname(parent)) {
        missingDirectories.add(path.relative(root, parent).split(path.sep).join("/"));
      }
      const op = { path: relative, existed, beforeHash, afterHash };
      if (fs.existsSync(targetTemporary(root, op, id, indexName))) throw recoveryError();
      entries.push(op);
    }
    manifest = { version: 1, id, state: "prepared", operations: entries, createdDirectories: [...missingDirectories] };
    yield* publishSteps(directory, manifest);
    for (const [number, op] of manifest.operations.entries()) {
      if (destinationHash(root, op, indexName) !== op.beforeHash) throw recoveryError();
      if (op.existed && op.beforeHash === op.afterHash) continue;
      const target = resolveTarget(root, op.path, indexName);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temporary = targetTemporary(root, op, id, indexName);
      fs.copyFileSync(path.join(directory, `${number}.after`), temporary, fs.constants.COPYFILE_EXCL); yield temporary;
      if (fileHash(temporary) !== op.afterHash) throw recoveryError();
      fs.renameSync(temporary, target); yield target;
    }
    manifest.state = "committed";
    yield* publishSteps(directory, manifest, () => { committed = true; });
    // Once the commit marker is visible, recovery must keep the new version.
    // A failure of its final flush is uncertain, not permission to roll back.
    try { cleanJournal(root, id); } catch { /* Retain the committed journal for recovery. */ }
    const stat = fs.statSync(indexPath);
    return { indexToken: fileHash(indexPath), stamp: `${stat.mtimeMs}:${stat.size}` };
  } catch (cause) {
    failure = committed
      ? Object.assign(error("workspace_commit_uncertain", "提交标记已发布，但最终持久化未确认，请重新载入工作区核对结果"), { cause })
      : cause;
    if (!committed && id) {
      try {
        if (manifest) {
          yield* rollbackSteps(root, manifest, indexName);
          manifest.state = "rolled-back"; yield* publishSteps(journalPath(root, id), manifest);
        }
        try { cleanJournal(root, id); } catch { /* Completed rollback marker permits safe later cleanup. */ }
      } catch (rollbackError) {
        failure = Object.assign(error("workspace_rollback_failed", "工作区回滚未完成，事务记录已保留"), { cause: rollbackError });
        throw failure;
      }
    }
    throw failure;
  } finally {
    try { release(root, lock); }
    catch (releaseError) {
      if (!failure) throw Object.assign(error(committed ? "workspace_commit_uncertain" : "workspace_storage_busy",
        committed ? "数据已写入，但事务锁未能释放，请保留事务记录并重新检查工作区" : "工作区事务锁无法释放，请稍后检查"), { cause: releaseError });
    }
  }
}

export function runStorageTransaction(rootDir, indexPath, prepare) {
  return drainSync(transactionSteps(rootDir, indexPath, prepare));
}

export async function runStorageTransactionAsync(rootDir, indexPath, prepare) {
  return drainAsync(transactionSteps(rootDir, indexPath, prepare));
}
