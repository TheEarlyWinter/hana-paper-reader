import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import registerApiRoutes from "../server/http/api-routes.js";
import { createPaperWorkspace } from "../server/domain/paper-workspace.js";
import * as sourceContract from "../ui/assets/evidence-source.js";

const HASH = "c".repeat(64);
const BLOCKS = [{ id: "b1", page: 3, type: "paragraph", text: "Owned original selected source", translatedText: "自建译文来源" },
  { id: "b2", page: 4, type: "paragraph", text: "Owned other source" }];
const panel = fs.readFileSync(new URL("../ui/assets/panel.js", import.meta.url), "utf8");
function extract(from, until) {
  const start = panel.indexOf(from), end = panel.indexOf(until, start + from.length);
  assert.ok(start >= 0 && end > start); return panel.slice(start, end);
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-selection-question-24-"));
  const workspace = createPaperWorkspace({ dataDir });
  const paper = await workspace.upsertPaper({ paperHash: HASH, metadata: { title: "Owned selection paper" }, blocks: BLOCKS });
  const routes = new Map(), app = {};
  for (const method of ["get", "post", "delete"]) app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  const f = { dataDir, workspace, paper, routes, calls: [], cancels: [], profileCalls: 0, onModel: null, onProfile: null, answer: "Owned selected answer" };
  registerApiRoutes(app, { dataDir,
    agents: { list: async () => ({ agents: [{ id: "owned-agent", name: "Owned assistant" }] }),
      profile: async () => { f.profileCalls++; await f.onProfile?.(); return { profile: { id: "owned-agent", name: "Owned assistant", model: { provider: "owned", id: "reader" } } }; } },
    models: { list: async () => ({ models: [{ provider: "owned", id: "reader" }] }), cancel: async requestId => { f.cancels.push(requestId); },
      stream: async input => { f.calls.push(input); await f.onModel?.(); const text = f.answer;
        return [{ type: "start", requestId: input.requestId }, { type: "text-delta", requestId: input.requestId, delta: text },
          { type: "done", requestId: input.requestId, stopReason: "stop", assistant: { role: "assistant", content: [{ type: "text", text }] } }]; } },
  });
  f.request = (body = {}, signal) => routes.get("POST /api/ask-agent")({ get: () => ({ principal: { id: "owned-selection-test" } }),
    req: { raw: { signal }, json: async () => ({ paperHash: HASH, blockId: "b1", quote: "original selected", agentId: "owned-agent", modelRef: "agent-default", ...body }) },
    json: (value, status = 200) => ({ value, status }) });
  f.close = async () => {
    await workspace.close();
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("hpr-selection-question-24-"));
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return f;
}
function pageHarness(f) {
  const elements = new Map(["selection-toolbar", "answer-drawer", "drawer-quote", "drawer-content"].map(id => [id, {
    style: {}, classList: { add() {}, remove() {} }, textContent: "", innerHTML: "", appended: "",
    insertAdjacentText(_position, text) { this.appended += text; },
  }]));
  const h = { calls: [], prepareCalls: 0, onPrepare: null, transform: value => value, elements, notices: [] };
  const sandbox = vm.createContext({
    ...sourceContract, AbortController, Number, JSON, Boolean,
    currentPaper: structuredClone(f.paper), paperRevision: 1, activeView: "paper",
    currentAgent: { id: "owned-agent", name: "Owned assistant", model: "owned/reader" }, currentThinkingLevel: "high",
    selectedText: "original selected", selectedContext: "Owned original selected source", selectedBlockId: "b1", selectedFromTranslation: false,
    askAgentRequestId: 0, askAgentController: null, selectionAnswerSource: null,
    document: { getElementById: id => elements.get(id) },
    normalizedPaperHash: value => String(value || "").toLowerCase(),
    paperRefIsCurrent: (revision, ref) => revision === sandbox.paperRevision && ref === sandbox.currentPaper,
    researchPaperView: () => sandbox.currentPaper,
    flushCurrentPaperState: async () => { h.prepareCalls++; await h.onPrepare?.(); return h.prepared !== false; },
    safeToast: async input => { h.notices.push(input); },
    selectedModelRefForAgent: () => "agent-default", applyEffectiveThinkingLevel() {},
    escapeHtml: value => String(value || ""), formatMarkdown: value => String(value || ""),
    apiErrorMessage: (data, fallback) => typeof data?.error === "string" ? data.error : data?.error?.message || fallback,
    pluginApiFetch: async (route, init) => {
      h.calls.push({ route, body: JSON.parse(init.body), signal: init.signal });
      const response = await f.request(JSON.parse(init.body), init.signal);
      return { ok: response.status === 200, status: response.status, json: async () => h.transform(response.value) };
    },
  });
  vm.runInContext(extract("function cancelSelectionQuestion(", "function sessionQuotePayload(") + "\nglobalThis.ask = askAgentQuestion; globalThis.cancel = cancelSelectionQuestion; globalThis.invalidate = invalidateSelectionAnswerIfChanged;", sandbox);
  h.sandbox = sandbox; h.ask = type => sandbox.ask(type); return h;
}

for (const change of ["update", "delete", "restore"]) {
  test(`selection questions reject ${change} during inference`, async () => {
    const f = await fixture();
    try {
      const backup = f.workspace.exportBackup(HASH);
      f.onModel = async () => {
        if (change === "update") await f.workspace.upsertPaper({ paperHash: HASH, blocks: BLOCKS.map(block => ({ ...block, page: block.page + 1 })) });
        else if (change === "delete") await f.workspace.removePaper(HASH);
        else await f.workspace.restoreBackup({ ...backup, expectedRevision: f.workspace.getPaper(HASH).revision });
      };
      const response = await f.request();
      assert.equal(response.status, 409); assert.equal(response.value.code, "evidence_source_changed"); assert.equal(response.value.answer, undefined);
    } finally { await f.close(); }
  });
}

test("selection questions reject source changes while reading the Agent profile", async () => {
  const f = await fixture();
  try {
    f.onProfile = () => f.workspace.upsertPaper({ paperHash: HASH, blocks: BLOCKS.map(block => ({ ...block, text: "Changed while reading Agent" })) });
    const response = await f.request();
    assert.equal(response.status, 409); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("an actual Page answer remains paired with its submitted selection after another selection", async () => {
  const f = await fixture(), gate = deferred(), entered = deferred();
  const h = pageHarness(f); let asking;
  try {
    f.onModel = async () => { entered.resolve(); await gate.promise; };
    asking = h.ask(); await entered.promise;
    h.sandbox.selectedText = "Owned other source"; h.sandbox.selectedContext = "Owned other source"; h.sandbox.selectedBlockId = "b2";
    gate.resolve(); await asking;
    assert.ok(h.elements.get("drawer-quote").textContent.includes("original selected"));
    assert.ok(!h.elements.get("drawer-quote").textContent.includes("Owned other source"));
    assert.equal(h.elements.get("drawer-content").innerHTML, "Owned selected answer");
  } finally { gate.resolve(); await asking; await f.close(); }
});

test("an actual Page does not append an unused evidence anchor to the model answer", async () => {
  const f = await fixture();
  try {
    const h = pageHarness(f); await h.ask();
    assert.equal(h.elements.get("drawer-content").innerHTML, "Owned selected answer");
    assert.equal(h.elements.get("drawer-content").appended, "");
  } finally { await f.close(); }
});

test("an anchored selection uses stored context and title and echoes its original conditional source", async () => {
  const f = await fixture();
  try {
    const expectedSource = sourceContract.selectionRequestBasis(f.paper, "b1");
    const response = await f.request({ expectedSource, expectedGeneration: f.paper.generation, paperTitle: "Forged title", context: "Forged source context" });
    assert.equal(response.status, 200); assert.equal(response.value.quote, "original selected"); assert.equal(response.value.quoteOrigin, "original");
    assert.equal(response.value.sourceBasis, expectedSource); assert.equal(response.value.sourceGeneration, f.paper.generation);
    assert.equal(response.value.paperHash, HASH); assert.equal(response.value.citation, "Page 3 / block b1");
    const prompt = f.calls[0].messages[0].content;
    assert.ok(prompt.includes("Owned original selected source")); assert.ok(prompt.includes("Owned selection paper"));
    assert.ok(!prompt.includes("Forged source context")); assert.ok(!prompt.includes("Forged title"));
  } finally { await f.close(); }
});

test("a stale selection source condition is rejected before Agent lookup and inference", async () => {
  const f = await fixture();
  try {
    const expectedSource = sourceContract.selectionRequestBasis(f.paper, "b1");
    await f.workspace.upsertPaper({ paperHash: HASH, blocks: BLOCKS.map(block => ({ ...block, text: "New selected source" })) });
    const response = await f.request({ expectedSource, expectedGeneration: f.paper.generation });
    assert.equal(response.status, 409); assert.equal(f.profileCalls, 0); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("a restored selection cannot reuse a previously opened generation", async () => {
  const f = await fixture();
  try {
    const backup = f.workspace.exportBackup(HASH);
    await f.workspace.restoreBackup({ ...backup, expectedRevision: f.paper.revision });
    const response = await f.request({ expectedGeneration: f.paper.generation });
    assert.equal(response.status, 409); assert.equal(f.profileCalls, 0); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("a translated selection is distinguished from original paper text", async () => {
  const f = await fixture();
  try {
    const response = await f.request({ quote: "自建译文", fromTranslation: true });
    assert.equal(response.status, 200); assert.equal(response.value.quoteOrigin, "translation");
    assert.ok(f.calls[0].messages[0].content.includes("译文不是论文原文"));
    assert.ok(f.calls[0].messages[0].content.includes("Owned original selected source"));
  } finally { await f.close(); }
});

test("a changed stored translation invalidates the selected question even with an unchanged original", async () => {
  const f = await fixture();
  try {
    f.onModel = () => f.workspace.upsertPaper({ paperHash: HASH, blocks: BLOCKS, translations: { b1: "更新后的自建译文" }, replaceTranslations: true });
    const response = await f.request({ quote: "自建译文", fromTranslation: true });
    assert.equal(response.status, 409); assert.equal(response.value.answer, undefined);
  } finally { await f.close(); }
});

test("an unmatched selection remains a labeled user discussion hint instead of verified original text", async () => {
  const f = await fixture();
  try {
    await f.workspace.upsertPaper({ paperHash: HASH, blocks: [{ id: "b1", page: 3, type: "table", text: "Owned table caption",
      tableHtml: "<table><tr><td>Owned cell</td></tr></table>", latex: "x^2" }] });
    const response = await f.request({ quote: "Unmatched selected rendered fragment", context: "Forged table" });
    assert.equal(response.status, 200); assert.equal(response.value.quoteOrigin, "unverified");
    const prompt = f.calls[0].messages[0].content;
    assert.ok(prompt.includes("只是用户提供的讨论线索")); assert.ok(prompt.includes("Owned table caption"));
    assert.ok(prompt.includes("Owned cell")); assert.ok(prompt.includes("x^2")); assert.ok(!prompt.includes("Forged table"));
  } finally { await f.close(); }
});

test("a legacy unanchored selection has no verified evidence or permitted paper citation", async () => {
  const f = await fixture();
  try {
    f.answer = "Legacy answer Page 999 / block forged";
    const response = await f.request({ paperHash: null, blockId: null });
    assert.equal(response.status, 200); assert.equal(response.value.evidence, null); assert.equal(response.value.citation, null);
    assert.equal(response.value.sourceBasis, null); assert.equal(response.value.quoteOrigin, "unverified");
    assert.ok(!response.value.answer.includes("Page 999")); assert.ok(response.value.answer.includes("[未核验来源已移除]"));
  } finally { await f.close(); }
});

test("a selection cannot resolve disagreeing block and evidence identifiers", async () => {
  const f = await fixture();
  try {
    const evidenceId = f.workspace.getEvidence(HASH, { blockId: "b2" }).evidenceId;
    const response = await f.request({ evidenceId, blockId: "b1" });
    assert.equal(response.status, 404); assert.equal(response.value.code, "evidence_not_found"); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("invalid selection quotes and conditions fail before public Agent reads without changing data", async () => {
  const f = await fixture();
  try {
    const paperFile = path.join(f.dataDir, "papers", HASH, "paper.json"), before = fs.readFileSync(paperFile);
    for (const body of [{ quote: "" }, { quote: "x".repeat(12001) }, { quote: {} }, { expectedSource: {} }, { expectedGeneration: "01" },
      { fromTranslation: "true" }, { blockId: null, expectedSource: "conditional-but-no-reference" }]) {
      const response = await f.request(body); assert.equal(response.status, 400); assert.equal(f.profileCalls, 0); assert.equal(f.calls.length, 0);
      assert.deepEqual(fs.readFileSync(paperFile), before);
    }
    assert.equal((await f.request({ quote: "x".repeat(12000) })).status, 200);
  } finally { await f.close(); }
});

test("notes and an unrelated block update do not invalidate the selection's own source", async () => {
  const f = await fixture();
  try {
    f.onModel = async () => {
      await f.workspace.putNote({ paperHash: HASH, blockId: "b1", note: "Owned unrelated note" });
      await f.workspace.upsertPaper({ paperHash: HASH, blocks: BLOCKS.map(block => block.id === "b2" ? { ...block, text: "New other source" } : block) });
    };
    assert.equal((await f.request()).status, 200);
  } finally { await f.close(); }
});

test("raw first-publication headings and paragraphs match the server's derived evidence metadata", async () => {
  const f = await fixture();
  try {
    const raw = { paperHash: HASH, metadata: { title: "Owned raw paper" }, blocks: [{ id: "h1", type: "heading", text: "Owned section" }, ...BLOCKS] };
    const committed = await f.workspace.upsertPaper(raw);
    const opened = { ...raw, generation: committed.generation, revision: committed.revision };
    assert.equal(sourceContract.evidenceRequestBasis(opened, "b1"), sourceContract.evidenceRequestBasis(committed, "b1"));
    assert.equal(sourceContract.selectionRequestBasis(opened, "b1"), sourceContract.selectionRequestBasis(committed, "b1"));
    assert.equal((await f.request({ expectedSource: sourceContract.selectionRequestBasis(opened, "b1"), expectedGeneration: opened.generation })).status, 200);
  } finally { await f.close(); }
});

for (const change of ["source", "generation", "failed", "cancelled"]) {
  test(`an actual Page stops sending after ${change} preparation and retains its submitted quote`, async () => {
    const f = await fixture();
    try {
      const h = pageHarness(f);
      h.onPrepare = async () => {
        if (change === "source") h.sandbox.currentPaper.blocks[0].text = "New prepared source";
        else if (change === "generation") h.sandbox.currentPaper.generation++;
        else if (change === "failed") h.prepared = false;
        else h.sandbox.cancel();
      };
      await h.ask(); assert.equal(f.calls.length, 0); assert.equal(h.calls.length, 0);
      assert.ok(h.elements.get("drawer-quote").textContent.includes("original selected"));
      assert.equal(h.sandbox.selectedText, "original selected");
    } finally { await f.close(); }
  });
}

test("an actual Page refuses a successful response after its local source changed", async () => {
  const f = await fixture();
  try {
    const h = pageHarness(f); f.onModel = () => { h.sandbox.currentPaper.blocks[0].page = 8; };
    await h.ask(); assert.ok(h.elements.get("drawer-content").textContent.includes("论文证据已变化"));
    assert.ok(!h.elements.get("drawer-content").innerHTML.includes("Owned selected answer"));
  } finally { await f.close(); }
});

test("an actual Page rejects malformed selection receipts and keeps the submitted quote", async () => {
  const f = await fixture();
  try {
    for (const patch of [{ quote: "Different quote" }, { paperHash: "d".repeat(64) }, { sourceBasis: "wrong" }, { sourceGeneration: 0 },
      { citation: "Page 9 / block b1" }, { evidence: null }, { quoteOrigin: "invented" }, { answer: "" }]) {
      const h = pageHarness(f); h.transform = value => ({ ...value, ...patch }); await h.ask();
      assert.ok(h.elements.get("drawer-content").textContent.includes("回执与原划选不一致"));
      assert.ok(!h.elements.get("drawer-content").innerHTML.includes("Owned selected answer"));
      assert.equal(h.sandbox.selectedText, "original selected"); assert.equal(h.calls.length, 1);
    }
  } finally { await f.close(); }
});

test("a displayed actual Page answer is invalidated when its source later changes", async () => {
  const f = await fixture();
  try {
    const h = pageHarness(f); await h.ask(); assert.equal(h.elements.get("drawer-content").innerHTML, "Owned selected answer");
    h.sandbox.currentPaper.blocks[0].text = "New displayed source"; h.sandbox.invalidate();
    assert.ok(h.elements.get("drawer-content").textContent.includes("论文证据已变化")); assert.equal(h.sandbox.selectionAnswerSource, null);
    assert.ok(panel.includes("function renderBlocks() {\n  invalidateSelectionAnswerIfChanged();") || panel.includes("function renderBlocks() {\r\n  invalidateSelectionAnswerIfChanged();"));
  } finally { await f.close(); }
});

test("cancelling an actual Page request reaches model cancellation and suppresses its late result", async () => {
  const f = await fixture(), gate = deferred(), entered = deferred(); let asking;
  try {
    const h = pageHarness(f); f.onModel = async () => { entered.resolve(); await gate.promise; };
    asking = h.ask(); await entered.promise; h.sandbox.cancel(); await asking;
    assert.equal(h.calls[0].signal.aborted, true); assert.equal(f.cancels.length, 1);
    gate.resolve(); assert.ok(!h.elements.get("drawer-content").innerHTML.includes("Owned selected answer"));
    assert.equal(h.sandbox.askAgentController, null);
  } finally { gate.resolve(); await asking; await f.close(); }
});

test("a same-paper Page context replacement cannot receive a late selected answer", async () => {
  const f = await fixture();
  try {
    const h = pageHarness(f); f.onModel = () => { h.sandbox.currentPaper = structuredClone(f.paper); h.sandbox.paperRevision++; };
    await h.ask(); assert.ok(!h.elements.get("drawer-content").innerHTML.includes("Owned selected answer"));
  } finally { await f.close(); }
});

test("an oversized actual Page selection is retained without saving or asking the model", async () => {
  const f = await fixture();
  try {
    const h = pageHarness(f); h.sandbox.selectedText = "x".repeat(12001); await h.ask();
    assert.equal(h.prepareCalls, 0); assert.equal(h.calls.length, 0); assert.equal(f.calls.length, 0); assert.equal(h.sandbox.selectedText.length, 12001);
  } finally { await f.close(); }
});

test("an actual first-publication Page can ask without borrowing preexisting derived evidence metadata", async () => {
  const f = await fixture();
  try {
    await f.workspace.removePaper(HASH);
    const h = pageHarness(f);
    h.sandbox.currentPaper = { paperHash: HASH, metadata: f.paper.metadata, blocks: structuredClone(BLOCKS), translations: { b1: "自建译文来源" } };
    h.onPrepare = async () => {
      const committed = await f.workspace.upsertPaper({ ...h.sandbox.currentPaper, expectedRevision: 0 });
      h.sandbox.currentPaper.generation = committed.generation; h.sandbox.currentPaper.revision = committed.revision;
    };
    await h.ask(); assert.equal(f.calls.length, 1); assert.equal(h.elements.get("drawer-content").innerHTML, "Owned selected answer");
    assert.equal(h.calls[0].body.expectedGeneration, f.workspace.getPaper(HASH).generation);
    assert.equal(h.sandbox.currentPaper.blocks[0].evidenceId, undefined);
  } finally { await f.close(); }
});

test("a newer actual Page question cancels the first one without accepting its late result", async () => {
  const f = await fixture(), gate = deferred(), entered = deferred(); let first;
  try {
    const h = pageHarness(f); let count = 0;
    f.onModel = async () => { if (++count === 1) { entered.resolve(); await gate.promise; } };
    first = h.ask(); await entered.promise;
    h.sandbox.selectedText = "Owned other source"; h.sandbox.selectedBlockId = "b2";
    await h.ask(); await first;
    const quote = h.elements.get("drawer-quote").textContent;
    assert.ok(quote.includes("Owned other source")); assert.ok(quote.includes("Page 4 / block b2"));
    assert.equal(f.calls.length, 2); assert.equal(f.cancels.length, 1); assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.calls[1].signal.aborted, false); gate.resolve();
    assert.equal(h.elements.get("drawer-quote").textContent, quote);
    assert.equal(h.elements.get("drawer-content").innerHTML, "Owned selected answer");
  } finally { gate.resolve(); await first; await f.close(); }
});

test("an actual translation commit immediately invalidates the displayed selection answer", async () => {
  const f = await fixture();
  try {
    const h = pageHarness(f); await h.ask();
    Object.assign(h.sandbox, { researchStateRevision: 1, activePaperContextIsCurrent: () => true, isFinalTranslation: () => false,
      translationTextElements: () => [], setBlockTranslationAction() {}, updateTranslationStateUi() {}, scheduleResearchSync() {}, formatMath: value => value });
    vm.runInContext(extract("function commitBlockTranslation(", "async function cachedTranslationsForBlocks(") + "\nglobalThis.commit = commitBlockTranslation;", h.sandbox);
    assert.equal(h.sandbox.commit("b1", "更新后的自建译文", { kind: "final" }), true);
    assert.ok(h.elements.get("drawer-content").textContent.includes("论文证据已变化")); assert.equal(h.sandbox.selectionAnswerSource, null);
  } finally { await f.close(); }
});
