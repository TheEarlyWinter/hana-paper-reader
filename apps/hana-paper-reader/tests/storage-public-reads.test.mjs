import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import registerApiRoutes from "../server/http/api-routes.js";
import { createPaperWorkspace } from "../server/domain/paper-workspace.js";
import { createPaperStorage } from "../server/domain/paper-storage.js";

const HASH = "a".repeat(64);
const worker = fileURLToPath(new URL("./fixtures/storage-crash-worker.mjs", import.meta.url));
const readRoutes = ["recent", "library", "paper", "parse-cache/check", "search", "evidence", "outline"];
function appFor(dataDir) {
  const routes = new Map();
  const app = { routes };
  for (const method of ["get", "post", "delete"]) app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  registerApiRoutes(app, { dataDir });
  return app;
}
function context(authorized = true, body = {}) {
  const query = { paperHash: HASH, query: "Fixture", blockId: "b1" };
  return {
    get: () => authorized ? { principal: { id: "owned-public-read-test" } } : null,
    req: { query: key => query[key], json: async () => body },
    json: (value, status = 200) => ({ value, status }),
  };
}
async function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-storage-crash-"));
  const workspace = createPaperWorkspace({ dataDir });
  await workspace.upsertPaper({ paperHash: HASH, metadata: { title: "Original fixture" },
    blocks: [{ id: "b1", page: 1, type: "paragraph", text: "Fixture evidence" }] });
  return { dataDir, workspace, close() {
    const root = path.resolve(dataDir);
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("hpr-storage-crash-"));
    fs.rmSync(root, { recursive: true, force: true });
  } };
}
function crash(f, checkpoint = "paper") {
  const child = spawnSync(process.execPath, [worker, f.dataDir, HASH, checkpoint],
    { encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(child.status, 71, child.stderr);
  const directory = path.join(f.dataDir, ".storage-transactions");
  return path.join(directory, fs.readdirSync(directory)[0], "manifest.json");
}

for (const route of readRoutes) {
  test(`the public ${route} route recovers an interrupted transaction before reading`, async () => {
    const f = await fixture();
    try {
      crash(f);
      const response = await appFor(f.dataDir).routes.get(`GET /api/research/${route}`)(context());
      assert.equal(response.status, 200, JSON.stringify(response.value));
      assert.equal(fs.existsSync(path.join(f.dataDir, ".storage-transactions")), false,
        "A public read must recover the journal without a separate workspace.load call");
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, "papers", HASH, "paper.json"), "utf8")).metadata.title, "Original fixture");
      assert.ok(!JSON.stringify(response.value).includes("Restored after interruption"));
    } finally { f.close(); }
  });
}

test("unauthorized public reads do not recover or alter an interrupted workspace", async () => {
  const f = await fixture();
  try {
    const manifest = crash(f);
    const bytes = fs.readFileSync(manifest);
    const app = appFor(f.dataDir);
    for (const route of readRoutes) {
      const response = await app.routes.get(`GET /api/research/${route}`)(context(false));
      assert.equal(response.status, 403);
      assert.deepEqual(fs.readFileSync(manifest), bytes);
    }
  } finally { f.close(); }
});

test("a damaged journal makes the public read fail closed without exposing partial data", async () => {
  const f = await fixture();
  try {
    const manifestFile = crash(f);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    const number = manifest.operations.findIndex(op => op.path === `papers/${HASH}/paper.json`);
    fs.writeFileSync(path.join(path.dirname(manifestFile), `${number}.before`), "Damaged owned fixture");
    const app = appFor(f.dataDir);
    for (const route of readRoutes) {
      const response = await app.routes.get(`GET /api/research/${route}`)(context());
      assert.equal(response.status, 503);
      assert.equal(response.value.error.code, "workspace_recovery_required");
      assert.ok(!JSON.stringify(response.value).includes(f.dataDir));
      assert.equal(fs.existsSync(manifestFile), true);
    }
  } finally { f.close(); }
});

test("public reads and writes report a live writer as busy rather than reading mixed shards", async () => {
  const f = await fixture();
  const child = spawn(process.execPath, [worker, f.dataDir, HASH, "paper", "pause"],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
    const app = appFor(f.dataDir);
    for (const route of readRoutes) {
      const response = await app.routes.get(`GET /api/research/${route}`)(context());
      assert.equal(response.status, 503);
      assert.equal(response.value.error.code, "workspace_storage_busy");
    }
    const write = await app.routes.get("POST /api/research/paper")(context(true, {
      paperHash: HASH, metadata: { title: "Must not replace a live write" },
    }));
    assert.equal(write.status, 503);
    assert.equal(write.value.error.code, "workspace_storage_busy");
    child.kill(); await finished;
    const read = await app.routes.get("GET /api/research/paper")(context());
    assert.equal(read.status, 200);
    assert.equal(read.value.paper.metadata.title, "Original fixture");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await finished; }
    f.close();
  }
});

test("a flush failure after publishing the commit marker keeps the new version for recovery", async () => {
  const f = await fixture();
  const originalOpen = fs.promises.open;
  let injected = false;
  try {
    const storage = createPaperStorage({ filePath: path.join(f.dataDir, "paper-workspace.json") });
    const next = structuredClone(storage.load().source);
    next.papers[HASH].metadata.title = "Committed fixture";
    next.papers[HASH].revision++;
    next.updatedAt = new Date().toISOString();
    fs.promises.open = async (file, ...args) => {
      const handle = await originalOpen(file, ...args);
      if (!injected && path.basename(String(file)) === "manifest.json"
          && String(file).startsWith(path.join(f.dataDir, ".storage-transactions") + path.sep)
          && JSON.parse(fs.readFileSync(file, "utf8")).state === "committed") {
        handle.sync = async () => { injected = true; throw Object.assign(new Error("Owned committed flush failure"), { code: "EIO" }); };
      }
      return handle;
    };
    await assert.rejects(storage.write(next), error => error.code === "workspace_commit_uncertain");
    assert.equal(injected, true);
    const journals = path.join(f.dataDir, ".storage-transactions");
    const manifestFile = path.join(journals, fs.readdirSync(journals)[0], "manifest.json");
    assert.equal(JSON.parse(fs.readFileSync(manifestFile, "utf8")).state, "committed");
    fs.promises.open = originalOpen;
    const read = await appFor(f.dataDir).routes.get("GET /api/research/paper")(context());
    assert.equal(read.status, 200);
    assert.equal(read.value.paper.metadata.title, "Committed fixture");
    assert.equal(fs.existsSync(journals), false);
  } finally { fs.promises.open = originalOpen; f.close(); }
});

for (const mode of ["mutation", "restore", "remove"]) {
  test(`a competing process cannot be overwritten by an already prepared ${mode}`, async () => {
    const f = await fixture();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let started;
    const checkpoint = new Promise(resolve => { started = resolve; });
    const storage = createPaperStorage({ filePath: path.join(f.dataDir, "paper-workspace.json") });
    const workspace = createPaperWorkspace({ dataDir: f.dataDir, storage: { ...storage,
      async write(...args) { started(); await gate; return storage.write(...args); },
    } });
    let operation;
    try {
      const before = workspace.getPaper(HASH);
      if (mode === "restore") {
        const backup = workspace.exportBackup(HASH);
        backup.paper.metadata.title = "Stale restore";
        operation = workspace.restoreBackup(backup);
      } else if (mode === "remove") {
        operation = workspace.removePaper(HASH, { expectedRevision: before.revision });
      } else {
        operation = workspace.upsertPaper({ ...before, expectedRevision: before.revision,
          metadata: { title: "Stale mutation" } });
      }
      const conflict = assert.rejects(operation, error => error.code === "workspace_conflict" && error.status === 409);
      await checkpoint;
      const child = spawnSync(process.execPath, [worker, f.dataDir, HASH, "complete"],
        { encoding: "utf8", timeout: 5000, windowsHide: true });
      assert.equal(child.status, 0, child.stderr);
      release(); await conflict;
      const reopened = createPaperWorkspace({ dataDir: f.dataDir });
      assert.equal(reopened.getPaper(HASH).metadata.title, "Restored after interruption");
      assert.equal(workspace.getPaper(HASH).metadata.title, "Restored after interruption");
      assert.equal(fs.readFileSync(path.join(f.dataDir, "mineru-cache", "c".repeat(24), "images", "one.png"), "utf8"), "x");
      assert.equal(fs.existsSync(path.join(f.dataDir, ".storage-transactions")), false);
    } finally { release(); if (operation) await operation.catch(() => {}); f.close(); }
  });
}

test("storage reads hold their lock across the index and shards", async () => {
  const f = await fixture();
  const read = fs.readFileSync;
  try {
    const index = path.join(f.dataDir, "paper-workspace.json");
    const storage = createPaperStorage({ filePath: index });
    const next = structuredClone(storage.load().source);
    next.papers[HASH].metadata.title = "Must not enter the reader snapshot";
    let injected = false;
    fs.readFileSync = (file, ...args) => {
      const bytes = read(file, ...args);
      if (!injected && path.resolve(String(file)) === index) {
        injected = true;
        assert.throws(() => storage.writeSync(next), error => error.code === "workspace_storage_busy");
      }
      return bytes;
    };
    assert.equal(storage.load().source.papers[HASH].metadata.title, "Original fixture");
    assert.equal(injected, true);
  } finally { fs.readFileSync = read; f.close(); }
});

test("a library request reads its index once across multiple papers", async () => {
  const f = await fixture();
  const read = fs.readFileSync;
  try {
    const index = path.join(f.dataDir, "paper-workspace.json");
    const storage = createPaperStorage({ filePath: index });
    const source = storage.load().source;
    const template = source.papers[HASH];
    for (let i = 1; i <= 20; i++) {
      const hash = i.toString(16).padStart(64, "0");
      source.papers[hash] = { ...structuredClone(template), paperHash: hash, metadata: { title: `Owned library ${i}` } };
    }
    storage.writeSync(source);
    let indexReads = 0;
    fs.readFileSync = (file, ...args) => {
      if (path.resolve(String(file)) === index) indexReads++;
      return read(file, ...args);
    };
    const request = context();
    request.req.query = () => "";
    const response = await appFor(f.dataDir).routes.get("GET /api/research/library")(request);
    assert.equal(response.status, 200);
    assert.equal(response.value.items.length, 21);
    assert.equal(indexReads, 1);
  } finally { fs.readFileSync = read; f.close(); }
});

test("public read recovery works with narrowly granted filesystem permissions", async () => {
  const f = await fixture();
  try {
    crash(f);
    const appRoot = path.resolve(path.dirname(worker), "../..");
    const routesUrl = pathToFileURL(path.join(appRoot, "server/http/api-routes.js")).href;
    const script = `import fs from "node:fs"; import path from "node:path"; import register from ${JSON.stringify(routesUrl)};
      const dataDir=${JSON.stringify(f.dataDir)};
      let parentDenied=false; try{fs.lstatSync(path.dirname(dataDir));}catch(error){parentDenied=error.code==="ERR_ACCESS_DENIED";}
      const routes=new Map();const app={};for(const method of ["get","post","delete"]) app[method]=(route,handler)=>routes.set(method+" "+route,handler);
      register(app,{dataDir});
      const c={get:()=>({principal:{id:"owned-restricted-reader"}}),req:{query:key=>key==="paperHash"?${JSON.stringify(HASH)}:""},json:(value,status=200)=>({value,status})};
      const result=await routes.get("get /api/research/paper")(c);
      console.log(JSON.stringify({parentDenied,status:result.status,title:result.value.paper?.metadata.title,retired:!fs.existsSync(path.join(dataDir,".storage-transactions"))}));`;
    const child = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${appRoot}`,
      `--allow-fs-read=${f.dataDir}`, `--allow-fs-write=${f.dataDir}`, "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 5000, windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { parentDenied: true, status: 200, title: "Original fixture", retired: true });
  } finally { f.close(); }
});
