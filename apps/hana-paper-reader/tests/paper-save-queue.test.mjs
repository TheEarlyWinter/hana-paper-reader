import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import registerApiRoutes from "../server/http/api-routes.js";
import { createPaperWorkspace } from "../server/domain/paper-workspace.js";
import { captureResearchOwner, withResearchOwner } from "../ui/assets/research-write-owner.js";
import { paperDeletionNotice, paperDeletionRevision } from "../ui/assets/paper-deletion-result.js";

const HASH = "a".repeat(64), OTHER = "b".repeat(64);
const blocks = [{ id: "b1", page: 1, type: "paragraph", text: "Owned queue evidence" }];
const panel = fs.readFileSync(new URL("../ui/assets/panel.js", import.meta.url), "utf8");
function functionRange(start, end) {
  const from = panel.indexOf(start), to = panel.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return panel.slice(from, to);
}
async function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-save-queue-"));
  const workspace = createPaperWorkspace({ dataDir });
  const routes = new Map(), app = {};
  for (const method of ["get", "post", "delete"]) app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  registerApiRoutes(app, { dataDir });
  const background = [];
  return { dataDir, workspace, routes, background, async close() {
    await Promise.allSettled(background);
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("hpr-save-queue-"));
    fs.rmSync(dataDir, { recursive: true, force: true });
  } };
}
function harness(f, initialPaper, { actualLoader = false, actualHydration = false } = {}) {
  const calls = [], notifications = [];
  const timers = [], notice = { textContent: "", hidden: true, dataset: {} };
  let hold = null;
  let reject = null;
  let transform = value => value;
  async function pauseResponse(route) {
    const matching = hold && (!hold.route || hold.route === route
      || hold.route === "translation-cache" && route.startsWith("/api/research/translation-cache?"));
    const pending = matching && !hold.remaining ? hold : null;
    if (matching && hold.remaining) hold.remaining--;
    if (pending) hold = null;
    if (pending) { pending.entered(); await pending.gate; }
  }
  const sandbox = vm.createContext({
    Map, Set, Promise, JSON, Number, URL, captureResearchOwner, withResearchOwner, paperDeletionNotice, paperDeletionRevision,
    currentPaper: initialPaper, paperRevision: 1, researchStateRevision: 1,
    currentReadingMode: "bilingual", scheduleResearchSync: () => { sandbox.scheduled = (sandbox.scheduled || 0) + 1; },
    researchTools: { refresh() {} }, invalidateSelectionAnswerIfChanged() {},
    window: { setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; }, clearTimeout() {} },
    document: { getElementById: id => id === "panel-notice" ? notice : null }, panelNoticeTimer: null,
    openPaperTabs: [{ paperHash: initialPaper.paperHash }], activeView: "paper", activePaperHash: initialPaper.paperHash,
    paperLoadingHash: null, paperLoadRequestId: 1, activeParseController: null, paperCloseRequests: new Map(), paperMutationContexts: new Map(),
    renderWorkspaceTabs() {}, saveTabsState() {}, cancelActiveParse() {},
    switchView(view, hash) { sandbox.activeView = view; if (hash) sandbox.activePaperHash = hash; },
    restoreRequestId: 0, fullTranslationRunId: 0, fullTranslationBusy: false, blockTranslationRunIds: new Map(),
    pendingPdfFile: null, pendingPdfLoadRequestId: 0, libraryItems: [], pdfFilesByHash: new Map(), paperViewSnapshots: new Map(),
    translationCacheChains: new Map(), progressState: { percent: 20 },
    currentReadingProgress: () => ({ paperHash: sandbox.currentPaper.paperHash, ...JSON.parse(JSON.stringify(sandbox.progressState)) }),
    researchUiStateSnapshot: () => ({ noteDraft: sandbox.progressState.noteDraft || null, glossaryDraft: sandbox.progressState.glossaryDraft || null, evidenceDraft: sandbox.progressState.evidenceDraft || null }),
    paperLoadIsCurrent: (id, hash) => id === sandbox.paperLoadRequestId && sandbox.activeView === "paper" && sandbox.activePaperHash === hash,
    applyPaperViewSnapshot(hash) { const state = sandbox.paperViewSnapshots.get(hash); if (state?.progress) sandbox.progressState = JSON.parse(JSON.stringify(state.progress)); },
    loadDetachedResearchRecord() {}, activateLibraryFallback() {}, removePaperTab() {},
    upsertPaperTab(paper) { if (!sandbox.openPaperTabs.some(tab => tab.paperHash === paper.paperHash)) sandbox.openPaperTabs.push(paper); },
    loadPaper(paper) { sandbox.currentPaper = paper; sandbox.paperRevision++; sandbox.researchStateRevision++; return true; },
    clearCurrentPaperView() { sandbox.currentPaper = { blocks: [], paperHash: null }; },
    deletedPaperHashes: new Set(), paperSyncBlocked: new Set(), paperConflictNotices: new Set(),
    paperSyncFailures: new Map(), paperSyncChains: new Map(), progressSyncFailures: new Map(), progressSyncChains: new Map(),
    normalizedPaperHash: value => typeof value === "string" ? value.trim().toLowerCase() : "",
    cloneJson: value => value === undefined ? undefined : JSON.parse(JSON.stringify(value)),
    paperContextIsCurrent: (hash, revision, ref) => hash === sandbox.currentPaper.paperHash && revision === sandbox.paperRevision && ref === sandbox.currentPaper,
    safeToast: async value => { notifications.push(value); },
    apiErrorMessage: (data, fallback) => data?.error?.message || fallback,
    pluginApiFetch: async (route, init) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      const method = init?.method || "GET", parsed = new URL(route, "https://owned.invalid");
      calls.push({ route, body, method });
      if (reject && reject.route === route) { const error = reject.error; reject = null; throw error; }
      const handlerRequest = f.routes.get(`${method} ${parsed.pathname}`)({
        get: () => ({ principal: { id: "owned-save-queue" } }),
        req: { json: async () => body, query: key => parsed.searchParams.get(key) || "" },
        json: (value, status = 200) => ({ value, status }),
      });
      if (parsed.pathname === "/api/research/library/metadata") f.background.push(handlerRequest);
      const result = await handlerRequest;
      await pauseResponse(route);
      return { ok: result.status >= 200 && result.status < 300, status: result.status, async json() { return transform(result.value); } };
    },
  });
  sandbox.capturePaperSyncSnapshot = options => {
    const paperRef = sandbox.currentPaper;
    if (!paperRef.blocks?.length || options?.paperHash && options.paperHash !== paperRef.paperHash) return null;
    return { paperHash: paperRef.paperHash, paperRef, revision: sandbox.paperRevision, stateRevision: sandbox.researchStateRevision,
      payload: sandbox.queue.buildPaperSyncPayload(paperRef, paperRef.paperHash), progress: sandbox.currentReadingProgress() };
  };
  let code = functionRange("function showPanelNotice(", "function hostViewStatePayload(")
    + functionRange("async function openPaperTab(", panel.includes("function paperViewSaveFingerprint(") ? "function paperViewSaveFingerprint(" : "function showPaperSaveFailure(")
    + functionRange(panel.includes("function paperViewSaveFingerprint(") ? "function paperViewSaveFingerprint(" : "function showPaperSaveFailure(", "function reconcileOpenPaperTabs(")
    + functionRange("async function waitForPaperSync(", "function invalidatePaperContext(")
    + functionRange("function buildPaperSyncPayload(", "async function resolvePaperHashForSnapshot(")
    + functionRange("function paperSyncOriginIsSuperseded(", "function enqueueProgressSync(")
    + functionRange("function enqueueProgressSync(", "async function initializeResearchTools(")
    + functionRange("function acknowledgeSyncedPaperVersion(", "function scheduleResearchSync(");
  if (actualLoader) {
    // Execute the production replacement and snapshot functions. DOM drawing,
    // PDF rendering is excluded; glossary/cache hydration is opt-in below.
    Object.assign(sandbox, {
      loadAgentsAndModels: async () => {}, sanitizedTableCache: new Map(),
      hidePaperTransientUi() {}, resetResearchUiForPaper() {},
      pdfPreviewPaperHash: null, pdfPreviewDocument: null, pdfPreviewLoadingTask: null,
      currentPdfFile: null, currentPdfFileHash: null, resetPdfPreview() {},
      READING_MODES: new Set(["bilingual"]), setReadingMode(mode) { sandbox.currentReadingMode = mode; },
      updateMineruUI() {}, renderBlocks() {}, mineruSettings: { modelVersion: "synthetic" },
      paperRefIsCurrent: (revision, ref) => revision === sandbox.paperRevision && ref === sandbox.currentPaper,
      activePaperContextIsCurrent: () => false,
      currentPaperHashPromise: null, activePane: null, selectedBlockId: null,
      hashPaperSource: async source => source.title === "Imported.md" ? OTHER : HASH,
      SAMPLE_PAPER: { paperHash: OTHER, title: "Owned sample", blocks },
      AbortController, MAX_PDF_BYTES: 50 * 1024 * 1024, UI_VERSION: "synthetic",
      parseJobId: 0, activeParseTask: null, mineruApiVersion: null, mineruConfigured: true,
      pdfPreviewGeneration: 1, initializePdfPreview() {},
      hashFile: async () => sandbox.fileHash || OTHER, checkParseCache: async () => sandbox.parseCache || null,
      parseTasksCreated: 0,
      createParseTask: async hash => { sandbox.parseTasksCreated++; return { id: "owned-parse", paperHash: hash, paperGeneration: 1 }; },
      parseTaskUpdates: [], updateParseTask: async (_task, patch) => { sandbox.parseTaskUpdates.push(patch); },
      confirmAction: async () => true,
      loadLibraryItems: async () => {},
    });
    const researchFetch = sandbox.pluginApiFetch;
    sandbox.pluginApiFetch = async (route, init) => {
      if (!route.startsWith("/api/parse-pdf?")) return researchFetch(route, init);
      calls.push({ route, method: "POST", body: null, syntheticParser: true });
      const hash = sandbox.fileHash || OTHER, previous = f.workspace.getPaper(hash);
      const saved = await f.workspace.upsertPaper({ paperHash: hash, blocks, parser: { kind: "mineru", pageCount: 1 },
        metadata: { title: init.body.name }, expectedRevision: previous?.revision || 0 });
      await pauseResponse("parser");
      return { ok: true, json: async () => ({ ok: true, paperHash: hash, revision: saved.revision, generation: saved.generation, pageCount: 1, blocks }) };
    };
    const badge = { textContent: "", title: "" };
    const controls = new Map(["reading-mode-control", "btn-translate-all", "btn-research-tools"].map(id => [id, { style: {} }]));
    sandbox.controls = controls;
    sandbox.translatableBlocks = () => [];
    sandbox.document.getElementById = id => id === "panel-notice" ? notice : id === "paper-badge" ? badge : controls.get(id) || null;
    sandbox.document.querySelectorAll = () => [];
    sandbox.document.querySelector = () => null;
    code += functionRange("async function resolvePaperHashForSnapshot(", "function clearPaperSyncTimers(")
      + functionRange(panel.includes("async function loadPaper(") ? "async function loadPaper(" : "function loadPaper(", "function blockGroupsByPage(")
      + functionRange(panel.includes("async function loadSamplePaper(") ? "async function loadSamplePaper(" : "function loadSamplePaper(", "async function parsePdfFile(")
      + functionRange("function cancelActiveParse(", panel.includes("async function loadSamplePaper(") ? "async function loadSamplePaper(" : "function loadSamplePaper(")
      + functionRange("async function parsePdfFile(", "async function handleFile(")
      + functionRange("async function handleFile(", "function translatableBlocks(")
      + functionRange("function invalidatePaperContext(", "function paperSyncOriginIsSuperseded(")
      + functionRange("function loadDetachedResearchRecord(", "async function restoreRecentPaper(")
      + functionRange("async function restoreResearchBackup(", "async function createNoteFromSelection(");
  }
  if (actualHydration) {
    assert.equal(actualLoader, true);
    Object.assign(sandbox, {
      URLSearchParams, glossaryRequestId: 0, paperViewRestoreRequestId: 0,
      restoredResearchUiState: { searchState: {}, noteDraft: null }, currentAgent: null,
      TRANSLATION_PROMPT_VERSION: "owned-v1", currentThinkingLevel: "medium",
      selectedModelRefForAgent: () => "", hashTranslationInput: async () => HASH,
      setBlockTranslationAction() {}, updateTranslationStateUi() {},
      renderBlocks: () => { sandbox.renderCount = (sandbox.renderCount || 0) + 1; },
      locateResearchBlock: id => { sandbox.located = id; },
      highlightSearchInReader: query => { sandbox.highlighted = query; },
      capturePaperViewSnapshot: () => { sandbox.capturedViews = (sandbox.capturedViews || 0) + 1; },
      READING_MODES: new Set(["bilingual", "original", "translation", "contrast"]),
      applyEffectiveThinkingLevel() {}, alignTranslationBlock() {}, placeholders: [],
      setTranslationPlaceholder: (id, text, error) => { sandbox.placeholders.push({ id, text, error }); },
    });
    sandbox.panes = new Map(["original-pane", "trans-pane", "contrast-pane"].map(id => [id, { scrollTop: 0 }]));
    const baseElement = sandbox.document.getElementById;
    sandbox.document.getElementById = id => sandbox.panes.get(id) || baseElement(id);
    sandbox.currentReadingProgress = () => ({ paperHash: sandbox.currentPaper.paperHash,
      ...JSON.parse(JSON.stringify(sandbox.progressState)), readingMode: sandbox.currentReadingMode,
      blockId: sandbox.selectedBlockId, originalScrollTop: sandbox.panes.get("original-pane").scrollTop,
      translationScrollTop: sandbox.panes.get("trans-pane").scrollTop, contrastScrollTop: sandbox.panes.get("contrast-pane").scrollTop });
    sandbox.researchUiStateSnapshot = () => ({ noteDraft: sandbox.progressState.noteDraft || null, glossaryDraft: sandbox.progressState.glossaryDraft || null, evidenceDraft: sandbox.progressState.evidenceDraft || null, searchState: sandbox.progressState.searchState || {} });
    sandbox.researchTools.restoreUiState = state => {
      sandbox.progressState.noteDraft = state.noteDraft;
      sandbox.progressState.glossaryDraft = state.glossaryDraft;
      sandbox.progressState.evidenceDraft = state.evidenceDraft;
      sandbox.progressState.searchState = state.searchState;
    };
    sandbox.window.requestAnimationFrame = callback => { timers.push({ callback, delay: "animation-frame" }); return timers.length; };
    const ownedFetch = sandbox.pluginApiFetch;
    sandbox.pluginApiFetch = async (route, init) => {
      if (route !== "/api/translate") return ownedFetch(route, init);
      const body = JSON.parse(init.body);
      calls.push({ route, method: "POST", body, syntheticModel: true });
      await pauseResponse("model");
      if (sandbox.failModel) throw new Error("Owned model failure");
      return { ok: true, json: async () => ({ ok: true, translations: (body.texts || [body.text]).map(text => `AI: ${text}`) }) };
    };
    code += functionRange("function paperRefIsCurrent(", "function researchUiStateSnapshot(")
      + functionRange("function restorePaperProgressInView(", "function resetResearchUiForPaper(")
      + functionRange("async function restorePaperProgress(", "function scheduleProgressSync(")
      + functionRange("async function getCachedBlockTranslation(", "function enqueueTranslationCache(")
      + functionRange("function enqueueTranslationCache(", "async function checkParseCache(")
      + functionRange("function translationTextElements(", "function paneContentTop(")
      + functionRange("function translationState(", "function researchPaperView(")
      + functionRange("function translationTextForBlock(", "function renderStructuredVisual(")
      + functionRange("async function translateSingleBlock(", "function handleTextSelection(");
  }
  sandbox.clearPaperSyncTimers = () => {};
  vm.runInContext(`${code}\nglobalThis.queue = { buildPaperSyncPayload, enqueuePaperSync, enqueueProgressSync, flushPaperSnapshot, ensureResearchPaper, closePaperTab, openPaperTab, flushForPageLifecycle, lifecyclePending: () => lifecycleFlushPromise${actualLoader ? ", loadPaper, loadSamplePaper, handleFile, parsePdfFile, restoreResearchBackup, preparePaperDataMutation, releasePaperDataMutation, deletePaperRecord" : ""}${actualLoader && panel.includes("async function applyPreparedPaperMutation(") ? ", applyPreparedPaperMutation, applyPreparedPaperDeletion" : ""}${actualHydration ? ", restorePaperProgress, restorePaperProgressInView, cachedTranslationsForBlocks, commitBlockTranslation, refreshGlossaryState, applyGlossaryRecord, translateSingleBlock, startFullTranslation" : ""} };`, sandbox);
  if (actualHydration && panel.includes("async function hydrateLoadedPaper(")) {
    const hydrate = sandbox.hydrateLoadedPaper;
    sandbox.hydrateLoadedPaper = (...args) => {
      const promise = hydrate(...args);
      sandbox.hydration = promise;
      f.background.push(promise);
      return promise;
    };
  }
  return { sandbox, calls, notifications, timers, notice, queue: sandbox.queue,
    rejectNext(route, error = new Error("Synthetic offline request")) { reject = { route, error }; },
    transformResponse(callback) { transform = callback; },
    snapshot(paperRef, title, revision = 1) { return { paperHash: paperRef.paperHash, paperRef, revision, stateRevision: 1,
      payload: sandbox.queue.buildPaperSyncPayload({ ...paperRef, title }, paperRef.paperHash), progress: { paperHash: paperRef.paperHash, percent: 20 } }; },
    holdNext(route, remaining = 0) {
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; });
      const ready = new Promise(resolve => { entered = resolve; });
      hold = { gate, entered, route, remaining };
      return { release, ready };
    },
  };
}

for (const replacement of ["recreated", "reloaded"]) {
  test(`the actual Page queue cannot rebase an old snapshot onto a ${replacement} owner`, async () => {
    const f = await fixture();
    try {
      const old = await f.workspace.upsertPaper({ paperHash: HASH, blocks, metadata: { title: "Old snapshot" } });
      if (replacement === "recreated") {
        await f.workspace.removePaper(HASH);
        await f.workspace.upsertPaper({ paperHash: HASH, blocks, metadata: { title: "Recreated owner" } });
      }
      const fresh = f.workspace.getPaper(HASH);
      const h = harness(f, fresh), gate = h.holdNext();
      const first = h.queue.enqueuePaperSync(h.snapshot(fresh, "New saved content", 2));
      await gate.ready;
      const stale = h.queue.enqueuePaperSync(h.snapshot(old, "Old queued content"));
      const failed = assert.rejects(stale, error => error.code === "paper_conflict");
      gate.release();
      await first; await failed;
      assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getPaper(HASH).metadata.title, "New saved content");
    } finally { await f.close(); }
  });
}

test("an unpersisted snapshot cannot overwrite an existing paper without a version", async () => {
  const f = await fixture();
  try {
    await f.workspace.upsertPaper({ paperHash: HASH, blocks, metadata: { title: "Existing owner" } });
    const local = { paperHash: HASH, blocks, title: "Unpersisted import" };
    const h = harness(f, local);
    await assert.rejects(h.queue.enqueuePaperSync(h.snapshot(local, "Unpersisted import")), error => error.code === "paper_conflict");
    assert.equal(f.workspace.getPaper(HASH).metadata.title, "Existing owner");
  } finally { await f.close(); }
});

test("a same-context queue advances its own committed version and keeps the latest edit", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper), gate = h.holdNext();
    const first = h.queue.enqueuePaperSync(h.snapshot(paper, "First edit"));
    await gate.ready;
    const second = h.queue.enqueuePaperSync(h.snapshot(paper, "Latest edit"));
    gate.release();
    const [, saved] = await Promise.all([first, second]);
    assert.equal(saved.revision, paper.revision + 2);
    assert.equal(saved.generation, paper.generation);
    assert.equal(f.workspace.getPaper(HASH).metadata.title, "Latest edit");
  } finally { await f.close(); }
});

test("two initial snapshots from the same local paper create once and retain the new owner", async () => {
  const f = await fixture();
  try {
    const paper = { paperHash: HASH, blocks, title: "First import" };
    const h = harness(f, paper), gate = h.holdNext();
    const first = h.queue.enqueuePaperSync(h.snapshot(paper, "Initial draft"));
    await gate.ready;
    const second = h.queue.enqueuePaperSync(h.snapshot(paper, "Latest initial draft"));
    gate.release();
    const [, saved] = await Promise.all([first, second]);
    assert.equal(saved.revision, 2);
    assert.equal(saved.generation, 1);
    assert.equal(f.workspace.getPaper(HASH).metadata.title, "Latest initial draft");
  } finally { await f.close(); }
});

test("a queued old save stops after an earlier save reports a version conflict", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    await f.workspace.updatePaperMetadata(HASH, { title: "External newer edit" });
    const h = harness(f, paper), gate = h.holdNext();
    const first = h.queue.enqueuePaperSync(h.snapshot(paper, "Old edit"));
    const firstFailed = assert.rejects(first, error => error.code === "paper_conflict");
    await gate.ready;
    const second = h.queue.enqueuePaperSync(h.snapshot(paper, "Another old edit"));
    const secondFailed = assert.rejects(second, error => error.code === "paper_conflict");
    gate.release();
    await firstFailed; await secondFailed;
    assert.equal(h.calls.length, 1);
    assert.equal(h.sandbox.paperSyncBlocked.has(HASH), true);
    assert.equal(h.notifications.length, 1);
    assert.equal(h.sandbox.paperSyncFailures.has(HASH), true);
    assert.equal(f.workspace.getPaper(HASH).metadata.title, "External newer edit");
  } finally { await f.close(); }
});

test("an unrelated paper queue completes while another paper's response is held", async () => {
  const f = await fixture();
  try {
    const firstPaper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const other = await f.workspace.upsertPaper({ paperHash: OTHER, blocks });
    const h = harness(f, firstPaper), gate = h.holdNext();
    const first = h.queue.enqueuePaperSync(h.snapshot(firstPaper, "Held edit"));
    await gate.ready;
    const saved = await h.queue.enqueuePaperSync(h.snapshot(other, "Independent edit"));
    assert.equal(saved.metadata.title, "Independent edit");
    gate.release(); await first;
  } finally { await f.close(); }
});

test("a late older state from the same local paper is superseded without writing its paper or progress", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper), gate = h.holdNext();
    const newest = h.snapshot(paper, "Newer state");
    newest.stateRevision = 2;
    const first = h.queue.enqueuePaperSync(newest);
    await gate.ready;
    const old = h.snapshot(paper, "Late older state");
    old.stateRevision = 1;
    const stale = h.queue.flushPaperSnapshot(old);
    gate.release();
    await first;
    assert.equal(await stale, false);
    assert.equal(h.calls.length, 1);
    assert.equal(f.workspace.getPaper(HASH).metadata.title, "Newer state");
  } finally { await f.close(); }
});

test("a queued payload is captured before waiting for the preceding response", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper), gate = h.holdNext();
    const first = h.queue.enqueuePaperSync(h.snapshot(paper, "First"));
    await gate.ready;
    const snapshot = h.snapshot(paper, "Captured queued edit");
    const second = h.queue.enqueuePaperSync(snapshot);
    snapshot.payload.metadata.title = "Borrowed later mutation";
    gate.release();
    await first; await second;
    assert.equal(f.workspace.getPaper(HASH).metadata.title, "Captured queued edit");
  } finally { await f.close(); }
});

test("a later edit still adopts the last actual commit after an older snapshot was superseded", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper), gate = h.holdNext();
    const newest = h.snapshot(paper, "State two"); newest.stateRevision = 2;
    const first = h.queue.enqueuePaperSync(newest);
    await gate.ready;
    const old = h.snapshot(paper, "State one"); old.stateRevision = 1;
    const skipped = h.queue.enqueuePaperSync(old);
    const next = h.snapshot(paper, "State three"); next.stateRevision = 3;
    const last = h.queue.enqueuePaperSync(next);
    gate.release();
    await first;
    assert.equal(await skipped, null);
    const saved = await last;
    assert.equal(saved.revision, 3);
    assert.equal(f.workspace.getPaper(HASH).metadata.title, "State three");
    assert.equal(h.calls.length, 2);
  } finally { await f.close(); }
});

test("the actual full flush creates a paper before its progress and retains the latest queued draft", async () => {
  for (const initialRevision of [undefined, 0]) {
    const f = await fixture();
    try {
      const paper = { paperHash: HASH, blocks, ...(initialRevision === undefined ? {} : { revision: initialRevision }) };
      const h = harness(f, paper), gate = h.holdNext();
      h.sandbox.researchStateRevision = 2;
      const one = h.snapshot(paper, "Initial title"); one.stateRevision = 1; one.progress.percent = 10;
      const first = h.queue.flushPaperSnapshot(one);
      await gate.ready;
      const two = h.snapshot(paper, "Latest title"); two.stateRevision = 2; two.progress.percent = 20;
      const second = h.queue.flushPaperSnapshot(two);
      gate.release();
      assert.deepEqual(await Promise.all([first, second]), [true, true]);
      const next = createPaperWorkspace({ dataDir: f.dataDir });
      assert.equal(next.getPaper(HASH).metadata.title, "Latest title");
      assert.equal(next.getProgress(HASH).percent, 20);
      assert.equal(paper.revision, 2);
      assert.equal(paper.generation, 1);
      assert.equal(h.calls[0].body.expectedRevision, 0);
      assert.equal(h.calls.filter(call => call.route.endsWith("progress")).every(call => call.body.expectedGeneration === 1), true);
    } finally { await f.close(); }
  }
});

test("a deletion accepted while a response is held stops both queued paper and progress writes", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper), gate = h.holdNext();
    const first = h.queue.flushPaperSnapshot(h.snapshot(paper, "In flight"));
    await gate.ready;
    const second = h.queue.flushPaperSnapshot(h.snapshot(paper, "Queued old draft"));
    await f.workspace.removePaper(HASH);
    h.sandbox.deletedPaperHashes.add(HASH);
    gate.release();
    assert.deepEqual(await Promise.all([first, second]), [false, false]);
    assert.equal(h.calls.length, 1);
    assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getPaper(HASH), null);
  } finally { await f.close(); }
});

test("progress captures its values before waiting for another progress response", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper), gate = h.holdNext();
    const first = h.queue.enqueueProgressSync({ paperHash: HASH, percent: 10 });
    await gate.ready;
    const payload = { paperHash: HASH, percent: 20, noteDraft: { note: "Captured draft" } };
    const second = h.queue.enqueueProgressSync(payload);
    payload.percent = 99; payload.noteDraft.note = "Borrowed changed draft";
    gate.release();
    await first; await second;
    const progress = createPaperWorkspace({ dataDir: f.dataDir }).getProgress(HASH);
    assert.equal(progress.percent, 20);
    assert.equal(progress.noteDraft.note, "Captured draft");
  } finally { await f.close(); }
});

test("an unpersisted old progress snapshot cannot borrow another local paper's first commit", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper), gate = h.holdNext();
    const first = h.queue.enqueuePaperSync(h.snapshot(paper, "Current owner", 2));
    await gate.ready;
    const oldRef = { paperHash: HASH, blocks };
    const progress = h.queue.enqueueProgressSync({ paperHash: HASH, percent: 99 }, { paperRef: oldRef, revision: 1 });
    const failed = assert.rejects(progress, /尚未同步|已切换/);
    gate.release();
    await first; await failed;
    assert.equal(h.calls.length, 1);
    assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getProgress(HASH), null);
  } finally { await f.close(); }
});

test("an invalid server paper version prevents the dependent progress write", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper);
    h.transformResponse(data => data.paper ? { ...data, paper: { ...data.paper, paperHash: OTHER } } : data);
    assert.equal(await h.queue.flushPaperSnapshot(h.snapshot(paper, "Committed but invalid reply")), false);
    assert.equal(h.calls.length, 1);
    assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getProgress(HASH), null);
    assert.equal(paper.revision, 1);
  } finally { await f.close(); }
});

for (const firstImport of [false, true]) {
  test(`autosave acknowledges its commit without replacing a newer local edit${firstImport ? " on first import" : ""}`, async () => {
    const f = await fixture();
    try {
      const paper = firstImport ? { paperHash: HASH, blocks, title: "First import" }
        : await f.workspace.upsertPaper({ paperHash: HASH, blocks });
      paper.translations = {}; paper.translationStates = {};
      const h = harness(f, paper), gate = h.holdNext();
      const one = h.snapshot(paper, "Saved first state");
      const first = h.queue.ensureResearchPaper({ snapshot: one });
      await gate.ready;
      paper.title = "New local draft";
      paper.translations = { b1: "Unsaved local translation" };
      h.sandbox.researchStateRevision = 2;
      gate.release();
      const saved = await first;
      assert.equal(paper.title, "New local draft");
      assert.equal(paper.translations.b1, "Unsaved local translation");
      assert.equal(paper.revision, saved.revision);
      assert.equal(paper.generation, saved.generation);
      assert.equal(h.sandbox.scheduled, 1);
      const two = h.snapshot(paper, paper.title); two.stateRevision = 2;
      const next = await h.queue.ensureResearchPaper({ snapshot: two });
      assert.equal(next.revision, saved.revision + 1);
      assert.equal(f.workspace.getPaper(HASH).metadata.title, "New local draft");
      assert.equal(f.workspace.getPaper(HASH).translations.b1, "Unsaved local translation");
    } finally { await f.close(); }
  });
}

test("an older full flush cannot lower the version acknowledged by a newer autosave", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    paper.translations = {}; paper.translationStates = {};
    const h = harness(f, paper), gate = h.holdNext("/api/research/progress");
    const first = h.queue.flushPaperSnapshot(h.snapshot(paper, "First full flush"));
    await gate.ready;
    paper.revision = f.workspace.getPaper(HASH).revision;
    const saved = await h.queue.ensureResearchPaper({ snapshot: h.snapshot(paper, "Newer autosave") });
    assert.equal(paper.revision, saved.revision);
    gate.release();
    assert.equal(await first, true);
    assert.equal(paper.revision, saved.revision);
    assert.equal(f.workspace.getPaper(HASH).metadata.title, "Newer autosave");
  } finally { await f.close(); }
});

test("an old flush does not update a later page context even when the paper object is reused", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper), gate = h.holdNext("/api/research/progress");
    const first = h.queue.flushPaperSnapshot(h.snapshot(paper, "Old flush"));
    await gate.ready;
    const changed = await f.workspace.updatePaperMetadata(HASH, { title: "Later committed state" });
    paper.revision = changed.revision;
    h.sandbox.paperRevision = 2;
    gate.release();
    assert.equal(await first, true);
    assert.equal(paper.revision, changed.revision);
  } finally { await f.close(); }
});

for (const route of ["paper", "progress"]) {
  test(`a late ${route} conflict does not block the freshly reloaded paper context`, async () => {
    const f = await fixture();
    try {
      const old = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
      await f.workspace.removePaper(HASH);
      const fresh = await f.workspace.upsertPaper({ paperHash: HASH, blocks, metadata: { title: "Fresh version" } });
      const h = harness(f, old), gate = h.holdNext();
      const request = route === "paper" ? h.queue.enqueuePaperSync(h.snapshot(old, "Old draft"))
        : h.queue.enqueueProgressSync({ paperHash: HASH, percent: 90 });
      const failed = assert.rejects(request);
      await gate.ready;
      h.sandbox.currentPaper = fresh; h.sandbox.paperRevision = 2;
      gate.release(); await failed;
      assert.equal(h.sandbox.paperSyncBlocked.has(HASH), false);
      assert.equal(h.sandbox.paperConflictNotices.has(HASH), false);
      assert.equal(h.notifications.length, 0);
      assert.equal(h.sandbox.paperSyncFailures.has(HASH), false);
      assert.equal(h.sandbox.progressSyncFailures.has(HASH), false);
      const saved = await h.queue.enqueuePaperSync(h.snapshot(fresh, "Fresh later edit", 2));
      assert.equal(saved.metadata.title, "Fresh later edit");
    } finally { await f.close(); }
  });
}

test("a conflict belonging to the current progress context still pauses further writes", async () => {
  const f = await fixture();
  try {
    const old = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    await f.workspace.removePaper(HASH);
    await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, old);
    await assert.rejects(h.queue.enqueueProgressSync({ paperHash: HASH, percent: 95 }));
    assert.equal(h.sandbox.paperSyncBlocked.has(HASH), true);
    assert.equal(h.sandbox.paperConflictNotices.has(HASH), true);
    assert.equal(h.sandbox.progressSyncFailures.has(HASH), true);
    assert.equal(h.notifications.length, 1);
    assert.equal(await h.queue.enqueueProgressSync({ paperHash: HASH, percent: 96 }), null);
    assert.equal(h.calls.length, 1);
    assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getProgress(HASH), null);
  } finally { await f.close(); }
});

for (const route of ["paper", "progress"]) {
  test(`tab close retains the local draft after its ${route} request fails`, async () => {
    const f = await fixture();
    try {
      const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
      paper.title = "Visible unsaved title";
      const h = harness(f, paper);
      h.rejectNext(`/api/research/${route}`);
      const result = await h.queue.closePaperTab(HASH);
      await Promise.allSettled([...h.sandbox.paperSyncChains.values(), ...h.sandbox.progressSyncChains.values()]);
      assert.equal(result, false);
      assert.equal(h.sandbox.currentPaper, paper);
      assert.equal(h.sandbox.activeView, "paper");
      assert.equal(h.sandbox.openPaperTabs.length, 1);
      assert.match(h.notice.textContent, /未.*同步|保存失败/);
      assert.equal(h.notice.hidden, false);
      assert.equal(await h.queue.closePaperTab(HASH), true);
      assert.equal(h.sandbox.openPaperTabs.length, 0);
      assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getPaper(HASH).metadata.title, paper.title);
      assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getProgress(HASH).percent, 20);
      assert.equal(h.notice.hidden, true);
    } finally { await f.close(); }
  });
}

test("tab close stays open when a new edit arrives during its final save", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    paper.title = "First close draft";
    const h = harness(f, paper), gate = h.holdNext();
    const request = h.queue.closePaperTab(HASH);
    await gate.ready;
    paper.title = "Changed during close"; h.sandbox.researchStateRevision++;
    gate.release();
    assert.equal(await request, false);
    assert.equal(h.sandbox.currentPaper, paper);
    assert.equal(h.sandbox.openPaperTabs.length, 1);
    assert.equal(await h.queue.closePaperTab(HASH), true);
    assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getPaper(HASH).metadata.title, "Changed during close");
  } finally { await f.close(); }
});

test("repeated tab close waits for one final save before removing the tab", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper), gate = h.holdNext();
    const first = h.queue.closePaperTab(HASH);
    await gate.ready;
    const wasRetained = h.sandbox.openPaperTabs.length === 1;
    const second = h.queue.closePaperTab(HASH);
    gate.release();
    const results = await Promise.all([first, second]);
    assert.equal(wasRetained, true);
    assert.equal(first, second);
    assert.deepEqual(results, [true, true]);
    assert.equal(h.calls.length, 2);
    assert.equal(h.sandbox.openPaperTabs.length, 0);
  } finally { await f.close(); }
});

test("a delayed close cannot discard a paper tab after the active context changed", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const other = await f.workspace.upsertPaper({ paperHash: OTHER, blocks });
    const h = harness(f, paper), gate = h.holdNext();
    const request = h.queue.closePaperTab(HASH);
    await gate.ready;
    h.sandbox.currentPaper = other; h.sandbox.paperRevision++;
    h.sandbox.activePaperHash = OTHER;
    gate.release();
    assert.equal(await request, false);
    assert.equal(h.sandbox.currentPaper, other);
    assert.equal(h.sandbox.openPaperTabs.some(tab => tab.paperHash === HASH), true);
  } finally { await f.close(); }
});

test("lifecycle save failure remains visible and a successful retry clears the save notice", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper);
    h.rejectNext("/api/research/paper");
    assert.equal(await h.queue.flushForPageLifecycle(), false);
    assert.equal(h.notice.hidden, false);
    assert.equal(h.notice.dataset.kind, "paper-save");
    assert.match(h.notice.textContent, /未.*同步/);
    assert.equal(h.timers.some(timer => timer.delay === 7000), false);
    for (const timer of h.timers.splice(0)) timer.callback();
    assert.equal(await h.queue.flushForPageLifecycle(), true);
    assert.equal(h.notice.hidden, true);
  } finally { await f.close(); }
});

test("lifecycle deduplication keeps a newer state and its pending attempt intact", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    paper.title = "Before hide";
    const h = harness(f, paper), firstGate = h.holdNext();
    const first = h.queue.flushForPageLifecycle();
    await firstGate.ready;
    const duplicate = h.queue.flushForPageLifecycle();
    paper.title = "Newest hidden state"; h.sandbox.researchStateRevision++;
    const second = h.queue.flushForPageLifecycle();
    if (first === second) {
      firstGate.release(); await first;
      assert.notEqual(first, second);
    }
    const progressGate = h.holdNext("/api/research/progress", 1);
    firstGate.release();
    await progressGate.ready;
    const firstResult = await first;
    for (const timer of h.timers.splice(0)) timer.callback();
    const pending = h.queue.lifecyclePending();
    progressGate.release();
    assert.equal(await second, true);
    assert.equal(duplicate, first);
    assert.equal(firstResult, false);
    assert.equal(pending, second);
    assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getPaper(HASH).metadata.title, "Newest hidden state");
  } finally { await f.close(); }
});

test("hiding an empty library is a successful no-op without a save-failure notice", async () => {
  const f = await fixture();
  try {
    const h = harness(f, { blocks: [] });
    h.sandbox.activeView = "library";
    assert.equal(await h.queue.flushForPageLifecycle(), true);
    assert.equal(h.calls.length, 0);
    assert.equal(h.notice.hidden, true);
  } finally { await f.close(); }
});

for (const route of ["paper", "progress"]) {
  test(`paper switch retains the visible draft when the previous ${route} save fails`, async () => {
    const f = await fixture();
    try {
      const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
      await f.workspace.upsertPaper({ paperHash: OTHER, blocks });
      paper.title = "Still visible unsaved draft";
      const h = harness(f, paper);
      h.rejectNext(`/api/research/${route}`);
      assert.equal(await h.queue.openPaperTab(OTHER), false);
      assert.equal(h.sandbox.currentPaper, paper);
      assert.equal(h.sandbox.activePaperHash, HASH);
      assert.equal(h.sandbox.activeView, "paper");
      assert.equal(h.sandbox.paperLoadingHash, null);
      assert.equal(h.calls.some(call => call.method === "GET"), false);
      assert.match(h.notice.textContent, /未.*同步/);
      assert.equal(await h.queue.openPaperTab(OTHER), true);
      assert.equal(h.sandbox.currentPaper.paperHash, OTHER);
      assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getPaper(HASH).metadata.title, paper.title);
    } finally { await f.close(); }
  });
}

for (const change of ["content", "progress"]) {
  test(`paper switch retains edits made while waiting for the previous save: ${change}`, async () => {
    const f = await fixture();
    try {
      const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
      await f.workspace.upsertPaper({ paperHash: OTHER, blocks });
      const h = harness(f, paper), gate = h.holdNext();
      const request = h.queue.openPaperTab(OTHER);
      await gate.ready;
      if (change === "content") { paper.title = "Edited while switching"; h.sandbox.researchStateRevision++; }
      else { h.sandbox.progressState = { percent: 87, noteDraft: { note: "Draft typed while switching" } }; }
      gate.release();
      assert.equal(await request, false);
      assert.equal(h.sandbox.currentPaper, paper);
      assert.equal(h.sandbox.activePaperHash, HASH);
      assert.equal(await h.queue.openPaperTab(OTHER), true);
      if (change === "content") assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getPaper(HASH).metadata.title, paper.title);
      else assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getProgress(HASH).noteDraft.note, "Draft typed while switching");
    } finally { await f.close(); }
  });
}

test("rapid paper switch requests retain the original draft until the latest target can open", async () => {
  const f = await fixture(), THIRD = "c".repeat(64);
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    await f.workspace.upsertPaper({ paperHash: OTHER, blocks });
    await f.workspace.upsertPaper({ paperHash: THIRD, blocks });
    const h = harness(f, paper), gate = h.holdNext();
    const first = h.queue.openPaperTab(OTHER);
    await gate.ready;
    const retained = h.sandbox.currentPaper === paper && h.sandbox.activePaperHash === HASH;
    const second = h.queue.openPaperTab(THIRD);
    gate.release();
    const result = await Promise.all([first, second]);
    assert.equal(retained, true);
    assert.deepEqual(result, [false, true]);
    assert.equal(h.sandbox.currentPaper.paperHash, THIRD);
    assert.equal(h.calls.filter(call => call.method === "GET").length, 1);
  } finally { await f.close(); }
});

test("returning to the current tab supersedes a waiting switch without dropping its draft", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    await f.workspace.upsertPaper({ paperHash: OTHER, blocks });
    const h = harness(f, paper), gate = h.holdNext();
    const request = h.queue.openPaperTab(OTHER);
    await gate.ready;
    h.sandbox.paperViewSnapshots.set(HASH, { progress: { percent: 20, noteDraft: { note: "Old snapshot" } } });
    h.sandbox.progressState = { percent: 90, noteDraft: { note: "New local draft" } };
    const returned = h.queue.openPaperTab(HASH);
    gate.release();
    assert.equal(await request, false);
    assert.equal(await returned, true);
    assert.equal(h.sandbox.currentPaper, paper);
    assert.equal(h.sandbox.activePaperHash, HASH);
    assert.equal(h.sandbox.progressState.noteDraft.note, "New local draft");
  } finally { await f.close(); }
});

test("returning from the library still restores the saved paper view state", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper);
    h.sandbox.activeView = "library";
    h.sandbox.paperViewSnapshots.set(HASH, { progress: { percent: 60, noteDraft: { note: "Saved library return" } } });
    assert.equal(await h.queue.openPaperTab(HASH), true);
    assert.equal(h.sandbox.progressState.noteDraft.note, "Saved library return");
  } finally { await f.close(); }
});

test("a detached research record with no body can switch without a paper upsert", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks: [] });
    await f.workspace.upsertPaper({ paperHash: OTHER, blocks });
    const h = harness(f, paper);
    assert.equal(await h.queue.openPaperTab(OTHER), true);
    assert.equal(h.calls.some(call => call.method === "POST" && call.route === "/api/research/paper"), false);
  } finally { await f.close(); }
});

test("tab close retains a note draft or scroll change even without a content state revision change", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper), gate = h.holdNext();
    const request = h.queue.closePaperTab(HASH);
    await gate.ready;
    h.sandbox.progressState = { percent: 73, noteDraft: { note: "Last visible draft" } };
    gate.release();
    assert.equal(await request, false);
    assert.equal(h.sandbox.currentPaper, paper);
    assert.equal(await h.queue.closePaperTab(HASH), true);
    assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getProgress(HASH).noteDraft.note, "Last visible draft");
  } finally { await f.close(); }
});

test("lifecycle progress changes start a new save even without a content state revision change", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper), gate = h.holdNext();
    const first = h.queue.flushForPageLifecycle();
    await gate.ready;
    h.sandbox.progressState = { percent: 81, noteDraft: { note: "Latest hidden draft" } };
    const second = h.queue.flushForPageLifecycle();
    gate.release();
    const results = await Promise.all([first, second]);
    assert.notEqual(first, second);
    assert.deepEqual(results, [false, true]);
    assert.equal(createPaperWorkspace({ dataDir: f.dataDir }).getProgress(HASH).noteDraft.note, "Latest hidden draft");
  } finally { await f.close(); }
});

for (const route of ["paper", "progress"]) {
  test(`direct import retains the previous paper when its ${route} save fails`, async () => {
    const f = await fixture();
    try {
      const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
      paper.title = "Retained direct-import draft";
      const h = harness(f, paper, { actualLoader: true });
      const pdfFile = { name: "Owned previous PDF" };
      h.sandbox.currentPdfFile = pdfFile;
      h.sandbox.currentPdfFileHash = HASH;
      h.rejectNext(`/api/research/${route}`);
      const loaded = await h.queue.loadPaper({ paperHash: OTHER, title: "Incoming", blocks });
      assert.equal(loaded, false);
      assert.equal(h.sandbox.currentPaper, paper);
      assert.equal(h.sandbox.activePaperHash, HASH);
      assert.equal(h.sandbox.currentPdfFile, pdfFile);
      assert.equal(h.notice.hidden, false);
      assert.match(h.notice.textContent, /未.*同步/);
      assert.equal(await h.queue.loadPaper({ paperHash: OTHER, title: "Incoming", blocks }), true);
      assert.equal(h.sandbox.currentPaper.paperHash, OTHER);
      assert.equal(f.workspace.getPaper(HASH).metadata.title, paper.title);
      assert.equal(h.notice.hidden, true);
    } finally { await f.close(); }
  });
}

for (const change of ["content", "progress"]) {
  test(`direct import retains a ${change} edit made during saving`, async () => {
    const f = await fixture();
    try {
      const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
      const h = harness(f, paper, { actualLoader: true }), gate = h.holdNext();
      const request = h.queue.loadPaper({ paperHash: OTHER, title: "Incoming", blocks });
      await gate.ready;
      const retained = h.sandbox.currentPaper === paper;
      if (change === "content") { paper.title = "Edit during import"; h.sandbox.researchStateRevision++; }
      else h.sandbox.progressState = { percent: 79, noteDraft: { note: "Draft during import" } };
      gate.release();
      const loaded = await request;
      assert.equal(retained, true);
      assert.equal(loaded, false);
      assert.equal(h.sandbox.currentPaper, paper);
      assert.equal(await h.queue.loadPaper({ paperHash: OTHER, title: "Incoming", blocks }), true);
      if (change === "content") assert.equal(f.workspace.getPaper(HASH).metadata.title, "Edit during import");
      else assert.equal(f.workspace.getProgress(HASH).noteDraft.note, "Draft during import");
    } finally { await f.close(); }
  });
}

test("the latest direct import supersedes an older waiting import", async () => {
  const f = await fixture(), THIRD = "c".repeat(64);
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper, { actualLoader: true }), gate = h.holdNext();
    const first = h.queue.loadPaper({ paperHash: OTHER, title: "Older import", blocks });
    await gate.ready;
    const second = h.queue.loadPaper({ paperHash: THIRD, title: "Latest import", blocks });
    gate.release();
    assert.deepEqual(await Promise.all([first, second]), [false, true]);
    assert.equal(h.sandbox.currentPaper.paperHash, THIRD);
  } finally { await f.close(); }
});

test("returning to the current tab cancels a waiting direct import", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper, { actualLoader: true }), gate = h.holdNext();
    const request = h.queue.loadPaper({ paperHash: OTHER, title: "Incoming", blocks });
    await gate.ready;
    const returning = h.queue.openPaperTab(HASH);
    gate.release();
    assert.equal(await request, false);
    assert.equal(await returning, true);
    assert.equal(h.sandbox.currentPaper, paper);
  } finally { await f.close(); }
});

test("a direct import captures its incoming content before waiting for the old save", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper, { actualLoader: true }), gate = h.holdNext();
    const incoming = { paperHash: OTHER, title: "Captured incoming", blocks: [{ ...blocks[0] }] };
    const request = h.queue.loadPaper(incoming);
    await gate.ready;
    incoming.title = "Changed while waiting";
    incoming.blocks[0].text = "Changed while waiting";
    gate.release();
    assert.equal(await request, true);
    assert.equal(h.sandbox.currentPaper.title, "Captured incoming");
    assert.equal(h.sandbox.currentPaper.blocks[0].text, blocks[0].text);
  } finally { await f.close(); }
});

test("a direct import saves a previous text paper whose hash has not resolved yet", async () => {
  const f = await fixture();
  try {
    const paper = { title: "Unhashed text", blocks, paperHash: null };
    const h = harness(f, paper, { actualLoader: true });
    assert.equal(await h.queue.loadPaper({ paperHash: OTHER, title: "Incoming", blocks }), true);
    assert.equal(f.workspace.getPaper(HASH).metadata.title, "Unhashed text");
    assert.equal(f.workspace.getProgress(HASH).percent, 20);
    assert.equal(h.sandbox.currentPaper.paperHash, OTHER);
  } finally { await f.close(); }
});

test("loading a sample returns failure and retains the current paper after a save error", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper, { actualLoader: true });
    h.rejectNext("/api/research/paper");
    assert.equal(await h.queue.loadSamplePaper(), false);
    assert.equal(h.sandbox.currentPaper, paper);
    assert.equal(await h.queue.loadSamplePaper(), true);
    assert.equal(h.sandbox.currentPaper.title, "Owned sample");
  } finally { await f.close(); }
});

test("text file import awaits the save and retains the original PDF after failure", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper, { actualLoader: true });
    const pdfFile = { name: "Owned previous PDF" };
    h.sandbox.currentPdfFile = pdfFile;
    h.sandbox.currentPdfFileHash = HASH;
    h.rejectNext("/api/research/progress");
    assert.equal(await h.queue.handleFile({ name: "Imported.md", size: 100, text: async () => "Owned incoming text" }), false);
    assert.equal(h.sandbox.currentPaper, paper);
    assert.equal(h.sandbox.currentPdfFile, pdfFile);
    assert.equal(h.sandbox.currentPdfFileHash, HASH);
    assert.equal(await h.queue.handleFile({ name: "Imported.md", size: 100, text: async () => "Owned incoming text" }), true);
    assert.equal(h.sandbox.currentPaper.title, "Imported.md");
  } finally { await f.close(); }
});

test("an empty reader accepts a direct import without attempting an empty save", async () => {
  const f = await fixture();
  try {
    const h = harness(f, { paperHash: null, blocks: [] }, { actualLoader: true });
    assert.equal(await h.queue.loadPaper({ paperHash: OTHER, title: "Incoming", blocks }), true);
    assert.equal(h.calls.length, 0);
    assert.equal(h.sandbox.currentPaper.paperHash, OTHER);
  } finally { await f.close(); }
});

test("a stale direct import request cannot change or save the current paper", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper, { actualLoader: true });
    assert.equal(await h.queue.loadPaper({ paperHash: OTHER, title: "Incoming", blocks }, { loadRequestId: 0 }), false);
    assert.equal(h.sandbox.currentPaper, paper);
    assert.equal(h.calls.length, 0);
  } finally { await f.close(); }
});

for (const cached of [true, false]) {
  test(`the ${cached ? "cached" : "parsed"} PDF caller awaits a refused reader replacement`, async () => {
    const f = await fixture();
    try {
      const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
      const h = harness(f, paper, { actualLoader: true });
      const previousPdf = { name: "Previous.pdf" };
      h.sandbox.currentPdfFile = previousPdf;
      h.sandbox.currentPdfFileHash = HASH;
      if (cached) h.sandbox.parseCache = { paperHash: OTHER, revision: 2, generation: 1, blocks, parser: { kind: "mineru", pageCount: 1 } };
      h.rejectNext("/api/research/paper");
      await h.queue.parsePdfFile({ name: "Incoming.pdf", size: 100 });
      assert.equal(h.sandbox.currentPaper, paper);
      assert.equal(h.sandbox.currentPdfFile, previousPdf);
      assert.equal(h.sandbox.currentPdfFileHash, HASH);
      assert.equal(h.notifications.some(value => value.type === "success"), false);
      assert.equal(h.notice.hidden, false);
      if (!cached) assert.equal(h.sandbox.parseTaskUpdates.at(-1).state, "succeeded");
    } finally { await f.close(); }
  });
}

for (const view of ["paper", "library"]) {
  test(`selecting the current PDF from ${view} keeps local content instead of loading its stale cache`, async () => {
    const f = await fixture();
    try {
      const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks, parser: { kind: "mineru", pageCount: 1 } });
      const h = harness(f, paper, { actualLoader: true });
      h.sandbox.parseCache = structuredClone(paper);
      h.sandbox.fileHash = HASH;
      paper.title = "Current unsaved title";
      paper.isPdf = true;
      paper.translations = { b1: "Current translation draft" };
      h.sandbox.activeView = view;
      h.sandbox.activePaperHash = view === "paper" ? HASH : null;
      h.sandbox.progressState = { percent: 83, noteDraft: { note: "Current note draft" } };
      const file = { name: "Same.pdf", size: 100 };
      await h.queue.parsePdfFile(file);
      assert.equal(h.sandbox.currentPaper, paper);
      assert.equal(paper.title, "Current unsaved title");
      assert.equal(paper.translations.b1, "Current translation draft");
      assert.equal(h.sandbox.progressState.noteDraft.note, "Current note draft");
      assert.equal(h.sandbox.currentPdfFile, file);
      assert.equal(h.sandbox.currentPdfFileHash, HASH);
      assert.equal(h.sandbox.pdfFilesByHash.get(HASH), file);
      assert.equal(h.sandbox.activeView, "paper");
      assert.equal(h.sandbox.paperRevision, 1);
      assert.equal(h.calls.length, 0);
    } finally { await f.close(); }
  });
}

test("backup restoration uses the prepared target version rather than its old backup version", async () => {
  const f = await fixture();
  try {
    await f.workspace.upsertPaper({ paperHash: HASH, blocks, metadata: { title: "Backup content" } });
    const backup = f.workspace.exportBackup(HASH, { includeAssets: false });
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks, metadata: { title: "Edited after backup" } });
    paper.title = "Edited after backup";
    const h = harness(f, paper, { actualLoader: true });
    await h.queue.restoreResearchBackup({ size: 100, text: async () => JSON.stringify(backup) });
    assert.equal(f.workspace.getPaper(HASH).metadata.title, "Backup content");
    const request = h.calls.find(call => call.route === "/api/research/restore");
    assert.equal(request.body.expectedRevision, paper.revision);
    assert.equal(h.sandbox.currentPaper.title, "Backup content");
  } finally { await f.close(); }
});

test("backup restoration retains a new draft typed while its committed response is waiting", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks, metadata: { title: "Backup content" } });
    const backup = f.workspace.exportBackup(HASH, { includeAssets: false });
    // The pre-fix path would otherwise fail on the backup's old version before
    // reaching its independent, unsafe response-replacement path.
    backup.expectedRevision = paper.revision + 1;
    const h = harness(f, paper, { actualLoader: true }), gate = h.holdNext("/api/research/restore");
    const restoring = h.queue.restoreResearchBackup({ size: 100, text: async () => JSON.stringify(backup) });
    await gate.ready;
    paper.title = "New draft during restore";
    h.sandbox.researchStateRevision++;
    h.sandbox.progressState = { noteDraft: { note: "New note during restore" } };
    gate.release();
    await restoring;
    assert.equal(h.sandbox.currentPaper, paper);
    assert.equal(paper.title, "New draft during restore");
    assert.equal(h.sandbox.progressState.noteDraft.note, "New note during restore");
    assert.equal(f.workspace.getPaper(HASH).metadata.title, "Backup content");
    assert.equal(h.notifications.some(value => value.type === "success"), false);
    assert.equal(h.sandbox.paperSyncBlocked.has(HASH), true);
  } finally { await f.close(); }
});

for (const change of ["content", "progress"]) {
  test(`mutation preparation refuses a ${change} edit made during its save`, async () => {
    const f = await fixture();
    try {
      const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
      const h = harness(f, paper, { actualLoader: true }), gate = h.holdNext("/api/research/paper");
      const preparing = h.queue.preparePaperDataMutation(HASH, "Owned cleanup");
      const rejected = assert.rejects(preparing, /已变化/);
      await gate.ready;
      if (change === "content") { paper.title = "New preparation draft"; h.sandbox.researchStateRevision++; }
      else h.sandbox.progressState = { noteDraft: { note: "Preparation note" } };
      gate.release();
      await rejected;
      assert.equal(h.sandbox.currentPaper, paper);
      assert.equal(h.sandbox.paperMutationContexts.size, 0);
      assert.equal(h.sandbox.paperSyncBlocked.has(HASH), false);
      assert.equal(h.calls.some(call => call.route === "/api/research/cleanup"), false);
    } finally { await f.close(); }
  });
}

test("a second mutation cannot release another mutation's preparation", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper, { actualLoader: true }), gate = h.holdNext("/api/research/paper");
    const preparing = h.queue.preparePaperDataMutation(HASH);
    await gate.ready;
    const firstContext = h.sandbox.paperMutationContexts.get(HASH);
    const rejected = assert.rejects(h.queue.preparePaperDataMutation(HASH), /尚未完成/);
    assert.equal(h.queue.releasePaperDataMutation(HASH, true, {}), false);
    gate.release();
    await rejected;
    assert.equal(await preparing, firstContext);
    assert.equal(h.sandbox.paperSyncBlocked.has(HASH), true);
    assert.equal(h.queue.releasePaperDataMutation(HASH, false, firstContext), true);
    assert.equal(h.sandbox.paperMutationContexts.size, 0);
    assert.equal(h.sandbox.paperSyncBlocked.has(HASH), false);
  } finally { await f.close(); }
});

for (const change of ["content", "progress", "detached-structure"]) {
  test(`a committed cleanup retains a subsequent local ${change} edit`, async () => {
    const f = await fixture();
    try {
      const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
      const h = harness(f, paper, { actualLoader: true });
      const context = await h.queue.preparePaperDataMutation(HASH);
      const action = change === "detached-structure" ? "structure-keep-notes" : "ai-translations";
      const response = await h.sandbox.pluginApiFetch("/api/research/cleanup", { method: "POST", body: JSON.stringify({ paperHash: HASH, action, expectedRevision: context.expectedRevision }) });
      const data = await response.json();
      assert.equal(response.ok, true);
      if (change === "progress") h.sandbox.progressState = { noteDraft: { note: "Cleanup note" } };
      else { paper.title = "New cleanup draft"; h.sandbox.researchStateRevision++; }
      assert.equal(await h.queue.applyPreparedPaperMutation({ ...data.result, action, mutationContext: context }), false);
      h.queue.releasePaperDataMutation(HASH, true, context);
      assert.equal(h.sandbox.currentPaper, paper);
      assert.equal(h.sandbox.paperMutationContexts.size, 0);
      assert.equal(h.sandbox.paperSyncBlocked.has(HASH), true);
      assert.equal(h.notice.hidden, false);
      const callCount = h.calls.length;
      assert.equal(await h.queue.ensureResearchPaper({ paperHash: HASH }), null);
      assert.equal(h.calls.length, callCount);
      assert.equal(await h.queue.closePaperTab(HASH), true);
      assert.equal(h.sandbox.currentPaper.paperHash, null);
    } finally { await f.close(); }
  });
}

test("a late cleanup finalizer cannot unblock a newer prepared mutation", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper, { actualLoader: true });
    const first = await h.queue.preparePaperDataMutation(HASH);
    const result = await f.workspace.clearPaperData(HASH, "ai-translations", { expectedRevision: first.expectedRevision });
    assert.equal(await h.queue.applyPreparedPaperMutation({ ...result, action: "ai-translations", mutationContext: first }), true);
    const second = await h.queue.preparePaperDataMutation(HASH);
    assert.equal(h.queue.releasePaperDataMutation(HASH, true, first), false);
    assert.equal(h.sandbox.paperMutationContexts.get(HASH), second);
    assert.equal(h.sandbox.paperSyncBlocked.has(HASH), true);
    h.queue.releasePaperDataMutation(HASH, false, second);
  } finally { await f.close(); }
});

test("a prepared target version still rejects an intervening server update", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper, { actualLoader: true });
    const context = await h.queue.preparePaperDataMutation(HASH);
    await f.workspace.upsertPaper({ paperHash: HASH, blocks, metadata: { title: "Competing server edit" } });
    const response = await h.sandbox.pluginApiFetch("/api/research/cleanup", { method: "POST", body: JSON.stringify({ paperHash: HASH, action: "ai-translations", expectedRevision: context.expectedRevision }) });
    assert.equal(response.status, 409);
    assert.equal(f.workspace.getPaper(HASH).metadata.title, "Competing server edit");
    h.queue.releasePaperDataMutation(HASH, false, context);
  } finally { await f.close(); }
});

test("restoring a missing different paper uses expectedRevision zero and saves the visible paper", async () => {
  const f = await fixture();
  try {
    await f.workspace.upsertPaper({ paperHash: OTHER, blocks, metadata: { title: "Restored other paper" } });
    const backup = f.workspace.exportBackup(OTHER, { includeAssets: false });
    await f.workspace.removePaper(OTHER);
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    paper.title = "Visible saved before switching";
    const h = harness(f, paper, { actualLoader: true });
    assert.equal(await h.queue.restoreResearchBackup({ size: 100, text: async () => JSON.stringify(backup) }), true);
    assert.equal(h.calls.find(call => call.route === "/api/research/restore").body.expectedRevision, 0);
    assert.equal(f.workspace.getPaper(HASH).metadata.title, paper.title);
    assert.equal(h.sandbox.currentPaper.paperHash, OTHER);
  } finally { await f.close(); }
});

test("a restore response cannot replace a different paper opened while waiting", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const backup = f.workspace.exportBackup(HASH, { includeAssets: false });
    const h = harness(f, paper, { actualLoader: true }), gate = h.holdNext("/api/research/restore");
    const restoring = h.queue.restoreResearchBackup({ size: 100, text: async () => JSON.stringify(backup) });
    await gate.ready;
    await h.queue.loadPaper({ paperHash: OTHER, blocks, title: "New current paper" }, { skipPreviousFlush: true });
    gate.release();
    assert.equal(await restoring, false);
    assert.equal(h.sandbox.currentPaper.paperHash, OTHER);
    assert.equal(h.notice.hidden, true);
    assert.equal(h.sandbox.paperMutationContexts.size, 0);
    assert.equal(h.sandbox.paperSyncBlocked.has(OTHER), false);
  } finally { await f.close(); }
});

test("deletion retains a new visible draft without recreating the deleted paper", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper, { actualLoader: true });
    const gate = h.holdNext(`/api/research/paper?paperHash=${HASH}&expectedRevision=${paper.revision + 1}`);
    const deleting = h.queue.deletePaperRecord(HASH);
    await gate.ready;
    paper.title = "New local draft during deletion";
    h.sandbox.researchStateRevision++;
    gate.release();
    assert.equal((await deleting).readerRetained, true);
    assert.equal(f.workspace.getPaper(HASH), null);
    assert.equal(h.sandbox.currentPaper, paper);
    assert.equal(h.sandbox.deletedPaperHashes.has(HASH), true);
    assert.equal(h.sandbox.paperMutationContexts.size, 0);
    assert.equal(h.sandbox.paperSyncBlocked.has(HASH), true);
    assert.equal(await h.queue.ensureResearchPaper({ paperHash: HASH }), null);
    assert.equal(await h.queue.closePaperTab(HASH), true);
    assert.equal(f.workspace.getPaper(HASH), null);
  } finally { await f.close(); }
});

test("ordinary deletion completes its preparation and removes the reader", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper, { actualLoader: true });
    const result = await h.queue.deletePaperRecord(HASH);
    assert.equal(result.deleted, true);
    assert.equal(result.readerRetained, false);
    assert.equal(f.workspace.getPaper(HASH), null);
    assert.equal(h.sandbox.currentPaper.paperHash, null);
    assert.equal(h.sandbox.paperMutationContexts.size, 0);
    assert.equal(h.sandbox.paperSyncBlocked.has(HASH), false);
  } finally { await f.close(); }
});

for (const route of ["paper", "progress"]) {
  test(`forced reparse stops before parsing if the previous ${route} save fails`, async () => {
    const f = await fixture();
    try {
      const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
      const h = harness(f, paper, { actualLoader: true });
      h.sandbox.fileHash = HASH;
      h.rejectNext(`/api/research/${route}`);
      assert.equal(await h.queue.parsePdfFile({ name: "Same.pdf", size: 100 }, { force: true }), false);
      assert.equal(h.sandbox.currentPaper, paper);
      assert.equal(h.sandbox.parseTasksCreated, 0);
      assert.equal(h.calls.some(call => call.syntheticParser), false);
      assert.equal(h.notice.hidden, false);
    } finally { await f.close(); }
  });
}

for (const change of ["content", "progress"]) {
  test(`forced reparse stops when ${change} changes during its preparation`, async () => {
    const f = await fixture();
    try {
      const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
      const h = harness(f, paper, { actualLoader: true }), gate = h.holdNext("/api/research/paper");
      h.sandbox.fileHash = HASH;
      const parsing = h.queue.parsePdfFile({ name: "Same.pdf", size: 100 }, { force: true });
      await gate.ready;
      if (change === "content") { paper.title = "New reparse preparation draft"; h.sandbox.researchStateRevision++; }
      else h.sandbox.progressState = { noteDraft: { note: "New reparse preparation note" } };
      gate.release();
      assert.equal(await parsing, false);
      assert.equal(h.sandbox.currentPaper, paper);
      assert.equal(h.sandbox.parseTasksCreated, 0);
      assert.equal(h.calls.some(call => call.syntheticParser), false);
    } finally { await f.close(); }
  });

  test(`a committed reparse retains a subsequent ${change} edit and completes its task`, async () => {
    const f = await fixture();
    try {
      const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
      const h = harness(f, paper, { actualLoader: true }), gate = h.holdNext("parser");
      h.sandbox.fileHash = HASH;
      const parsing = h.queue.parsePdfFile({ name: "Same.pdf", size: 100 }, { force: true });
      await gate.ready;
      if (change === "content") { paper.title = "New reparse draft"; h.sandbox.researchStateRevision++; }
      else h.sandbox.progressState = { noteDraft: { note: "New reparse note" } };
      gate.release();
      assert.equal(await parsing, false);
      assert.equal(h.sandbox.currentPaper, paper);
      assert.equal(h.sandbox.parseTaskUpdates.at(-1).state, "succeeded");
      assert.equal(h.sandbox.activeParseTask, null);
      assert.equal(h.sandbox.paperSyncBlocked.has(HASH), true);
      assert.equal(h.notifications.some(value => value.type === "success"), false);
      assert.equal(f.workspace.getPaper(HASH).metadata.title, "Same.pdf");
      assert.equal(await h.queue.ensureResearchPaper({ paperHash: HASH }), null);
    } finally { await f.close(); }
  });
}

test("an unchanged forced reparse saves first and loads its committed version", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper, { actualLoader: true });
    h.sandbox.fileHash = HASH;
    await h.queue.parsePdfFile({ name: "Same.pdf", size: 100 }, { force: true });
    assert.notEqual(h.sandbox.currentPaper, paper);
    assert.equal(h.sandbox.currentPaper.paperHash, HASH);
    assert.equal(h.sandbox.currentPaper.revision, f.workspace.getPaper(HASH).revision);
    assert.equal(h.sandbox.currentPaper.generation, f.workspace.getPaper(HASH).generation);
    assert.equal(h.sandbox.parseTasksCreated, 1);
    assert.equal(h.sandbox.parseTaskUpdates.at(-1).state, "succeeded");
    assert.equal(h.notifications.some(value => value.type === "success"), true);
    assert.equal(h.sandbox.paperSyncBlocked.has(HASH), false);
  } finally { await f.close(); }
});

const researchToolsSource = fs.readFileSync(new URL("../ui/assets/research-tools.js", import.meta.url), "utf8");
function uiMutationHarness(kind, cancelAfterPrepare) {
  const requests = [], finished = [], notifications = [], received = [];
  const context = { expectedRevision: 17 };
  let current = true;
  const backup = { paperHash: HASH, paper: { paperHash: HASH, revision: 2 } };
  const sandbox = vm.createContext({
    JSON, String, Number, encodeURIComponent, paperDeletionRevision, paperDeletionNotice,
    hash: HASH, token: 1, endpoints: { cleanup: "/cleanup", restore: "/restore", paper: "/paper" },
    restoreInput: { files: [{ size: 100, text: async () => JSON.stringify(backup) }], value: "" },
    restore: { disabled: false }, removeAll: { disabled: false },
    confirmAction: async () => true, isCurrentRender: () => current,
    getPaper: () => ({ paperHash: OTHER, revision: 888 }),
    options: {
      onBeforePaperMutation: async () => { if (cancelAfterPrepare) current = false; return context; },
      onBeforePaperDeleted: async () => { if (cancelAfterPrepare) current = false; return context; },
      onPaperDataChanged: async data => { received.push(data); return false; },
      onPaperDeleted: async data => { received.push(data); return false; },
      onPaperMutationFinished: async data => { finished.push(data); },
      onPaperDeletionFinished: async data => { finished.push(data); },
      onPaperDeletionFailed: async () => { throw new Error("An ordinary completion must not call the failure callback"); },
    },
    call: async (route, init) => { requests.push({ route, init }); return { result: { paperHash: HASH }, paper: { paperHash: HASH }, deleted: true }; },
    notify: (...args) => notifications.push(args), render: () => { throw new Error("A retained draft must not be reset by render"); },
    addListener: (_element, _event, handler) => { sandbox.handler = handler; },
  });
  const startText = kind === "cleanup" ? "const runCleanup = async (" : kind === "restore"
    ? 'addListener(restoreInput, "change", async () => {' : 'addListener(removeAll, "click", async () => {';
  const endText = kind === "cleanup" ? "const operations =" : kind === "restore" ? "backupActions.append" : "operations.append";
  const start = researchToolsSource.indexOf(startText), end = researchToolsSource.indexOf(endText, start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(researchToolsSource.slice(start, end) + (kind === "cleanup" ? '\nglobalThis.handler = () => runCleanup("ai-translations", "Owned confirmation");' : ""), sandbox);
  return { sandbox, requests, finished, notifications, received, context };
}

for (const kind of ["cleanup", "restore", "delete"]) {
  test(`the actual research ${kind} handler passes its prepared version and retains a refused refresh`, async () => {
    const h = uiMutationHarness(kind, false);
    await h.sandbox.handler();
    assert.equal(h.requests.length, 1);
    if (kind === "delete") assert.match(h.requests[0].route, /expectedRevision=17/);
    else assert.equal(JSON.parse(h.requests[0].init.body).expectedRevision, 17);
    assert.equal(h.received[0].mutationContext, h.context);
    assert.equal(h.finished[0].mutationContext, h.context);
    assert.equal(h.notifications.length, 0);
  });
  test(`the actual research ${kind} handler cancels before writing after its view changes`, async () => {
    const h = uiMutationHarness(kind, true);
    await h.sandbox.handler();
    assert.equal(h.requests.length, 0);
    assert.equal(h.finished[0].mutationContext, h.context);
    assert.equal(h.notifications.length, 0);
  });
}

test("an unchanged structure cleanup loads its detached research record and releases the mutation", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper, { actualLoader: true });
    const context = await h.queue.preparePaperDataMutation(HASH);
    const result = await f.workspace.clearPaperData(HASH, "structure-keep-notes", { expectedRevision: context.expectedRevision });
    assert.equal(await h.queue.applyPreparedPaperMutation({ ...result, action: "structure-keep-notes", mutationContext: context }), true);
    assert.equal(h.sandbox.currentPaper.structureDetached, true);
    assert.equal(h.sandbox.currentPaper.blocks.length, 0);
    assert.equal(h.sandbox.activePaperHash, HASH);
    assert.equal(h.sandbox.paperSyncBlocked.has(HASH), false);
    assert.equal(h.sandbox.paperMutationContexts.size, 0);
    assert.equal(h.sandbox.controls.get("reading-mode-control").style.display, "none");
    assert.equal(h.sandbox.controls.get("btn-research-tools").style.display, "inline-flex");
  } finally { await f.close(); }
});

test("mutation preparation cannot take a version from a response after the paper has changed", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper, { actualLoader: true });
    const gate = h.holdNext(`/api/research/paper?paperHash=${HASH}`);
    const preparing = h.queue.preparePaperDataMutation(HASH);
    const rejected = assert.rejects(preparing, /页面或内容已变化/);
    await gate.ready;
    await h.queue.loadPaper({ paperHash: OTHER, blocks, title: "Different context" }, { skipPreviousFlush: true });
    gate.release();
    await rejected;
    assert.equal(h.sandbox.currentPaper.paperHash, OTHER);
    assert.equal(h.sandbox.paperMutationContexts.size, 0);
    assert.equal(h.sandbox.paperSyncBlocked.has(HASH), false);
    assert.equal(h.sandbox.paperSyncBlocked.has(OTHER), false);
    assert.equal(h.calls.some(call => call.method === "DELETE"), false);
  } finally { await f.close(); }
});

test("tab close cannot discard a new draft while a data mutation is pending", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper, { actualLoader: true });
    const context = await h.queue.preparePaperDataMutation(HASH);
    h.sandbox.progressState = { noteDraft: { note: "Draft before a premature close" } };
    const calls = h.calls.length;
    assert.equal(await h.queue.closePaperTab(HASH), false);
    assert.equal(h.sandbox.currentPaper, paper);
    assert.equal(h.calls.length, calls);
    assert.equal(h.sandbox.paperMutationContexts.get(HASH), context);
    assert.equal(h.notice.hidden, false);
    h.queue.releasePaperDataMutation(HASH, false, context);
    assert.equal(await h.queue.closePaperTab(HASH), true);
    assert.equal(f.workspace.getProgress(HASH).noteDraft.note, "Draft before a premature close");
  } finally { await f.close(); }
});

test("a late reading-progress response cannot replace a newly typed note draft", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    await f.workspace.setProgress({ paperHash: HASH, noteDraft: { note: "Old persisted note", paperHash: HASH }, originalScrollTop: 180 });
    const h = harness(f, paper, { actualLoader: true, actualHydration: true });
    const gate = h.holdNext(`/api/research/progress?paperHash=${HASH}`);
    const restoring = h.queue.restorePaperProgress(HASH, 1, paper);
    await gate.ready;
    h.sandbox.progressState.noteDraft = { note: "New visible note", paperHash: HASH };
    gate.release();
    assert.equal(await restoring, false);
    assert.equal(h.sandbox.progressState.noteDraft.note, "New visible note");
    assert.equal(h.sandbox.panes.get("original-pane").scrollTop, 0);
  } finally { await f.close(); }
});

test("a late cache lookup cannot return a translation for a block now finalized locally", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    await f.workspace.putTranslation({ paperHash: HASH, blockId: "b1", glossaryVersion: 0,
      source: blocks[0].text, translation: "Old cached translation", promptVersion: "owned-v1", inputHash: HASH });
    const h = harness(f, paper, { actualLoader: true, actualHydration: true }), gate = h.holdNext("translation-cache");
    const reading = h.queue.cachedTranslationsForBlocks(paper.blocks, true);
    await gate.ready;
    assert.equal(h.queue.commitBlockTranslation("b1", "New user final", { kind: "final" }), true);
    gate.release();
    assert.equal((await reading).size, 0);
    assert.equal(paper.translations.b1, "New user final");
  } finally { await f.close(); }
});

async function seedOwnedCache(f, sourceBlocks = blocks) {
  for (const block of sourceBlocks) await f.workspace.putTranslation({ paperHash: HASH, blockId: block.id,
    glossaryVersion: 0, source: block.text, translation: `Cached: ${block.text}`,
    promptVersion: "owned-v1", inputHash: HASH });
}
function progressTimer(h) {
  const timer = h.timers.find(item => item.delay === 100);
  assert.ok(timer, "The actual reading-position restore must schedule its timer");
  return timer;
}

test("the actual progress builder persists a question draft and the actual restore reloads its evidence anchor", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper, { actualLoader: true, actualHydration: true });
    const draft = { paperHash: HASH, question: "Owned pending question", blockId: "b1", evidenceId: null };
    h.sandbox.progressState.evidenceDraft = draft;
    h.sandbox.activePane = null; h.sandbox.selectedResearchBlock = () => paper.blocks[0];
    h.sandbox.researchTools.uiState = () => h.sandbox.progressState;
    vm.runInContext(functionRange("function currentReadingProgress(", "function normalizedPaperHash("), h.sandbox);
    const snapshot = h.snapshot(paper, "Owned question progress"); snapshot.progress = h.sandbox.currentReadingProgress();
    assert.equal(await h.queue.flushPaperSnapshot(snapshot), true);
    assert.deepEqual(f.workspace.getProgress(HASH).evidenceDraft, draft);
    delete h.sandbox.progressState.evidenceDraft;
    assert.equal(await h.queue.restorePaperProgress(HASH, 1, paper), true);
    assert.deepEqual(JSON.parse(JSON.stringify(h.sandbox.progressState.evidenceDraft)), draft);
  } finally { await f.close(); }
});

test("a late progress response cannot replace a newly typed question draft", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    await f.workspace.setProgress({ paperHash: HASH, evidenceDraft: { paperHash: HASH, question: "Saved question", blockId: "b1" } });
    const h = harness(f, paper, { actualLoader: true, actualHydration: true }), gate = h.holdNext(`/api/research/progress?paperHash=${HASH}`);
    const restoring = h.queue.restorePaperProgress(HASH, 1, paper); await gate.ready;
    h.sandbox.progressState.evidenceDraft = { paperHash: HASH, question: "New unsaved question", blockId: "b1" };
    gate.release(); assert.equal(await restoring, false);
    assert.equal(h.sandbox.progressState.evidenceDraft.question, "New unsaved question");
  } finally { await f.close(); }
});

test("a delayed position restore yields to a newer question draft", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    await f.workspace.setProgress({ paperHash: HASH, originalScrollTop: 180, evidenceDraft: { paperHash: HASH, question: "Saved question", blockId: "b1" } });
    const h = harness(f, paper, { actualLoader: true, actualHydration: true });
    assert.equal(await h.queue.restorePaperProgress(HASH, 1, paper), true);
    h.sandbox.progressState.evidenceDraft = { paperHash: HASH, question: "New question", blockId: "b1" };
    progressTimer(h).callback(); assert.equal(h.sandbox.panes.get("original-pane").scrollTop, 0);
    assert.equal(h.sandbox.progressState.evidenceDraft.question, "New question");
  } finally { await f.close(); }
});

test("the actual progress builder persists a glossary draft and the actual restore reloads its condition", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper, { actualLoader: true, actualHydration: true });
    const draft = { paperHash: HASH, term: "Owned term", translation: "Pending translation", itemVersion: f.workspace.getGlossary(HASH).itemVersion };
    h.sandbox.progressState.glossaryDraft = draft;
    h.sandbox.activePane = null;
    h.sandbox.selectedResearchBlock = () => paper.blocks[0];
    h.sandbox.researchTools.uiState = () => h.sandbox.progressState;
    const start = panel.indexOf("function currentReadingProgress("), end = panel.indexOf("function normalizedPaperHash(", start);
    assert.ok(start >= 0 && end > start);
    vm.runInContext(panel.slice(start, end), h.sandbox);
    const snapshot = h.snapshot(paper, "Owned glossary progress");
    snapshot.progress = h.sandbox.currentReadingProgress();
    assert.equal(await h.queue.flushPaperSnapshot(snapshot), true);
    assert.deepEqual(f.workspace.getProgress(HASH).glossaryDraft, draft);
    delete h.sandbox.progressState.glossaryDraft;
    assert.equal(await h.queue.restorePaperProgress(HASH, 1, paper), true);
    assert.deepEqual(JSON.parse(JSON.stringify(h.sandbox.progressState.glossaryDraft)), draft);
  } finally { await f.close(); }
});

test("a late progress response cannot replace a newly typed glossary draft", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    await f.workspace.setProgress({ paperHash: HASH, glossaryDraft: { paperHash: HASH, term: "Saved term", translation: "Saved" } });
    const h = harness(f, paper, { actualLoader: true, actualHydration: true });
    const gate = h.holdNext(`/api/research/progress?paperHash=${HASH}`);
    const restoring = h.queue.restorePaperProgress(HASH, 1, paper); await gate.ready;
    h.sandbox.progressState.glossaryDraft = { paperHash: HASH, term: "New term", translation: "New unsaved" };
    gate.release(); assert.equal(await restoring, false);
    assert.equal(h.sandbox.progressState.glossaryDraft.translation, "New unsaved");
  } finally { await f.close(); }
});

test("a delayed position restore yields to a newer glossary draft", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    await f.workspace.setProgress({ paperHash: HASH, originalScrollTop: 180, glossaryDraft: { paperHash: HASH, term: "Saved", translation: "Saved" } });
    const h = harness(f, paper, { actualLoader: true, actualHydration: true });
    assert.equal(await h.queue.restorePaperProgress(HASH, 1, paper), true);
    h.sandbox.progressState.glossaryDraft = { paperHash: HASH, term: "New", translation: "Keep" };
    progressTimer(h).callback();
    assert.equal(h.sandbox.panes.get("original-pane").scrollTop, 0);
    assert.equal(h.sandbox.progressState.glossaryDraft.translation, "Keep");
  } finally { await f.close(); }
});

test("an unchanged reading-progress response restores its draft, mode and delayed position", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    await f.workspace.setProgress({ paperHash: HASH, readingMode: "original", blockId: "b1",
      noteDraft: { note: "Saved note", paperHash: HASH }, searchState: { query: "Owned" },
      originalScrollTop: 180, translationScrollTop: 40, contrastScrollTop: 70 });
    const h = harness(f, paper, { actualLoader: true, actualHydration: true });
    assert.equal(await h.queue.restorePaperProgress(HASH, 1, paper), true);
    assert.equal(h.sandbox.progressState.noteDraft.note, "Saved note");
    assert.equal(h.sandbox.currentReadingMode, "original");
    assert.equal(h.sandbox.selectedBlockId, "b1");
    assert.equal(h.sandbox.panes.get("original-pane").scrollTop, 0);
    progressTimer(h).callback();
    assert.equal(h.sandbox.panes.get("original-pane").scrollTop, 180);
    assert.equal(h.sandbox.panes.get("trans-pane").scrollTop, 40);
    assert.equal(h.sandbox.panes.get("contrast-pane").scrollTop, 70);
    assert.equal(h.sandbox.highlighted, "Owned");
    assert.equal(h.sandbox.capturedViews, 1);
  } finally { await f.close(); }
});

for (const change of ["draft", "mode", "scroll"]) {
  test(`a delayed position restore yields to a newer ${change} operation`, async () => {
    const f = await fixture();
    try {
      const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
      paper.restored = true;
      await f.workspace.setProgress({ paperHash: HASH, noteDraft: { note: "Saved note" },
        originalScrollTop: 180, searchState: { query: "Old query" } });
      const h = harness(f, paper, { actualLoader: true, actualHydration: true });
      assert.equal(await h.queue.restorePaperProgress(HASH, 1, paper), true);
      if (change === "draft") h.sandbox.progressState.noteDraft = { note: "New typed note" };
      if (change === "mode") h.sandbox.currentReadingMode = "contrast";
      if (change === "scroll") h.sandbox.panes.get("original-pane").scrollTop = 25;
      progressTimer(h).callback();
      assert.equal(h.sandbox.panes.get("original-pane").scrollTop, change === "scroll" ? 25 : 0);
      assert.equal(h.sandbox.highlighted, undefined);
      assert.equal(h.notifications.length, 0);
    } finally { await f.close(); }
  });
}

test("a progress response for another paper is rejected before restoring its draft", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    await f.workspace.setProgress({ paperHash: HASH, noteDraft: { note: "Wrong response" } });
    const h = harness(f, paper, { actualLoader: true, actualHydration: true });
    h.transformResponse(value => value.progress ? { ...value, progress: { ...value.progress, paperHash: OTHER } } : value);
    assert.equal(await h.queue.restorePaperProgress(HASH, 1, paper), false);
    assert.equal(h.sandbox.progressState.noteDraft, undefined);
    assert.equal(h.timers.some(item => item.delay === 100), false);
  } finally { await f.close(); }
});

test("an older position timer cannot run after a newer restore with the same draft", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    await f.workspace.setProgress({ paperHash: HASH, originalScrollTop: 180 });
    const h = harness(f, paper, { actualLoader: true, actualHydration: true });
    await h.queue.restorePaperProgress(HASH, 1, paper);
    const oldTimer = progressTimer(h);
    await f.workspace.setProgress({ paperHash: HASH, originalScrollTop: 290 });
    await h.queue.restorePaperProgress(HASH, 1, paper);
    oldTimer.callback();
    assert.equal(h.sandbox.panes.get("original-pane").scrollTop, 0);
    h.timers.filter(item => item.delay === 100).at(-1).callback();
    assert.equal(h.sandbox.panes.get("original-pane").scrollTop, 290);
  } finally { await f.close(); }
});

for (const change of ["scroll", "new restore"]) {
  test(`a queued local snapshot frame yields to a ${change}`, async () => {
    const f = await fixture();
    try {
      const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
      const h = harness(f, paper, { actualLoader: true, actualHydration: true });
      h.queue.restorePaperProgressInView({ originalScrollTop: 180 }, HASH, 1, paper);
      const oldFrame = h.timers.find(item => item.delay === "animation-frame");
      if (change === "scroll") h.sandbox.panes.get("original-pane").scrollTop = 25;
      else h.queue.restorePaperProgressInView({ originalScrollTop: 290 }, HASH, 1, paper);
      assert.equal(oldFrame.callback(), false);
      if (change === "new restore") h.timers.at(-1).callback();
      assert.equal(h.sandbox.panes.get("original-pane").scrollTop, change === "scroll" ? 25 : 290);
    } finally { await f.close(); }
  });
}

test("the actual load hydration preserves a note typed while its initial paper save is delayed", async () => {
  const f = await fixture();
  let gate;
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    await f.workspace.setProgress({ paperHash: HASH, noteDraft: { note: "Old persisted note" }, originalScrollTop: 180 });
    const h = harness(f, { blocks: [], paperHash: null }, { actualLoader: true, actualHydration: true });
    gate = h.holdNext("/api/research/paper");
    assert.equal(await h.queue.loadPaper(paper), true);
    await gate.ready;
    h.sandbox.progressState.noteDraft = { note: "Typed during hydration" };
    gate.release();
    assert.equal(await h.sandbox.hydration, true);
    assert.equal(h.sandbox.progressState.noteDraft.note, "Typed during hydration");
    assert.equal(h.calls.some(call => call.route.startsWith("/api/research/progress?")), false);
    assert.equal(h.sandbox.panes.get("original-pane").scrollTop, 0);
  } finally { gate?.release(); await f.close(); }
});

test("the actual unchanged load hydration restores progress and fills its matching cache", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    await seedOwnedCache(f);
    await f.workspace.setProgress({ paperHash: HASH, noteDraft: { note: "Saved hydrated note" }, originalScrollTop: 180 });
    const h = harness(f, { blocks: [], paperHash: null }, { actualLoader: true, actualHydration: true });
    assert.equal(await h.queue.loadPaper(paper), true);
    assert.equal(await h.sandbox.hydration, true);
    assert.equal(h.sandbox.currentPaper.translations.b1, `Cached: ${blocks[0].text}`);
    assert.equal(h.sandbox.progressState.noteDraft.note, "Saved hydrated note");
    progressTimer(h).callback();
    assert.equal(h.sandbox.panes.get("original-pane").scrollTop, 180);
    assert.equal(h.sandbox.paperLoadingHash, null);
  } finally { await f.close(); }
});

for (const change of ["ai translation", "single run", "full run", "source text"]) {
  test(`a late cache response yields to a newer ${change}`, async () => {
    const f = await fixture();
    let gate;
    try {
      const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
      await seedOwnedCache(f);
      const h = harness(f, paper, { actualLoader: true, actualHydration: true });
      gate = h.holdNext("translation-cache");
      const reading = h.queue.cachedTranslationsForBlocks(paper.blocks, true);
      await gate.ready;
      if (change === "ai translation") h.queue.commitBlockTranslation("b1", "New AI result");
      if (change === "single run") h.sandbox.blockTranslationRunIds.set("b1", 1);
      if (change === "full run") h.sandbox.fullTranslationRunId++;
      if (change === "source text") paper.blocks[0].text = "Changed source";
      gate.release();
      assert.equal((await reading).size, 0);
      if (change === "ai translation") assert.equal(paper.translations.b1, "New AI result");
    } finally { gate?.release(); await f.close(); }
  });
}

test("a late cache response from a previous glossary version is discarded", async () => {
  const f = await fixture();
  let gate;
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    await seedOwnedCache(f);
    const h = harness(f, paper, { actualLoader: true, actualHydration: true });
    gate = h.holdNext("translation-cache");
    const reading = h.queue.cachedTranslationsForBlocks(paper.blocks, true);
    await gate.ready;
    h.queue.applyGlossaryRecord({ version: 1, terms: { Owned: "New term" } });
    gate.release();
    assert.equal((await reading).size, 0);
    assert.equal(paper.glossaryVersion, 1);
  } finally { gate?.release(); await f.close(); }
});

test("actual load hydration retains a finalized block and still fills an unchanged second block", async () => {
  const f = await fixture();
  let gate;
  try {
    const sourceBlocks = [...blocks, { id: "b2", page: 1, type: "paragraph", text: "Second owned block" }];
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks: sourceBlocks });
    await seedOwnedCache(f, sourceBlocks);
    const h = harness(f, { blocks: [], paperHash: null }, { actualLoader: true, actualHydration: true });
    gate = h.holdNext("translation-cache");
    await h.queue.loadPaper(paper);
    await gate.ready;
    h.queue.commitBlockTranslation("b1", "User finalized first block", { kind: "final" });
    gate.release();
    assert.equal(await h.sandbox.hydration, true);
    assert.equal(h.sandbox.currentPaper.translations.b1, "User finalized first block");
    assert.equal(h.sandbox.currentPaper.translationStates.b1.kind, "final");
    assert.equal(h.sandbox.currentPaper.translations.b2, "Cached: Second owned block");
  } finally { gate?.release(); await f.close(); }
});

test("actual load hydration does not redraw when every cached block was finalized during lookup", async () => {
  const f = await fixture();
  let gate;
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    await seedOwnedCache(f);
    const h = harness(f, { blocks: [], paperHash: null }, { actualLoader: true, actualHydration: true });
    gate = h.holdNext("translation-cache");
    await h.queue.loadPaper(paper);
    await gate.ready;
    h.queue.commitBlockTranslation("b1", "Final during hydration", { kind: "final" });
    const rendered = h.sandbox.renderCount, scheduled = h.sandbox.scheduled;
    gate.release();
    assert.equal(await h.sandbox.hydration, true);
    assert.equal(h.sandbox.renderCount, rendered);
    assert.equal(h.sandbox.scheduled, scheduled);
    assert.equal(h.sandbox.currentPaper.translations.b1, "Final during hydration");
  } finally { gate?.release(); await f.close(); }
});

test("AI commits preserve user final text while another manual final edit remains allowed", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper, { actualLoader: true, actualHydration: true });
    assert.equal(h.queue.commitBlockTranslation("b1", "First final", { kind: "final" }), true);
    assert.equal(h.queue.commitBlockTranslation("b1", "Late AI"), false);
    assert.equal(paper.translations.b1, "First final");
    assert.equal(h.queue.commitBlockTranslation("b1", "Revised final", { kind: "final" }), true);
    assert.equal(paper.translations.b1, "Revised final");
  } finally { await f.close(); }
});

test("an AI commit carrying an obsolete glossary version cannot change local content", async () => {
  const f = await fixture();
  try {
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
    const h = harness(f, paper, { actualLoader: true, actualHydration: true });
    h.queue.applyGlossaryRecord({ version: 1, terms: { Owned: "Term" } });
    assert.equal(h.queue.commitBlockTranslation("b1", "Obsolete AI", { glossaryVersion: 0 }), false);
    assert.equal(paper.translations.b1, undefined);
  } finally { await f.close(); }
});

for (const failure of [false, true]) {
  test(`an actual single translation ${failure ? "failure" : "result"} cannot replace a final edit made while waiting`, async () => {
    const f = await fixture();
    let gate;
    try {
      const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
      const h = harness(f, paper, { actualLoader: true, actualHydration: true });
      gate = h.holdNext("model");
      const translating = h.queue.translateSingleBlock("b1");
      await gate.ready;
      h.queue.commitBlockTranslation("b1", "Final while model waits", { kind: "final" });
      h.sandbox.failModel = failure;
      gate.release();
      await translating;
      assert.equal(paper.translations.b1, "Final while model waits");
      assert.equal(paper.translationStates.b1.kind, "final");
      assert.equal(h.sandbox.placeholders.some(item => item.error), false);
      assert.equal(h.calls.some(call => call.route === "/api/research/translation-cache" && call.method === "POST"), false);
    } finally { gate?.release(); await f.close(); }
  });
}

for (const failure of [false, true]) {
  test(`an actual full translation ${failure ? "failure" : "batch"} retains a new final edit and finishes its other block`, async () => {
    const f = await fixture();
    let gate;
    try {
      const sourceBlocks = [...blocks, { id: "b2", page: 1, type: "paragraph", text: "Second owned block" }];
      const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks: sourceBlocks });
      const h = harness(f, paper, { actualLoader: true, actualHydration: true });
      gate = h.holdNext("model");
      const translating = h.queue.startFullTranslation();
      await gate.ready;
      h.queue.commitBlockTranslation("b1", "Final in batch", { kind: "final" });
      h.sandbox.failModel = failure;
      gate.release();
      await translating;
      assert.equal(paper.translations.b1, "Final in batch");
      assert.equal(paper.translationStates.b1.kind, "final");
      assert.equal(h.sandbox.placeholders.some(item => item.id === "b1" && item.error), false);
      const cached = h.calls.filter(call => call.route === "/api/research/translation-cache" && call.method === "POST");
      if (failure) {
        assert.equal(paper.translations.b2, undefined);
        assert.equal(h.sandbox.placeholders.filter(item => item.error).length, 1);
        assert.equal(h.sandbox.controls.get("btn-translate-all").textContent, "重试未完成段落 (1)");
        assert.equal(cached.length, 0);
      } else {
        assert.equal(paper.translations.b2, "AI: Second owned block");
        assert.deepEqual(cached.map(call => call.body.blockId), ["b2"]);
      }
      assert.equal(h.sandbox.fullTranslationBusy, false);
      assert.equal(h.sandbox.controls.get("btn-translate-all").disabled, false);
    } finally { gate?.release(); await f.close(); }
  });
}

for (const kind of ["single", "full"]) {
  test(`an actual ${kind} translation discards a result produced with a superseded glossary`, async () => {
    const f = await fixture();
    let gate;
    try {
      const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks });
      const h = harness(f, paper, { actualLoader: true, actualHydration: true });
      gate = h.holdNext("model");
      const translating = kind === "single" ? h.queue.translateSingleBlock("b1") : h.queue.startFullTranslation();
      await gate.ready;
      h.queue.applyGlossaryRecord({ version: 1, terms: { Owned: "New term" } });
      gate.release();
      await translating;
      assert.equal(paper.translations.b1, undefined);
      assert.equal(h.calls.some(call => call.route === "/api/research/translation-cache" && call.method === "POST"), false);
      assert.equal(h.sandbox.placeholders.some(item => item.error), false);
      assert.equal(h.sandbox.fullTranslationBusy, false);
      if (kind === "full") assert.equal(h.sandbox.controls.get("btn-translate-all").disabled, false);
    } finally { gate?.release(); await f.close(); }
  });
}

