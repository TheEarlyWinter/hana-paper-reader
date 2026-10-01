import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createPaperWorkspace } from "../domain/paper-workspace.js";
import { assertPaperHash, assertCacheId, assertTranslationCacheKey, safeId } from "../domain/paper-identity.js";
import { verifyNoSymlinks } from "../domain/paper-path-guard.js";
import { decodeBackupAsset, validateBackupAssetMode, validateBackupAssetCoverage, backupAssetKey } from "../domain/backup-assets.js";
import { validateMigrationReceipt, isMigrationHash, isMigrationPlanId } from "../../ui/assets/migration-receipt.js";

export const MAX_MIGRATION_BYTES = 256 * 1024 * 1024;
const digest = v => createHash("sha256").update(v).digest("hex");
const receiptReadToken = Symbol("migration-receipt-read-token");
const migrationJobs = globalThis[Symbol.for("hana-paper-reader.migration-jobs")] ||= new Map();
export class MigrationImportError extends Error {
  constructor(code, message, status = 400) { super(message); Object.assign(this, { code, status }); }
}
const fail = (code, message, status) => { throw new MigrationImportError(code, message, status); };
const object = v => v && typeof v === "object" && !Array.isArray(v);
function canonicalReceipt(value, depth = 0) {
  if (depth > 32) fail("migration_plan_invalid", "迁移回执嵌套层数无效", 503);
  if (Array.isArray(value)) return value.map(item => canonicalReceipt(item, depth + 1));
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalReceipt(value[key], depth + 1)]));
}
function receiptDigest(state) {
  const { receiptChecksum, ...payload } = state;
  return digest(JSON.stringify(canonicalReceipt(payload)));
}
function paperHash(value, message = "迁移文件含无效论文指纹") {
  try { return assertPaperHash(value); } catch { fail("migration_invalid", message); }
}
function assetPath(value) {
  if (typeof value !== "string" || !value || value.length > 1000 || /[\\:\x00-\x1f<>"|?*]/.test(value)) fail("migration_invalid", "资源路径无效");
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[. ]$/.test(part)
      || /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(part))) fail("migration_invalid", "资源路径无法安全导入 Windows 工作区");
  return value;
}
function sanitize(value, cacheMap, depth = 0) {
  if (depth > 60) fail("migration_invalid", "迁移数据嵌套层数过多");
  if (Array.isArray(value)) return value.map(v => sanitize(v, cacheMap, depth + 1));
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(?:__proto__|constructor|prototype|config|credentials|authorization|headers|token|apiKey|accessToken|refreshToken|secret|password|sessionPath|authorizedFolders|workspaceFolders)$/i.test(key))
    .map(([key, v]) => [key, key === "cacheId" && cacheMap.has(v) ? cacheMap.get(v) : sanitize(v, cacheMap, depth + 1)]));
}
function validateBundle(bundle) {
  if (!object(bundle) || bundle.format !== "hana-paper-reader-migration" || bundle.version !== 1
      || bundle.sensitiveConfigPolicy !== "manual-reentry" || !isMigrationHash(bundle.sourceFingerprint)
      || !Array.isArray(bundle.papers) || bundle.papers.length > 1000) fail("migration_invalid", "不是有效的迁移文件，或论文数超过 1000");
  const seen = new Set();
  let assetTotal = 0;
  return bundle.papers.map(input => {
    if (!object(input)) fail("migration_invalid", "迁移论文记录必须为对象");
    const hash = paperHash(input.paperHash);
    if (seen.has(hash) || input.format !== "hana-paper-reader-backup" || input.version !== 1 || !object(input.paper)
        || paperHash(input.paper.paperHash) !== hash || !Array.isArray(input.paper.blocks)) fail("migration_invalid", "迁移文件有重复论文或结构缺失");
    seen.add(hash);
    if (input.paper.blocks.length > 100000) fail("migration_invalid", "单篇论文的正文块数超过限制");
    const cacheMap = new Map();
    const collectCacheIds = (value, depth = 0) => {
      if (depth > 60) fail("migration_invalid", "论文结构嵌套层数过多");
      if (Array.isArray(value)) value.forEach(v => collectCacheIds(v, depth + 1));
      else if (object(value)) {
        if (typeof value.cacheId === "string") {
          let id; try { id = assertCacheId(value.cacheId); } catch { fail("migration_invalid", "论文资源引用无效"); }
          const replacement = digest(`${bundle.sourceFingerprint}:${id}`).slice(0, 24);
          cacheMap.set(value.cacheId, replacement);
          cacheMap.set(id, replacement);
        }
        Object.values(value).forEach(v => collectCacheIds(v, depth + 1));
      }
    };
    collectCacheIds(input);
    const assets = input.assets || [];
    try { validateBackupAssetMode(input); } catch { fail("migration_invalid", "备份资源模式无效"); }
    if (!Array.isArray(assets) || assets.length > 2000) fail("migration_invalid", "资源数量超过限制");
    const assetKeys = new Set();
    const coveredAssets = new Set();
    for (const asset of assets) {
      if (!object(asset)) fail("migration_invalid", "资源记录必须为对象");
      let id;
      try { id = assertCacheId(asset.cacheId); } catch { fail("migration_invalid", "资源缓存标识无效"); }
      if (asset.cacheId !== id) fail("migration_invalid", "资源缓存标识必须规范化");
      const relative = assetPath(asset.path);
      const key = `${id}/${relative}`.toLowerCase();
      if (assetKeys.has(key)) fail("migration_invalid", "迁移资源路径在 Windows 中重复");
      assetKeys.add(key);
      let bytes;
      try { bytes = decodeBackupAsset(asset, { requireIntegrity: input.assetMode === "included" }); }
      catch { fail("migration_invalid", "资源编码、大小或校验值无效"); }
      coveredAssets.add(backupAssetKey(id, relative));
      assetTotal += bytes.length;
      if (assetTotal > 256 * 1024 * 1024) fail("migration_invalid", "资源总大小超过限制");
      cacheMap.set(id, digest(`${bundle.sourceFingerprint}:${id}`).slice(0, 24));
    }
    try { validateBackupAssetCoverage(input, input.paper, coveredAssets); }
    catch { fail("migration_invalid", "完整备份缺少引用的资源"); }
    const backup = sanitize(input, cacheMap);
    backup.assets = sanitize(assets, cacheMap);
    backup.paperHash = hash; backup.paper.paperHash = hash; backup.expectedRevision = 0;
    const blockIds = new Set();
    backup.paper.blocks = backup.paper.blocks.map((block, index) => {
      if (!object(block)) fail("migration_invalid", "正文块必须为对象");
      const id = block.id ? (typeof block.id === "string" ? block.id.trim() : "") : `block-${index + 1}`;
      if (!id || id.length > 256 || /[\\/\0]/.test(id) || blockIds.has(id)) fail("migration_invalid", "正文块标识无效或重复");
      blockIds.add(id);
      if (block.assetRef && !object(block.assetRef)) fail("migration_invalid", "正文资源引用无效");
      if (block.assetRef?.path) assetPath(block.assetRef.path);
      return { ...block, id };
    });
    for (const collection of ["notes", "bookmarks", "tasks", "translationCache"]) {
      if (!Array.isArray(backup[collection] || [])) fail("migration_invalid", "研究数据格式无效");
      if ((backup[collection] || []).length > 100000) fail("migration_invalid", "研究条目数超过限制");
      const localIds = new Set();
      backup[collection] = (backup[collection] || []).map(item => {
        if (!object(item) || paperHash(item.paperHash) !== hash) fail("migration_invalid", "研究条目的论文指纹不一致");
        if (collection === "translationCache") {
          let key;
          try { key = assertTranslationCacheKey(item.key, hash); } catch { fail("migration_invalid", "翻译缓存键无效"); }
          if (localIds.has(key)) fail("migration_invalid", "翻译缓存键重复");
          localIds.add(key); return item;
        }
        let id;
        try { id = safeId(item.id); } catch { fail("migration_invalid", "研究条目标识无效"); }
        if (localIds.has(id)) fail("migration_invalid", "研究条目标识重复"); localIds.add(id);
        const next = { ...item, id: `mig-${digest(`${collection}:${hash}:${id}`).slice(0, 40)}` };
        if (collection === "tasks" && ["queued", "running"].includes(item.state || item.status)) {
          next.state = "failed"; next.status = "failed"; next.needsRetry = true;
          next.error = "旧任务未在新版本自动恢复，请重新发起";
        }
        return next;
      });
    }
    for (const name of ["progress", "glossary"]) if (backup[name] && (!object(backup[name]) || paperHash(backup[name].paperHash) !== hash)) fail("migration_invalid", "进度或术语表的论文指纹不一致");
    return backup;
  });
}

export function createMigrationImporter(runtime) {
  const root = path.join(runtime.dataDir, "migration", "imports");
  const resolvedRoot = path.resolve(root);
  const jobRoot = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
  const jobKey = id => jobRoot + "\0" + id;
  const workspace = () => runtime.workspace ||= createPaperWorkspace({ dataDir: runtime.dataDir });
  function file(id, name) {
    if (!isMigrationPlanId(id)) fail("migration_plan_invalid", "迁移计划标识无效");
    const target = path.join(root, id, name); verifyNoSymlinks(target, runtime.dataDir); return target;
  }
  function save(id, name, value) {
    const original = value;
    const expectedToken = name === "receipt.json" ? original[receiptReadToken] : null;
    const target = file(id, name);
    const assertReceiptUnchanged = () => {
      if (name !== "receipt.json") return;
      let currentToken = null;
      try { verifyNoSymlinks(target, runtime.dataDir); currentToken = digest(fs.readFileSync(target)); }
      catch (error) { if (error?.code !== "ENOENT") fail("migration_receipt_changed", "迁移回执无法核对，已完成的论文保留；请刷新结果并重新准备原文件", 409); }
      if (expectedToken ? currentToken !== expectedToken : currentToken !== null) {
        fail("migration_receipt_changed", "迁移回执在导入期间发生变化，已完成的论文保留；请刷新结果并重新准备原文件", 409);
      }
    };
    assertReceiptUnchanged();
    if (name === "receipt.json") {
      value = { ...value, integrityVersion: 1 };
      value.receiptChecksum = receiptDigest(value);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const encoded = JSON.stringify(value), temp = `${target}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, encoded, { flag: "wx" }); assertReceiptUnchanged(); fs.renameSync(temp, target);
    if (name === "receipt.json") {
      Object.assign(original, { integrityVersion: value.integrityVersion, receiptChecksum: value.receiptChecksum });
      Object.defineProperty(original, receiptReadToken, { value: digest(encoded), writable: true, configurable: true });
    }
  }
  function read(id, name) {
    const target = file(id, name);
    if (!fs.existsSync(target) || !fs.lstatSync(target).isFile() || fs.statSync(target).size > MAX_MIGRATION_BYTES) fail("migration_plan_invalid", "迁移计划文件缺失或无效", 404);
    try {
      const bytes = fs.readFileSync(target), value = JSON.parse(bytes.toString("utf8"));
      if (name === "receipt.json" && object(value)) Object.defineProperty(value, receiptReadToken, { value: digest(bytes), writable: true, configurable: true });
      return value;
    } catch { fail("migration_plan_invalid", "迁移计划文件损坏", 503); }
  }
  function owned(id, principal) {
    const state = read(id, "receipt.json");
    try { validateMigrationReceipt(state); } catch { fail("migration_plan_invalid", "迁移回执损坏；不会执行导入", 503); }
    if (state.planId !== id || state.state === "interrupted" || !isMigrationHash(state.owner)) fail("migration_plan_invalid", "迁移回执损坏；不会执行导入", 503);
    if (state.owner !== digest(principal)) fail("migration_plan_invalid", "无权访问此迁移计划", 403);
    if (state.integrityVersion !== undefined || state.receiptChecksum !== undefined) {
      if (state.integrityVersion !== 1 || !isMigrationHash(state.receiptChecksum) || receiptDigest(state) !== state.receiptChecksum) {
        fail("migration_plan_invalid", "迁移回执校验失败；不会执行导入", 503);
      }
    } else verifyLegacyReceipt(state);
    return state;
  }
  function publicState(state) {
    const { owner, integrityVersion, receiptChecksum, ...result } = state; return result;
  }
  function verifiedBundle(state) {
    const bundle = read(state.planId, "bundle.json");
    if (!isMigrationHash(state.bundleFingerprint) || digest(JSON.stringify(bundle)) !== state.bundleFingerprint) {
      fail("migration_plan_changed", "迁移暂存数据已改变或缺少完整性记录，请重新选择原迁移文件；没有开始新的导入或导出", 409);
    }
    return bundle;
  }
  function verifyLegacyReceipt(state) {
    const bundle = verifiedBundle(state);
    if (!object(bundle) || bundle.format !== "hana-paper-reader-migration" || bundle.version !== 1
        || bundle.sensitiveConfigPolicy !== "manual-reentry" || bundle.sourceFingerprint !== state.sourceFingerprint
        || !Array.isArray(bundle.papers) || bundle.papers.length !== state.rows.length) fail("migration_plan_invalid", "旧迁移回执与暂存数据不一致；请重新选择原文件", 503);
    for (const [index, backup] of bundle.papers.entries()) {
      const row = state.rows[index];
      if (!object(backup) || backup.paperHash !== row.paperHash || backup.paper?.paperHash !== row.paperHash
          || String(backup.paper?.metadata?.title || "未命名论文").slice(0, 300) !== row.title
          || !["notes", "bookmarks", "tasks", "assets"].every(key => Array.isArray(backup[key]) && backup[key].length === row[key])) {
        fail("migration_plan_invalid", "旧迁移预览与暂存数据不一致；请重新选择原文件", 503);
      }
    }
  }
  function preview(backups) {
    const existing = workspace().load().papers;
    return backups.map(backup => ({ paperHash: backup.paperHash, title: String(backup.paper.metadata?.title || "未命名论文").slice(0, 300),
      action: existing[backup.paperHash] ? "keep-target-isolate-source" : "import", notes: backup.notes.length, bookmarks: backup.bookmarks.length,
      tasks: backup.tasks.length, assets: backup.assets.length }));
  }
  function prepare(principal, bundle) {
    const backups = validateBundle(bundle);
    const rows = preview(backups);
    const id = randomUUID();
    const state = { format: "hana-paper-reader-migration-receipt", version: 1, planId: id, owner: digest(principal),
      sourceFingerprint: bundle.sourceFingerprint, state: "prepared", policy: "keep-target-isolate-source",
      createdAt: new Date().toISOString(), rows, imported: [], kept: [], failed: [], acceptance: "not-performed" };
    const preparedBundle = { format: bundle.format, version: bundle.version, sourceFingerprint: bundle.sourceFingerprint,
      sensitiveConfigPolicy: "manual-reentry", papers: backups };
    state.bundleFingerprint = digest(JSON.stringify(preparedBundle));
    save(id, "bundle.json", preparedBundle); save(id, "receipt.json", state);
    return publicState(state);
  }
  async function commit(principal, id) {
    owned(id, principal);
    const key = jobKey(id);
    if (migrationJobs.has(key)) return publicState(owned(id, principal));
    const operation = (async () => {
      const state = owned(id, principal);
      if (state.state !== "prepared") return publicState(state);
      const bundle = verifiedBundle(state);
      state.state = "importing"; save(id, "receipt.json", state);
      for (const backup of bundle.papers) {
        const hash = backup.paperHash;
        // State survives host restarts. Interrupted plans never blindly retry.
        state.currentPaper = hash; save(id, "receipt.json", state);
        try {
          if (workspace().load().papers[hash]) { state.kept.push(hash); continue; }
          await workspace().restoreBackup(backup, { requireAbsent: true });
          state.imported.push(hash);
        } catch (error) {
          if (error?.code === "paper_conflict") state.kept.push(hash);
          else { state.failed.push({ paperHash: hash, code: "migration_paper_failed" }); state.state = "partial"; break; }
        } finally { delete state.currentPaper; save(id, "receipt.json", state); }
      }
      if (state.state === "importing") state.state = "completed";
      state.finishedAt = new Date().toISOString(); save(id, "receipt.json", state);
      return publicState(state);
    })();
    migrationJobs.set(key, operation);
    try { return await operation; } finally { if (migrationJobs.get(key) === operation) migrationJobs.delete(key); }
  }
  function status(principal, id) {
    const state = owned(id, principal);
    if (state.state === "importing" && !migrationJobs.has(jobKey(id))) return { ...publicState(state), state: "interrupted", message: "迁移被中断，已导入论文保留。重新准备原文件会跳过已存在论文；不会覆盖或自动重放。" };
    return publicState(state);
  }
  function isolated(principal, id, hash) {
    const state = owned(id, principal);
    const canonical = assertPaperHash(hash);
    if (!state.rows.some(row => row.paperHash === canonical)) fail("migration_paper_invalid", "迁移计划中没有此论文", 404);
    const backup = verifiedBundle(state).papers.find(paper => paper.paperHash === canonical);
    // Export a regular per-paper backup for an explicit, later replacement.
    const { expectedRevision, ...result } = backup; return result;
  }
  return { prepare, commit, status, isolated };
}
