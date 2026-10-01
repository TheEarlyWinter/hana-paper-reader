import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createResearchTools } from "../ui/assets/research-tools.js";
import registerApiRoutes from "../server/http/api-routes.js";
import { createPaperWorkspace } from "../server/domain/paper-workspace.js";

const HASH = "a".repeat(64), OTHER = "b".repeat(64);
const blocks = [{ id: "b1", page: 1, type: "paragraph", text: "Owned first evidence" },
  { id: "b2", page: 2, type: "paragraph", text: "Owned second evidence" }];

// This is an in-memory element substitute, not a browser or DOM acceptance test.
class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
    this.dataset = {}; this.style = {}; this.attributes = {}; this.handlers = new Map();
    this.classList = { toggle() {}, remove() {}, add() {} };
    this.disabled = false; this._text = ""; this._value = undefined;
  }
  set textContent(value) { this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  set value(value) { this._value = String(value); }
  get value() { return this._value ?? (this.tagName === "SELECT" ? (this.children.find(child => child.selected) || this.children[0])?.value || "" : ""); }
  get isConnected() { return Boolean(this.root || this.parentNode?.isConnected); }
  append(...children) { for (const child of children) this.appendChild(child); }
  appendChild(child) { child.remove(); child.parentNode = this; this.children.push(child); return child; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); }
  contains(element) { return this === element || this.children.some(child => child.contains(element)); }
  querySelectorAll(selector) { assert.equal(selector, "button"); return descendants(this).filter(element => element !== this && element.tagName === "BUTTON"); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(type, handler) { this.handlers.set(type, handler); }
  fire(type) { return this.handlers.get(type)?.({ target: this, preventDefault() {} }); }
}
function descendants(root) { return [root, ...root.children.flatMap(descendants)]; }
function glossaryForm(h) {
  const view = descendants(h.root).find(element => element.id === "research-tool-glossary");
  const elements = descendants(view);
  return { view, form: elements.find(element => element.tagName === "FORM"),
    term: elements.find(element => element.getAttribute("aria-label") === "原文术语"),
    translation: elements.find(element => element.getAttribute("aria-label") === "固定译法"),
    save: elements.find(element => element.tagName === "BUTTON" && element._text === "添加术语") };
}
function typeGlossary(h, source, target) {
  const form = glossaryForm(h);
  form.term.value = source; form.term.fire("input");
  form.translation.value = target; form.translation.fire("input");
  return form;
}
function toolView(h, id) { return descendants(h.root).find(element => element.id === `research-tool-${id}`); }
function toolButton(h, id, label) {
  const found = descendants(toolView(h, id)).find(element => element.tagName === "BUTTON" && element._text === label);
  assert.ok(found, `Missing ${id} button: ${label}`); return found;
}
function evidencePrompt(h) { return descendants(toolView(h, "evidence")).find(element => element.tagName === "TEXTAREA"); }
async function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-note-draft-"));
  const workspace = createPaperWorkspace({ dataDir });
  const paper = await workspace.upsertPaper({ paperHash: HASH, blocks, metadata: { title: "Owned note test" } });
  const routes = new Map(), app = {};
  for (const method of ["get", "post", "delete"]) app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  const modelState = { requests: [], cancellations: [], answer: "Owned answer\nPage 1 / block b1", beforeStream: null, failure: null };
  registerApiRoutes(app, { dataDir, modelTimeoutMs: 2000,
    agents: {
      list: async () => ({ agents: [{ id: "owned-agent", name: "Owned synthetic assistant" }] }),
      profile: async () => ({ profile: { id: "owned-agent", name: "Owned synthetic assistant", identity: "Owned instructions", model: { provider: "owned", id: "reader" } } }),
    },
    models: {
      list: async () => ({ models: [{ provider: "owned", id: "reader", name: "Owned synthetic model" }] }),
      stream: async input => {
        modelState.requests.push(input);
        await modelState.beforeStream?.(input);
        if (modelState.failure) throw modelState.failure;
        return [{ type: "start", requestId: input.requestId }, { type: "text-delta", requestId: input.requestId, delta: modelState.answer },
          { type: "done", requestId: input.requestId, stopReason: "stop", assistant: { role: "assistant", content: [{ type: "text", text: modelState.answer }] } }];
      },
      cancel: async requestId => { modelState.cancellations.push(requestId); },
    },
  });
  const pending = [];
  return { dataDir, workspace, paper, routes, pending, modelState, async close() {
    for (let attempt = 0; attempt < 20; attempt++) {
      const count = pending.length;
      await Promise.allSettled([...pending]);
      await new Promise(resolve => setImmediate(resolve));
      if (pending.length === count) break;
      assert.ok(attempt < 19, "Owned note callbacks must settle before cleanup");
    }
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("hpr-note-draft-"));
    fs.rmSync(dataDir, { recursive: true, force: true });
  } };
}
function harness(f, { refreshAfterSave = true } = {}) {
  const root = new Element("div"); root.root = true;
  const doc = { createElement: tag => new Element(tag), activeElement: null,
    defaultView: { setTimeout: () => 1, clearTimeout() {} } };
  let held = null, rejection = null;
  const h = { currentPaper: f.paper, selectedId: "b1", root, notifications: [], writes: [], changed: [], uiChanges: [], tools: null };
  const fetch = (route, init = {}) => {
    const operation = (async () => {
      const method = init.method || "GET", parsed = new URL(route, "https://owned.invalid");
      if (rejection && method === "POST" && parsed.pathname === rejection.pathName) { const error = rejection.error; rejection = null; throw error; }
      const body = init.body ? JSON.parse(init.body) : {};
      if (method !== "GET") h.writes.push({ method, route, body });
      let handler = f.routes.get(`${method} ${parsed.pathname}`), params = {};
      const itemRoute = parsed.pathname.match(/^\/api\/research\/(notes|bookmarks)\/([^/]+)$/);
      if (!handler && itemRoute) {
        handler = f.routes.get(`${method} /api/research/${itemRoute[1]}/:id`);
        params.id = decodeURIComponent(parsed.pathname.split("/").at(-1));
      }
      assert.ok(handler, `No owned route: ${method} ${parsed.pathname}`);
      const result = await handler({ get: () => ({ principal: { id: "owned-note-draft" } }),
        req: { json: async () => body, query: key => parsed.searchParams.get(key) || "", param: key => params[key] || "", raw: { signal: init.signal } },
        json: (value, status = 200) => ({ value, status }) });
      if (held?.method === method && held.path === parsed.pathname) {
        const gate = held; held = null; gate.entered(); await gate.gate;
      }
      if (h.failAfterResponse && method === "POST") throw new Error("Owned delayed response failure");
      return { ok: result.status >= 200 && result.status < 300, status: result.status,
        headers: { get: () => "application/json" }, json: async () => h.dataTransform ? h.dataTransform(structuredClone(result.value)) : result.value };
    })();
    f.pending.push(operation);
    return operation;
  };
  h.tools = createResearchTools({ root, document: doc, apiFetch: fetch,
    // Like researchPaperView, each read returns a fresh public view object.
    getPaper: () => ({ ...h.currentPaper }), getSelectedBlock: () => h.currentPaper.blocks.find(block => block.id === h.selectedId),
    onPrepareResearchWrite: input => h.prepareEvidence?.(input),
    onPaperStateChanged: change => {
      const callback = (async () => { h.changed.push(change); await h.afterSave?.(change); if (refreshAfterSave) h.tools.refresh(); })();
      f.pending.push(callback);
      return callback;
    },
    onUiStateChanged: value => h.uiChanges.push(structuredClone(value)),
    toast: value => { h.notifications.push(value); },
  });
  h.holdNext = (method = "POST", pathName = "/api/research/notes") => {
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
    held = { method, path: pathName, gate, entered };
    return { ready, release };
  };
  h.rejectNext = (pathName = "/api/research/notes") => { rejection = { pathName, error: new Error("Owned offline research save") }; };
  h.idle = async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const count = f.pending.length;
      await Promise.allSettled([...f.pending]);
      await new Promise(resolve => setImmediate(resolve));
      if (f.pending.length === count) return;
    }
    throw new Error("Owned note requests did not settle");
  };
  h.view = () => descendants(root).find(item => item.id === "research-tool-notes");
  h.note = () => descendants(h.view()).find(item => item.tagName === "TEXTAREA");
  h.tags = () => descendants(h.view()).find(item => item.getAttribute("aria-label") === "笔记标签");
  h.type = () => descendants(h.view()).find(item => item.getAttribute("aria-label") === "笔记类型");
  h.button = label => { const found = descendants(h.view()).find(item => item.tagName === "BUTTON" && item._text === label); assert.ok(found, `Missing button: ${label}`); return found; };
  h.typeNote = text => { h.note().value = text; h.note().fire("input"); };
  h.edit = async () => { h.tools.open("notes"); await h.idle(); h.button("编辑").fire("click"); await h.idle(); };
  return h;
}
function evidenceHarness(f) { const h = harness(f); h.currentPaper = { ...f.paper, agentId: "owned-agent", modelRef: "agent-default", thinkingLevel: "low" }; h.tools.open("evidence"); return h; }
function typeQuestion(h, question) { evidencePrompt(h).value = question; evidencePrompt(h).fire("input"); }
function holdModel(f) {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  f.modelState.beforeStream = async () => { f.modelState.beforeStream = null; entered(); await gate; };
  return { release, ready };
}

test("an actual evidence drawer refresh keeps an unsubmitted question", async () => {
  const f = await fixture();
  try {
    const h = harness(f); h.tools.open("evidence");
    evidencePrompt(h).value = "Owned unsubmitted question"; evidencePrompt(h).fire("input");
    h.tools.refresh();
    assert.equal(evidencePrompt(h).value, "Owned unsubmitted question");
  } finally { await f.close(); }
});

test("an actual bookmark drawer refresh cannot repeat its pending creation", async () => {
  const f = await fixture(); let gate;
  try {
    const h = harness(f); h.tools.open("markers"); await h.idle();
    gate = h.holdNext("POST", "/api/research/bookmarks"); toolButton(h, "markers", "添加证据书签").fire("click"); await gate.ready;
    h.tools.refresh(); toolButton(h, "markers", "添加证据书签").fire("click");
    gate.release(); await h.idle();
    assert.equal(h.writes.filter(value => value.route === "/api/research/bookmarks").length, 1);
    assert.equal(f.workspace.listItems("bookmarks", HASH).length, 1);
  } finally { gate?.release(); await f.close(); }
});

test("a failed bookmark submission enables the current button and allows one successful retry", async () => {
  const f = await fixture();
  try {
    const h = harness(f); h.tools.open("markers"); await h.idle(); h.rejectNext("/api/research/bookmarks");
    toolButton(h, "markers", "添加证据书签").fire("click"); await h.idle();
    assert.equal(f.workspace.listItems("bookmarks", HASH).length, 0);
    assert.equal(toolButton(h, "markers", "添加证据书签").disabled, false);
    toolButton(h, "markers", "添加证据书签").fire("click"); await h.idle();
    assert.equal(f.workspace.listItems("bookmarks", HASH).length, 1);
  } finally { await f.close(); }
});

test("a late bookmark failure is silent after resetting its paper context", async () => {
  const f = await fixture(); let gate;
  try {
    const h = harness(f); h.tools.open("markers"); await h.idle();
    gate = h.holdNext("POST", "/api/research/bookmarks"); toolButton(h, "markers", "添加证据书签").fire("click"); await gate.ready;
    h.failAfterResponse = true; h.tools.resetPaperState(); h.tools.open("notes"); h.typeNote("Current draft");
    gate.release(); await h.idle();
    assert.equal(h.notifications.some(value => value.type === "error"), false);
    assert.equal(h.tools.uiState().noteDraft.note, "Current draft");
    assert.equal(f.workspace.listItems("bookmarks", HASH).length, 1, "A lost receipt does not undo a committed bookmark");
  } finally { gate?.release(); await f.close(); }
});

test("an old bookmark completion cannot release the pending button of a new same-paper context", async () => {
  const f = await fixture(); let oldGate, newGate;
  try {
    const h = harness(f); h.tools.open("markers"); await h.idle();
    oldGate = h.holdNext("POST", "/api/research/bookmarks"); toolButton(h, "markers", "添加证据书签").fire("click"); await oldGate.ready;
    const oldRequest = f.pending.at(-1);
    h.tools.resetPaperState(); h.tools.open("markers");
    newGate = h.holdNext("POST", "/api/research/bookmarks"); toolButton(h, "markers", "添加证据书签").fire("click"); await newGate.ready;
    oldGate.release(); await oldRequest; await new Promise(resolve => setImmediate(resolve));
    assert.equal(toolButton(h, "markers", "添加证据书签").disabled, true);
    assert.equal(h.changed.length, 0);
    newGate.release(); await h.idle();
    assert.equal(toolButton(h, "markers", "添加证据书签").disabled, false);
    assert.equal(h.changed.length, 1);
  } finally { oldGate?.release(); newGate?.release(); await f.close(); }
});

test("an old detached bookmark control cannot submit on behalf of a different paper", async () => {
  const f = await fixture();
  try {
    const h = harness(f); h.tools.open("markers"); await h.idle(); const old = toolButton(h, "markers", "添加证据书签");
    h.tools.resetPaperState(); h.currentPaper = await f.workspace.upsertPaper({ paperHash: OTHER, blocks }); h.tools.open("markers"); await h.idle();
    old.fire("click"); await h.idle();
    assert.equal(h.writes.length, 0);
    assert.equal(f.workspace.listItems("bookmarks", OTHER).length, 0);
  } finally { await f.close(); }
});

test("a bookmark uses the evidence displayed by its current control", async () => {
  const f = await fixture();
  try {
    const h = harness(f); h.tools.open("markers"); await h.idle(); h.selectedId = "b2";
    toolButton(h, "markers", "添加证据书签").fire("click"); await h.idle();
    assert.equal(f.workspace.listItems("bookmarks", HASH)[0].blockId, "b1");
  } finally { await f.close(); }
});

test("an actual evidence answer survives a drawer refresh and stays paired with its submitted question", async () => {
  const f = await fixture(); let gate;
  try {
    const h = evidenceHarness(f); typeQuestion(h, "Submitted original question");
    gate = h.holdNext("POST", "/api/research/evidence"); const asking = toolButton(h, "evidence", "提交问题").fire("click"); await gate.ready;
    typeQuestion(h, "New unsent continuation"); h.tools.refresh();
    gate.release(); await asking; await h.idle();
    const view = toolView(h, "evidence");
    assert.equal(evidencePrompt(h).value, "New unsent continuation");
    assert.ok(view.textContent.includes("问题：Submitted original question"));
    assert.ok(view.textContent.includes("Owned answer"));
    h.tools.refresh(); assert.ok(toolView(h, "evidence").textContent.includes("Owned answer"));
    assert.equal(toolButton(h, "evidence", "提交问题").disabled, false);
    assert.equal(f.modelState.requests.length, 1);
  } finally { gate?.release(); await f.close(); }
});

test("an evidence preparation cannot adopt a new existing-paper generation even with identical content", async () => {
  const f = await fixture();
  try {
    const h = evidenceHarness(f); typeQuestion(h, "Question for the original owner");
    h.prepareEvidence = async () => {
      const backup = f.workspace.exportBackup(HASH);
      await f.workspace.restoreBackup({ ...backup, expectedRevision: f.workspace.getPaper(HASH).revision });
      h.currentPaper = { ...f.workspace.getPaper(HASH), agentId: "owned-agent", modelRef: "agent-default" };
      return { ...h.currentPaper };
    };
    await toolButton(h, "evidence", "提交问题").fire("click"); await h.idle();
    assert.equal(f.modelState.requests.length, 0);
    assert.equal(h.writes.filter(value => value.route === "/api/research/evidence").length, 0);
    assert.equal(evidencePrompt(h).value, "Question for the original owner");
  } finally { await f.close(); }
});

test("a stale reader view cannot ask a question against newer committed source text", async () => {
  const f = await fixture();
  try {
    const h = evidenceHarness(f); typeQuestion(h, "Question for the visible source");
    await f.workspace.upsertPaper({ paperHash: HASH, blocks: blocks.map(block => block.id === "b1" ? { ...block, text: "Other writer source" } : block) });
    await toolButton(h, "evidence", "提交问题").fire("click"); await h.idle();
    assert.equal(f.modelState.requests.length, 0); assert.equal(evidencePrompt(h).value, "Question for the visible source");
    assert.ok(!toolView(h, "evidence").textContent.includes("Owned answer"));
  } finally { await f.close(); }
});

for (const change of ["source", "question", "cancel"]) {
  test(`a ${change} change during question preparation preserves the draft and respects its original intent`, async () => {
    const f = await fixture(); let release;
    try {
      const h = evidenceHarness(f); typeQuestion(h, "Original preparation question");
      let entered; const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
      h.prepareEvidence = async () => { entered(); await gate; return { ...h.currentPaper }; };
      const asking = toolButton(h, "evidence", "提交问题").fire("click"); await ready;
      if (change === "source") h.currentPaper = { ...h.currentPaper, blocks: h.currentPaper.blocks.map(block => block.id === "b1" ? { ...block, text: "New local preparation source" } : block) };
      if (change === "question") typeQuestion(h, "New question while preparing");
      if (change === "cancel") toolButton(h, "evidence", "取消问答").fire("click");
      release(); await asking; await h.idle();
      if (change === "question") {
        assert.equal(f.modelState.requests.length, 1);
        assert.equal(evidencePrompt(h).value, "New question while preparing");
        assert.ok(toolView(h, "evidence").textContent.includes("问题：Original preparation question"));
      } else {
        assert.equal(f.modelState.requests.length, 0);
        assert.equal(h.writes.length, 0); assert.equal(evidencePrompt(h).value, "Original preparation question");
      }
    } finally { release?.(); await f.close(); }
  });
}

test("question preparation failure retains its draft without sending or automatically retrying", async () => {
  const f = await fixture();
  try {
    const h = evidenceHarness(f); typeQuestion(h, "Draft during unavailable storage");
    h.prepareEvidence = async () => { throw new Error("Owned preparation failure"); };
    await toolButton(h, "evidence", "提交问题").fire("click"); await h.idle();
    assert.equal(evidencePrompt(h).value, "Draft during unavailable storage");
    assert.equal(f.modelState.requests.length, 0); assert.equal(h.writes.length, 0);
    assert.equal(toolButton(h, "evidence", "提交问题").disabled, false);
  } finally { await f.close(); }
});

for (const field of ["sourceBasis", "sourceGeneration"]) {
  test(`an evidence reply with an incorrect ${field} preserves the question and cannot display as valid`, async () => {
    const f = await fixture();
    try {
      const h = evidenceHarness(f); typeQuestion(h, "Question with inconsistent receipt");
      h.dataTransform = data => { if (data.answer) data[field] = field === "sourceBasis" ? "Unrelated source" : 999; return data; };
      await toolButton(h, "evidence", "提交问题").fire("click"); await h.idle();
      assert.equal(evidencePrompt(h).value, "Question with inconsistent receipt");
      assert.ok(!toolView(h, "evidence").textContent.includes("Owned answer"));
      assert.ok(toolView(h, "evidence").textContent.includes("回执"));
      assert.equal(f.modelState.requests.length, 1);
    } finally { await f.close(); }
  });
}

test("an evidence answer is discarded if its source text changed during the request", async () => {
  const f = await fixture(); let gate;
  try {
    const h = evidenceHarness(f); typeQuestion(h, "Question about original text");
    gate = h.holdNext("POST", "/api/research/evidence"); const asking = toolButton(h, "evidence", "提交问题").fire("click"); await gate.ready;
    h.currentPaper = { ...h.currentPaper, blocks: h.currentPaper.blocks.map(block => block.id === "b1" ? { ...block, text: "New local source text" } : block) };
    gate.release(); await asking; await h.idle();
    assert.ok(!toolView(h, "evidence").textContent.includes("Owned answer"));
    assert.equal(evidencePrompt(h).value, "Question about original text");
  } finally { gate?.release(); await f.close(); }
});

test("a previously displayed evidence answer is invalidated when its source changes", async () => {
  const f = await fixture();
  try {
    const h = evidenceHarness(f); typeQuestion(h, "Question about original text");
    await toolButton(h, "evidence", "提交问题").fire("click"); await h.idle();
    assert.ok(toolView(h, "evidence").textContent.includes("Owned answer"));
    h.currentPaper = { ...h.currentPaper, blocks: h.currentPaper.blocks.map(block => block.id === "b1" ? { ...block, page: 9 } : block) };
    h.tools.refresh();
    assert.ok(!toolView(h, "evidence").textContent.includes("Owned answer"));
  } finally { await f.close(); }
});

test("a pending evidence request stays single while refreshing or switching the tool", async () => {
  const f = await fixture(); let gate;
  try {
    const h = evidenceHarness(f); typeQuestion(h, "Only once");
    gate = h.holdNext("POST", "/api/research/evidence"); const asking = toolButton(h, "evidence", "提交问题").fire("click"); await gate.ready;
    h.tools.open("notes"); h.tools.open("evidence");
    assert.equal(toolButton(h, "evidence", "提交问题").disabled, true);
    await toolButton(h, "evidence", "提交问题").fire("click");
    gate.release(); await asking; await h.idle();
    assert.equal(f.modelState.requests.length, 1);
    assert.ok(toolView(h, "evidence").textContent.includes("Owned answer"));
  } finally { gate?.release(); await f.close(); }
});

test("an actual evidence cancellation reaches the model boundary and preserves its question for retry", async () => {
  const f = await fixture(); let gate;
  try {
    const h = evidenceHarness(f); typeQuestion(h, "Question to cancel"); gate = holdModel(f);
    const asking = toolButton(h, "evidence", "提交问题").fire("click"); await gate.ready;
    toolButton(h, "evidence", "取消问答").fire("click"); await asking;
    assert.equal(f.modelState.cancellations.length, 1);
    assert.equal(evidencePrompt(h).value, "Question to cancel");
    assert.ok(toolView(h, "evidence").textContent.includes("请求已取消"));
    assert.equal(h.notifications.some(value => value.type === "error"), false);
    const retry = toolButton(h, "evidence", "提交问题").fire("click"); await retry;
    gate.release(); await h.idle();
    assert.equal(f.modelState.requests.length, 2);
    assert.ok(toolView(h, "evidence").textContent.includes("Owned answer"));
  } finally { gate?.release(); await f.close(); }
});

for (const action of ["reset", "destroy"]) {
  test(`an evidence ${action} cancels an active model request through the actual route`, async () => {
    const f = await fixture(); let gate;
    try {
      const h = evidenceHarness(f); typeQuestion(h, "Active request"); gate = holdModel(f);
      const asking = toolButton(h, "evidence", "提交问题").fire("click"); await gate.ready;
      if (action === "destroy") h.tools.destroy(); else { h.tools.resetPaperState(); h.tools.refresh(); typeQuestion(h, "New context"); }
      await asking;
      assert.equal(f.modelState.cancellations.length, 1); assert.equal(h.notifications.some(value => value.type === "error"), false);
      if (action === "reset") assert.equal(evidencePrompt(h).value, "New context");
      gate.release(); await h.idle();
    } finally { gate?.release(); await f.close(); }
  });
}

test("an overlong evidence question is retained and rejected before the model is called", async () => {
  const f = await fixture();
  try {
    const h = evidenceHarness(f); typeQuestion(h, "x".repeat(12001));
    await toolButton(h, "evidence", "提交问题").fire("click"); await h.idle();
    assert.equal(f.modelState.requests.length, 0); assert.equal(h.writes.length, 0);
    assert.equal(evidencePrompt(h).value.length, 12001);
    assert.equal(h.notifications.some(value => value.type === "error"), true);
  } finally { await f.close(); }
});

test("a same-content paper generation change invalidates an earlier evidence answer", async () => {
  const f = await fixture();
  try {
    const h = evidenceHarness(f); typeQuestion(h, "Original generation question");
    await toolButton(h, "evidence", "提交问题").fire("click"); await h.idle();
    h.currentPaper = { ...h.currentPaper, generation: h.currentPaper.generation + 1 }; h.tools.refresh();
    assert.ok(!toolView(h, "evidence").textContent.includes("Owned answer"));
    assert.equal(evidencePrompt(h).value, "Original generation question");
  } finally { await f.close(); }
});

test("an uncited model answer labels the available evidence without claiming it was cited", async () => {
  const f = await fixture();
  try {
    const h = evidenceHarness(f); typeQuestion(h, "Uncited answer question"); f.modelState.answer = "Owned uncited inference";
    await toolButton(h, "evidence", "提交问题").fire("click"); await h.idle();
    assert.ok(toolView(h, "evidence").textContent.includes("本次提供给助手的论文证据"));
    assert.ok(toolView(h, "evidence").textContent.includes("Owned uncited inference"));
    assert.ok(!toolView(h, "evidence").textContent.includes("已引用"));
  } finally { await f.close(); }
});

test("canceling a delayed evidence receipt cannot release or replace a newer request", async () => {
  const f = await fixture(); let oldGate, newGate;
  try {
    const h = evidenceHarness(f); typeQuestion(h, "Old question");
    oldGate = h.holdNext("POST", "/api/research/evidence"); const oldAsking = toolButton(h, "evidence", "提交问题").fire("click"); await oldGate.ready;
    toolButton(h, "evidence", "取消问答").fire("click");
    typeQuestion(h, "New question"); f.modelState.answer = "New owned answer\nPage 1 / block b1";
    newGate = h.holdNext("POST", "/api/research/evidence"); const newAsking = toolButton(h, "evidence", "提交问题").fire("click"); await newGate.ready;
    oldGate.release(); await oldAsking;
    assert.equal(toolButton(h, "evidence", "提交问题").disabled, true);
    assert.ok(!toolView(h, "evidence").textContent.includes("Owned answer"));
    newGate.release(); await newAsking; await h.idle();
    assert.ok(toolView(h, "evidence").textContent.includes("问题：New question"));
    assert.ok(toolView(h, "evidence").textContent.includes("New owned answer"));
  } finally { oldGate?.release(); newGate?.release(); await f.close(); }
});

test("a failed evidence request preserves its question and allows a successful retry", async () => {
  const f = await fixture();
  try {
    const h = evidenceHarness(f); typeQuestion(h, "Retain after model failure"); f.modelState.failure = new Error("Owned unavailable model");
    await toolButton(h, "evidence", "提交问题").fire("click"); await h.idle();
    assert.equal(evidencePrompt(h).value, "Retain after model failure");
    assert.equal(toolButton(h, "evidence", "提交问题").disabled, false);
    assert.ok(!toolView(h, "evidence").textContent.includes("Owned answer"));
    f.modelState.failure = null; await toolButton(h, "evidence", "提交问题").fire("click"); await h.idle();
    assert.ok(toolView(h, "evidence").textContent.includes("Owned answer"));
  } finally { await f.close(); }
});

test("a JSON and progress restored question keeps its original evidence until explicitly rebound", async () => {
  const f = await fixture();
  try {
    const h = evidenceHarness(f); typeQuestion(h, "Original evidence question");
    const draft = JSON.parse(JSON.stringify(h.tools.uiState().evidenceDraft));
    await f.workspace.setProgress({ paperHash: HASH, evidenceDraft: draft });
    h.selectedId = "b2"; h.tools.refresh();
    const h2 = evidenceHarness(f); h2.selectedId = "b2"; h2.tools.restoreUiState(f.workspace.getProgress(HASH)); h2.tools.refresh();
    assert.equal(evidencePrompt(h2).value, draft.question);
    await toolButton(h2, "evidence", "提交问题").fire("click"); await h2.idle();
    assert.equal(h2.writes[0].body.blockId, "b1");
    toolButton(h2, "evidence", "使用当前段落").fire("click");
    f.modelState.answer = "Rebound answer\nPage 2 / block b2";
    await toolButton(h2, "evidence", "提交问题").fire("click"); await h2.idle();
    assert.equal(h2.writes[1].body.blockId, "b2");
    assert.equal(evidencePrompt(h2).value, draft.question);
  } finally { await f.close(); }
});

for (const replacement of ["same paper reset", "different paper", "destroyed drawer"]) {
  test(`a late evidence result does not affect a ${replacement} context`, async () => {
    const f = await fixture(); let gate;
    try {
      const h = evidenceHarness(f); typeQuestion(h, "Old context question");
      gate = h.holdNext("POST", "/api/research/evidence"); const asking = toolButton(h, "evidence", "提交问题").fire("click"); await gate.ready;
      if (replacement === "destroyed drawer") h.tools.destroy();
      else {
        h.tools.resetPaperState();
        if (replacement === "different paper") h.currentPaper = { ...await f.workspace.upsertPaper({ paperHash: OTHER, blocks }), agentId: "owned-agent" };
        h.tools.refresh(); typeQuestion(h, "Current context question");
      }
      gate.release(); await asking; await h.idle();
      assert.equal(h.notifications.some(value => value.type === "error"), false);
      if (replacement !== "destroyed drawer") {
        assert.equal(evidencePrompt(h).value, "Current context question");
        assert.ok(!toolView(h, "evidence").textContent.includes("Owned answer"));
      }
    } finally { gate?.release(); await f.close(); }
  });
}

for (const mismatch of ["wrong paper", "wrong question", "missing success", "wrong evidence paper"]) {
  test(`an evidence ${mismatch} receipt does not display an answer as valid`, async () => {
    const f = await fixture();
    try {
      const h = evidenceHarness(f); typeQuestion(h, "Question with bad receipt");
      h.dataTransform = data => {
        if (data.answer) {
          if (mismatch === "wrong paper") data.paperHash = OTHER;
          if (mismatch === "wrong question") data.question = "Different question";
          if (mismatch === "missing success") delete data.ok;
          if (mismatch === "wrong evidence paper") data.evidence[0].paperHash = OTHER;
        }
        return data;
      };
      await toolButton(h, "evidence", "提交问题").fire("click"); await h.idle();
      assert.equal(evidencePrompt(h).value, "Question with bad receipt");
      assert.ok(!toolView(h, "evidence").textContent.includes("Owned answer"));
      assert.ok(toolView(h, "evidence").textContent.includes("回执"));
      assert.equal(f.modelState.requests.length, 1);
    } finally { await f.close(); }
  });
}

test("an actual glossary refresh keeps unsaved term input", async () => {
  const f = await fixture();
  try {
    const h = harness(f); h.tools.open("glossary"); await h.idle();
    typeGlossary(h, "Owned pending term", "Owned pending translation");
    h.tools.refresh(); await h.idle();
    assert.equal(glossaryForm(h).term.value, "Owned pending term");
    assert.equal(glossaryForm(h).translation.value, "Owned pending translation");
  } finally { await f.close(); }
});

test("an actual glossary-save acknowledgement keeps newer term input", async () => {
  const f = await fixture(); let gate;
  try {
    const h = harness(f); h.tools.open("glossary"); await h.idle();
    const form = typeGlossary(h, "Submitted term", "Submitted translation");
    gate = h.holdNext("POST", "/api/research/glossary");
    const submit = form.form.fire("submit"); await gate.ready;
    typeGlossary(h, "New continuation", "New translation");
    gate.release(); await submit; await h.idle();
    assert.equal(glossaryForm(h).term.value, "New continuation");
    assert.equal(glossaryForm(h).translation.value, "New translation");
    assert.equal(f.workspace.getGlossary(HASH).terms["Submitted term"], "Submitted translation");
  } finally { gate?.release(); await f.close(); }
});

test("an actual stale glossary list cannot delete a newer term translation", async () => {
  const f = await fixture();
  try {
    await f.workspace.putGlossary({ paperHash: HASH, terms: { evidence: "Original term" } });
    const h = harness(f); h.tools.open("glossary"); await h.idle();
    const oldView = glossaryForm(h).view;
    const remove = descendants(oldView).find(element => element.tagName === "BUTTON" && element._text === "删除");
    await f.workspace.putGlossary({ paperHash: HASH, terms: { evidence: "Other writer translation" } });
    await remove.fire("click"); await h.idle();
    assert.equal(f.workspace.getGlossary(HASH).terms.evidence, "Other writer translation");
    assert.equal(h.notifications.some(value => value.type === "success"), false);
  } finally { await f.close(); }
});

test("an actual stale glossary form cannot overwrite another writer translation", async () => {
  const f = await fixture();
  try {
    await f.workspace.putGlossary({ paperHash: HASH, terms: { evidence: "Original term" } });
    const h = harness(f); h.tools.open("glossary"); await h.idle();
    const form = typeGlossary(h, "evidence", "Old editor translation");
    await f.workspace.putGlossary({ paperHash: HASH, terms: { evidence: "Other writer translation" } });
    await form.form.fire("submit"); await h.idle();
    assert.equal(f.workspace.getGlossary(HASH).terms.evidence, "Other writer translation");
    assert.equal(glossaryForm(h).translation.value, "Old editor translation");
  } finally { await f.close(); }
});

test("an actual note-save acknowledgement cannot clear a newer draft typed while waiting", async () => {
  const f = await fixture(); let gate;
  try {
    const h = harness(f); h.tools.open("notes"); await h.idle();
    h.typeNote("Submitted note"); gate = h.holdNext(); h.button("保存研究笔记").fire("click");
    await gate.ready;
    h.typeNote("New unsaved continuation");
    gate.release(); await h.idle();
    assert.equal(h.tools.uiState().noteDraft?.note, "New unsaved continuation");
    assert.equal(h.note().value, "New unsaved continuation");
    assert.equal(f.workspace.listItems("notes", HASH)[0].note, "Submitted note");
  } finally { gate?.release(); await f.close(); }
});

test("an unchanged glossary save clears its own draft and enables the current refreshed form", async () => {
  const f = await fixture();
  try {
    const h = harness(f); h.tools.open("glossary"); await h.idle();
    await typeGlossary(h, "Unchanged", "Owned").form.fire("submit"); await h.idle();
    assert.equal(h.tools.uiState().glossaryDraft, null);
    assert.equal(glossaryForm(h).term.value, "");
    assert.equal(glossaryForm(h).save.disabled, false);
    assert.equal(h.notifications.filter(value => value.type === "success").length, 1);
  } finally { await f.close(); }
});

test("a refreshed glossary form cannot duplicate a pending submission", async () => {
  const f = await fixture(); let gate;
  try {
    const h = harness(f); h.tools.open("glossary"); await h.idle();
    const form = typeGlossary(h, "Original", "Owned");
    gate = h.holdNext("POST", "/api/research/glossary"); const submitting = form.form.fire("submit"); await gate.ready;
    h.tools.refresh(); await new Promise(resolve => setImmediate(resolve));
    // Only wait for the new GET requests, since the original POST is held.
    await Promise.all(f.pending.slice(-2)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(glossaryForm(h).save.disabled, true);
    await glossaryForm(h).form.fire("submit");
    assert.equal(h.writes.filter(value => value.method === "POST").length, 1);
    typeGlossary(h, "Continuation", "Later");
    gate.release(); await submitting; await h.idle();
    assert.equal(glossaryForm(h).save.disabled, false);
    await glossaryForm(h).form.fire("submit"); await h.idle();
    assert.equal(f.workspace.getGlossary(HASH).terms.Continuation, "Later");
  } finally { gate?.release(); await f.close(); }
});

test("a JSON and progress restored glossary draft preserves its original condition", async () => {
  const f = await fixture();
  try {
    const h = harness(f); h.tools.open("glossary"); await h.idle(); typeGlossary(h, "Archived term", "Pending value");
    const draft = JSON.parse(JSON.stringify(h.tools.uiState().glossaryDraft));
    await f.workspace.setProgress({ paperHash: HASH, glossaryDraft: draft });
    const fresh = createPaperWorkspace({ dataDir: f.dataDir });
    const h2 = harness(f); h2.tools.restoreUiState(fresh.getProgress(HASH)); h2.tools.open("glossary"); await h2.idle();
    assert.equal(glossaryForm(h2).term.value, draft.term);
    assert.equal(h2.tools.uiState().glossaryDraft.itemVersion, draft.itemVersion);
    await glossaryForm(h2).form.fire("submit"); await h2.idle();
    assert.equal(f.workspace.getGlossary(HASH).terms[draft.term], draft.translation);
  } finally { await f.close(); }
});

test("a restored glossary draft without its condition never borrows the current list condition", async () => {
  const f = await fixture();
  try {
    const h = harness(f); h.tools.restoreUiState({ glossaryDraft: { paperHash: HASH, term: "Legacy", translation: "Pending" } });
    h.tools.open("glossary"); await h.idle();
    await glossaryForm(h).form.fire("submit"); await h.idle();
    assert.equal(h.writes.length, 0); assert.equal(glossaryForm(h).translation.value, "Pending");
    assert.equal(h.notifications.some(value => value.type === "error"), true);
  } finally { await f.close(); }
});

test("a glossary continuation adopts only its own acknowledgement and rejects a later external update", async () => {
  const f = await fixture(); let gate;
  try {
    const h = harness(f); h.tools.open("glossary"); await h.idle();
    gate = h.holdNext("POST", "/api/research/glossary");
    const submission = typeGlossary(h, "First", "Own commit").form.fire("submit"); await gate.ready;
    const ownVersion = f.workspace.getGlossary(HASH).itemVersion;
    typeGlossary(h, "evidence", "Unsubmitted continuation");
    h.afterSave = () => f.workspace.putGlossary({ paperHash: HASH, terms: { evidence: "Other writer" } });
    gate.release(); await submission; await h.idle();
    assert.equal(h.tools.uiState().glossaryDraft.itemVersion, ownVersion);
    assert.notEqual(f.workspace.getGlossary(HASH).itemVersion, ownVersion);
    await glossaryForm(h).form.fire("submit"); await h.idle();
    assert.equal(f.workspace.getGlossary(HASH).terms.evidence, "Other writer");
    assert.equal(glossaryForm(h).translation.value, "Unsubmitted continuation");
  } finally { gate?.release(); await f.close(); }
});

test("an own glossary deletion advances an unchanged draft condition and preserves its input", async () => {
  const f = await fixture();
  try {
    await f.workspace.putGlossary({ paperHash: HASH, terms: { evidence: "Delete me" } });
    const h = harness(f); h.tools.open("glossary"); await h.idle(); typeGlossary(h, "New term", "New value");
    const remove = descendants(glossaryForm(h).view).find(element => element.tagName === "BUTTON" && element._text === "删除");
    await remove.fire("click"); await h.idle();
    assert.equal(glossaryForm(h).term.value, "New term");
    assert.equal(h.tools.uiState().glossaryDraft.itemVersion, f.workspace.getGlossary(HASH).itemVersion);
    await glossaryForm(h).form.fire("submit"); await h.idle();
    assert.equal(f.workspace.getGlossary(HASH).terms["New term"], "New value");
    assert.equal(f.workspace.getGlossary(HASH).terms.evidence, undefined);
  } finally { await f.close(); }
});

for (const replacement of ["same paper reset", "different paper", "destroyed drawer"]) {
  test(`a late glossary acknowledgement does not update a ${replacement} context`, async () => {
    const f = await fixture(); let gate;
    try {
      const h = harness(f); h.tools.open("glossary"); await h.idle();
      gate = h.holdNext("POST", "/api/research/glossary");
      const submission = typeGlossary(h, "Submitted", "Original context").form.fire("submit"); await gate.ready;
      if (replacement === "destroyed drawer") h.tools.destroy();
      else {
        h.tools.resetPaperState();
        if (replacement === "different paper") h.currentPaper = await f.workspace.upsertPaper({ paperHash: OTHER, blocks });
        h.tools.refresh(); await new Promise(resolve => setImmediate(resolve));
        await Promise.all(f.pending.slice(-2)); await new Promise(resolve => setImmediate(resolve));
        typeGlossary(h, "Current", "New context draft");
      }
      gate.release(); await submission; await h.idle();
      assert.equal(h.changed.length, 0); assert.equal(h.notifications.some(value => value.type === "success"), false);
      if (replacement !== "destroyed drawer") assert.equal(glossaryForm(h).translation.value, "New context draft");
      assert.equal(f.workspace.getGlossary(HASH).terms.Submitted, "Original context");
    } finally { gate?.release(); await f.close(); }
  });
}

test("late glossary errors and events from a detached form cannot overwrite the current context", async () => {
  const f = await fixture(); let gate;
  try {
    const h = harness(f); h.tools.open("glossary"); await h.idle();
    const oldForm = typeGlossary(h, "Old", "Draft");
    gate = h.holdNext("POST", "/api/research/glossary"); const submission = oldForm.form.fire("submit"); await gate.ready;
    h.failAfterResponse = true;
    h.tools.resetPaperState(); h.tools.refresh(); await new Promise(resolve => setImmediate(resolve));
    await Promise.all(f.pending.slice(-2)); await new Promise(resolve => setImmediate(resolve));
    typeGlossary(h, "Current", "Retained"); const count = h.writes.length;
    oldForm.term.value = "Detached overwrite"; oldForm.term.fire("input"); await oldForm.form.fire("submit");
    gate.release(); await submission; await h.idle();
    assert.equal(h.writes.length, count); assert.equal(glossaryForm(h).term.value, "Current");
    assert.equal(h.notifications.some(value => value.type === "error"), false);
  } finally { gate?.release(); await f.close(); }
});

for (const mismatch of ["missing token", "wrong hash", "old token", "wrong terms"]) {
  test(`a glossary ${mismatch} acknowledgement preserves the submitted draft without reporting success`, async () => {
    const f = await fixture();
    try {
      const h = harness(f); h.tools.open("glossary"); await h.idle(); typeGlossary(h, "Submitted", "Retain on bad receipt");
      const expected = h.tools.uiState().glossaryDraft.itemVersion;
      h.dataTransform = data => {
        if (data.glossary) {
          if (mismatch === "missing token") delete data.glossary.itemVersion;
          if (mismatch === "wrong hash") data.glossary.paperHash = OTHER;
          if (mismatch === "old token") data.glossary.itemVersion = expected;
          if (mismatch === "wrong terms") data.glossary.terms = {};
        }
        return data;
      };
      await glossaryForm(h).form.fire("submit"); await h.idle();
      assert.equal(h.tools.uiState().glossaryDraft.translation, "Retain on bad receipt");
      assert.equal(h.tools.uiState().glossaryDraft.itemVersion, expected);
      assert.equal(h.notifications.some(value => value.type === "success"), false);
      assert.equal(h.notifications.some(value => value.type === "error"), true);
      assert.equal(f.workspace.getGlossary(HASH).terms.Submitted, "Retain on bad receipt", "Server may already have committed");
      assert.equal(h.writes.length, 1, "Do not automatically resend a questionable receipt");
    } finally { await f.close(); }
  });
}

test("an actual note-editor refresh retains an edited draft ahead of its persisted record", async () => {
  const f = await fixture();
  try {
    await f.workspace.putNote({ paperHash: HASH, id: "owned-note", blockId: "b1", note: "Persisted note", tags: ["old"] });
    const h = harness(f); await h.edit();
    h.typeNote("Edited unsaved note"); h.tags().value = "new"; h.tags().fire("input");
    h.tools.refresh(); await h.idle();
    assert.equal(h.note().value, "Edited unsaved note");
    assert.equal(h.tags().value, "new");
    assert.equal(f.workspace.listItems("notes", HASH)[0].note, "Persisted note");
  } finally { await f.close(); }
});

test("an actual new-note refresh preserves the evidence block selected when drafting", async () => {
  const f = await fixture();
  try {
    const h = harness(f); h.tools.open("notes"); await h.idle();
    h.typeNote("Draft for first evidence");
    h.selectedId = "b2"; h.tools.refresh(); await h.idle();
    h.button("保存研究笔记").fire("click"); await h.idle();
    const saved = f.workspace.listItems("notes", HASH)[0];
    assert.equal(saved.blockId, "b1");
    assert.equal(saved.quote, blocks[0].text);
  } finally { await f.close(); }
});

test("an unchanged actual note save clears only its submitted draft after the parent refresh", async () => {
  const f = await fixture();
  try {
    const h = harness(f); h.tools.open("notes"); await h.idle();
    h.typeNote("Unchanged submitted note"); h.button("保存研究笔记").fire("click"); await h.idle();
    assert.equal(h.tools.uiState().noteDraft, null);
    assert.equal(h.note().value, "");
    assert.equal(h.button("保存研究笔记").disabled, false);
    assert.equal(f.workspace.listItems("notes", HASH)[0].note, "Unchanged submitted note");
    assert.equal(h.changed.length, 1);
  } finally { await f.close(); }
});

test("a failed actual note save retains its draft and allows a successful retry", async () => {
  const f = await fixture();
  try {
    const h = harness(f); h.tools.open("notes"); await h.idle();
    h.typeNote("Draft during offline save"); h.rejectNext(); h.button("保存研究笔记").fire("click"); await h.idle();
    assert.equal(h.tools.uiState().noteDraft.note, "Draft during offline save");
    assert.equal(h.button("保存研究笔记").disabled, false);
    assert.equal(f.workspace.listItems("notes", HASH).length, 0);
    assert.equal(h.notifications.some(item => item.type === "error"), true);
    h.button("保存研究笔记").fire("click"); await h.idle();
    assert.equal(f.workspace.listItems("notes", HASH).length, 1);
    assert.equal(h.tools.uiState().noteDraft, null);
  } finally { await f.close(); }
});

test("a deliberately emptied existing note and its tags remain empty through an actual refresh", async () => {
  const f = await fixture();
  try {
    await f.workspace.putNote({ paperHash: HASH, id: "owned-note", blockId: "b1", note: "Old nonempty note", tags: ["old"] });
    const h = harness(f); await h.edit();
    h.typeNote(""); h.tags().value = ""; h.tags().fire("input");
    h.tools.refresh(); await h.idle();
    assert.equal(h.note().value, "");
    assert.equal(h.tags().value, "");
    h.button("更新研究笔记").fire("click"); await h.idle();
    assert.equal(h.tools.uiState().noteDraft.note, "");
    assert.equal(h.writes.length, 0, "Empty notes are rejected before persistence");
  } finally { await f.close(); }
});

test("new note type and tags typed during a save survive the actual callback refresh", async () => {
  const f = await fixture(); let gate;
  try {
    const h = harness(f); h.tools.open("notes"); await h.idle();
    h.typeNote("Submitted fields"); gate = h.holdNext(); h.button("保存研究笔记").fire("click");
    await gate.ready;
    h.type().value = "question"; h.type().fire("change");
    h.tags().value = "pending, evidence"; h.tags().fire("input");
    gate.release(); await h.idle();
    assert.equal(h.tools.uiState().noteDraft.noteType, "question");
    assert.equal(h.type().value, "question");
    assert.equal(h.tags().value, "pending, evidence");
    assert.equal(f.workspace.listItems("notes", HASH)[0].noteType, "finding");
  } finally { gate?.release(); await f.close(); }
});

test("an existing note update retains a newer edit and its original record ID", async () => {
  const f = await fixture(); let gate;
  try {
    await f.workspace.putNote({ paperHash: HASH, id: "owned-note", blockId: "b1", note: "Old saved note" });
    const h = harness(f); await h.edit();
    h.typeNote("Submitted edit"); gate = h.holdNext(); h.button("更新研究笔记").fire("click");
    await gate.ready; h.typeNote("New edit while waiting");
    gate.release(); await h.idle();
    assert.equal(h.note().value, "New edit while waiting");
    assert.equal(h.tools.uiState().noteDraft.id, "owned-note");
    assert.equal(f.workspace.listItems("notes", HASH).length, 1);
    assert.equal(f.workspace.listItems("notes", HASH)[0].note, "Submitted edit");
    h.button("更新研究笔记").fire("click"); await h.idle();
    assert.equal(f.workspace.listItems("notes", HASH).length, 1);
    assert.equal(f.workspace.listItems("notes", HASH)[0].note, "New edit while waiting");
  } finally { gate?.release(); await f.close(); }
});

test("a JSON-restored edit draft updates its original note before its list response arrives", async () => {
  const f = await fixture(); let gate;
  try {
    await f.workspace.putNote({ paperHash: HASH, id: "owned-note", blockId: "b1", note: "Old saved note" });
    const h = harness(f); await h.edit();
    h.typeNote("Restored pending edit");
    const draft = JSON.parse(JSON.stringify(h.tools.uiState().noteDraft));
    await f.workspace.setProgress({ paperHash: HASH, noteDraft: draft });
    h.tools.resetPaperState();
    h.selectedId = "b2";
    h.tools.restoreUiState({ paperHash: HASH, noteDraft: f.workspace.getProgress(HASH).noteDraft });
    gate = h.holdNext("GET"); h.tools.open("notes"); await gate.ready;
    assert.equal(h.note().value, "Restored pending edit");
    const saving = h.button("更新研究笔记").fire("click");
    if (saving) await saving;
    gate.release(); await h.idle();
    const notes = f.workspace.listItems("notes", HASH);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].id, "owned-note");
    assert.equal(notes[0].blockId, "b1");
    assert.equal(notes[0].note, "Restored pending edit");
    assert.equal(notes[0].quote, blocks[0].text);
  } finally { gate?.release(); await f.close(); }
});

test("canceling an edit during its save cannot clear a subsequently composed new note", async () => {
  const f = await fixture(); let gate;
  try {
    await f.workspace.putNote({ paperHash: HASH, id: "owned-note", blockId: "b1", note: "Old note" });
    const h = harness(f); await h.edit();
    h.typeNote("Submitted edit"); gate = h.holdNext(); h.button("更新研究笔记").fire("click");
    await gate.ready; h.button("取消编辑").fire("click");
    assert.equal(h.note().value, ""); h.typeNote("New note after cancel");
    gate.release(); await h.idle();
    assert.equal(h.note().value, "New note after cancel");
    assert.equal(h.tools.uiState().noteDraft.id, null);
    assert.equal(h.button("保存研究笔记").disabled, false);
    assert.equal(f.workspace.listItems("notes", HASH)[0].note, "Submitted edit");
  } finally { gate?.release(); await f.close(); }
});

for (const replacement of ["same paper", "other paper", "destroyed drawer"]) {
  test(`a late actual note acknowledgement cannot affect the ${replacement} context`, async () => {
    const f = await fixture(); let gate;
    try {
      const h = harness(f); h.tools.open("notes"); await h.idle();
      h.typeNote("Original submitted note"); gate = h.holdNext(); h.button("保存研究笔记").fire("click");
      await gate.ready;
      if (replacement === "destroyed drawer") h.tools.destroy();
      else {
        if (replacement === "other paper") h.currentPaper = await f.workspace.upsertPaper({ paperHash: OTHER, blocks });
        h.tools.resetPaperState(); h.tools.open("notes");
        h.typeNote("New context draft");
      }
      gate.release(); await h.idle();
      assert.equal(h.changed.length, 0);
      assert.equal(h.notifications.some(item => item.type === "success"), false);
      if (replacement !== "destroyed drawer") assert.equal(h.tools.uiState().noteDraft.note, "New context draft");
      assert.equal(f.workspace.listItems("notes", HASH)[0].note, "Original submitted note");
    } finally { gate?.release(); await f.close(); }
  });
}

test("refreshing a pending actual note form cannot submit it twice and releases its new button", async () => {
  const f = await fixture(); let gate;
  try {
    const h = harness(f); h.tools.open("notes"); await h.idle();
    h.typeNote("One submitted note"); gate = h.holdNext(); h.button("保存研究笔记").fire("click");
    await gate.ready; h.tools.refresh();
    assert.equal(h.button("保存研究笔记").disabled, true);
    h.button("保存研究笔记").fire("click");
    assert.equal(h.writes.length, 1);
    h.typeNote("Next unsaved note");
    gate.release(); await h.idle();
    assert.equal(h.button("保存研究笔记").disabled, false);
    assert.equal(h.note().value, "Next unsaved note");
    assert.equal(f.workspace.listItems("notes", HASH).length, 1);
  } finally { gate?.release(); await f.close(); }
});

test("events on a detached old note form cannot rewrite or save the current draft", async () => {
  const f = await fixture();
  try {
    const h = harness(f); h.tools.open("notes"); await h.idle();
    h.typeNote("Current draft"); const oldNote = h.note(), oldSave = h.button("保存研究笔记");
    h.tools.refresh(); await h.idle();
    oldNote.value = "Detached stale input"; oldNote.fire("input"); oldSave.fire("click"); await h.idle();
    assert.equal(h.tools.uiState().noteDraft.note, "Current draft");
    assert.equal(h.writes.length, 0);
  } finally { await f.close(); }
});

test("restoring another paper's draft leaves the current note and evidence intact", async () => {
  const f = await fixture();
  try {
    const h = harness(f); h.tools.open("notes"); await h.idle(); h.typeNote("Current owned draft");
    h.tools.restoreUiState({ paperHash: OTHER, noteDraft: { paperHash: OTHER, blockId: "b2", note: "Wrong paper draft" } });
    h.tools.refresh(); await h.idle();
    assert.equal(h.note().value, "Current owned draft");
    assert.equal(h.tools.uiState().noteDraft.blockId, "b1");
  } finally { await f.close(); }
});

test("a delayed note response failure cannot show an error in a reset same-paper context", async () => {
  const f = await fixture(); let gate;
  try {
    const h = harness(f); h.tools.open("notes"); await h.idle();
    h.typeNote("Original pending note"); gate = h.holdNext(); h.button("保存研究笔记").fire("click");
    await gate.ready; h.tools.resetPaperState(); h.tools.open("notes"); h.typeNote("Reset context note");
    h.failAfterResponse = true; gate.release(); await h.idle();
    assert.equal(h.notifications.some(item => item.type === "error"), false);
    assert.equal(h.tools.uiState().noteDraft.note, "Reset context note");
    assert.equal(h.changed.length, 0);
    assert.equal(h.button("保存研究笔记").disabled, false);
  } finally { gate?.release(); await f.close(); }
});

test("a late note-list response preserves the form's newer visible draft", async () => {
  const f = await fixture(); let gate;
  try {
    const h = harness(f); gate = h.holdNext("GET"); h.tools.open("notes"); await gate.ready;
    h.typeNote("Typed while notes list waits");
    gate.release(); await h.idle();
    assert.equal(h.note().value, "Typed while notes list waits");
    assert.equal(h.tools.uiState().noteDraft.note, "Typed while notes list waits");
  } finally { gate?.release(); await f.close(); }
});

test("a late actual note deletion does not refresh or notify a reset same-paper drawer", async () => {
  const f = await fixture(); let gate;
  try {
    await f.workspace.putNote({ paperHash: HASH, id: "owned-note", blockId: "b1", note: "Owned deletion" });
    const h = harness(f); h.tools.open("notes"); await h.idle();
    gate = h.holdNext("DELETE", "/api/research/notes/owned-note"); h.button("删除").fire("click");
    await gate.ready; h.tools.resetPaperState(); h.tools.open("notes"); h.typeNote("Draft after deletion context reset");
    gate.release(); await h.idle();
    assert.equal(h.changed.length, 0);
    assert.equal(h.notifications.some(item => item.type === "success"), false);
    assert.equal(h.tools.uiState().noteDraft.note, "Draft after deletion context reset");
    assert.equal(f.workspace.listItems("notes", HASH).length, 0);
  } finally { gate?.release(); await f.close(); }
});

test("the shared bookmark save callback also respects a reset same-paper drawer", async () => {
  const f = await fixture(); let gate;
  try {
    const h = harness(f); h.tools.open("markers"); await h.idle();
    const view = descendants(h.root).find(item => item.id === "research-tool-markers");
    const save = descendants(view).find(item => item.tagName === "BUTTON" && item._text === "添加证据书签");
    assert.ok(save);
    gate = h.holdNext("POST", "/api/research/bookmarks"); save.fire("click");
    await gate.ready; h.tools.resetPaperState(); h.tools.open("notes"); h.typeNote("Draft after bookmark context reset");
    gate.release(); await h.idle();
    assert.equal(h.changed.length, 0);
    assert.equal(h.notifications.some(item => item.type === "success"), false);
    assert.equal(h.tools.uiState().noteDraft.note, "Draft after bookmark context reset");
    assert.equal(f.workspace.listItems("bookmarks", HASH).length, 1);
  } finally { gate?.release(); await f.close(); }
});

test("resolving a question while editing retains its draft and does not undo the new resolved state", async () => {
  const f = await fixture();
  try {
    await f.workspace.putNote({ paperHash: HASH, id: "owned-question", blockId: "b1", note: "Saved question", noteType: "question", resolved: false });
    const h = harness(f); await h.edit(); h.typeNote("Pending question edit");
    h.button("标记已解决").fire("click"); await h.idle();
    assert.equal(h.note().value, "Pending question edit");
    h.button("更新研究笔记").fire("click"); await h.idle();
    const saved = f.workspace.listItems("notes", HASH)[0];
    assert.equal(saved.note, "Pending question edit");
    assert.equal(saved.resolved, true);
  } finally { await f.close(); }
});

for (const first of ["form", "resolution"]) {
  test(`a pending ${first} write prevents the other note action from submitting stale text`, async () => {
    const f = await fixture(); let gate;
    try {
      await f.workspace.putNote({ paperHash: HASH, id: "owned-question", blockId: "b1", note: "Original question", noteType: "question", resolved: false });
      const h = harness(f); await h.edit(); h.typeNote("Latest edited question");
      gate = h.holdNext();
      h.button(first === "form" ? "更新研究笔记" : "标记已解决").fire("click");
      await gate.ready;
      h.button(first === "form" ? "标记已解决" : "更新研究笔记").fire("click");
      assert.equal(h.writes.length, 1);
      gate.release(); await h.idle();
      const saved = f.workspace.listItems("notes", HASH)[0];
      if (first === "form") {
        assert.equal(saved.note, "Latest edited question");
        assert.equal(saved.resolved, false);
        assert.equal(h.button("保存研究笔记").disabled, false);
      } else {
        assert.equal(saved.note, "Original question");
        assert.equal(saved.resolved, true);
        assert.equal(h.note().value, "Latest edited question");
        assert.equal(h.button("更新研究笔记").disabled, false);
        h.button("更新研究笔记").fire("click"); await h.idle();
        assert.equal(f.workspace.listItems("notes", HASH)[0].note, "Latest edited question");
        assert.equal(f.workspace.listItems("notes", HASH)[0].resolved, true);
      }
    } finally { gate?.release(); await f.close(); }
  });
}

test("a stale actual note editor cannot overwrite another editor's committed text", async () => {
  const f = await fixture();
  try {
    await f.workspace.putNote({ paperHash: HASH, id: "owned-note", blockId: "b1", note: "Initially saved" });
    const h = harness(f); await h.edit(); h.typeNote("Stale local draft");
    await createPaperWorkspace({ dataDir: f.dataDir }).putNote({ paperHash: HASH, id: "owned-note", blockId: "b1", note: "Newer other-editor text" });
    h.button("更新研究笔记").fire("click"); await h.idle();
    assert.equal(f.workspace.getItem("notes", "owned-note").note, "Newer other-editor text");
    assert.equal(h.tools.uiState().noteDraft.note, "Stale local draft");
    assert.equal(h.notifications.some(item => item.type === "error"), true);
    assert.equal(h.notifications.some(item => item.type === "success"), false);
  } finally { await f.close(); }
});

test("an actual stale edit cannot recreate a note deleted after its editor opened", async () => {
  const f = await fixture();
  try {
    await f.workspace.putNote({ paperHash: HASH, id: "owned-note", blockId: "b1", note: "Note to delete" });
    const h = harness(f); await h.edit(); h.typeNote("Draft for deleted note");
    await f.workspace.deleteItem("notes", "owned-note");
    h.button("更新研究笔记").fire("click"); await h.idle();
    assert.equal(f.workspace.getItem("notes", "owned-note"), null);
    assert.equal(h.tools.uiState().noteDraft.note, "Draft for deleted note");
    assert.equal(h.notifications.some(item => item.type === "success"), false);
  } finally { await f.close(); }
});

test("an actual stale note-list delete cannot remove newer committed content", async () => {
  const f = await fixture();
  try {
    await f.workspace.putNote({ paperHash: HASH, id: "owned-note", blockId: "b1", note: "Old list item" });
    const h = harness(f); h.tools.open("notes"); await h.idle();
    await f.workspace.putNote({ paperHash: HASH, id: "owned-note", blockId: "b1", note: "Newer item to retain" });
    h.button("删除").fire("click"); await h.idle();
    assert.equal(f.workspace.getItem("notes", "owned-note")?.note, "Newer item to retain");
    assert.equal(h.notifications.some(item => item.type === "error"), true);
    assert.equal(h.notifications.some(item => item.type === "success"), false);
  } finally { await f.close(); }
});

function ownedRequest(f, collection, method, body = {}, id = "", query = {}) {
  const route = `${method} /api/research/${collection}${id ? "/:id" : ""}`;
  return f.routes.get(route)({ get: () => ({ principal: { id: "owned-item-version" } }),
    req: { json: async () => body, query: key => query[key] || "", param: key => key === "id" ? id : "" },
    json: (value, status = 200) => ({ value, status }) });
}
function recordInput(collection, fields = {}) {
  return { paperHash: HASH, id: "owned-item", blockId: "b1", ...(collection === "notes" ? { note: "Owned note" } : { label: "Owned bookmark" }), ...fields };
}
function recordBytes(f) {
  return ["paper-workspace.json", ...["paper.json", "research.json", "translations.json", "tasks.json"].map(file => `papers/${HASH}/${file}`)]
    .map(file => fs.readFileSync(path.join(f.dataDir, file)));
}

test("glossary conditions protect empty initialization, durable updates, deletion and recreation", async () => {
  const f = await fixture();
  try {
    const beforeEmpty = recordBytes(f), empty = f.workspace.getGlossary(HASH);
    assert.match(empty.itemVersion, /^[a-f0-9]{64}$/);
    assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getGlossary(HASH).itemVersion, empty.itemVersion);
    assert.deepEqual(recordBytes(f), beforeEmpty);
    const first = await ownedRequest(f, "glossary", "POST", { paperHash: HASH, terms: { evidence: "First" }, expectedItemVersion: empty.itemVersion, itemVersion: "0".repeat(64) });
    assert.equal(first.status, 200);
    assert.notEqual(first.value.glossary.itemVersion, empty.itemVersion);
    assert.notEqual(first.value.glossary.itemVersion, "0".repeat(64));
    const before = recordBytes(f);
    assert.equal((await ownedRequest(f, "glossary", "POST", { paperHash: HASH, terms: { evidence: "Stale" }, expectedItemVersion: empty.itemVersion })).status, 409);
    assert.deepEqual(recordBytes(f), before);
    const removed = await ownedRequest(f, "glossary", "DELETE", { expectedItemVersion: first.value.glossary.itemVersion }, "", { paperHash: HASH, term: "evidence" });
    assert.equal(removed.status, 200); assert.equal(removed.value.deleted, true);
    assert.equal(removed.value.glossary.terms.evidence, undefined);
    assert.notEqual(removed.value.glossary.itemVersion, first.value.glossary.itemVersion);
    assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getGlossary(HASH).itemVersion, removed.value.glossary.itemVersion);
    await f.workspace.putGlossary({ paperHash: HASH, terms: { evidence: "Recreated" }, expectedItemVersion: removed.value.glossary.itemVersion });
    const recreatedBytes = recordBytes(f);
    assert.equal((await ownedRequest(f, "glossary", "DELETE", {}, "", { paperHash: HASH, term: "evidence", expectedItemVersion: first.value.glossary.itemVersion })).status, 409);
    assert.deepEqual(recordBytes(f), recreatedBytes);
    const stored = JSON.parse(fs.readFileSync(path.join(f.dataDir, "papers", HASH, "research.json"), "utf8"));
    assert.equal(stored.glossary.expectedItemVersion, undefined);
  } finally { await f.close(); }
});

test("malformed glossary request conditions fail without modifying stored data", async () => {
  const f = await fixture();
  try {
    await f.workspace.putGlossary({ paperHash: HASH, terms: { evidence: "Owned" } });
    const before = recordBytes(f);
    for (const expectedItemVersion of [null, "", false, 0, {}, [], "a".repeat(63), "g".repeat(64)]) {
      for (const method of ["POST", "DELETE"]) {
        const response = await ownedRequest(f, "glossary", method, { paperHash: HASH, terms: { evidence: "Unsafe" }, expectedItemVersion }, "", { paperHash: HASH, term: "evidence" });
        assert.equal(response.status, 400); assert.equal(response.value.error.code, "research_item_version_invalid");
        assert.deepEqual(recordBytes(f), before);
      }
    }
  } finally { await f.close(); }
});

test("a legacy glossary projects its read-only condition before the first conditional update", async () => {
  const f = await fixture();
  try {
    await f.workspace.putGlossary({ paperHash: HASH, terms: { evidence: "Owned legacy" } });
    const file = path.join(f.dataDir, "papers", HASH, "research.json"), raw = JSON.parse(fs.readFileSync(file, "utf8"));
    delete raw.glossary.itemVersion; fs.writeFileSync(file, JSON.stringify(raw));
    const before = recordBytes(f), fresh = createPaperWorkspace({ dataDir: f.dataDir });
    const glossary = fresh.getGlossary(HASH);
    const response = await ownedRequest(f, "glossary", "GET", {}, "", { paperHash: HASH });
    assert.equal(response.value.glossary.itemVersion, glossary.itemVersion);
    assert.deepEqual(recordBytes(f), before);
    const updated = await fresh.putGlossary({ paperHash: HASH, terms: { evidence: "New" }, expectedItemVersion: glossary.itemVersion });
    assert.notEqual(updated.itemVersion, glossary.itemVersion);
  } finally { await f.close(); }
});

for (const [field, value] of [["itemVersion", "broken"], ["version", "1"]]) {
  test(`a malformed persisted glossary ${field} stops reads and writes without resetting data`, async () => {
    const f = await fixture();
    try {
      await f.workspace.putGlossary({ paperHash: HASH, terms: { evidence: "Owned" } });
      const file = path.join(f.dataDir, "papers", HASH, "research.json"), raw = JSON.parse(fs.readFileSync(file, "utf8"));
      raw.glossary[field] = value; fs.writeFileSync(file, JSON.stringify(raw));
      const before = recordBytes(f);
      for (const method of ["GET", "POST"]) {
        const response = await ownedRequest(f, "glossary", method, { paperHash: HASH, terms: { evidence: "Unsafe" } }, "", { paperHash: HASH });
        assert.equal(response.status, 503); assert.equal(response.value.error.code, "workspace_integrity_error");
        assert.deepEqual(recordBytes(f), before);
      }
    } finally { await f.close(); }
  });
}

test("two conditional glossary writers yield one commit and one conflict", async () => {
  const f = await fixture();
  try {
    const glossary = await f.workspace.putGlossary({ paperHash: HASH, terms: { evidence: "Original" } });
    const other = createPaperWorkspace({ dataDir: f.dataDir });
    const results = await Promise.allSettled([f.workspace.putGlossary({ paperHash: HASH, terms: { evidence: "A" }, expectedItemVersion: glossary.itemVersion }),
      other.putGlossary({ paperHash: HASH, terms: { evidence: "B" }, expectedItemVersion: glossary.itemVersion })]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected" && result.reason.code === "research_item_changed").length, 1);
  } finally { await f.close(); }
});

for (const stale of [false, true]) {
  test(`restoring a glossary ${stale ? "preserves an already stale" : "advances a matching"} archived draft condition`, async () => {
    const f = await fixture();
    try {
      const glossary = await f.workspace.putGlossary({ paperHash: HASH, terms: { evidence: "Archived" } });
      await f.workspace.setProgress({ paperHash: HASH, glossaryDraft: { paperHash: HASH, term: "evidence", translation: "Unsubmitted", itemVersion: stale ? "0".repeat(64) : glossary.itemVersion } });
      const backup = f.workspace.exportBackup(HASH), serialized = JSON.stringify(backup);
      await f.workspace.restoreBackup({ ...backup, expectedRevision: f.workspace.getPaper(HASH).revision });
      assert.equal(JSON.stringify(backup), serialized);
      const restored = f.workspace.getGlossary(HASH), draft = f.workspace.getProgress(HASH).glossaryDraft;
      assert.notEqual(restored.itemVersion, glossary.itemVersion);
      assert.equal(draft.itemVersion, stale ? "0".repeat(64) : restored.itemVersion);
      assert.equal(draft.translation, "Unsubmitted");
      const before = recordBytes(f);
      assert.equal((await ownedRequest(f, "glossary", "POST", { paperHash: HASH, terms: { evidence: "Unsafe old editor" }, expectedItemVersion: glossary.itemVersion })).status, 409);
      assert.deepEqual(recordBytes(f), before);
    } finally { await f.close(); }
  });
}

test("malformed archived glossary conditions and versions are rejected before publication", async () => {
  const f = await fixture();
  try {
    await f.workspace.putGlossary({ paperHash: HASH, terms: { evidence: "Owned" } });
    const backup = f.workspace.exportBackup(HASH), before = recordBytes(f);
    for (const patch of [{ itemVersion: null }, { version: -1 }]) {
      await assert.rejects(f.workspace.restoreBackup({ ...backup, glossary: { ...backup.glossary, ...patch }, expectedRevision: f.workspace.getPaper(HASH).revision }), error => error.code === "backup_invalid");
      assert.deepEqual(recordBytes(f), before);
    }
  } finally { await f.close(); }
});

for (const [collection, method] of [["notes", "putNote"], ["bookmarks", "putBookmark"]]) {
  test(`conditional ${collection} updates rotate durable versions and exclude request controls`, async () => {
    const f = await fixture();
    try {
      const first = await f.workspace[method](recordInput(collection, { itemVersion: "0".repeat(64) }));
      assert.match(first.itemVersion, /^[a-f0-9]{64}$/);
      assert.notEqual(first.itemVersion, "0".repeat(64));
      const second = await ownedRequest(f, collection, "POST", recordInput(collection, { expectedItemVersion: first.itemVersion,
        expectedGeneration: f.paper.generation, note: "New note", label: "New bookmark" }));
      assert.equal(second.status, 200);
      const saved = second.value[collection === "notes" ? "note" : "bookmark"];
      assert.notEqual(saved.itemVersion, first.itemVersion);
      assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getItem(collection, first.id).itemVersion, saved.itemVersion);
      assert.ok(!fs.readFileSync(path.join(f.dataDir, "papers", HASH, "research.json"), "utf8").includes('"expectedItemVersion"'));
      const before = recordBytes(f);
      const stale = await ownedRequest(f, collection, "POST", recordInput(collection, { expectedItemVersion: first.itemVersion }));
      assert.equal(stale.status, 409);
      assert.equal(stale.value.error.code, "research_item_changed");
      assert.deepEqual(recordBytes(f), before);
    } finally { await f.close(); }
  });

  test(`a ${collection} delete rejects an old version and accepts its current version`, async () => {
    const f = await fixture();
    try {
      const first = await f.workspace[method](recordInput(collection));
      const second = await f.workspace[method](recordInput(collection));
      const before = recordBytes(f);
      const stale = await ownedRequest(f, collection, "DELETE", { paperHash: HASH, expectedItemVersion: first.itemVersion }, first.id);
      assert.equal(stale.status, 409);
      assert.equal(stale.value.error.code, "research_item_changed");
      assert.deepEqual(recordBytes(f), before);
      const removed = await ownedRequest(f, collection, "DELETE", { paperHash: HASH }, first.id, { expectedItemVersion: second.itemVersion });
      assert.equal(removed.status, 200);
      assert.equal(f.workspace.getItem(collection, first.id), null);
      const missing = await ownedRequest(f, collection, "POST", recordInput(collection, { expectedItemVersion: second.itemVersion }));
      assert.equal(missing.status, 409);
      assert.equal(f.workspace.getItem(collection, first.id), null);
    } finally { await f.close(); }
  });

  test(`recreating the same ${collection} ID cannot revive an earlier edit or delete condition`, async () => {
    const f = await fixture();
    try {
      const first = await f.workspace[method](recordInput(collection));
      await f.workspace.deleteItem(collection, first.id);
      const fresh = await f.workspace[method](recordInput(collection));
      assert.notEqual(fresh.itemVersion, first.itemVersion);
      const before = recordBytes(f);
      assert.equal((await ownedRequest(f, collection, "POST", recordInput(collection, { expectedItemVersion: first.itemVersion }))).status, 409);
      assert.equal((await ownedRequest(f, collection, "DELETE", { expectedItemVersion: first.itemVersion }, first.id)).status, 409);
      assert.deepEqual(recordBytes(f), before);
    } finally { await f.close(); }
  });

  test(`malformed ${collection} version conditions cannot change a record or treat it as absent`, async () => {
    const f = await fixture();
    try {
      const first = await f.workspace[method](recordInput(collection));
      const before = recordBytes(f);
      for (const token of [null, "", 0, false, {}, [], "0".repeat(63), "g".repeat(64)]) {
        for (const operation of ["POST", "DELETE"]) {
          const response = await ownedRequest(f, collection, operation,
            operation === "POST" ? recordInput(collection, { expectedItemVersion: token }) : { expectedItemVersion: token }, operation === "DELETE" ? first.id : "");
          assert.equal(response.status, 400);
          assert.equal(response.value.error.code, "research_item_version_invalid");
          assert.deepEqual(recordBytes(f), before);
        }
      }
    } finally { await f.close(); }
  });

  test(`legacy ${collection} get a stable read-only version and can perform their first conditional update`, async () => {
    const f = await fixture();
    try {
      await f.workspace[method](recordInput(collection));
      const file = path.join(f.dataDir, "papers", HASH, "research.json"), raw = JSON.parse(fs.readFileSync(file, "utf8"));
      delete raw[collection]["owned-item"].itemVersion;
      fs.writeFileSync(file, JSON.stringify(raw));
      const before = recordBytes(f), fresh = createPaperWorkspace({ dataDir: f.dataDir });
      const item = fresh.getItem(collection, "owned-item"), listed = (await ownedRequest(f, collection, "GET", {}, "", { paperHash: HASH })).value[collection][0];
      assert.match(item.itemVersion, /^[a-f0-9]{64}$/);
      assert.equal(listed.itemVersion, item.itemVersion);
      assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getItem(collection, item.id).itemVersion, item.itemVersion);
      assert.deepEqual(recordBytes(f), before, "Version projection must not rewrite legacy research data");
      const updated = await fresh[method](recordInput(collection, { expectedItemVersion: item.itemVersion }));
      assert.notEqual(updated.itemVersion, item.itemVersion);
    } finally { await f.close(); }
  });

  test(`a corrupt persisted ${collection} version rejects reads and writes without changing files`, async () => {
    const f = await fixture();
    try {
      await f.workspace[method](recordInput(collection));
      const file = path.join(f.dataDir, "papers", HASH, "research.json"), raw = JSON.parse(fs.readFileSync(file, "utf8"));
      raw[collection]["owned-item"].itemVersion = "broken";
      fs.writeFileSync(file, JSON.stringify(raw));
      const before = recordBytes(f);
      const read = await ownedRequest(f, collection, "GET", {}, "", { paperHash: HASH });
      assert.equal(read.status, 503);
      assert.equal(read.value.error.code, "workspace_integrity_error");
      const write = await ownedRequest(f, collection, "POST", recordInput(collection));
      assert.equal(write.status, 503);
      assert.deepEqual(recordBytes(f), before);
    } finally { await f.close(); }
  });
}

test("two conditional editors of one note yield one commit and one conflict", async () => {
  const f = await fixture();
  try {
    const first = await f.workspace.putNote(recordInput("notes"));
    const other = createPaperWorkspace({ dataDir: f.dataDir });
    const results = await Promise.allSettled([f.workspace.putNote(recordInput("notes", { note: "First contender", expectedItemVersion: first.itemVersion })),
      other.putNote(recordInput("notes", { note: "Second contender", expectedItemVersion: first.itemVersion }))]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected" && result.reason.code === "research_item_changed").length, 1);
    assert.ok(["First contender", "Second contender"].includes(other.getItem("notes", first.id).note));
  } finally { await f.close(); }
});

test("backup restore rotates record versions and advances only a matching archived edit draft", async () => {
  const f = await fixture();
  try {
    const note = await f.workspace.putNote(recordInput("notes")), bookmark = await f.workspace.putBookmark(recordInput("bookmarks"));
    await f.workspace.setProgress({ paperHash: HASH, noteDraft: { paperHash: HASH, id: note.id, blockId: "b1", note: "Unsubmitted archived edit", itemVersion: note.itemVersion } });
    const backup = f.workspace.exportBackup(HASH), serialized = JSON.stringify(backup);
    await f.workspace.restoreBackup({ ...backup, expectedRevision: f.workspace.getPaper(HASH).revision });
    assert.equal(JSON.stringify(backup), serialized, "Restore must not mutate its input draft");
    const restored = f.workspace.getItem("notes", note.id);
    assert.notEqual(restored.itemVersion, note.itemVersion);
    assert.notEqual(f.workspace.getItem("bookmarks", bookmark.id).itemVersion, bookmark.itemVersion);
    assert.equal(f.workspace.getProgress(HASH).noteDraft.itemVersion, restored.itemVersion);
    assert.equal(f.workspace.getProgress(HASH).noteDraft.note, "Unsubmitted archived edit");
    const stale = await ownedRequest(f, "notes", "POST", recordInput("notes", { expectedItemVersion: note.itemVersion }));
    assert.equal(stale.status, 409);
    const updated = await f.workspace.putNote(recordInput("notes", { expectedItemVersion: restored.itemVersion, note: "Restored draft saved" }));
    assert.equal(updated.note, "Restored draft saved");
  } finally { await f.close(); }
});

test("backup restore does not adopt a current record version for an already stale archived draft", async () => {
  const f = await fixture();
  try {
    const old = await f.workspace.putNote(recordInput("notes"));
    await f.workspace.putNote(recordInput("notes", { note: "Newer before backup" }));
    await f.workspace.setProgress({ paperHash: HASH, noteDraft: { paperHash: HASH, id: old.id, itemVersion: old.itemVersion, note: "Already stale draft" } });
    const backup = f.workspace.exportBackup(HASH);
    await f.workspace.restoreBackup({ ...backup, expectedRevision: f.workspace.getPaper(HASH).revision });
    assert.equal(f.workspace.getProgress(HASH).noteDraft.itemVersion, old.itemVersion);
    assert.notEqual(f.workspace.getProgress(HASH).noteDraft.itemVersion, f.workspace.getItem("notes", old.id).itemVersion);
  } finally { await f.close(); }
});

test("a backup with a malformed record version is refused before publishing any data", async () => {
  const f = await fixture();
  try {
    await f.workspace.putNote(recordInput("notes"));
    const backup = f.workspace.exportBackup(HASH); backup.notes[0].itemVersion = "invalid";
    const before = recordBytes(f);
    await assert.rejects(f.workspace.restoreBackup(backup), error => error.code === "backup_invalid");
    assert.deepEqual(recordBytes(f), before);
  } finally { await f.close(); }
});

test("a restored edit draft without its original version never borrows the freshly listed note version", async () => {
  const f = await fixture();
  try {
    await f.workspace.putNote({ paperHash: HASH, id: "owned-note", blockId: "b1", note: "Current stored note" });
    const h = harness(f); h.tools.resetPaperState();
    h.tools.restoreUiState({ paperHash: HASH, noteDraft: { paperHash: HASH, id: "owned-note", blockId: "b1", note: "Legacy edit without version" } });
    h.tools.open("notes"); await h.idle();
    h.button("更新研究笔记").fire("click"); await h.idle();
    assert.equal(h.writes.length, 0);
    assert.equal(h.tools.uiState().noteDraft.note, "Legacy edit without version");
    assert.equal(f.workspace.getItem("notes", "owned-note").note, "Current stored note");
    assert.equal(h.notifications.some(item => item.type === "error"), true);
  } finally { await f.close(); }
});

test("a question-state action from an old list cannot overwrite another editor's note", async () => {
  const f = await fixture();
  try {
    await f.workspace.putNote({ paperHash: HASH, id: "owned-note", blockId: "b1", note: "Old question", noteType: "question" });
    const h = harness(f); await h.edit(); h.typeNote("Pending local question draft");
    await f.workspace.putNote({ paperHash: HASH, id: "owned-note", blockId: "b1", note: "Newer other-editor question", noteType: "question" });
    h.button("标记已解决").fire("click"); await h.idle();
    assert.equal(f.workspace.getItem("notes", "owned-note").note, "Newer other-editor question");
    assert.equal(f.workspace.getItem("notes", "owned-note").resolved, false);
    assert.equal(h.tools.uiState().noteDraft.note, "Pending local question draft");
  } finally { await f.close(); }
});

test("a newly listed version after an external save cannot rebase a local draft onto that version", async () => {
  const f = await fixture();
  try {
    await f.workspace.putNote({ paperHash: HASH, id: "owned-note", blockId: "b1", note: "Initial edit target" });
    const h = harness(f); await h.edit(); h.typeNote("Submitted first edit");
    h.afterSave = async () => {
      h.typeNote("Unsubmitted continuation");
      h.afterSave = null;
      await f.workspace.putNote({ paperHash: HASH, id: "owned-note", blockId: "b1", note: "Intervening other-editor content" });
    };
    h.button("更新研究笔记").fire("click"); await h.idle();
    const draft = h.tools.uiState().noteDraft;
    assert.equal(draft.note, "Unsubmitted continuation");
    assert.equal(h.notifications.some(item => item.type === "error"), false, JSON.stringify(h.notifications));
    assert.equal(f.workspace.getItem("notes", "owned-note").note, "Intervening other-editor content");
    assert.notEqual(draft.itemVersion, f.workspace.getItem("notes", "owned-note").itemVersion);
    h.button("更新研究笔记").fire("click"); await h.idle();
    assert.equal(f.workspace.getItem("notes", "owned-note").note, "Intervening other-editor content");
    assert.equal(h.tools.uiState().noteDraft.note, "Unsubmitted continuation");
  } finally { await f.close(); }
});

test("a stale bookmark list delete keeps a newer bookmark", async () => {
  const f = await fixture();
  try {
    await f.workspace.putBookmark(recordInput("bookmarks"));
    const h = harness(f); h.tools.open("markers"); await h.idle();
    const view = descendants(h.root).find(item => item.id === "research-tool-markers");
    const remove = descendants(view).find(item => item.tagName === "BUTTON" && item._text === "删除");
    assert.ok(remove);
    await f.workspace.putBookmark(recordInput("bookmarks", { label: "Newer bookmark" }));
    remove.fire("click"); await h.idle();
    assert.equal(f.workspace.getItem("bookmarks", "owned-item").label, "Newer bookmark");
    assert.equal(h.notifications.some(item => item.type === "error"), true);
  } finally { await f.close(); }
});

for (const invalid of ["missing version", "wrong ID", "wrong paper", "old version"]) {
  test(`an actual note update with a ${invalid} receipt keeps its draft for review`, async () => {
    const f = await fixture();
    try {
      await f.workspace.putNote({ paperHash: HASH, id: "owned-note", blockId: "b1", note: "Before receipt test" });
      const h = harness(f); await h.edit(); h.typeNote("Committed but receipt rejected");
      const version = h.tools.uiState().noteDraft.itemVersion;
      h.dataTransform = value => {
        if (!value.note) return value;
        if (invalid === "missing version") delete value.note.itemVersion;
        if (invalid === "wrong ID") value.note.id = "different-note";
        if (invalid === "wrong paper") value.note.paperHash = OTHER;
        if (invalid === "old version") value.note.itemVersion = version;
        return value;
      };
      h.button("更新研究笔记").fire("click"); await h.idle();
      assert.equal(f.workspace.getItem("notes", "owned-note").note, "Committed but receipt rejected");
      assert.equal(h.tools.uiState().noteDraft.note, "Committed but receipt rejected");
      assert.equal(h.tools.uiState().noteDraft.itemVersion, version);
      assert.equal(h.changed.length, 0);
      assert.equal(h.notifications.some(item => item.type === "success"), false);
      assert.equal(h.notifications.some(item => item.type === "error"), true);
    } finally { await f.close(); }
  });
}
