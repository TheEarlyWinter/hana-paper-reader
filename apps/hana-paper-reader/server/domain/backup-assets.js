import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { assertCacheId } from "./paper-identity.js";
import { verifyNoSymlinks } from "./paper-path-guard.js";

export const MAX_BACKUP_ASSET_BYTES = 32 * 1024 * 1024;
export const MAX_BACKUP_TOTAL_ASSET_BYTES = 256 * 1024 * 1024;
export const MAX_BACKUP_ASSETS = 2000;
const invalid = () => Object.assign(new Error("backup assets are invalid"), { code: "backup_invalid" });
const tooLarge = () => Object.assign(new Error("backup assets exceed size limits"), { code: "backup_too_large" });
const unavailable = () => Object.assign(new Error("complete backup resources are unavailable"), { code: "backup_assets_unavailable" });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

export function safeBackupAssetPath(value) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 1000) throw invalid();
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /[\u0000-\u001f<>:"|?*]/.test(normalized)) throw invalid();
  const parts = normalized.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[. ]$/.test(part)
      || /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(part))) throw invalid();
  return parts.join("/");
}

export function backupAssetKey(cacheId, relative) {
  // A backup must also have an unambiguous destination on Windows.
  return assertCacheId(cacheId) + ":" + safeBackupAssetPath(relative).toLowerCase();
}

function referencedAssets(paper) {
  const required = new Set();
  for (const block of paper?.blocks || []) {
    const ref = block?.assetRef;
    if (ref === null || ref === undefined) continue;
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) throw invalid();
    required.add(backupAssetKey(ref.cacheId, ref.path));
  }
  return required;
}

export function captureBackupAssets({ dataDir, paper, includeAssets = true }) {
  if (!includeAssets) return { assetMode: "omitted", assets: [] };
  try {
    const required = referencedAssets(paper), assets = [], captured = new Set();
    const cacheIds = [...new Set([...required].map(key => key.slice(0, 24)))];
    const base = path.join(dataDir, "mineru-cache");
    let totalBytes = 0;
    for (const cacheId of cacheIds) {
      verifyNoSymlinks(base, dataDir);
      const root = path.join(base, cacheId), stack = [root];
      while (stack.length) {
        const directory = stack.pop();
        verifyNoSymlinks(directory, base);
        const directoryStat = fs.lstatSync(directory);
        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw unavailable();
        const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          if (entry.isSymbolicLink()) throw unavailable();
          const target = path.join(directory, entry.name);
          verifyNoSymlinks(target, root);
          const before = fs.lstatSync(target);
          if (before.isSymbolicLink()) throw unavailable();
          const relative = safeBackupAssetPath(path.relative(root, target).replace(/\\/g, "/"));
          if (before.isDirectory()) { stack.push(target); continue; }
          if (!before.isFile()) throw unavailable();
          if (assets.length >= MAX_BACKUP_ASSETS || before.size > MAX_BACKUP_ASSET_BYTES
              || totalBytes + before.size > MAX_BACKUP_TOTAL_ASSET_BYTES) throw tooLarge();
          const key = backupAssetKey(cacheId, relative);
          if (captured.has(key)) throw unavailable();
          const bytes = fs.readFileSync(target), after = fs.lstatSync(target);
          if (!after.isFile() || after.isSymbolicLink() || before.size !== bytes.length
              || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
              || before.dev !== after.dev || before.ino !== after.ino) throw unavailable();
          if (bytes.length > MAX_BACKUP_ASSET_BYTES || totalBytes + bytes.length > MAX_BACKUP_TOTAL_ASSET_BYTES) throw tooLarge();
          totalBytes += bytes.length; captured.add(key);
          assets.push({ cacheId, path: relative, data: bytes.toString("base64"), size: bytes.length, sha256: digest(bytes) });
        }
      }
    }
    if ([...required].some(key => !captured.has(key))) throw unavailable();
    return { assetMode: "included", assets };
  } catch (error) {
    if (error?.code === "backup_too_large") throw error;
    throw unavailable();
  }
}

export function decodeBackupAsset(asset, { requireIntegrity = false } = {}) {
  const encoded = asset?.data;
  if (typeof encoded !== "string" || encoded.length > Math.ceil(MAX_BACKUP_ASSET_BYTES / 3) * 4
      || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw invalid();
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_BACKUP_ASSET_BYTES || bytes.toString("base64") !== encoded) throw invalid();
  const hasIntegrity = requireIntegrity || asset.size !== undefined || asset.sha256 !== undefined;
  if (hasIntegrity) {
    if (!Number.isSafeInteger(asset.size) || asset.size < 0 || asset.size !== bytes.length
        || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(asset.sha256)
        || asset.sha256.toLowerCase() !== digest(bytes)) throw invalid();
  } else if (!bytes.length) throw invalid(); // Preserve the legacy nonempty encoding contract.
  return bytes;
}

export function validateBackupAssetMode(input) {
  if (input.assetMode === undefined) return;
  if (!["included", "omitted"].includes(input.assetMode) || !Array.isArray(input.assets)
      || input.assetMode === "omitted" && input.assets.length) throw invalid();
}

export function validateBackupAssetCoverage(input, paper, seenAssets) {
  if (input.assetMode !== "included") return;
  try {
    if ([...referencedAssets(paper)].some(key => !seenAssets.has(key))) throw invalid();
  } catch { throw invalid(); }
}
