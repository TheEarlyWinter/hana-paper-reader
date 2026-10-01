#!/usr/bin/env node
// User-invoked migration preparation. Reads an explicitly supplied, frozen
// business snapshot only; never guesses a live plugin-data or credentials path.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { inspectMigrationSource, validateMigrationApproval } from "../apps/hana-paper-reader/server/migration/migration-plan.js";
import { verifyNoSymlinks } from "../apps/hana-paper-reader/server/domain/paper-path-guard.js";
const args = process.argv.slice(2);
const flags = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!["--source", "--out", "--approval"].includes(args[i]) || !args[i + 1] || flags.has(args[i])) throw new Error("Usage: node tools/prepare-migration.mjs --source <frozen-snapshot> --approval <approval.json> --out <new-file.migration.json>");
  flags.set(args[i], args[i + 1]);
}
for (const key of ["--source", "--out", "--approval"]) if (!path.isAbsolute(flags.get(key) || "")) throw new Error(`${key} must be absolute`);
const source = path.resolve(flags.get("--source"));
const output = path.resolve(flags.get("--out"));
const relative = path.relative(source, output);
if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Output must be outside the immutable source snapshot");
const approvalFile = flags.get("--approval");
if (fs.lstatSync(approvalFile).isSymbolicLink() || fs.statSync(approvalFile).size > 65536) throw new Error("Approval must be a small regular JSON file");
const approval = validateMigrationApproval(JSON.parse(fs.readFileSync(approvalFile, "utf8")), source);
const manifest = inspectMigrationSource(source);
const read = relative => {
  const file = path.join(source, ...relative.split("/"));
  verifyNoSymlinks(file, source);
  return JSON.parse(fs.readFileSync(file, "utf8"));
};
const sanitize = value => {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:__proto__|constructor|prototype|config|credentials|authorization|headers|token|apiKey|accessToken|refreshToken|secret|password|sessionPath|authorizedFolders|workspaceFolders)$/i.test(key)).map(([key, item]) => [key, sanitize(item)]));
};
const records = (object, hash) => Object.entries(object || {}).map(([id, value]) => ({ ...sanitize(value), id: value.id || id, paperHash: hash }));
let bytesTotal = 0;
const papers = manifest.paperHashes.map(hash => {
  const prefix = `papers/${hash}`;
  const paper = sanitize(read(`${prefix}/paper.json`));
  const research = sanitize(read(`${prefix}/research.json`));
  const translations = sanitize(read(`${prefix}/translations.json`));
  const tasks = read(`${prefix}/tasks.json`);
  const cacheIds = new Set();
  const collect = value => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") { if (/^[a-f0-9]{24}$/i.test(value.cacheId || "")) cacheIds.add(value.cacheId.toLowerCase()); Object.values(value).forEach(collect); }
  };
  collect(paper);
  collect(research);
  const assets = [];
  for (const entry of manifest.files) {
    const match = /^mineru-cache\/([a-f0-9]{24})\/(.+)$/i.exec(entry.path);
    if (!match || !cacheIds.has(match[1].toLowerCase())) continue;
    if (entry.size > 32 * 1024 * 1024 || assets.length >= 2000) throw new Error("Paper assets exceed the import limits");
    const target = path.join(source, ...entry.path.split("/")); verifyNoSymlinks(target, source);
    const bytes = fs.readFileSync(target);
    bytesTotal += bytes.length;
    if (bytesTotal > 180 * 1024 * 1024) throw new Error("Migration bundle exceeds 256 MiB JSON limit; prepare smaller snapshots");
    assets.push({ cacheId: match[1].toLowerCase(), path: match[2], data: bytes.toString("base64") });
  }
  return { format: "hana-paper-reader-backup", version: 1, paperHash: hash,
    paper: { ...paper, paperHash: hash, translations: translations.translations || {}, translationStates: translations.translationStates || {},
      translationGlossaryVersion: translations.translationGlossaryVersion || 0, readingMode: research.readingMode || "bilingual" },
    notes: records(research.notes, hash), bookmarks: records(research.bookmarks, hash),
    progress: research.progress ? { ...research.progress, paperHash: hash } : null,
    glossary: research.glossary ? { ...research.glossary, paperHash: hash } : null,
    translationCache: Object.entries(translations.cache || {}).map(([key, value]) => ({ ...sanitize(value), key: value.key || key, paperHash: hash })),
    tasks: records(tasks.tasks, hash).map(task => ({ id: task.id, paperHash: hash, kind: task.kind || "parse", type: task.type,
      state: ["queued", "running"].includes(task.state || task.status) ? "failed" : task.state || task.status || "failed",
      status: ["queued", "running"].includes(task.state || task.status) ? "failed" : task.state || task.status || "failed",
      needsRetry: ["queued", "running"].includes(task.state || task.status), createdAt: task.createdAt, updatedAt: task.updatedAt,
      error: ["queued", "running"].includes(task.state || task.status) ? "旧任务未在新版本自动恢复，请重新发起" : undefined })), assets };
});
// These checks are mandatory migration integrity guards, not App acceptance.
const finalManifest = inspectMigrationSource(source);
if (manifest.sourceFingerprint !== finalManifest.sourceFingerprint) throw new Error("Snapshot changed while reading; no bundle published");
const bundle = { format: "hana-paper-reader-migration", version: 1, migrationId: randomUUID(), createdAt: new Date().toISOString(),
  sourceFingerprint: manifest.sourceFingerprint, counts: manifest.counts, sensitiveConfigPolicy: approval.sensitiveConfigPolicy, papers };
const encoded = JSON.stringify(bundle);
if (Buffer.byteLength(encoded) > 256 * 1024 * 1024) throw new Error("Migration bundle exceeds 256 MiB; prepare smaller snapshots");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, encoded, { flag: "wx" });
console.log(JSON.stringify({ prepared: true, paperCount: papers.length, bytes: Buffer.byteLength(encoded), fingerprint: createHash("sha256").update(encoded).digest("hex"), acceptance: "not-performed" }));
