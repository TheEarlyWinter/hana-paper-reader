import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import registerApiRoutes from "../server/http/api-routes.js";
import { createPaperWorkspace } from "../server/domain/paper-workspace.js";
import { captureResearchOwner, withResearchOwner, researchOwnerIsCurrent, prepareResearchRequest } from "../ui/assets/research-write-owner.js";

const HASH = "a".repeat(64), OTHER = "b".repeat(64);
const blocks = [{ id: "b1", page: 1, type: "paragraph", text: "Owned synthetic evidence" }];
async function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-research-owner-"));
  const workspace = createPaperWorkspace({ dataDir });
  const paper = await workspace.upsertPaper({ paperHash: HASH, metadata: { title: "Synthetic owner" }, blocks });
  const routes = new Map(), app = {};
  for (const method of ["get", "post", "delete"]) app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  registerApiRoutes(app, { dataDir });
  return { dataDir, workspace, paper, routes, close() {
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("hpr-research-owner-"));
    fs.rmSync(dataDir, { recursive: true, force: true });
  } };
}
function context(body = {}, query = {}, params = {}) {
  return { get: () => ({ principal: { id: "owned-research-owner" } }),
    req: { query: key => query[key] || "", param: key => params[key] || "", json: async () => body },
    json: (value, status = 200) => ({ value, status }) };
}
function bytes(f) {
  return ["paper-workspace.json", ...["paper.json", "research.json", "translations.json", "tasks.json"].map(file => `papers/${HASH}/${file}`)]
    .map(file => fs.readFileSync(path.join(f.dataDir, file)));
}
async function seed(workspace, hash = HASH) {
  await workspace.putNote({ paperHash: hash, id: "note-one", blockId: "b1", note: "Current note" });
  await workspace.putBookmark({ paperHash: hash, id: "bookmark-one", blockId: "b1", label: "Current bookmark" });
  await workspace.putGlossary({ paperHash: hash, terms: { evidence: "current term" } });
  await workspace.setProgress({ paperHash: hash, percent: 25 });
  await workspace.createTask({ paperHash: hash, id: "task-one" });
}

for (const [route, fields, query, params] of [
  ["POST /api/research/notes", { id: "note-one", blockId: "b1", note: "Stale note" }],
  ["POST /api/research/bookmarks", { id: "bookmark-one", blockId: "b1", label: "Stale bookmark" }],
  ["POST /api/research/progress", { percent: 99 }],
  ["POST /api/research/glossary", { terms: { evidence: "stale term" } }],
  ["POST /api/research/translation-cache", { blockId: "b1", source: "Old source", translation: "Stale cache" }],
  ["POST /api/research/parse-status/tasks", { id: "late-task" }],
  ["POST /api/research/parse-status/tasks/:taskId", { state: "running" }, {}, { taskId: "task-one" }],
  ["DELETE /api/research/notes/:id", {}, {}, { id: "note-one" }],
  ["DELETE /api/research/bookmarks/:id", {}, {}, { id: "bookmark-one" }],
  ["DELETE /api/research/glossary", {}, { term: "evidence" }],
]) {
  test(`a recreated paper rejects old research ownership: ${route}`, async () => {
    const f = await fixture();
    try {
      const oldGeneration = f.paper.generation ?? f.paper.revision;
      await f.workspace.removePaper(HASH);
      await f.workspace.upsertPaper({ paperHash: HASH, blocks });
      await seed(f.workspace);
      const before = bytes(f);
      const response = await f.routes.get(route)(context({ paperHash: HASH, expectedGeneration: oldGeneration, ...fields }, query, params));
      assert.equal(response.status, 409, JSON.stringify(response.value));
      assert.equal(response.value.error.code, "paper_conflict");
      assert.deepEqual(bytes(f), before);
    } finally { f.close(); }
  });
}

for (const kind of ["Note", "Bookmark", "Task"]) {
  test(`an existing ${kind} ID cannot replace another paper's record`, async () => {
    const f = await fixture();
    try {
      await seed(f.workspace);
      await f.workspace.upsertPaper({ paperHash: OTHER, blocks });
      const before = bytes(f);
      const id = `${kind.toLowerCase()}-one`;
      const method = kind === "Task" ? "createTask" : `put${kind}`;
      await assert.rejects(f.workspace[method]({ paperHash: OTHER, id, blockId: "b1", note: "Wrong owner" }),
        error => error.code === "research_item_conflict");
      assert.deepEqual(bytes(f), before);
    } finally { f.close(); }
  });
}

test("initial PDF task creation persists a paper owner and task together", async () => {
  const f = await fixture();
  try {
    const response = await f.routes.get("POST /api/research/parse-status/tasks")(context({
      paperHash: OTHER, createPaperIfAbsent: true, expectedRevision: 0, fileName: "Owned new PDF.pdf" }));
    assert.equal(response.status, 200, JSON.stringify(response.value));
    const next = createPaperWorkspace({ dataDir: f.dataDir });
    const paper = next.getPaper(OTHER), task = next.getTask(response.value.task.id);
    assert.equal(paper.metadata.title, "Owned new PDF.pdf");
    assert.equal(task.paperGeneration, paper.generation);
    assert.equal(task.state, "queued");
  } finally { f.close(); }
});

test("a captured UI owner remains usable after ordinary saves but rejects deletion and recreation", async () => {
  const f = await fixture();
  try {
    const owner = captureResearchOwner(f.paper);
    await f.workspace.updatePaperMetadata(HASH, { title: "Renamed" });
    await f.workspace.upsertPaper({ paperHash: HASH, blocks, generation: 999 });
    assert.ok(f.workspace.getPaper(HASH).revision > f.paper.revision);
    assert.equal(f.workspace.getPaper(HASH).generation, owner.generation, "Input cannot forge the server's generation");
    const saved = await f.routes.get("POST /api/research/progress")(context(withResearchOwner({ percent: 50 }, owner)));
    assert.equal(saved.status, 200);
    assert.equal(researchOwnerIsCurrent(f.workspace.getPaper(HASH), owner), true);
    await f.workspace.removePaper(HASH);
    await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    assert.equal(researchOwnerIsCurrent(f.workspace.getPaper(HASH), owner), false);
    const before = bytes(f);
    const delayed = await f.routes.get("POST /api/research/progress")(context(withResearchOwner({ percent: 99 }, owner)));
    assert.equal(delayed.status, 409);
    assert.deepEqual(bytes(f), before);
  } finally { f.close(); }
});

test("restore and structure cleanup retire the old owner while restored tasks bind to the new owner", async () => {
  const f = await fixture();
  try {
    await seed(f.workspace);
    const backup = f.workspace.exportBackup(HASH);
    const restored = await f.workspace.restoreBackup({ ...backup, expectedRevision: f.paper.revision });
    assert.ok(restored.generation > f.paper.generation);
    const task = f.workspace.getTask("task-one");
    assert.equal(task.paperGeneration, restored.generation);
    await f.workspace.updateTask(task.id, { expectedGeneration: restored.generation, state: "running" });
    await assert.rejects(f.workspace.putNote({ paperHash: HASH, blockId: "b1", note: "Old owner",
      expectedGeneration: f.paper.generation }), error => error.code === "paper_conflict");
    const cleaned = await f.workspace.clearPaperData(HASH, "structure-keep-notes");
    assert.ok(cleaned.paper.generation > restored.generation);
    await assert.rejects(f.workspace.setProgress({ paperHash: HASH, expectedGeneration: restored.generation }),
      error => error.code === "paper_conflict");
  } finally { f.close(); }
});

test("legacy paper generations remain stable after the first save and are visible to public reads", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.dataDir, "papers", HASH, "paper.json");
    const paper = JSON.parse(fs.readFileSync(file, "utf8"));
    delete paper.generation;
    fs.writeFileSync(file, JSON.stringify(paper));
    const publicPaper = f.routes.get("GET /api/research/paper")(context({}, { paperHash: HASH })).value.paper;
    const owner = captureResearchOwner(publicPaper);
    await createPaperWorkspace({ dataDir: f.dataDir }).updatePaperMetadata(HASH, { title: "Legacy renamed" });
    const saved = await f.routes.get("POST /api/research/progress")(context(withResearchOwner({ percent: 42 }, owner)));
    assert.equal(saved.status, 200, JSON.stringify(saved.value));
    const current = f.routes.get("GET /api/research/paper")(context({}, { paperHash: HASH })).value.paper;
    assert.equal(current.generation, owner.generation);
    assert.ok(current.revision > publicPaper.revision);
  } finally { f.close(); }
});

test("invalid owner conditions and cross-paper deletion cannot alter any research file", async () => {
  const f = await fixture();
  try {
    await seed(f.workspace);
    const before = bytes(f);
    for (const expectedGeneration of [null, "", " 1", false, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const response = await f.routes.get("POST /api/research/progress")(context({ paperHash: HASH, expectedGeneration }));
      assert.equal(response.status, 400, JSON.stringify(response.value));
      assert.equal(response.value.error.code, "paper_generation_invalid");
      assert.deepEqual(bytes(f), before);
    }
    const response = await f.routes.get("DELETE /api/research/notes/:id")(context({ paperHash: OTHER }, {}, { id: "note-one" }));
    assert.equal(response.status, 409);
    assert.equal(response.value.error.code, "research_item_conflict");
    assert.deepEqual(bytes(f), before);
  } finally { f.close(); }
});

test("research writes honor explicit revision conditions and do not persist request controls", async () => {
  const f = await fixture();
  try {
    const owner = captureResearchOwner(f.paper);
    await f.workspace.updatePaperMetadata(HASH, { title: "New revision" });
    const before = bytes(f);
    const stale = await f.routes.get("POST /api/research/progress")(context({ ...withResearchOwner({}, owner), expectedRevision: f.paper.revision }));
    assert.equal(stale.status, 409);
    assert.deepEqual(bytes(f), before);
    for (const [route, fields] of [["notes", { blockId: "b1", note: "Clean controls" }], ["progress", { percent: 10 }],
      ["translation-cache", { blockId: "b1", translation: "Clean cache" }], ["parse-status/tasks", {}]]) {
      const response = await f.routes.get(`POST /api/research/${route}`)(context({ ...withResearchOwner(fields, owner), expectedRevision: f.workspace.getPaper(HASH).revision }));
      assert.equal(response.status, 200, JSON.stringify(response.value));
    }
    const persisted = bytes(f).slice(2).map(value => value.toString()).join("\n");
    assert.ok(!persisted.includes('"expectedRevision"'));
    assert.ok(!persisted.includes('"expectedGeneration"'));
    assert.ok(!persisted.includes('"createPaperIfAbsent"'));
  } finally { f.close(); }
});

test("task updates keep ownership across ordinary saves and duplicate creation cannot reset state", async () => {
  const f = await fixture();
  try {
    const task = await f.workspace.createTask({ paperHash: HASH, id: "stable-task", expectedGeneration: f.paper.generation });
    await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const running = await f.workspace.updateTask(task.id, { state: "running", expectedGeneration: task.paperGeneration, paperGeneration: 999 });
    assert.equal(running.paperGeneration, task.paperGeneration);
    const before = bytes(f);
    await assert.rejects(f.workspace.createTask({ paperHash: HASH, id: task.id }), error => error.code === "research_item_conflict");
    assert.deepEqual(bytes(f), before);
  } finally { f.close(); }
});

test("a failed initial task cannot leave a newly created paper or consume its generation", async () => {
  const f = await fixture();
  const rename = fs.renameSync;
  try {
    const before = fs.readFileSync(path.join(f.dataDir, "paper-workspace.json"));
    let injected = false;
    fs.renameSync = (source, destination) => {
      if (!injected && path.resolve(String(destination)) === path.join(f.dataDir, "paper-workspace.json")) {
        injected = true;
        throw Object.assign(new Error("Owned task index failure"), { code: "EIO" });
      }
      return rename(source, destination);
    };
    await assert.rejects(f.workspace.createTask({ paperHash: OTHER, id: "initial-task", createPaperIfAbsent: true, expectedRevision: 0 }));
    assert.equal(injected, true);
    assert.deepEqual(fs.readFileSync(path.join(f.dataDir, "paper-workspace.json")), before);
    fs.renameSync = rename;
    const next = createPaperWorkspace({ dataDir: f.dataDir });
    assert.equal(next.getPaper(OTHER), null);
    assert.equal(next.getTask("initial-task"), null);
    const task = await next.createTask({ paperHash: OTHER, id: "initial-task", createPaperIfAbsent: true, expectedRevision: 0 });
    assert.equal(task.paperGeneration, 1);
  } finally { fs.renameSync = rename; f.close(); }
});

test("corrupt stored generations stop public reading and writing", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.dataDir, "papers", HASH, "paper.json");
    const original = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const generation of [null, -1, "1", 2, 1.5]) {
      fs.writeFileSync(file, JSON.stringify({ ...original, generation }));
      const before = bytes(f);
      for (const route of ["GET /api/research/paper", "POST /api/research/progress"]) {
        const response = await f.routes.get(route)(context({ paperHash: HASH }, { paperHash: HASH }));
        assert.equal(response.status, 503, JSON.stringify(response.value));
        assert.equal(response.value.error.code, "workspace_integrity_error");
        assert.deepEqual(bytes(f), before);
      }
    }
  } finally { f.close(); }
});

test("the tools' shared request path preserves an old owner while a request is queued", async () => {
  const f = await fixture();
  try {
    const request = prepareResearchRequest("/api/research/notes", { method: "POST",
      body: JSON.stringify({ blockId: "b1", note: "Queued old note" }) }, { paper: f.paper, getPaper: () => f.paper });
    await f.workspace.removePaper(HASH);
    await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const prepared = await request;
    const before = bytes(f);
    const response = await f.routes.get("POST /api/research/notes")(context(JSON.parse(prepared.body)));
    assert.equal(response.status, 409);
    assert.deepEqual(bytes(f), before);
  } finally { f.close(); }
});

test("first-save preparation cannot bind a research write to a replaced paper", async () => {
  const f = await fixture();
  try {
    let live = f.paper, release;
    const gate = new Promise(resolve => { release = resolve; });
    const request = prepareResearchRequest("/api/research/progress", { method: "POST", body: "{}" }, {
      paper: { paperHash: HASH }, getPaper: () => live, prepare: async () => { await gate; return f.paper; },
    });
    await f.workspace.removePaper(HASH);
    live = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    release();
    await assert.rejects(request, /重新导入/);
    const prepared = await prepareResearchRequest("/api/research/progress", { method: "POST", body: "{}" }, {
      paper: { paperHash: HASH }, getPaper: () => live, prepare: async () => live,
    });
    const response = await f.routes.get("POST /api/research/progress")(context(JSON.parse(prepared.body)));
    assert.equal(response.status, 200);
  } finally { f.close(); }
});

test("task creation cancellation before and during persistence cannot leave a runnable queued task", async () => {
  for (const checkpoint of ["before", "after-write"]) {
    const f = await fixture();
    try {
      const controller = new AbortController();
      const ctx = context({ paperHash: HASH, id: "cancelled-create", expectedGeneration: f.paper.generation });
      ctx.req.raw = { signal: controller.signal };
      if (checkpoint === "before") controller.abort();
      else {
        const storageModule = await import("../server/domain/paper-storage.js");
        const storage = storageModule.createPaperStorage({ filePath: path.join(f.dataDir, "paper-workspace.json") });
        let writes = 0;
        const workspace = createPaperWorkspace({ dataDir: f.dataDir, storage: { ...storage, async write(data, opts) {
          const result = await storage.write(data, opts);
          if (++writes === 1) controller.abort();
          return result;
        } } });
        const app = {};
        for (const method of ["get", "post", "delete"]) app[method] = (route, handler) => f.routes.set(`${method.toUpperCase()} ${route}`, handler);
        registerApiRoutes(app, { dataDir: f.dataDir, workspace });
      }
      const response = await f.routes.get("POST /api/research/parse-status/tasks")(ctx);
      assert.equal(response.status, 499, JSON.stringify(response.value));
      const task = createPaperWorkspace({ dataDir: f.dataDir }).getTask("cancelled-create");
      assert.equal(task?.state ?? "absent", checkpoint === "before" ? "absent" : "cancelled");
    } finally { f.close(); }
  }
});
