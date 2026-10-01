import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPaperWorkspace } from "../server/domain/paper-workspace.js";
import { createPaperStorage } from "../server/domain/paper-storage.js";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
const worker = fileURLToPath(new URL("./fixtures/storage-crash-worker.mjs", import.meta.url));

async function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-storage-crash-"));
  const workspace = createPaperWorkspace({ dataDir });
  for (const paperHash of [OTHER, HASH]) await workspace.upsertPaper({ paperHash,
    metadata: { title: `Original ${paperHash[0]}` }, blocks: [{ id: "b1", page: 1, type: "paragraph", text: "Fixture evidence" }] });
  const files = [path.join(dataDir, "paper-workspace.json"), ...[HASH, OTHER].flatMap(hash =>
    ["paper.json", "research.json", "translations.json", "tasks.json"].map(name => path.join(dataDir, "papers", hash, name)))];
  const original = new Map(files.map(file => [file, fs.readFileSync(file)]));
  return { dataDir, original, close() {
    const root = path.resolve(dataDir);
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("hpr-storage-crash-"));
    fs.rmSync(root, { recursive: true, force: true });
  } };
}

test("a process exiting after a paper swap restores the original workspace on next load", async () => {
  const f = await fixture();
  try {
    const child = spawnSync(process.execPath, [worker, f.dataDir, HASH, "paper"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    assert.equal(child.status, 71, child.stderr);
    assert.match(child.stdout, /owned-checkpoint/);
    const reopened = createPaperWorkspace({ dataDir: f.dataDir });
    assert.equal(reopened.load().papers[HASH].metadata.title, "Original a");
    for (const [file, bytes] of f.original) assert.deepEqual(fs.readFileSync(file), bytes, path.basename(file));
    assert.equal(fs.existsSync(path.join(f.dataDir, "mineru-cache", "c".repeat(24), "images", "one.png")), false);
  } finally { f.close(); }
});

for (const checkpoint of ["prepared", "asset", "index", "committed"]) {
  test(`reopening after an owned process exits at ${checkpoint} keeps a complete transaction`, async () => {
    const f = await fixture();
    try {
      const child = spawnSync(process.execPath, [worker, f.dataDir, HASH, checkpoint], { encoding: "utf8", timeout: 5000, windowsHide: true });
      assert.equal(child.status, 71, child.stderr);
      const store = createPaperWorkspace({ dataDir: f.dataDir }).load();
      const committed = checkpoint === "committed";
      assert.equal(store.papers[HASH].metadata.title, committed ? "Restored after interruption" : "Original a");
      for (const [file, bytes] of f.original) {
        if (!committed || file.includes(`${path.sep}${OTHER}${path.sep}`)) assert.deepEqual(fs.readFileSync(file), bytes);
      }
      const asset = path.join(f.dataDir, "mineru-cache", "c".repeat(24), "images", "one.png");
      assert.equal(fs.existsSync(asset), committed);
      if (committed) assert.equal(fs.readFileSync(asset, "utf8"), "x");
      assert.equal(fs.existsSync(path.join(f.dataDir, ".storage-transactions")), false);
      assert.equal(fs.existsSync(path.join(f.dataDir, ".storage-write-lock.json")), false);
    } finally { f.close(); }
  });
}

test("a live owned writer prevents another process from stealing its recovery lock", async () => {
  const f = await fixture();
  const child = spawn(process.execPath, [worker, f.dataDir, HASH, "paper", "pause"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const finished = once(child, "exit");
  let timer;
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        child.stdout.on("data", data => { if (String(data).includes("owned-checkpoint")) resolve(); });
        child.once("error", reject);
        child.once("exit", () => reject(new Error("Owned writer exited before its checkpoint")));
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Owned checkpoint timeout")), 5000); }),
    ]);
    const storage = createPaperStorage({ filePath: path.join(f.dataDir, "paper-workspace.json") });
    assert.throws(() => storage.load(), error => error.code === "workspace_storage_busy");
    assert.equal(fs.existsSync(path.join(f.dataDir, ".storage-write-lock.json")), true);
    child.kill(); await finished;
    assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).load().papers[HASH].metadata.title, "Original a");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await finished; }
    f.close();
  }
});

function crash(f, checkpoint = "paper") {
  const child = spawnSync(process.execPath, [worker, f.dataDir, HASH, checkpoint], { encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(child.status, 71, child.stderr);
  const journals = path.join(f.dataDir, ".storage-transactions");
  const directory = path.join(journals, fs.readdirSync(journals)[0]);
  const file = path.join(directory, "manifest.json");
  return { directory, file, manifest: JSON.parse(fs.readFileSync(file, "utf8")) };
}

test("recovery preserves a file changed outside the interrupted transaction", async () => {
  const f = await fixture();
  try {
    const journal = crash(f);
    const target = path.join(f.dataDir, "papers", HASH, "paper.json");
    const outsideEdit = Buffer.from("synthetic external edit"); fs.writeFileSync(target, outsideEdit);
    const storage = createPaperStorage({ filePath: path.join(f.dataDir, "paper-workspace.json") });
    assert.throws(() => storage.load(), error => error.code === "workspace_recovery_required");
    assert.deepEqual(fs.readFileSync(target), outsideEdit);
    assert.equal(fs.existsSync(journal.file), true);
  } finally { f.close(); }
});

test("damaged original journal bytes stop recovery before any original files are replaced", async () => {
  const f = await fixture();
  try {
    const journal = crash(f);
    const number = journal.manifest.operations.findIndex(op => op.path === `papers/${HASH}/paper.json`);
    fs.writeFileSync(path.join(journal.directory, `${number}.before`), "damaged synthetic backup");
    const target = path.join(f.dataDir, "papers", HASH, "paper.json");
    const beforeAttempt = fs.readFileSync(target);
    assert.throws(() => createPaperStorage({ filePath: path.join(f.dataDir, "paper-workspace.json") }).load(), error => error.code === "workspace_recovery_required");
    assert.deepEqual(fs.readFileSync(target), beforeAttempt);
    assert.equal(fs.existsSync(journal.file), true);
  } finally { f.close(); }
});

test("journal paths cannot escape the owned workspace or modify unrelated data", async () => {
  const f = await fixture();
  try {
    const journal = crash(f);
    const unrelated = path.join(f.dataDir, "unrelated-fixture.json"); fs.writeFileSync(unrelated, "preserve");
    journal.manifest.operations[0].path = "../unrelated-fixture.json";
    fs.writeFileSync(journal.file, JSON.stringify(journal.manifest));
    assert.throws(() => createPaperStorage({ filePath: path.join(f.dataDir, "paper-workspace.json") }).load(), error => error.code === "workspace_recovery_required");
    assert.equal(fs.readFileSync(unrelated, "utf8"), "preserve");
    assert.equal(fs.existsSync(journal.file), true);
  } finally { f.close(); }
});

test("a committed journal can finish cleanup when some payload files were already removed", async () => {
  const f = await fixture();
  try {
    const journal = crash(f, "committed");
    for (const name of fs.readdirSync(journal.directory)) if (/^\d+\.(before|after)$/.test(name)) fs.unlinkSync(path.join(journal.directory, name));
    const reopened = createPaperWorkspace({ dataDir: f.dataDir });
    assert.equal(reopened.load().papers[HASH].metadata.title, "Restored after interruption");
    assert.equal(fs.existsSync(journal.directory), false);
  } finally { f.close(); }
});

test("the transaction works with filesystem access limited by Node's permission model", async () => {
  const f = await fixture();
  try {
    const repository = path.resolve(path.dirname(worker), "../../../..");
    const child = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${repository}`,
      `--allow-fs-read=${f.dataDir}`, `--allow-fs-write=${f.dataDir}`, worker, f.dataDir, HASH, "complete"],
    { encoding: "utf8", timeout: 5000, windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).load().papers[HASH].metadata.title, "Restored after interruption");
  } finally { f.close(); }
});

test("an occupied reclamation ticket cannot delete a newly competing recovery lock", async () => {
  const f = await fixture();
  try {
    crash(f);
    const leaseFile = path.join(f.dataDir, ".storage-write-lock.json");
    const lease = JSON.parse(fs.readFileSync(leaseFile, "utf8"));
    const original = fs.readFileSync(leaseFile);
    const ticket = path.join(f.dataDir, `.storage-reclaim-${lease.id}.json`);
    fs.writeFileSync(ticket, JSON.stringify({ version: 1, pid: process.pid, id: randomUUID() }));
    const storage = createPaperStorage({ filePath: path.join(f.dataDir, "paper-workspace.json") });
    assert.throws(() => storage.load(), error => error.code === "workspace_storage_busy");
    assert.deepEqual(fs.readFileSync(leaseFile), original);
    fs.unlinkSync(ticket);
    assert.equal(storage.load().source.papers[HASH].metadata.title, "Original a");
  } finally { f.close(); }
});

test("an interrupted lock reclamation preserves its records for inspection", async () => {
  const f = await fixture();
  try {
    crash(f);
    const leaseFile = path.join(f.dataDir, ".storage-write-lock.json");
    const lease = JSON.parse(fs.readFileSync(leaseFile, "utf8"));
    const ticket = path.join(f.dataDir, `.storage-reclaim-${lease.id}.json`);
    fs.writeFileSync(ticket, JSON.stringify({ version: 1, pid: lease.pid, id: randomUUID() }));
    assert.throws(() => createPaperStorage({ filePath: path.join(f.dataDir, "paper-workspace.json") }).load(), error => error.code === "workspace_recovery_required");
    assert.equal(fs.existsSync(ticket), true);
    assert.equal(fs.existsSync(leaseFile), true);
  } finally { f.close(); }
});
