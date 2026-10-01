import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { createMigrationUi } from "../ui/assets/migration-ui.js";
import registerMigrationRoutes from "../server/http/migration-routes.js";
import { createPaperWorkspace } from "../server/domain/paper-workspace.js";

const HASH = "a".repeat(64), SOURCE = "b".repeat(64);
const OTHER_ID = "11111111-1111-4111-8111-111111111111";
const KEY = "hana-paper-reader-migration-plan-v1";
const tick = () => new Promise(resolve => setImmediate(resolve));
const canonicalCheckpoint = value => Array.isArray(value) ? value.map(canonicalCheckpoint)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalCheckpoint(value[key])])) : value;
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

// This deliberately small element substitute reads the production template's
// attributes. It never opens a browser, uses a real clipboard, or sends input.
class Element {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.doc = doc; this.children = []; this.parentNode = null;
    this.dataset = {}; this.attributes = {}; this.handlers = new Map(); this.disabled = false;
    const classes = new Set(); this.classList = { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) };
  }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, handler) { this.handlers.set(type, handler); }
  fire(type = "click", event = {}) { return this.handlers.get(type)?.({ target: this, preventDefault() {}, stopPropagation() {}, ...event }); }
  click() { if (this.tagName === "A") this.doc.downloads.push({ href: this.href, name: this.download }); else this.fire(); }
  focus() { this.doc.activeElement = this; }
  showModal() { this.open = true; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(item => item !== this); this.parentNode = null; }
  set innerHTML(value) {
    this._html = value; this.children = [];
    for (const match of value.matchAll(/<(\w+)\b[^>]*\b(data-migration-[\w-]+)(?:="([^"]*)")?[^>]*>/g)) {
      const child = new Element(match[1], this.doc); child.setAttribute(match[2], match[3] || "");
      if (match[2] === "data-migration-paper") child.dataset.migrationPaper = match[3];
      this.append(child);
    }
  }
  get innerHTML() { return this._html || ""; }
  querySelectorAll(selector) {
    const key = selector.slice(1, -1);
    return this.children.flatMap(child => [...(Object.hasOwn(child.attributes, key) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return Object.hasOwn(this.attributes, selector.slice(1, -1)) ? this : this.parentNode?.closest(selector); }
}
function bundle() {
  return { format: "hana-paper-reader-migration", version: 1, sourceFingerprint: SOURCE, sensitiveConfigPolicy: "manual-reentry",
    papers: [{ format: "hana-paper-reader-backup", version: 1, assetMode: "omitted", paperHash: HASH,
      paper: { paperHash: HASH, metadata: { title: "Owned migration UI fixture" }, blocks: [{ id: "b1", page: 1, text: "Owned source evidence" }] },
      notes: [], bookmarks: [], tasks: [], assets: [], translationCache: [] }] };
}
function fixture(config = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-migration-ui-28-"));
  const workspace = createPaperWorkspace({ dataDir }), routes = new Map(), app = {};
  for (const method of ["get", "post"]) app[method] = (route, handler) => routes.set(method.toUpperCase() + " " + route, handler);
  registerMigrationRoutes(app, { dataDir, workspace });
  const doc = { downloads: [], blobs: [], activeElement: null, defaultView: new EventTarget(), handlers: new Map() };
  doc.createElement = tag => new Element(tag, doc); doc.body = new Element("body", doc);
  doc.addEventListener = (type, handler) => doc.handlers.set(type, handler);
  const storage = new Map(), previous = { document: globalThis.document, localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
    createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL, setTimeout: globalThis.setTimeout };
  globalThis.document = doc; globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  if (config.storedPlanId !== undefined) storage.set(KEY, config.storedPlanId);
  URL.createObjectURL = blob => { doc.blobs.push(blob); return "blob:owned-migration-fixture"; }; URL.revokeObjectURL = () => {}; globalThis.setTimeout = () => 1;
  const f = { dataDir, workspace, routes, doc, storage, requests: [], pending: [], notifications: [], changed: 0, plans: [] };
  const apiFetch = (route, init = {}) => {
    const operation = (async () => {
      const url = new URL(route, "https://owned.invalid"), method = init.method || "GET";
      f.requests.push({ path: url.pathname, method, body: init.body });
      await f.before?.(url.pathname, method);
      const parts = url.pathname.split("/"), id = parts[3];
      const key = url.pathname === "/api/migration/prepare" ? "POST /api/migration/prepare"
        : method + " /api/migration/:planId" + (parts[4] ? "/" + parts[4] + (parts[4] === "papers" ? "/:paperHash" : "") : "");
      const response = await routes.get(key)({ get: () => ({ principal: { id: "owned-migration-ui" } }), header() {},
        req: { text: async () => init.body || "", param: name => name === "planId" ? id : parts[5] },
        json: (value, status = 200) => ({ value, status }) });
      if (response instanceof Response) {
        const value = await response.json(); await f.after?.(url.pathname, method, value);
        return { ok: response.ok, status: response.status, json: async () => f.transform ? f.transform(value, url.pathname, method) : value };
      }
      if (response.value.plan) f.plans.push(structuredClone(response.value.plan));
      await f.after?.(url.pathname, method, response.value);
      const value = f.transform ? f.transform(structuredClone(response.value), url.pathname, method) : response.value;
      return { ok: response.status >= 200 && response.status < 300, status: response.status,
        json: async () => value, blob: async () => new Blob([JSON.stringify(value)]) };
    })();
    f.pending.push(operation); return operation;
  };
  f.createUi = () => createMigrationUi({ apiFetch, toast: async value => { f.notifications.push(value); await f.onToast?.(); },
    onChanged: async () => { f.changed++; await f.onChanged?.(); } });
  f.ui = f.createUi();
  f.modal = doc.body.children[0]; f.control = key => f.modal.querySelector(`[data-migration-${key}]`);
  f.idle = async () => {
    for (let i = 0; i < 25; i++) { const count = f.pending.length; await Promise.allSettled([...f.pending]); await tick(); if (count === f.pending.length) return; }
    throw new Error("Owned migration UI requests did not settle");
  };
  f.select = async (value = bundle(), overrides = {}) => {
    const text = JSON.stringify(value); f.control("input").files = [{ size: Buffer.byteLength(text), text: async () => text, ...overrides }];
    f.control("input").fire("change"); await f.idle();
  };
  f.commit = async (accept = true) => {
    f.control("commit").fire(); await tick();
    const dialog = doc.body.children.find(item => item.tagName === "DIALOG");
    if (dialog) dialog.children[2].children[accept ? 1 : 0].fire();
    await f.idle();
  };
  f.closeModal = () => f.modal.querySelectorAll("[data-migration-close]")[0].fire();
  f.close = async () => {
    await f.idle(); await workspace.close();
    if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document;
    if (previous.localStorage === undefined) delete globalThis.localStorage; else Object.defineProperty(globalThis, "localStorage", previous.localStorage);
    URL.createObjectURL = previous.createObjectURL; URL.revokeObjectURL = previous.revokeObjectURL; globalThis.setTimeout = previous.setTimeout;
    const target = path.resolve(dataDir); assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith("hpr-migration-ui-28-")); fs.rmSync(target, { recursive: true, force: true });
  };
  f.ui.open(); return f;
}

test("an invalid newly selected file cannot leave the previous plan ready for import", async () => {
  const f = fixture();
  try { await f.select(); assert.equal(f.control("commit").disabled, false);
    await f.select(bundle(), { size: 0 }); assert.equal(f.control("commit").disabled, true);
    await f.commit(); assert.equal(f.requests.filter(item => item.path.endsWith("/commit")).length, 0);
  } finally { await f.close(); }
});

test("a prepared receipt with another target policy is not accepted or remembered", async () => {
  const f = fixture();
  try { f.transform = value => value.plan ? { ...value, plan: { ...value.plan, policy: "replace-target" } } : value;
    await f.select(); assert.equal(f.control("commit").disabled, true); assert.equal(f.storage.has(KEY), false);
    assert.match(f.control("status").textContent, /回执|核对/);
  } finally { await f.close(); }
});

test("a status response from another plan cannot replace the plan being refreshed", async () => {
  const f = fixture();
  try { await f.select(); const id = f.storage.get(KEY);
    f.transform = value => value.plan ? { ...value, plan: { ...value.plan, planId: OTHER_ID } } : value;
    f.control("refresh").fire(); await f.idle(); assert.equal(f.control("commit").disabled, true);
    assert.equal(f.storage.get(KEY), id); assert.match(f.control("status").textContent, /回执|核对/);
  } finally { await f.close(); }
});

for (const change of ["planId", "sourceFingerprint"]) {
  test("a commit response with a changed " + change + " cannot claim a verified import", async () => {
    const f = fixture();
    try { await f.select(); f.transform = (value, route) => route.endsWith("/commit") ? { ...value, plan: { ...value.plan,
      [change]: change === "planId" ? OTHER_ID : "c".repeat(64) } } : value;
      await f.commit(); assert.equal(f.changed, 0); assert.deepEqual(f.notifications, []);
      assert.equal(f.control("commit").disabled, true); assert.match(f.control("status").textContent, /刷新|核对/);
      assert.ok(f.workspace.getPaper(HASH)); // Real owned import completed; the UI cannot infer it from a wrong receipt.
    } finally { await f.close(); }
  });
}

test("a lost commit acknowledgement stays blocked until an explicit verified status refresh", async () => {
  const f = fixture();
  try { await f.select(); f.after = async route => { if (route.endsWith("/commit")) throw new Error("Owned lost commit response"); };
    await f.commit(); assert.equal(f.control("commit").disabled, true); assert.deepEqual(f.notifications, []);
    await f.commit(); assert.equal(f.requests.filter(item => item.path.endsWith("/commit")).length, 1);
    f.after = null; f.control("refresh").fire(); await f.idle(); assert.match(f.control("status").textContent, /导入完成/);
    assert.equal(f.control("commit").disabled, true); assert.ok(f.workspace.getPaper(HASH));
  } finally { await f.close(); }
});

test("a receipt download completed after closing the modal cannot start a native download", async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try { await f.select(); f.after = async route => { if (route.endsWith("/receipt")) { entered.resolve(); await release.promise; } };
    f.control("receipt").fire(); await entered.promise; f.closeModal(); release.resolve(); await f.idle();
    assert.deepEqual(f.doc.downloads, []);
  } finally { release.resolve(); await f.close(); }
});

test("a confirmed real import preserves existing target research and imports only the missing paper", async () => {
  const f = fixture(), existing = "c".repeat(64);
  try {
    await f.workspace.upsertPaper({ paperHash: existing, metadata: { title: "Owned existing target" }, blocks: [{ id: "b1", text: "Keep owned target" }] });
    await f.workspace.putNote({ paperHash: existing, blockId: "b1", id: "keep-note", note: "Keep existing note" });
    const before = f.workspace.load(), input = bundle();
    const kept = structuredClone(input.papers[0]); kept.paperHash = existing; kept.paper.paperHash = existing; input.papers.unshift(kept);
    await f.select(input); await f.commit();
    assert.equal(f.changed, 1); assert.equal(f.notifications.at(-1).type, "success");
    assert.deepEqual(f.workspace.getPaper(existing), before.papers[existing]);
    assert.deepEqual(f.workspace.load().notes["keep-note"], before.notes["keep-note"]); assert.ok(f.workspace.getPaper(HASH));
    assert.equal(f.control("commit").disabled, true);
  } finally { await f.close(); }
});

test("cancelled confirmation and a closed modal cannot start an import", async () => {
  const f = fixture();
  try {
    await f.select(); await f.commit(false); assert.equal(f.requests.filter(item => item.path.endsWith("/commit")).length, 0);
    f.control("commit").fire(); await tick(); const dialog = f.doc.body.children.find(item => item.tagName === "DIALOG");
    assert.ok(dialog); f.closeModal(); dialog.children[2].children[1].fire(); await f.idle();
    assert.equal(f.requests.filter(item => item.path.endsWith("/commit")).length, 0); assert.equal(f.workspace.getPaper(HASH), null);
  } finally { await f.close(); }
});

test("choosing a different plan invalidates an earlier confirmation", async () => {
  const f = fixture();
  try {
    await f.select(); const oldId = f.storage.get(KEY); f.control("commit").fire(); await tick();
    const dialog = f.doc.body.children.find(item => item.tagName === "DIALOG");
    await f.select(); assert.notEqual(f.storage.get(KEY), oldId); dialog.children[2].children[1].fire(); await f.idle();
    assert.equal(f.requests.filter(item => item.path.endsWith("/commit")).length, 0); assert.equal(f.workspace.getPaper(HASH), null);
  } finally { await f.close(); }
});

test("repeated commit clicks share one confirmation and one actual import", async () => {
  const f = fixture();
  try {
    await f.select(); f.control("commit").fire(); f.control("commit").fire(); await tick();
    assert.equal(f.control("commit").disabled, true);
    f.doc.body.children.find(item => item.tagName === "DIALOG").children[2].children[1].fire(); await f.idle();
    const remaining = f.doc.body.children.find(item => item.tagName === "DIALOG"); if (remaining) remaining.children[2].children[0].fire();
    await f.idle(); assert.equal(remaining, undefined); assert.equal(f.requests.filter(item => item.path.endsWith("/commit")).length, 1);
  } finally {
    for (const dialog of f.doc.body.children.filter(item => item.tagName === "DIALOG")) dialog.children[2].children[0].fire();
    await tick(); for (const dialog of f.doc.body.children.filter(item => item.tagName === "DIALOG")) dialog.children[2].children[0].fire();
    await f.close();
  }
});

test("invalid raw JSON stops before another prepare request and preserves the older resume pointer", async () => {
  const f = fixture();
  try { await f.select(); const id = f.storage.get(KEY); await f.select(null, { text: async () => "{owned invalid JSON" });
    assert.equal(f.requests.filter(item => item.path.endsWith("/prepare")).length, 1); assert.equal(f.storage.get(KEY), id);
    assert.equal(f.control("commit").disabled, true); f.control("refresh").fire(); await f.idle();
    assert.equal(f.control("commit").disabled, false); assert.equal(f.requests.filter(item => item.path.endsWith("/commit")).length, 0);
  } finally { await f.close(); }
});

test("prepared results must match the selected file source and ordered paper identities", async () => {
  for (const change of [plan => ({ ...plan, sourceFingerprint: "c".repeat(64) }),
    plan => ({ ...plan, rows: plan.rows.map(row => ({ ...row, paperHash: "c".repeat(64) })) }), plan => ({ ...plan, rows: [] })]) {
    const f = fixture();
    try { f.transform = value => ({ ...value, plan: change(value.plan) }); await f.select();
      assert.equal(f.control("commit").disabled, true); assert.equal(f.storage.has(KEY), false); assert.match(f.control("status").textContent, /回执|核对/);
    } finally { await f.close(); }
  }
});

test("malformed receipt variants remain a visible error without a render exception or import", async () => {
  const variants = [() => null, () => [], plan => ({ ...plan, rows: null }), plan => ({ ...plan, planId: "../unsafe" }),
    plan => ({ ...plan, bundleFingerprint: "missing" }), plan => ({ ...plan, createdAt: "invalid" }),
    plan => ({ ...plan, rows: [...plan.rows, plan.rows[0]] }), plan => ({ ...plan, rows: plan.rows.map(row => ({ ...row, assets: 1.5 })) }),
    plan => ({ ...plan, state: "completed" }), plan => ({ ...plan, imported: [HASH] }),
    plan => ({ ...plan, acceptance: "passed" }), plan => ({ ...plan, imported: null }),
    plan => ({ ...plan, planId: [plan.planId] }), plan => ({ ...plan, sourceFingerprint: [plan.sourceFingerprint] }),
    plan => ({ ...plan, bundleFingerprint: [plan.bundleFingerprint] })];
  for (const change of variants) {
    const f = fixture();
    try { f.transform = value => ({ ...value, plan: change(value.plan) }); await f.select();
      assert.equal(f.control("commit").disabled, true); assert.equal(f.control("select").disabled, false);
      assert.equal(f.storage.has(KEY), false); assert.match(f.control("status").textContent, /回执|核对/); assert.deepEqual(f.notifications, []);
    } finally { await f.close(); }
  }
});

test("non-boolean success flags cannot confirm a migration preparation", async () => {
  for (const ok of ["true", 1, null]) {
    const f = fixture(); try { f.transform = value => ({ ...value, ok }); await f.select();
      assert.equal(f.control("commit").disabled, true); assert.equal(f.storage.has(KEY), false);
    } finally { await f.close(); }
  }
});

test("a request that failed before commit stays blocked until explicit status and an explicit new confirmation", async () => {
  const f = fixture();
  try { await f.select(); f.before = async route => { if (route.endsWith("/commit")) throw new Error("Owned pre-send failure"); };
    await f.commit(); assert.equal(f.workspace.getPaper(HASH), null); await f.commit();
    assert.equal(f.requests.filter(item => item.path.endsWith("/commit")).length, 1);
    f.before = null; f.control("refresh").fire(); await f.idle(); assert.equal(f.control("commit").disabled, false);
    assert.equal(f.workspace.getPaper(HASH), null); await f.commit(); assert.ok(f.workspace.getPaper(HASH));
  } finally { await f.close(); }
});

test("verified status after a lost commit response refreshes the library without another commit", async () => {
  const f = fixture();
  try { await f.select(); f.after = async route => { if (route.endsWith("/commit")) throw new Error("Owned lost acknowledgement"); };
    await f.commit(); assert.equal(f.changed, 0); f.after = null; f.control("refresh").fire(); await f.idle();
    assert.equal(f.changed, 1); f.control("refresh").fire(); await f.idle(); assert.equal(f.changed, 1);
    assert.equal(f.requests.filter(item => item.path.endsWith("/commit")).length, 1); assert.deepEqual(f.notifications, []);
  } finally { await f.close(); }
});

test("a completed import remains successful when library refresh or toast fails", async () => {
  const f = fixture();
  try { await f.select(); f.onChanged = async () => { throw new Error("Owned library refresh failure"); };
    f.onToast = async () => { throw new Error("Owned toast failure"); }; await f.commit();
    assert.ok(f.workspace.getPaper(HASH)); assert.match(f.control("status").textContent, /结果已经保存/);
    assert.equal(f.notifications[0].type, "success"); assert.equal(f.control("commit").disabled, true);
  } finally { await f.close(); }
});

test("an import finishing after close keeps saved data but suppresses the obsolete success notification", async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try { await f.select(); f.after = async route => { if (route.endsWith("/commit")) { entered.resolve(); await release.promise; } };
    f.control("commit").fire(); await tick(); f.doc.body.children.find(item => item.tagName === "DIALOG").children[2].children[1].fire();
    await entered.promise; f.closeModal(); release.resolve(); await f.idle();
    assert.ok(f.workspace.getPaper(HASH)); assert.equal(f.changed, 1); assert.deepEqual(f.notifications, []);
  } finally { release.resolve(); await f.close(); }
});

test("a callback that closes and reopens the modal cannot deliver the prior import toast", async () => {
  const f = fixture();
  try { await f.select(); f.onChanged = async () => { f.closeModal(); f.ui.open(); }; await f.commit();
    assert.deepEqual(f.notifications, []); assert.ok(f.workspace.getPaper(HASH)); assert.equal(f.control("commit").disabled, true);
  } finally { await f.close(); }
});

test("a commit still reported as importing cannot claim a final result or replay automatically", async () => {
  const f = fixture();
  try { await f.select(); f.transform = (value, route) => route.endsWith("/commit") ? { ...value,
    plan: { ...value.plan, state: "importing", imported: [], kept: [], failed: [], currentPaper: HASH, finishedAt: undefined } } : value;
    await f.commit(); assert.equal(f.changed, 0); assert.deepEqual(f.notifications, []); assert.equal(f.control("commit").disabled, true);
    assert.match(f.control("status").textContent, /正在导入/); f.transform = null; f.control("refresh").fire(); await f.idle();
    assert.equal(f.changed, 1); assert.match(f.control("status").textContent, /导入完成/);
  } finally { await f.close(); }
});

test("verified receipt and isolated backup downloads contain the correct source and paper", async () => {
  const f = fixture();
  try { await f.select(); const id = f.storage.get(KEY); f.control("receipt").fire(); await f.idle();
    const receipt = JSON.parse(await f.doc.blobs[0].text()); assert.equal(receipt.planId, id); assert.equal(receipt.sourceFingerprint, SOURCE);
    const row = f.control("rows").querySelector("[data-migration-paper]"); f.control("rows").fire("click", { target: row }); await f.idle();
    const backup = JSON.parse(await f.doc.blobs[1].text()); assert.equal(backup.paperHash, HASH); assert.equal(backup.assetMode, "omitted");
    assert.equal(f.doc.downloads.length, 2); assert.equal(f.workspace.getPaper(HASH), null);
  } finally { await f.close(); }
});

test("a receipt from another plan cannot become a downloaded receipt", async () => {
  const f = fixture();
  try { await f.select(); f.transform = (value, route) => route.endsWith("/receipt") ? { ...value, planId: OTHER_ID } : value;
    f.control("receipt").fire(); await f.idle(); assert.deepEqual(f.doc.downloads, []); assert.deepEqual(f.doc.blobs, []);
    assert.match(f.control("status").textContent, /回执|核对/);
  } finally { await f.close(); }
});

test("an isolated backup belonging to another paper cannot be downloaded", async () => {
  const f = fixture();
  try { await f.select(); f.transform = (value, route) => route.includes("/papers/") ? { ...value, paperHash: "c".repeat(64) } : value;
    f.control("rows").fire("click", { target: f.control("rows").querySelector("[data-migration-paper]") }); await f.idle();
    assert.deepEqual(f.doc.downloads, []); assert.match(f.control("status").textContent, /回执|核对/);
  } finally { await f.close(); }
});

test("an isolated download from the earlier plan cannot start after another file is prepared", async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  try { await f.select(); f.after = async route => { if (route.includes("/papers/")) { entered.resolve(); await release.promise; } };
    f.control("rows").fire("click", { target: f.control("rows").querySelector("[data-migration-paper]") }); await entered.promise;
    f.control("input").files = [{ size: 1, text: async () => JSON.stringify(bundle()) }]; f.control("input").fire("change"); await tick();
    release.resolve(); await f.idle(); assert.deepEqual(f.doc.downloads, []);
  } finally { release.resolve(); await f.close(); }
});

test("a plan containing only existing papers cannot ask for an unnecessary import", async () => {
  const f = fixture();
  try { await f.workspace.upsertPaper({ paperHash: HASH, blocks: [{ id: "b1", text: "Existing owned text" }] });
    await f.select(); assert.equal(f.control("commit").disabled, true); await f.commit();
    assert.equal(f.requests.filter(item => item.path.endsWith("/commit")).length, 0); assert.equal(f.workspace.getPaper(HASH).blocks[0].text, "Existing owned text");
  } finally { await f.close(); }
});

test("an unsafe persisted plan pointer cannot dispatch a request on opening", async () => {
  for (const id of ["../outside", "", "11111111/1111/4111/8111/111111111111"]) {
    const f = fixture({ storedPlanId: id }); try { await f.idle(); assert.deepEqual(f.requests, []); assert.equal(f.control("commit").disabled, true); }
    finally { await f.close(); }
  }
});

test("a new UI instance resumes its verified completed receipt without replaying the import", async () => {
  const f = fixture();
  try { await f.select(); await f.commit(); f.closeModal(); const resumed = f.createUi(); resumed.open(); await f.idle();
    const modal = f.doc.body.children.at(-1); assert.match(modal.querySelector("[data-migration-status]").textContent, /导入完成/);
    assert.equal(modal.querySelector("[data-migration-commit]").disabled, true);
    assert.equal(f.requests.filter(item => item.path.endsWith("/commit")).length, 1); assert.ok(f.workspace.getPaper(HASH));
  } finally { await f.close(); }
});

test("a real partial import retains its completed paper and never claims full completion", async () => {
  const f = fixture(), second = "c".repeat(64), third = "d".repeat(64);
  try {
    const input = bundle(); for (const hash of [second, third]) { const paper = structuredClone(input.papers[0]); paper.paperHash = hash; paper.paper.paperHash = hash; input.papers.push(paper); }
    const original = f.workspace.restoreBackup.bind(f.workspace); let calls = 0;
    f.workspace.restoreBackup = async (...args) => { calls++; if (calls === 2) throw new Error("Owned second paper failure"); return original(...args); };
    await f.select(input); await f.commit(); assert.ok(f.workspace.getPaper(HASH));
    assert.equal(f.workspace.getPaper(second), null); assert.equal(f.workspace.getPaper(third), null); assert.equal(calls, 2);
    assert.equal(f.notifications.at(-1).type, "error"); assert.match(f.control("status").textContent, /部分论文导入失败/);
    assert.equal(f.control("commit").disabled, true); await f.commit(); assert.equal(calls, 2);
  } finally { await f.close(); }
});

test("changed immutable preview rows invalidate a commit result even when the plan ID matches", async () => {
  const f = fixture();
  try { await f.select(); f.transform = (value, route) => route.endsWith("/commit") ? { ...value,
    plan: { ...value.plan, rows: value.plan.rows.map(row => ({ ...row, notes: row.notes + 1 })) } } : value;
    await f.commit(); assert.equal(f.changed, 0); assert.deepEqual(f.notifications, []); assert.ok(f.workspace.getPaper(HASH));
    assert.equal(f.control("commit").disabled, true); assert.match(f.control("status").textContent, /核对/);
  } finally { await f.close(); }
});

test("a stale prepared response after commit cannot authorize replay and explicit status recovers the saved result", async () => {
  const f = fixture();
  try { await f.select(); const prepared = structuredClone(f.plans.at(-1));
    f.transform = (value, route) => route.endsWith("/commit") ? { ...value, plan: prepared } : value;
    await f.commit(); assert.ok(f.workspace.getPaper(HASH)); assert.equal(f.changed, 0); assert.deepEqual(f.notifications, []);
    assert.equal(f.control("commit").disabled, true); f.transform = null; f.control("refresh").fire(); await f.idle();
    assert.equal(f.changed, 1); assert.match(f.control("status").textContent, /导入完成/);
    assert.equal(f.requests.filter(item => item.path.endsWith("/commit")).length, 1);
  } finally { await f.close(); }
});

test("a persisted interrupted intent is displayed without replaying the unstarted paper", async () => {
  const f = fixture();
  try { await f.select(); const id = f.storage.get(KEY), receiptPath = path.join(f.dataDir, "migration", "imports", id, "receipt.json");
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")); receipt.state = "importing"; receipt.currentPaper = HASH;
    const { receiptChecksum, ...checkpointPayload } = receipt;
    receipt.receiptChecksum = createHash("sha256").update(JSON.stringify(canonicalCheckpoint(checkpointPayload))).digest("hex");
    fs.writeFileSync(receiptPath, JSON.stringify(receipt)); f.control("refresh").fire(); await f.idle();
    assert.match(f.control("status").textContent, /中断/); assert.equal(f.control("commit").disabled, true);
    await f.commit(); assert.equal(f.requests.filter(item => item.path.endsWith("/commit")).length, 0);
    assert.equal(f.workspace.getPaper(HASH), null); assert.deepEqual(f.notifications, []);
  } finally { await f.close(); }
});

test("invalid source fingerprint types cannot send a file preparation request from the UI", async () => {
  for (const value of [[SOURCE], [], null, 1]) { const f = fixture();
    try { const input = bundle(); input.sourceFingerprint = value; await f.select(input);
      assert.equal(f.requests.filter(item => item.path.endsWith("/prepare")).length, 0); assert.equal(f.control("commit").disabled, true);
      assert.equal(f.storage.has(KEY), false);
    } finally { await f.close(); }
  }
});
