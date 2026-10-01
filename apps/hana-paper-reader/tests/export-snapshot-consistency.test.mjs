import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPaperWorkspace } from "../server/domain/paper-workspace.js";
import registerApiRoutes from "../server/http/api-routes.js";

const HASH = "e".repeat(64);
const crashWorker = fileURLToPath(new URL("./fixtures/storage-crash-worker.mjs", import.meta.url));
async function fixture(prefix = "hpr-export-safe-25-") {
  assert.ok(["hpr-export-safe-25-", "hpr-storage-crash-export-safe-25-"].includes(prefix));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspace = createPaperWorkspace({ dataDir });
  const paper = await workspace.upsertPaper({ paperHash: HASH, metadata: { title: "Owned old export" },
    blocks: [{ id: "b1", page: 1, type: "paragraph", text: "Owned old source" }] });
  await workspace.putNote({ id: "n1", paperHash: HASH, blockId: "b1", note: "Owned old note" });
  const routes = new Map(), app = {};
  for (const method of ["get", "post", "delete"]) app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  registerApiRoutes(app, { dataDir, workspace });
  const f = { dataDir, workspace, paper, routes };
  f.request = (name = "export", body, query = {}) => routes.get(`${body === undefined ? "GET" : "POST"} /api/research/${name}`)({
    get: () => ({ principal: { id: "owned-export-test" } }),
    req: { json: async () => ({ paperHash: HASH, ...body }), query: key => ({ paperHash: HASH, ...query })[key] || "" },
    json: (value, status = 200) => ({ value, status }),
  });
  f.close = async () => {
    await workspace.close();
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith(prefix));
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return f;
}
function competingWrite(f) {
  const moduleUrl = new URL("../server/domain/paper-workspace.js", import.meta.url).href;
  const program = `import { createPaperWorkspace } from ${JSON.stringify(moduleUrl)};
const workspace = createPaperWorkspace({ dataDir: process.argv[1] });
try { await workspace.upsertPaper({ paperHash: ${JSON.stringify(HASH)}, metadata: { title: "Owned new export" }, blocks: [{ id: "b1", page: 1, type: "paragraph", text: "Owned new source" }] });
await workspace.putNote({ id: "n1", paperHash: ${JSON.stringify(HASH)}, blockId: "b1", note: "Owned new note" });
process.stdout.write(JSON.stringify({ committed: true }) + "\\n");
} catch (error) { process.stdout.write(JSON.stringify({ committed: false, code: error.code }) + "\\n"); }
finally { await workspace.close(); }`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", program, f.dataDir],
    { windowsHide: true, timeout: 15000, stdio: "pipe", encoding: "utf8" }).trim());
}

for (const kind of ["notes", "bookmarks"]) {
  test(`a Markdown export includes all 101 owned ${kind} rather than the list display limit`, async () => {
    const f = await fixture();
    try {
      const backup = f.workspace.exportBackup(HASH, { includeAssets: false });
      backup[kind] = Array.from({ length: 101 }, (_value, index) => ({ id: `${kind}-${index + 1}`, paperHash: HASH, blockId: "b1",
        createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
        ...(kind === "notes" ? { note: `Owned note ${index + 1}`, noteType: "finding" } : { label: `Owned bookmark ${index + 1}` }) }));
      await f.workspace.restoreBackup({ ...backup, expectedRevision: f.paper.revision });
      const response = await f.request(); assert.equal(response.status, 200);
      const markdown = await response.text(); assert.ok(markdown.includes(`Owned ${kind === "notes" ? "note" : "bookmark"} 101`));
    } finally { await f.close(); }
  });
}

test("a Markdown export cannot splice an older source with records committed by a separate writer", async () => {
  const f = await fixture();
  try {
    const getPaper = f.workspace.getPaper; let first = true;
    f.workspace.getPaper = hash => {
      const captured = getPaper(hash);
      if (first) { first = false; assert.equal(competingWrite(f).committed, true); }
      return captured;
    };
    const response = await f.request(); assert.equal(response.status, 200);
    const markdown = await response.text();
    assert.ok(!(markdown.includes("Owned old source") && markdown.includes("Owned new note")), "One export must not combine these committed versions");
    assert.ok(!(markdown.includes("Owned old source") && /filename="Owned new export.md"/.test(response.headers.get("content-disposition"))), "Filename and content must come from the same capture");
  } finally { await f.close(); }
});

for (const route of ["export", "backup", "snapshot", "storage"]) {
  test(`a warmed ${route} reader refuses a corrupt owned shard without using its cached data`, async () => {
    const f = await fixture();
    try {
      fs.writeFileSync(path.join(f.dataDir, "papers", HASH, "paper.json"), "Owned invalid JSON shard");
      const response = await f.request(route); assert.equal(response.status, 503);
      assert.equal(response.value.error.code, "workspace_integrity_error");
      assert.equal(fs.readFileSync(path.join(f.dataDir, "papers", HASH, "paper.json"), "utf8"), "Owned invalid JSON shard");
      assert.ok(!JSON.stringify(response.value).includes(f.dataDir));
    } finally { await f.close(); }
  });
}

test("an interrupted export write never publishes a partial final file", async () => {
  const f = await fixture(), originalSync = fs.writeFileSync, originalOpen = fs.promises.open;
  let injected = false;
  try {
    const prefix = path.join(f.dataDir, "exports") + path.sep;
    fs.writeFileSync = (file, content, ...args) => {
      if (!injected && String(file).startsWith(prefix)) {
        injected = true; originalSync(file, Buffer.from(content).subarray(0, 2), ...args);
        throw Object.assign(new Error("Owned partial export write"), { code: "EIO" });
      }
      return originalSync(file, content, ...args);
    };
    fs.promises.open = async (file, ...args) => {
      const handle = await originalOpen(file, ...args);
      if (!injected && String(file).startsWith(prefix)) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async content => { injected = true; await write(Buffer.from(content).subarray(0, 2)); throw Object.assign(new Error("Owned partial export write"), { code: "EIO" }); };
      }
      return handle;
    };
    const response = await f.request("export", { saveToDisk: true });
    assert.equal(response.status, 503); assert.equal(injected, true);
    assert.deepEqual(fs.readdirSync(path.join(f.dataDir, "exports")), []);
  } finally { fs.writeFileSync = originalSync; fs.promises.open = originalOpen; await f.close(); }
});

test("concurrent exports publish unique complete files with matching hashes and captured source receipts", async () => {
  const f = await fixture();
  try {
    const responses = await Promise.all([f.request("export", { saveToDisk: true }), f.request("export", { saveToDisk: true })]);
    assert.equal(new Set(responses.map(response => response.value.fileName)).size, 2);
    for (const response of responses) {
      assert.equal(response.status, 200); assert.equal(response.value.sourceRevision, f.paper.revision); assert.equal(response.value.sourceGeneration, f.paper.generation);
      const bytes = fs.readFileSync(response.value.filePath);
      assert.equal(response.value.size, bytes.length); assert.equal(response.value.sha256, createHash("sha256").update(bytes).digest("hex"));
      assert.ok(bytes.toString("utf8").includes("Owned old source")); assert.equal(path.dirname(response.value.filePath), path.join(f.dataDir, "exports"));
    }
    assert.equal(fs.readdirSync(path.join(f.dataDir, "exports")).length, 2);
  } finally { await f.close(); }
});

test("an export flush failure leaves no final file and permits an explicit clean retry", async () => {
  const f = await fixture(), originalOpen = fs.promises.open; let injected = false;
  try {
    fs.promises.open = async (file, ...args) => {
      const handle = await originalOpen(file, ...args);
      if (!injected && String(file).startsWith(path.join(f.dataDir, "exports") + path.sep)) {
        handle.sync = async () => { injected = true; throw Object.assign(new Error("Owned export flush failure"), { code: "EIO" }); };
      }
      return handle;
    };
    const failed = await f.request("backup", { saveToDisk: true, includeAssets: false });
    assert.equal(failed.status, 503); assert.equal(injected, true); assert.deepEqual(fs.readdirSync(path.join(f.dataDir, "exports")), []);
    fs.promises.open = originalOpen;
    const retried = await f.request("backup", { saveToDisk: true, includeAssets: false }); assert.equal(retried.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(retried.value.filePath, "utf8")).paperHash, HASH);
  } finally { fs.promises.open = originalOpen; await f.close(); }
});

test("a failed export publication preserves existing files and removes only its temporary output", async () => {
  const f = await fixture(), originalLink = fs.promises.link; let injected = false;
  try {
    const directory = path.join(f.dataDir, "exports"); fs.mkdirSync(directory); const sentinel = path.join(directory, "Owned old export.md");
    fs.writeFileSync(sentinel, "Owned preexisting export");
    fs.promises.link = async (source, target) => {
      if (String(source).startsWith(directory + path.sep)) { injected = true; throw Object.assign(new Error("Owned publish failure"), { code: "EIO" }); }
      return originalLink(source, target);
    };
    const response = await f.request("export", { saveToDisk: true }); assert.equal(response.status, 503); assert.equal(injected, true);
    assert.deepEqual(fs.readdirSync(directory), ["Owned old export.md"]); assert.equal(fs.readFileSync(sentinel, "utf8"), "Owned preexisting export");
  } finally { fs.promises.link = originalLink; await f.close(); }
});

test("conditional Markdown and backup exports enforce the same source through POST and GET", async () => {
  const f = await fixture();
  try {
    const backup = f.workspace.exportBackup(HASH, { includeAssets: false });
    const current = await f.workspace.restoreBackup({ ...backup, expectedRevision: f.paper.revision });
    for (const route of ["export", "backup"]) {
      for (const field of ["expectedRevision", "expectedGeneration"]) {
        const stale = { [field]: f.paper[field === "expectedRevision" ? "revision" : "generation"] };
        assert.equal((await f.request(route, { ...stale, saveToDisk: true })).status, 409);
        assert.equal((await f.request(route, undefined, stale)).status, 409);
      }
      const response = await f.request(route, undefined, { expectedRevision: String(current.revision), expectedGeneration: String(current.generation), includeAssets: "false" });
      assert.equal(response.status, 200); assert.equal(response.headers.get("x-paper-revision"), String(current.revision));
      assert.equal(response.headers.get("x-paper-generation"), String(current.generation));
    }
    assert.equal(fs.existsSync(path.join(f.dataDir, "exports")), false);
  } finally { await f.close(); }
});

test("invalid export conditions fail without creating output or exposing raw paths", async () => {
  const f = await fixture();
  try {
    for (const route of ["export", "backup"]) {
      for (const value of [null, {}, -1, 1.5, "01", "bad"]) {
        const response = await f.request(route, { saveToDisk: true, expectedGeneration: value });
        assert.equal(response.status, 400); assert.equal(response.value.error.code, "export_condition_invalid");
        assert.ok(!JSON.stringify(response.value).includes(f.dataDir));
      }
      assert.equal((await f.request(route, undefined, { expectedRevision: "01" })).status, 400);
    }
    assert.equal(fs.existsSync(path.join(f.dataDir, "exports")), false);
  } finally { await f.close(); }
});

test("a source write during asynchronous output keeps the already captured content and receipt coherent", async () => {
  const f = await fixture(), originalOpen = fs.promises.open; let injected = false;
  try {
    fs.promises.open = async (file, ...args) => {
      const handle = await originalOpen(file, ...args);
      if (!injected && String(file).startsWith(path.join(f.dataDir, "exports") + path.sep)) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async content => {
          injected = true;
          await f.workspace.upsertPaper({ paperHash: HASH, metadata: { title: "Owned updated during output" }, blocks: [{ id: "b1", page: 1, text: "Owned updated while output waits" }] });
          return write(content);
        };
      }
      return handle;
    };
    const response = await f.request("export", { saveToDisk: true }); assert.equal(response.status, 200); assert.equal(injected, true);
    assert.equal(response.value.fileName, "Owned old export.md"); assert.equal(response.value.sourceRevision, f.paper.revision);
    assert.ok(fs.readFileSync(response.value.filePath, "utf8").includes("Owned old source"));
    assert.ok(f.workspace.getPaper(HASH).revision > response.value.sourceRevision);
  } finally { fs.promises.open = originalOpen; await f.close(); }
});

test("asset bytes are captured under the same backup lease as the source and records", async () => {
  const f = await fixture(), originalRead = fs.readFileSync; let attempt;
  try {
    const cacheId = "f".repeat(24), directory = path.join(f.dataDir, "mineru-cache", cacheId); fs.mkdirSync(directory, { recursive: true });
    const asset = path.join(directory, "owned.bin"); fs.writeFileSync(asset, "Owned asset bytes");
    await f.workspace.upsertPaper({ paperHash: HASH, blocks: [...f.paper.blocks, { id: "fig1", page: 1, type: "image", text: "Owned figure", assetRef: { cacheId, path: "owned.bin" } }] });
    fs.readFileSync = (file, ...args) => { if (String(file) === asset && !attempt) attempt = competingWrite(f); return originalRead(file, ...args); };
    const response = await f.request("backup"); assert.equal(response.status, 200);
    const backup = JSON.parse(await response.text()); assert.deepEqual(attempt, { committed: false, code: "workspace_storage_busy" });
    assert.equal(backup.assets.length, 1); assert.equal(Buffer.from(backup.assets[0].data, "base64").toString("utf8"), "Owned asset bytes");
  } finally { fs.readFileSync = originalRead; await f.close(); }
});

for (const route of ["export", "backup", "snapshot", "storage"]) {
  test("the " + route + " capture excludes a separate writer and releases its lease afterwards", async () => {
    const f = await fixture(), originalRead = fs.readFileSync; let attempt;
    try {
      const researchFile = path.join(f.dataDir, "papers", HASH, "research.json");
      fs.readFileSync = (file, ...args) => {
        if (String(file) === researchFile && !attempt) attempt = competingWrite(f);
        return originalRead(file, ...args);
      };
      const response = await f.request(route); assert.equal(response.status, 200);
      assert.deepEqual(attempt, { committed: false, code: "workspace_storage_busy" });
      fs.readFileSync = originalRead;
      assert.deepEqual(competingWrite(f), { committed: true });
    } finally { fs.readFileSync = originalRead; await f.close(); }
  });

  test("the warmed " + route + " capture recovers a stopped owned writer before reading", async () => {
    const f = await fixture("hpr-storage-crash-export-safe-25-");
    try {
      const child = spawnSync(process.execPath, [crashWorker, f.dataDir, HASH, "paper"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
      assert.equal(child.status, 71, child.stderr); assert.match(child.stdout, /owned-checkpoint/);
      assert.equal(fs.existsSync(path.join(f.dataDir, ".storage-transactions")), true);
      const response = await f.request(route); assert.equal(response.status, 200);
      assert.equal(fs.existsSync(path.join(f.dataDir, ".storage-transactions")), false);
      assert.equal(fs.existsSync(path.join(f.dataDir, ".storage-write-lock.json")), false);
      assert.equal(f.workspace.getPaper(HASH).metadata.title, "Owned old export");
    } finally { await f.close(); }
  });
}

test("warmed composite readers refuse a live paused owned writer and recover only after it exits", async () => {
  const f = await fixture("hpr-storage-crash-export-safe-25-");
  const child = spawn(process.execPath, [crashWorker, f.dataDir, HASH, "paper", "pause"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const finished = once(child, "exit"); let timer;
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        child.stdout.on("data", data => { if (String(data).includes("owned-checkpoint")) resolve(); });
        child.once("error", reject);
        child.once("exit", () => reject(new Error("Owned writer exited before its checkpoint")));
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Owned checkpoint timeout")), 5000); }),
    ]);
    for (const route of ["export", "backup", "snapshot", "storage"]) {
      const response = await f.request(route); assert.equal(response.status, 503);
      assert.equal(response.value.error.code, "workspace_storage_busy");
    }
    child.kill(); await finished;
    for (const route of ["export", "backup", "snapshot", "storage"]) assert.equal((await f.request(route)).status, 200);
    assert.equal(fs.existsSync(path.join(f.dataDir, ".storage-transactions")), false);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await finished; }
    await f.close();
  }
});

test("a committed backup projects a legacy record token without rewriting its shard", async () => {
  const f = await fixture(); let fresh;
  try {
    const file = path.join(f.dataDir, "papers", HASH, "research.json");
    const research = JSON.parse(fs.readFileSync(file, "utf8")); delete research.notes.n1.itemVersion;
    fs.writeFileSync(file, JSON.stringify(research, null, 2)); const before = fs.readFileSync(file);
    fresh = createPaperWorkspace({ dataDir: f.dataDir });
    const expected = fresh.getItem("notes", "n1").itemVersion;
    const backup = f.workspace.exportBackup(HASH, { includeAssets: false });
    assert.equal(backup.notes[0].itemVersion, expected); assert.ok(expected);
    assert.deepEqual(fs.readFileSync(file), before);
  } finally { if (fresh) await fresh.close(); await f.close(); }
});

test("unauthorized composite requests cannot capture or create an export", async () => {
  const f = await fixture();
  try {
    const before = fs.readFileSync(f.workspace.filePath);
    for (const route of ["export", "backup", "snapshot", "storage"]) {
      const response = await f.routes.get("GET /api/research/" + route)({
        get: () => null, req: { query: key => key === "paperHash" ? HASH : "" },
        json: (value, status = 200) => ({ value, status }),
      });
      assert.equal(response.status, 403);
    }
    assert.deepEqual(fs.readFileSync(f.workspace.filePath), before);
    assert.equal(fs.existsSync(path.join(f.dataDir, "exports")), false);
  } finally { await f.close(); }
});

test("reserved and empty Windows titles produce ordinary files in the owned exports directory", async () => {
  const f = await fixture();
  try {
    for (const [title, expected] of [["CON", "_CON.md"], ["...", "paper.md"]]) {
      await f.workspace.upsertPaper({ paperHash: HASH, metadata: { title } });
      const response = await f.request("export", { saveToDisk: true }); assert.equal(response.status, 200);
      assert.equal(response.value.fileName, expected); assert.equal(path.dirname(response.value.filePath), path.join(f.dataDir, "exports"));
      assert.equal(fs.statSync(response.value.filePath).isFile(), true);
    }
  } finally { await f.close(); }
});
