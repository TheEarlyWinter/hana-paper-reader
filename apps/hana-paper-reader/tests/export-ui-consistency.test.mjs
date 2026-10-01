import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createResearchTools, startDownload } from "../ui/assets/research-tools.js";
import { createPaperWorkspace } from "../server/domain/paper-workspace.js";
import registerApiRoutes from "../server/http/api-routes.js";

const HASH = "a".repeat(64), OTHER = "b".repeat(64);
// Explicit memory element substitute; no browser or native window is started.
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.dataset = {}; this.style = {}; this.handlers = new Map(); this.attributes = {}; this.classList = { toggle() {}, add() {}, remove() {} }; this.disabled = false; this._text = ""; }
  set textContent(value) { this._text = String(value); }
  get textContent() { return this._text + this.children.map(item => item.textContent).join(""); }
  get isConnected() { return Boolean(this.root || this.parentNode?.isConnected); }
  append(...items) { for (const item of items) this.appendChild(item); }
  appendChild(item) { item.remove(); item.parentNode = this; this.children.push(item); return item; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(item => item !== this); this.parentNode = null; }
  replaceChildren(...items) { for (const item of [...this.children]) item.remove(); this.append(...items); }
  contains(item) { return this === item || this.children.some(child => child.contains(item)); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, handler) { this.handlers.set(type, handler); }
  fire(type = "click") { return this.handlers.get(type)?.({ target: this, preventDefault() {} }); }
  click() { this.clicked = true; }
  showModal() { this.open = true; }
  focus() {}
}
function elements(root) { return [root, ...root.children.flatMap(elements)]; }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(config = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-export-ui-26-"));
  const workspace = createPaperWorkspace({ dataDir });
  const input = { paperHash: HASH, metadata: { title: "Owned UI export" },
    blocks: [{ id: "b1", page: 1, text: "Owned old UI text" }] };
  if (config.missingResource) input.blocks[0].assetRef = { cacheId: "c".repeat(24), path: "images/missing.bin" };
  const paper = config.unpublished ? input : await workspace.upsertPaper(input);
  const routes = new Map(), app = {};
  for (const method of ["get", "post", "delete"]) app[method] = (route, handler) => routes.set(method.toUpperCase() + " " + route, handler);
  registerApiRoutes(app, { dataDir, workspace });
  const root = new Element("div"); root.root = true;
  const document = { baseURI: "https://owned.invalid/reader.html", body: root, activeElement: null,
    createElement: tag => new Element(tag), defaultView: { setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, removeEventListener() {} } };
  const previousWindow = globalThis.window; globalThis.window = document.defaultView;
  const previousDocument = globalThis.document; globalThis.document = document;
  const f = { dataDir, workspace, routes, root, document, currentPaper: structuredClone(paper), notifications: [], opened: [], writes: [], pending: [], preparations: 0,
    progress: { paperHash: HASH, blockId: "b1", percent: 45, noteDraft: { paperHash: HASH, note: "Owned unsaved note draft" } } };
  const apiFetch = (route, init = {}) => {
    const request = (async () => {
      const url = new URL(route, document.baseURI), method = init.method || "GET", body = init.body ? JSON.parse(init.body) : {};
      if (method === "POST") f.writes.push({ path: url.pathname, body });
      if (f.beforeRequest && method === "POST") await f.beforeRequest(url.pathname, body);
      const response = await routes.get(method + " " + url.pathname)({
        get: () => ({ principal: { id: "owned-export-ui" } }), req: { json: async () => body, query: key => url.searchParams.get(key) || "" },
        json: (value, status = 200) => ({ value, status }),
      });
      if (f.afterRequest && method === "POST") await f.afterRequest(response, url.pathname);
      if (response instanceof Response) return response;
      return { ok: response.status >= 200 && response.status < 300, status: response.status,
        headers: { get: () => "application/json" }, json: async () => f.transform ? f.transform(response.value) : response.value };
    })();
    f.pending.push(request); return request;
  };
  f.tools = createResearchTools({ root, document, apiFetch, apiUrl: route => "https://owned.invalid" + route,
    resourceOpen: async input => { f.opened.push(input); await f.onOpen?.(input); return { opened: true }; },
    getPaper: () => structuredClone(f.currentPaper), getProgress: () => structuredClone(f.progress),
    onPrepareResearchWrite: config.omitPrepare ? undefined : async input => {
      f.preparations++;
      await f.onPrepare?.(input);
      if (f.prepareResult !== undefined) return f.prepareResult;
      const saved = await workspace.upsertPaper({ ...f.currentPaper, expectedRevision: f.currentPaper.revision, expectedGeneration: f.currentPaper.generation });
      await workspace.setProgress({ ...f.progress, expectedGeneration: saved.generation });
      f.currentPaper = saved; return structuredClone(saved);
    },
    toast: value => { f.notifications.push(value); },
  });
  f.button = (kind = "export") => {
    const view = elements(root).find(item => item.id === "research-tool-" + (kind.startsWith("backup") ? "parse" : "export"));
    const label = kind === "backup-omitted" ? "导出不含资源的备份" : kind === "backup" ? "导出完整备份" : "导出双语 Markdown";
    const found = elements(view).find(item => item.tagName === "BUTTON" && item._text === label);
    assert.ok(found); return found;
  };
  f.idle = async () => {
    for (let attempt = 0; attempt < 25; attempt++) {
      const count = f.pending.length; await Promise.allSettled([...f.pending]); await new Promise(resolve => setImmediate(resolve));
      if (count === f.pending.length) return;
    }
    throw new Error("Owned UI requests did not settle");
  };
  f.open = async (kind = "export") => { f.tools.open(kind.startsWith("backup") ? "parse" : "export"); await f.idle(); };
  f.files = () => fs.existsSync(path.join(dataDir, "exports")) ? fs.readdirSync(path.join(dataDir, "exports")) : [];
  f.close = async () => {
    f.tools.destroy(); await f.idle(); await workspace.close();
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("hpr-export-ui-26-"));
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return f;
}

for (const kind of ["export", "backup"]) {
  test("the actual " + kind + " control prepares visible text and drafts before exporting with conditions", async () => {
    const f = await fixture();
    try {
      f.currentPaper.blocks[0].text = "Owned unsaved latest UI text";
      await f.open(kind); await f.button(kind).fire(); await f.idle();
      assert.equal(f.preparations, 1); assert.equal(f.writes.length, 1);
      assert.equal(f.writes[0].body.expectedRevision, f.currentPaper.revision);
      assert.equal(f.writes[0].body.expectedGeneration, f.currentPaper.generation);
      const bytes = fs.readFileSync(path.join(f.dataDir, "exports", f.files()[0]), "utf8");
      assert.ok(bytes.includes("Owned unsaved latest UI text"));
      if (kind === "backup") assert.equal(JSON.parse(bytes).progress.noteDraft.note, "Owned unsaved note draft");
    } finally { await f.close(); }
  });
}

test("a refreshed export control cannot resubmit a still pending output", async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  try {
    f.afterRequest = async () => { f.afterRequest = null; entered.resolve(); await release.promise; };
    await f.open(); const first = f.button().fire(); await entered.promise;
    f.tools.refresh(); assert.equal(f.button().disabled, true);
    await f.button().fire(); assert.equal(f.writes.length, 1);
    release.resolve(); await first; await f.idle();
  } finally { release.resolve(); await f.close(); }
});

test("a lost direct-save acknowledgement cannot automatically start another download", async () => {
  const f = await fixture();
  try {
    f.afterRequest = async () => { throw new Error("Owned lost save acknowledgement"); };
    await f.open(); await f.button().fire(); await f.idle();
    assert.equal(f.files().length, 1); assert.equal(f.opened.length, 0);
    assert.equal(elements(f.root).some(item => item.tagName === "A" && item.clicked), false);
    assert.equal(f.notifications.some(item => item.type === "success"), false);
  } finally { await f.close(); }
});

test("a malformed save receipt is not revealed or accepted as success", async () => {
  const f = await fixture();
  try {
    f.transform = value => value.saved ? { ...value, paperHash: OTHER } : value;
    await f.open(); await f.button().fire(); await f.idle();
    assert.equal(f.files().length, 1); assert.equal(f.opened.length, 0);
    assert.equal(f.notifications.some(item => item.type === "success"), false);
  } finally { await f.close(); }
});

test("an old export completion cannot reveal or notify a replacement context", async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  try {
    f.afterRequest = async () => { f.afterRequest = null; entered.resolve(); await release.promise; };
    await f.open(); const first = f.button().fire(); await entered.promise;
    f.tools.resetPaperState(); f.currentPaper = { ...f.currentPaper, paperHash: OTHER }; f.tools.refresh();
    f.notifications.length = 0; release.resolve(); await first; await f.idle();
    assert.equal(f.opened.length, 0); assert.deepEqual(f.notifications, []);
  } finally { release.resolve(); await f.close(); }
});

test("a rejected preparation keeps drafts and cannot issue an export", async () => {
  const f = await fixture();
  try {
    f.onPrepare = async () => { throw new Error("Owned failed paper or progress save"); };
    const before = structuredClone(f.progress);
    await f.open(); await f.button().fire();
    assert.equal(f.writes.length, 0); assert.deepEqual(f.files(), []); assert.deepEqual(f.progress, before);
    assert.equal(f.notifications.at(-1).type, "error"); assert.equal(f.button().disabled, false);
  } finally { await f.close(); }
});

test("missing preparation support cannot export a possibly unsaved view", async () => {
  const f = await fixture({ omitPrepare: true });
  try {
    await f.open(); await f.button().fire(); assert.equal(f.writes.length, 0); assert.deepEqual(f.files(), []);
    assert.match(f.notifications.at(-1).message, /同步不可用/);
  } finally { await f.close(); }
});

test("invalid prepared identities and versions do not receive a new export attempt", async () => {
  for (const transform of [paper => ({ ...paper, paperHash: OTHER }), paper => ({ ...paper, revision: -1 }), paper => ({ ...paper, revision: paper.revision + 1 }), () => null]) {
    const f = await fixture();
    try {
      f.prepareResult = transform(f.currentPaper);
      await f.open(); await f.button().fire(); assert.equal(f.writes.length, 0); assert.deepEqual(f.files(), []);
      assert.equal(f.notifications.at(-1).type, "error");
    } finally { await f.close(); }
  }
});

for (const changing of ["text", "progress", "long-text-tail"]) {
  test("a " + changing + " change while preparing blocks an export of a different visible state", async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    try {
      if (changing === "long-text-tail") f.currentPaper.blocks[0].text = "x".repeat(40000) + "Owned old tail";
      f.onPrepare = async () => { entered.resolve(); await release.promise; };
      await f.open(); const operation = f.button().fire(); await entered.promise;
      if (changing === "progress") f.progress.noteDraft.note = "Owned draft changed during save";
      else f.currentPaper.blocks[0].text = changing === "long-text-tail" ? "x".repeat(40000) + "Owned new tail" : "Owned text changed during save";
      release.resolve(); await operation;
      assert.equal(f.writes.length, 0); assert.deepEqual(f.files(), []); assert.match(f.notifications.at(-1).message, /已变化/);
    } finally { release.resolve(); await f.close(); }
  });
}

test("the same-content restore during preparation cannot grant the old export a new generation", async () => {
  const f = await fixture();
  try {
    f.onPrepare = async () => { f.currentPaper = await f.workspace.restoreBackup({ ...f.workspace.exportBackup(HASH, { includeAssets: false }), expectedRevision: f.currentPaper.revision }); };
    await f.open(); await f.button().fire();
    assert.equal(f.writes.length, 0); assert.deepEqual(f.files(), []); assert.match(f.notifications.at(-1).message, /恢复或重新导入/);
  } finally { await f.close(); }
});

for (const kind of ["export", "backup"]) {
  test("a real " + kind + " source conflict after preparation stops without another transport", async () => {
    const f = await fixture();
    try {
      f.beforeRequest = async () => {
        f.beforeRequest = null;
        if (kind === "backup") await f.workspace.restoreBackup({ ...f.workspace.exportBackup(HASH, { includeAssets: false }), expectedRevision: f.currentPaper.revision });
        else await f.workspace.upsertPaper({ paperHash: HASH, metadata: { title: "Owned other writer title" } });
      };
      await f.open(kind); await f.button(kind).fire();
      assert.equal(f.writes.length, 1); assert.deepEqual(f.files(), []); assert.deepEqual(f.opened, []);
      assert.equal(f.notifications.at(-1).type, "error"); assert.match(f.notifications.at(-1).message, /其他窗口/);
    } finally { await f.close(); }
  });
}

test("a detached old export control cannot act after the drawer refreshes", async () => {
  const f = await fixture();
  try {
    await f.open(); const old = f.button(); f.tools.refresh(); await old.fire();
    assert.equal(f.preparations, 0); assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test("pending backup protection survives a parse refresh and switching to Markdown", async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  try {
    f.afterRequest = async () => { f.afterRequest = null; entered.resolve(); await release.promise; };
    await f.open("backup"); const operation = f.button("backup").fire(); await entered.promise;
    f.tools.refresh(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.button("backup").disabled, true); await f.button("backup").fire();
    f.tools.open("export"); assert.equal(f.button().disabled, true); await f.button().fire();
    assert.equal(f.writes.length, 1); release.resolve(); await operation;
    assert.equal(f.button().disabled, false);
  } finally { release.resolve(); await f.close(); }
});

for (const action of ["close", "destroy", "generation"]) {
  test("a " + action + " during output suppresses later reveal and success notification", async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    try {
      f.afterRequest = async () => { f.afterRequest = null; entered.resolve(); await release.promise; };
      await f.open(); const operation = f.button().fire(); await entered.promise;
      if (action === "generation") {
        f.currentPaper = await f.workspace.restoreBackup({ ...f.workspace.exportBackup(HASH, { includeAssets: false }), expectedRevision: f.currentPaper.revision });
        f.tools.refresh();
      } else f.tools[action]();
      f.notifications.length = 0; release.resolve(); await operation; await f.idle();
      assert.equal(f.files().length, 1); assert.deepEqual(f.opened, []); assert.deepEqual(f.notifications, []);
    } finally { release.resolve(); await f.close(); }
  });
}

test("the old same-paper completion cannot unlock a new context's pending export", { timeout: 10000 }, async () => {
  const f = await fixture(), entered = deferred(), release = deferred(), enteredAgain = deferred(), releaseAgain = deferred();
  try {
    f.afterRequest = async () => { f.afterRequest = null; entered.resolve(); await release.promise; };
    await f.open(); const first = f.button().fire(); await entered.promise;
    f.tools.resetPaperState(); f.currentPaper = f.workspace.getPaper(HASH); f.tools.open("export");
    f.afterRequest = async () => { f.afterRequest = null; enteredAgain.resolve(); await releaseAgain.promise; };
    const second = f.button().fire(); await enteredAgain.promise;
    release.resolve(); await first; assert.equal(f.button().disabled, true); assert.deepEqual(f.opened, []);
    releaseAgain.resolve(); await second; assert.equal(f.button().disabled, false); assert.equal(f.opened.length, 1);
    assert.equal(f.files().length, 2);
  } finally { release.resolve(); releaseAgain.resolve(); await f.close(); }
});

test("malformed receipts in twelve forms never reveal or claim success and never fall back", async () => {
  const f = await fixture();
  try {
    for (const transform of [
      value => ({ ...value, ok: false }), value => ({ ...value, saved: false }),
      value => ({ ...value, paperHash: OTHER }), value => ({ ...value, sourceRevision: value.sourceRevision + 1 }),
      value => ({ ...value, sourceGeneration: value.sourceGeneration + 1 }), value => ({ ...value, size: 0 }),
      value => ({ ...value, sha256: "bad" }), value => ({ ...value, filePath: "relative/exports/" + value.fileName }),
      value => ({ ...value, fileName: "../invalid.md" }), value => ({ ...value, filePath: "C:\\Other\\" + value.fileName }),
      value => ({ ...value, fileName: "bad.txt", filePath: path.join(f.dataDir, "exports", "bad.txt") }),
      value => ({ ...value, filePath: value.filePath + "\u0000" }),
    ]) {
      f.transform = value => value.saved ? transform(value) : value;
      await f.open(); await f.button().fire(); assert.match(f.notifications.at(-1).message, /回执无效/);
    }
    assert.equal(f.files().length, 12); assert.deepEqual(f.opened, []);
    assert.equal(f.notifications.some(value => value.type === "success"), false);
    assert.equal(elements(f.root).some(item => item.tagName === "A" && item.clicked), false);
  } finally { await f.close(); }
});

test("an actual confirmed export remains successful if revealing its file fails", async () => {
  const f = await fixture();
  try {
    f.onOpen = async () => { throw new Error("Owned reveal unavailable"); };
    await f.open(); await f.button().fire(); assert.equal(f.files().length, 1);
    assert.equal(f.opened.length, 1); assert.equal(f.notifications.at(-1).type, "success"); assert.equal(f.writes.length, 1);
  } finally { await f.close(); }
});

test("an explicit retry after a lost reply is allowed and remains separate from automatic replay", async () => {
  const f = await fixture();
  try {
    f.afterRequest = async () => { throw new Error("Owned lost reply"); };
    await f.open(); await f.button().fire(); assert.equal(f.files().length, 1); assert.deepEqual(f.opened, []);
    f.afterRequest = null; await f.button().fire(); assert.equal(f.files().length, 2); assert.equal(f.writes.length, 2);
    assert.equal(f.notifications.at(-1).type, "success");
  } finally { await f.close(); }
});

test("an unpublished raw paper can export after its own first prepared commit", async () => {
  const f = await fixture({ unpublished: true });
  try {
    await f.open(); await f.button().fire(); assert.equal(f.files().length, 1); assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].body.expectedGeneration, f.currentPaper.generation); assert.equal(f.notifications.at(-1).type, "success");
  } finally { await f.close(); }
});

function legacyDocument() {
  const root = new Element("div"); root.root = true;
  return { root, baseURI: "https://owned.invalid/reader.html", body: root, createElement: tag => new Element(tag), defaultView: { setTimeout() {} } };
}
const legacyParams = { paperHash: HASH, expectedRevision: 4, expectedGeneration: 2 };
test("legacy host download carries source conditions and reports only dispatch", async () => {
  const document = legacyDocument(); let opened, sessionRequested;
  const result = await startDownload(document, "/api/research/export", legacyParams, (route, flags) => {
    sessionRequested = flags.withSurfaceSession; return "https://owned.invalid" + route;
  }, async input => { opened = input; return { opened: true }; });
  assert.equal(result.method, "host"); assert.equal(result.saved, undefined); assert.equal(sessionRequested, true);
  assert.equal(new URL(opened.resource.url).searchParams.get("expectedGeneration"), "2");
});
test("an explicitly refused legacy host opener permits a conditional native attempt", async () => {
  const document = legacyDocument();
  const result = await startDownload(document, "/api/research/export", legacyParams, undefined, async () => ({ opened: false }));
  assert.equal(result.method, "native"); const anchor = document.root.children[0]; assert.equal(anchor.clicked, true);
  assert.equal(new URL(anchor.href).searchParams.get("expectedRevision"), "4");
});
test("a lost legacy host reply cannot start a native download", async () => {
  const document = legacyDocument();
  await assert.rejects(startDownload(document, "/api/research/export", legacyParams, undefined, async () => { throw new Error("Owned host reply lost"); }), /结果未确认/);
  assert.equal(document.root.children.length, 0);
});
test("an obsolete download is rejected before any API or opener action", async () => {
  const document = legacyDocument(); let actions = 0;
  const result = await startDownload(document, "/api/research/export", legacyParams, undefined, async () => { actions++; }, async () => { actions++; }, { isCurrent: () => false });
  assert.equal(result.method, "stale"); assert.equal(actions, 0); assert.equal(document.root.children.length, 0);
});
test("a legacy context changed during an explicit host refusal cannot start a native attempt", async () => {
  const document = legacyDocument(); let current = true;
  const result = await startDownload(document, "/api/research/export", legacyParams, undefined, async () => {
    current = false; return { opened: false };
  }, undefined, { isCurrent: () => current });
  assert.equal(result.method, "stale"); assert.equal(document.root.children.length, 0);
});

test("a missing resource stops the complete backup control without automatically creating a partial backup", async () => {
  const f = await fixture({ missingResource: true });
  try {
    await f.open("backup"); await f.button("backup").fire();
    assert.deepEqual(f.files(), []); assert.equal(f.writes.length, 1); assert.deepEqual(f.opened, []);
    assert.match(f.notifications.at(-1).message, /缺少或无法读取资源/); assert.equal(f.notifications.at(-1).type, "error");
    assert.equal(f.button("backup-omitted").disabled, false);
  } finally { await f.close(); }
});

test("an explicit resource-free control saves drafts and truthfully reports omitted resources", async () => {
  const f = await fixture({ missingResource: true });
  try {
    await f.open("backup"); await f.button("backup-omitted").fire();
    assert.equal(f.writes.length, 1); assert.equal(f.writes[0].body.includeAssets, "false");
    const backup = JSON.parse(fs.readFileSync(path.join(f.dataDir, "exports", f.files()[0]), "utf8"));
    assert.equal(backup.assetMode, "omitted"); assert.deepEqual(backup.assets, []);
    assert.equal(backup.progress.noteDraft.note, "Owned unsaved note draft");
    assert.match(f.notifications.at(-1).message, /不含资源的备份已保存/); assert.equal(f.notifications.at(-1).type, "success");
  } finally { await f.close(); }
});

test("a mismatched or missing resource mode receipt cannot report a complete or resource-free success", async () => {
  for (const [kind, assetMode] of [["backup", "omitted"], ["backup-omitted", "included"], ["backup", undefined]]) {
    const f = await fixture();
    try {
      f.transform = value => value.saved ? { ...value, assetMode } : value;
      await f.open("backup"); await f.button(kind).fire();
      assert.equal(f.files().length, 1); assert.deepEqual(f.opened, []);
      assert.equal(f.notifications.at(-1).type, "error"); assert.match(f.notifications.at(-1).message, /回执无效/);
    } finally { await f.close(); }
  }
});

test("a pending resource-free backup protects all export controls through refresh", async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  try {
    f.afterRequest = async () => { f.afterRequest = null; entered.resolve(); await release.promise; };
    await f.open("backup"); const operation = f.button("backup-omitted").fire(); await entered.promise;
    f.tools.refresh(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.button("backup-omitted").disabled, true); assert.equal(f.button("backup").disabled, true);
    await f.button("backup").fire(); assert.equal(f.writes.length, 1);
    release.resolve(); await operation; assert.equal(f.button("backup").disabled, false);
  } finally { release.resolve(); await f.close(); }
});

test("a resource-free completion from an obsolete context cannot reveal or notify", async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  try {
    f.afterRequest = async () => { f.afterRequest = null; entered.resolve(); await release.promise; };
    await f.open("backup"); const operation = f.button("backup-omitted").fire(); await entered.promise;
    const other = await f.workspace.upsertPaper({ paperHash: OTHER, metadata: { title: "Owned replacement context" }, blocks: [{ id: "b1", page: 1, text: "Owned replacement text" }] });
    f.tools.resetPaperState(); f.currentPaper = other; f.tools.refresh();
    await new Promise(resolve => setImmediate(resolve));
    f.notifications.length = 0; release.resolve(); await operation;
    assert.deepEqual(f.opened, []); assert.deepEqual(f.notifications, []); assert.equal(f.files().length, 1);
  } finally { release.resolve(); await f.close(); }
});

for (const mode of ["included", "omitted", "legacy"]) {
  test("an actual confirmed " + mode + " restore explains its resource scope", async () => {
    const f = await fixture();
    try {
      const backup = f.workspace.exportBackup(HASH, { includeAssets: mode !== "omitted" });
      if (mode === "legacy") delete backup.assetMode;
      await f.open("backup");
      const view = elements(f.root).find(item => item.id === "research-tool-parse");
      const input = elements(view).find(item => item.tagName === "INPUT" && item.type === "file");
      input.files = [{ size: 2000, text: async () => JSON.stringify(backup) }];
      const operation = input.fire("change"); await new Promise(resolve => setImmediate(resolve));
      const dialog = elements(f.root).find(item => item.tagName === "DIALOG"); assert.ok(dialog);
      elements(dialog).find(item => item.tagName === "BUTTON" && item._text === "确认").fire();
      await operation; await f.idle();
      const notice = f.notifications.at(-1);
      assert.match(notice.message, /备份恢复成功/);
      if (mode === "included") assert.equal(notice.type, "success");
      else { assert.equal(notice.type, "info"); assert.match(notice.message, mode === "legacy" ? /旧备份未声明/ : /不含图片和附件/); }
    } finally { await f.close(); }
  });
}
