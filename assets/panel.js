const PROTOCOL = "hana.plugin.ui";
const VERSION = 1;
const UI_VERSION = "0.9.0";
const UI_ASSET_CACHE_VERSION = "0.9.0-r1";
const MAX_PDF_BYTES = 50 * 1024 * 1024;
let seq = 0;

function targetOrigin() {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get("hana-host-origin");
  let referrerOrigin = null;
  try { referrerOrigin = new URL(document.referrer).origin; } catch {}
  if (explicit && (explicit === referrerOrigin || explicit === window.location.origin)) return explicit;
  return referrerOrigin || window.location.origin;
}

function post(message) {
  window.parent.postMessage(message, targetOrigin());
}

function event(type, payload) {
  post({ protocol: PROTOCOL, version: VERSION, kind: "event", type, payload });
}

function request(type, payload, timeoutMs = 10000) {
  const id = `hana-plugin-${Date.now()}-${++seq}`;
  const origin = targetOrigin();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error(`Host request timed out: ${type}`));
    }, timeoutMs);

    function onMessage(evt) {
      if (evt.source !== window.parent) return;
      if (origin !== "*" && evt.origin !== origin) return;
      const msg = evt.data || {};
      if (msg.protocol !== PROTOCOL || msg.version !== VERSION || msg.id !== id || msg.type !== type) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (msg.kind === "error") reject(new Error(msg.error?.message || `Host request failed: ${type}`));
      else resolve(msg.payload);
    }

    window.addEventListener("message", onMessage);
    post({ protocol: PROTOCOL, version: VERSION, id, kind: "request", type, payload });
  });
}

function pluginApiUrl(path, { withSurfaceSession = false } = {}) {
  const cleanPath = String(path || "").replace(/^\/+/, "");
  if (window.hana?.api?.url) {
    try {
      const resolved = new URL(window.hana.api.url(cleanPath), window.location.href);
      if (withSurfaceSession) {
        const surfaceSession = new URLSearchParams(window.location.search).get("pluginSurfaceSession");
        if (surfaceSession) resolved.searchParams.set("pluginSurfaceSession", surfaceSession);
      }
      return resolved.toString();
    } catch {}
  }
  // Direct-iframe fallback: append the plugin route to the already-loaded
  // surface root. The normal path is hana.api.url above.
  const routeBase = new URL("./", window.location.href);
  const url = new URL(`${routeBase.pathname.replace(/\/+$/, "")}/${cleanPath}`, routeBase.origin);
  if (withSurfaceSession) {
    const surfaceSession = new URLSearchParams(window.location.search).get("pluginSurfaceSession");
    if (surfaceSession) url.searchParams.set("pluginSurfaceSession", surfaceSession);
  }
  return url.toString();
}

function pluginApiFetch(path, init = {}) {
  const cleanPath = String(path || "").replace(/^\/+/, "");
  let pending;
  if (window.hana?.api?.fetch) {
    const headers = new Headers(init.headers || {});
    headers.set("X-Hana-Paper-Reader-UI-Version", UI_VERSION);
    pending = window.hana.api.fetch(cleanPath, { ...init, headers });
  } else {
    const surfaceSession = new URLSearchParams(window.location.search).get("pluginSurfaceSession");
    const headers = new Headers(init.headers || {});
    if (surfaceSession) headers.set("X-Hana-Plugin-Surface-Session", surfaceSession);
    headers.set("X-Hana-Paper-Reader-UI-Version", UI_VERSION);
    pending = fetch(pluginApiUrl(path), { ...init, headers });
  }
  if (cleanPath === "api/diagnostics/log") return pending;
  return Promise.resolve(pending).then((response) => {
    if (!response?.ok) recordQaEvent("api.response.failed", { path: cleanPath, method: init.method || "GET", status: response?.status || 0 }, "error");
    return response;
  }, (error) => {
    recordQaEvent("api.request.failed", { path: cleanPath, method: init.method || "GET", message: String(error?.message || error) }, "error");
    throw error;
  });
}

function recordQaEvent(event, details = {}, level = "info") {
  try {
    void pluginApiFetch("/api/diagnostics/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level, event: String(event || "client.event").slice(0, 160), details }),
    }).catch(() => {});
  } catch {}
}

const hanaBridge = {
  ready: () => event("hana.ready"),
  ui: { resize: (size) => event("ui.resize", size) },
  toast: { show: (input) => request("toast.show", input) },
  resources: {
    open: (input) => {
      if (typeof window.hana?.resources?.open === "function") return window.hana.resources.open(input);
      // A missing capability handler should fall back quickly so the older
      // native-anchor path is not separated from the user's click by 10s.
      return request("resource.open", input, 1500);
    },
  },
  clipboard: {
    writeText: async (value) => {
      const text = String(value || "");
      if (!text || typeof window.hana?.clipboard?.writeText !== "function") return false;
      try {
        const result = await window.hana.clipboard.writeText(text);
        return result?.written !== false;
      } catch {
        return false;
      }
    },
  },
};

async function copyTextToClipboard(text) {
  const value = String(text || "");
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {}

  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

function isPaperHash(value) {
  return /^[a-f0-9]{12,128}$/i.test(String(value || ""));
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

let sha256ModulePromise = null;

async function sha256Hex(value) {
  const moduleUrl = document.body?.dataset?.sha256Url;
  if (!moduleUrl) throw new Error("SHA-256 资源未加载");
  sha256ModulePromise ||= import(moduleUrl);
  const module = await sha256ModulePromise;
  return module.sha256Hex(value);
}

async function hashFile(file) {
  return sha256Hex(new Uint8Array(await file.arrayBuffer()));
}

async function hashPaperSource(paper) {
  const source = {
    title: String(paper?.title || ""),
    parser: String(paper?.parser || ""),
    blocks: Array.isArray(paper?.blocks) ? paper.blocks.map((block) => ({
      id: block?.id,
      page: block?.page,
      type: block?.type,
      text: block?.text,
      latex: block?.latex,
      tableHtml: block?.tableHtml,
      assetPath: block?.assetPath,
    })) : [],
  };
  return sha256Hex(JSON.stringify(source));
}

function citationAnchorForBlock(block) {
  const page = Number(block?.page) > 0 ? Number(block.page) : 1;
  const id = String(block?.id || "block").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "block";
  return `paper-p${page}-b-${id}`;
}

// ================= 全局状态 =================
let agentsList = [
  { id: "hakimi", name: "哈基米", model: "gemini-3.7-flash", description: "理性与推导兼备", avatarUrl: null },
  { id: "agent-mqb7zal0", name: "客服小祥", model: "deepseek-v4-pro", description: "分析与交叉验证", avatarUrl: null },
  { id: "cixiaogui", name: "星见凛", model: "gpt-5.6-luna", description: "学术解析与深度概念", avatarUrl: null },
  { id: "beishu", name: "背书小助手", model: "deepseek-v4-flash", description: "考点抽背与精准纠错", avatarUrl: null },
  { id: "hanako", name: "小鲸鱼", model: "deepseek-v4-flash-0731", description: "全科陪伴助手", avatarUrl: null }
];
let chatModels = [];
let modelCatalogReady = false;
let modelCatalogError = "";
let modelPreferences = {};
let currentAgent = agentsList[0];
const AGENT_DEFAULT_MODEL = "agent-default";
try {
  const stored = JSON.parse(localStorage.getItem("hana-paper-reader-model-preferences") || "{}");
  if (stored && typeof stored === "object" && !Array.isArray(stored)) modelPreferences = stored;
} catch {}

function normalizeModelRef(value) {
  const ref = typeof value === "string" ? value.trim() : "";
  return /^[^/\x00-\x20]{1,160}\/[^\x00-\x20]{1,240}$/u.test(ref) ? ref : "";
}

function modelByRef(ref) {
  return chatModels.find((model) => model?.ref === ref) || null;
}

function selectedModelRefForAgent(agent = currentAgent) {
  const saved = typeof modelPreferences?.[agent?.id] === "string" ? modelPreferences[agent.id].trim() : "";
  return saved || AGENT_DEFAULT_MODEL;
}

function selectedModelForAgent(agent = currentAgent) {
  const ref = selectedModelRefForAgent(agent);
  return ref === AGENT_DEFAULT_MODEL ? null : modelByRef(ref);
}

function persistModelPreferences() {
  try { localStorage.setItem("hana-paper-reader-model-preferences", JSON.stringify(modelPreferences)); } catch {}
}

function setModelPreference(agentId, modelRef) {
  if (!agentId) return;
  const ref = typeof modelRef === "string" && modelRef.trim() ? modelRef.trim() : AGENT_DEFAULT_MODEL;
  modelPreferences = { ...modelPreferences, [agentId]: ref };
  persistModelPreferences();
}

function modelDisplayLabel(agent = currentAgent) {
  const ref = selectedModelRefForAgent(agent);
  if (ref === AGENT_DEFAULT_MODEL) {
    const configured = normalizeModelRef(agent?.model);
    return configured ? `跟随 · ${configured}` : "跟随 Agent";
  }
  const model = modelByRef(ref);
  return model ? `${model.name} · ${model.ref}` : `不可用 · ${ref}`;
}

let currentPaper = {
  title: "未导入文献",
  paperHash: null,
  blocks: [],
  translations: {},
  translationStates: {},
  glossaryVersion: 0,
  glossaryTerms: {},
  translationGlossaryVersion: 0,
};
let openPaperTabs = [];
let activeView = "library";
let activePaperHash = null;
let libraryItems = [];
let libraryFilter = "all";
let librarySort = "lastRead_desc";
let libraryQuery = "";
let libraryLoading = false;
const TABS_STATE_STORAGE_KEY = "hana-paper-reader-tabs-state-v1";
let mineruConfigured = false;
let mineruApiVersion = null;
let mineruSettings = {
  modelVersion: "vlm",
  language: "ch",
  enableFormula: true,
  enableTable: true,
  ocr: false,
  timeoutSeconds: 900,
  pollIntervalSeconds: 5,
};
let currentPdfFile = null;
let currentPdfFileHash = null;
const pdfFilesByHash = new Map();
let pendingPdfFile = null;
let paperLoadingHash = null;
let pendingPdfLoadRequestId = 0;
let parseJobId = 0;
let activeParseController = null;
let paperRevision = 0;
let currentPaperHashPromise = null;
let paperLoadRequestId = 0;
let libraryRequestId = 0;
let restoreRequestId = 0;
let fullTranslationRunId = 0;
let fullTranslationBusy = false;
let askAgentRequestId = 0;
const blockTranslationRunIds = new Map();
let selectedText = "";
let selectedContext = "";
let selectedFromTranslation = false;
let sessionTargets = [];
let selectedSessionTargetId = null;
let sessionPickerBusy = false;
let sessionPickerRequestId = 0;
const THINKING_LEVEL_ORDER = ["off", "low", "medium", "high", "max"];
const THINKING_LEVEL_LABELS = {
  off: "无",
  low: "低",
  medium: "中",
  high: "高",
  max: "最高",
};
let currentThinkingLevel = "max";
let effectiveThinkingLevel = null;
const READING_MODES = new Set(["original", "bilingual", "translation", "contrast"]);
let currentReadingMode = "bilingual";
try {
  currentThinkingLevel = normalizeThinkingLevel(localStorage.getItem("hana-paper-reader-thinking-level"));
  const savedReadingMode = localStorage.getItem("hana-paper-reader-reading-mode");
  if (READING_MODES.has(savedReadingMode)) currentReadingMode = savedReadingMode;
} catch {}
let activePane = null;
let syncingPanes = false;
let pdfPreviewGeneration = 0;
let pdfPreviewPaperHash = null;
let pdfPreviewDocument = null;
let pdfPreviewLoadingTask = null;
let pdfPreviewObserver = null;
let pdfJsModulePromise = null;
let paperViewRestoreRequestId = 0;
const pdfPreviewObjectUrls = new Set();
const mineruAssetUrlPromises = new Map();
const pdfPageRenderLocks = new Map();
let researchTools = null;
let researchToolsPromise = null;
let selectedBlockId = null;
let activeParseTask = null;
const progressSyncTimers = new Map();
const researchSyncTimers = new Map();
const paperViewSnapshots = new Map();
const paperSyncChains = new Map();
const progressSyncChains = new Map();
const translationCacheChains = new Map();
const paperSyncFailures = new Map();
const progressSyncFailures = new Map();
const paperSyncBlocked = new Set();
const deletedPaperHashes = new Set();
let researchStateRevision = 0;
let glossaryRequestId = 0;
let restoredResearchUiState = { searchState: {}, noteDraft: null };
let activeSearchQuery = "";

const SAMPLE_PAPER = {
  title: "Attention Is All You Need (Vaswani et al.)",
  blocks: [
    { id: "b1", type: "heading", text: "Abstract" },
    { id: "b2", type: "paragraph", text: "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. The best performing models also connect the encoder and decoder through an attention mechanism." },
    { id: "b3", type: "paragraph", text: "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely. Experiments on two machine translation tasks show these models to be superior in quality while being more parallelizable and requiring significantly less time to train." },
    { id: "b4", type: "heading", text: "1. Introduction" },
    { id: "b5", type: "paragraph", text: "Recurrent neural networks, long short-term memory and gated recurrent neural networks in particular, have been firmly established as state of the art approaches in sequence modeling and transduction problems such as language modeling and machine translation." },
    { id: "b6", type: "paragraph", text: "In this work we propose the Transformer, a model architecture eschewing recurrence and instead relying entirely on an attention mechanism to draw global dependencies between input and output. The Transformer allows for significantly more parallelization and can reach a new state of the art in translation quality." },
    { id: "b7", type: "heading", text: "2. Model Architecture - Scaled Dot-Product Attention" },
    { id: "b8", type: "paragraph", text: "We call our particular attention 'Scaled Dot-Product Attention'. The input consists of queries and keys of dimension $d_k$, and values of dimension $d_v$. We compute the matrix of outputs as: $$\\text{Attention}(Q, K, V) = \\text{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V$$" }
  ]
};

const root = document.getElementById("root");
let panelNoticeTimer = null;
let pendingActionConfirm = null;

function closeActionConfirm(result = false) {
  const modal = document.getElementById("action-confirm-modal");
  const resolver = pendingActionConfirm;
  pendingActionConfirm = null;
  if (modal) {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  }
  if (typeof resolver === "function") resolver(Boolean(result));
}

function requestActionConfirmation(message, title = "请确认") {
  const modal = document.getElementById("action-confirm-modal");
  const messageEl = document.getElementById("action-confirm-message");
  const titleEl = document.getElementById("action-confirm-title");
  if (!modal || !messageEl || !titleEl) {
    try { return Promise.resolve(typeof window.confirm === "function" && window.confirm(String(message || "请确认"))); } catch { return Promise.resolve(false); }
  }
  closeActionConfirm(false);
  titleEl.textContent = String(title || "请确认");
  messageEl.textContent = String(message || "请确认");
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  return new Promise((resolve) => {
    pendingActionConfirm = resolve;
    window.setTimeout(() => document.getElementById("btn-confirm-action")?.focus?.(), 0);
  });
}

function showPanelNotice(input = {}) {
  const notice = document.getElementById("panel-notice");
  if (!notice) return;
  const message = String(input?.message || "").trim();
  if (panelNoticeTimer !== null) window.clearTimeout(panelNoticeTimer);
  notice.textContent = message;
  notice.dataset.type = String(input?.type || "info");
  notice.hidden = !message;
  if (!message) {
    panelNoticeTimer = null;
    return;
  }
  panelNoticeTimer = window.setTimeout(() => {
    notice.hidden = true;
    notice.textContent = "";
    panelNoticeTimer = null;
  }, 7000);
}

function saveTabsState() {
  try {
    const data = {
      openPaperTabs: openPaperTabs.map((t) => ({
        paperHash: t.paperHash,
        title: t.title,
        isPdf: Boolean(t.isPdf),
        pageCount: Number(t.pageCount || 0),
        lastReadAt: t.lastReadAt || null,
      })),
      activePaperHash: isPaperHash(activePaperHash) ? activePaperHash : null,
      activeView: activeView === "paper" && isPaperHash(activePaperHash) ? "paper" : "library",
    };
    localStorage.setItem(TABS_STATE_STORAGE_KEY, JSON.stringify(data));
  } catch {}
}

function restoreTabsState() {
  try {
    const raw = localStorage.getItem(TABS_STATE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const seen = new Set();
      if (Array.isArray(parsed.openPaperTabs)) {
        openPaperTabs = parsed.openPaperTabs.filter((tab) => {
          const hash = String(tab?.paperHash || "").toLowerCase();
          if (!isPaperHash(hash) || seen.has(hash)) return false;
          seen.add(hash);
          return true;
        }).map((tab) => ({
          paperHash: String(tab.paperHash).toLowerCase(),
          title: String(tab.title || "未命名论文").slice(0, 500),
          isPdf: Boolean(tab.isPdf),
          pageCount: Number(tab.pageCount || 0),
          lastReadAt: tab.lastReadAt || null,
        }));
      }
      activePaperHash = isPaperHash(parsed.activePaperHash) ? String(parsed.activePaperHash).toLowerCase() : null;
      if (parsed.activeView === "library" || parsed.activeView === "paper") activeView = parsed.activeView;
      return parsed;
    }
  } catch {}
  return null;
}

function upsertPaperTab(paper = {}) {
  const hash = String(paper.paperHash || "").toLowerCase();
  if (!isPaperHash(hash)) return null;
  let tab = openPaperTabs.find((item) => item.paperHash === hash);
  if (!tab) {
    tab = { paperHash: hash, title: "未命名论文", isPdf: false, pageCount: 0, lastReadAt: null };
    openPaperTabs.push(tab);
  }
  if (paper.title) tab.title = String(paper.title).slice(0, 500);
  if (paper.isPdf !== undefined) tab.isPdf = Boolean(paper.isPdf);
  if (paper.pageCount !== undefined) tab.pageCount = Number(paper.pageCount || 0);
  if (paper.lastReadAt !== undefined) tab.lastReadAt = paper.lastReadAt || null;
  return tab;
}

function removePaperTab(hash) {
  const normalized = String(hash || "").toLowerCase();
  const index = openPaperTabs.findIndex((tab) => tab.paperHash === normalized);
  if (index < 0) return false;
  openPaperTabs.splice(index, 1);
  if (activePaperHash === normalized) activePaperHash = null;
  return true;
}

function paperLoadIsCurrent(requestId, hash) {
  const normalizedHash = normalizedPaperHash(hash);
  return requestId === paperLoadRequestId
    && activeView === "paper"
    && activePaperHash === normalizedHash
    && !deletedPaperHashes.has(normalizedHash);
}

function renderWorkspaceTabs() {
  const tabsBar = document.getElementById("workspace-paper-tabs");
  const libraryTab = document.getElementById("tab-library");
  if (!tabsBar || !libraryTab) return;

  if (activeView === "library") {
    libraryTab.classList.add("active");
    libraryTab.setAttribute("aria-selected", "true");
  } else {
    libraryTab.classList.remove("active");
    libraryTab.setAttribute("aria-selected", "false");
  }

  tabsBar.innerHTML = openPaperTabs.map((tab) => {
    const isActive = activeView === "paper" && tab.paperHash === activePaperHash;
    const safeTitle = escapeHtml(tab.title || "未命名论文");
    const icon = tab.isPdf ? "📑" : "📄";
    return `
      <div class="workspace-tab-item tab-paper ${isActive ? "active" : ""}" data-hash="${escapeAttr(tab.paperHash)}" role="tab" aria-selected="${isActive}">
        <span class="tab-icon">${icon}</span>
        <span class="tab-label" title="${escapeAttr(tab.title || "未命名论文")}">${safeTitle}</span>
        <button type="button" class="tab-close-btn" data-close-hash="${escapeAttr(tab.paperHash)}" title="关闭标签页（不删除论文）" aria-label="关闭标签页">✕</button>
      </div>
    `;
  }).join("");

  tabsBar.querySelectorAll(".workspace-tab-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".tab-close-btn")) return;
      const hash = el.dataset.hash;
      if (hash) void openPaperTab(hash);
    });
  });

  tabsBar.querySelectorAll(".tab-close-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const hash = btn.dataset.closeHash;
      if (hash) closePaperTab(hash);
    });
  });
  tabsBar.querySelector(".workspace-tab-item.active")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

function resetTranslationRunState() {
  fullTranslationRunId += 1;
  fullTranslationBusy = false;
  blockTranslationRunIds.clear();
  const button = document.getElementById("btn-translate-all");
  if (button) {
    button.disabled = false;
    button.textContent = "翻译全文";
  }
}

function hidePaperTransientUi() {
  selectedText = "";
  selectedContext = "";
  selectedFromTranslation = false;
  const toolbar = document.getElementById("selection-toolbar");
  if (toolbar) toolbar.style.display = "none";
  document.getElementById("answer-drawer")?.classList.remove("open");
  const modal = document.getElementById("session-target-modal");
  modal?.classList.remove("open");
  modal?.setAttribute("aria-hidden", "true");
  closeActionConfirm(false);
  selectedSessionTargetId = null;
  sessionTargets = [];
  sessionPickerBusy = false;
  sessionPickerRequestId += 1;
  askAgentRequestId += 1;
}

function switchView(view, hash = null) {
  const previousView = activeView;
  const nextView = view === "paper" ? "paper" : "library";
  if (nextView === "paper" && hash) activePaperHash = normalizedPaperHash(hash) || null;

  const libraryEl = document.getElementById("library-view");
  const readerEl = document.getElementById("reader-container");
  const emptyEl = document.getElementById("empty-view");
  const readingModeControl = document.getElementById("reading-mode-control");
  const translateButton = document.getElementById("btn-translate-all");
  const researchButton = document.getElementById("btn-research-tools");
  const locateButton = document.getElementById("btn-locate-sync");
  const reparseButton = document.getElementById("btn-reparse");

  if (nextView === "library") {
    // A user-visible return to the library supersedes startup restoration.
    restoreRequestId += 1;
    // Capture the old paper while it is still the active DOM context. The
    // snapshot helper is synchronous for a known hash; changing activeView
    // first would make future guards unnecessarily ambiguous.
    paperLoadRequestId += 1;
    paperLoadingHash = null;
    if (previousView === "paper" || currentPaper.blocks.length) {
      paperRevision += 1;
      researchStateRevision += 1;
    }
    if (activeParseController) void cancelActiveParse();
    pendingPdfFile = null;
    pendingPdfLoadRequestId = 0;
    const flush = flushCurrentPaperState();
    void flush.catch(() => {});
    resetTranslationRunState();
    hidePaperTransientUi();
    activeView = "library";
    // The snapshot has already captured the old paper above. Once the library
    // becomes visible, the research drawer must not keep rendering that paper
    // or let a late tool callback mutate the next one.
    activePaperHash = null;
    researchTools?.resetPaperState?.();
    researchTools?.close?.();
    researchTools?.refresh?.();
    if (libraryEl) libraryEl.style.display = "flex";
    if (readerEl) readerEl.style.display = "none";
    if (emptyEl) emptyEl.style.display = "none";
    if (readingModeControl) readingModeControl.style.display = "none";
    if (translateButton) translateButton.style.display = "none";
    if (researchButton) researchButton.style.display = "none";
    if (locateButton) locateButton.style.display = "none";
    if (reparseButton) reparseButton.style.display = "none";
    const badge = document.getElementById("paper-badge");
    if (badge) badge.textContent = "我的文库";
    renderWorkspaceTabs();
    saveTabsState();
    void loadLibraryItems();
    return;
  }

  activeView = "paper";
  if (libraryEl) libraryEl.style.display = "none";
  const paperIsReady = currentPaper.blocks.length > 0
    && normalizedPaperHash(currentPaper.paperHash) === normalizedPaperHash(activePaperHash);
  if (paperIsReady) {
    if (readerEl) readerEl.style.display = "flex";
    if (emptyEl) emptyEl.style.display = "none";
    if (readingModeControl) readingModeControl.style.display = "inline-flex";
    if (translateButton) translateButton.style.display = translatableBlocks().length ? "inline-flex" : "none";
    if (researchButton) researchButton.style.display = "inline-flex";
    if (locateButton) locateButton.style.display = currentReadingMode === "bilingual" ? "inline-flex" : "none";
    if (reparseButton) reparseButton.style.display = currentPdfFile ? "inline-flex" : "none";
  } else {
    if (readerEl) readerEl.style.display = "none";
    if (emptyEl) emptyEl.style.display = "flex";
    if (readingModeControl) readingModeControl.style.display = "none";
    if (translateButton) translateButton.style.display = "none";
    if (researchButton) researchButton.style.display = currentPaper.structureDetached ? "inline-flex" : "none";
    if (locateButton) locateButton.style.display = "none";
    if (reparseButton) reparseButton.style.display = "none";
  }
  const badge = document.getElementById("paper-badge");
  if (badge) badge.textContent = paperLoadingHash ? "正在载入论文…" : (currentPaper.title || "未载入文献");
  renderWorkspaceTabs();
  saveTabsState();
}

function activateLibraryFallback() {
  const nextTab = openPaperTabs[0] || null;
  if (nextTab) {
    activeView = "paper";
    activePaperHash = nextTab.paperHash;
    paperLoadingHash = nextTab.paperHash;
    renderWorkspaceTabs();
    saveTabsState();
    void openPaperTab(nextTab.paperHash);
    return;
  }
  activePaperHash = null;
  activeView = "library";
  paperLoadingHash = null;
  clearCurrentPaperView("未载入文献", { preserveView: true });
  switchView("library");
}

function mergeServerPaperRevision(data, hash, options = {}) {
  const normalizedHash = normalizedPaperHash(hash);
  if (!normalizedHash || normalizedPaperHash(currentPaper.paperHash) !== normalizedHash) return false;
  if (options.paperRef && options.paperRef !== currentPaper) return false;
  if (options.requestId !== undefined && !paperLoadIsCurrent(options.requestId, normalizedHash)) return false;
  const nextRevision = Number(data?.revision);
  if (!Number.isInteger(nextRevision) || nextRevision < 0) return false;
  const currentRevision = Number(currentPaper.revision);
  const previousRevision = Number.isInteger(currentRevision) && currentRevision >= 0 ? currentRevision : 0;
  // Never let a slower response from an older metadata request roll back the
  // local paper metadata after a newer revision has already been observed.
  if (nextRevision < previousRevision) return false;
  if (data?.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)) {
    currentPaper.metadata = { ...(currentPaper.metadata && typeof currentPaper.metadata === "object" ? currentPaper.metadata : {}), ...data.metadata };
    if (typeof data.metadata.title === "string" && data.metadata.title.trim()) currentPaper.title = data.metadata.title.trim();
  }
  if (data?.lastReadAt) {
    currentPaper.lastReadAt = data.lastReadAt;
    currentPaper.metadata = { ...(currentPaper.metadata || {}), lastReadAt: data.lastReadAt };
  }
  if (nextRevision === previousRevision) return false;
  currentPaper.revision = nextRevision;
  if (currentPaper.blocks.length && !paperSyncBlocked.has(normalizedHash) && activeView === "paper") {
    scheduleResearchSync();
  }
  return true;
}

function mergeLibraryMetadataResponse(hash, data = {}) {
  const normalizedHash = normalizedPaperHash(hash);
  const item = libraryItems.find((candidate) => normalizedPaperHash(candidate?.paperHash) === normalizedHash);
  if (!item) return false;
  const metadata = data?.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata) ? data.metadata : {};
  if (typeof metadata.title === "string" && metadata.title.trim()) item.title = metadata.title.trim();
  for (const key of ["authors", "year", "doi", "tags", "favorite", "archived"]) {
    if (Object.prototype.hasOwnProperty.call(metadata, key)) item[key] = cloneJson(metadata[key]);
  }
  if (data.lastReadAt) item.lastReadAt = data.lastReadAt;
  if (data.revision !== undefined) item.revision = data.revision;
  return true;
}

async function updatePaperMetadataOnServer(hash, patch = {}, options = {}) {
  const normalizedHash = normalizedPaperHash(hash);
  if (!normalizedHash || !isPaperHash(normalizedHash)) throw new Error("论文指纹无效");
  const paperRef = currentPaper;
  const response = await pluginApiFetch("/api/research/library/metadata", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paperHash: normalizedHash, ...patch }),
  });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok || !data.ok) throw new Error(data.error || "论文元数据更新失败");
  mergeServerPaperRevision(data, normalizedHash, { ...options, paperRef });
  mergeLibraryMetadataResponse(normalizedHash, data);
  return data;
}

async function openPaperTab(hash, options = {}) {
  const normalizedHash = normalizedPaperHash(hash);
  if (!normalizedHash || !isPaperHash(normalizedHash)) return false;
  if (paperSyncBlocked.has(normalizedHash) || deletedPaperHashes.has(normalizedHash)) {
    recordQaEvent("paper.open.blocked", { paperHash: normalizedHash, reason: deletedPaperHashes.has(normalizedHash) ? "deleted" : "sync-blocked" }, "warn");
    void safeToast({ message: deletedPaperHashes.has(normalizedHash) ? "这篇论文已被删除" : "论文正在同步或删除，请稍后重试", type: "error" });
    return false;
  }
  // Any explicit tab activation supersedes a startup restore that is still
  // waiting on the library/recent endpoint. The restore path opts out because
  // it has already claimed the restore request itself.
  if (options.fromRestore !== true) restoreRequestId += 1;
  const requestId = ++paperLoadRequestId;
  recordQaEvent("paper.open.start", { paperHash: normalizedHash, requestId });
  const previousHash = normalizedPaperHash(currentPaper.paperHash);
  const replacingPaper = (Boolean(currentPaper.blocks.length) || Boolean(previousHash)) && previousHash !== normalizedHash;
  let previousFlush = Promise.resolve(true);

  if (activeParseController) void cancelActiveParse();
  if (replacingPaper) {
    // Capture the old DOM selection before changing activePaperHash. The
    // snapshot function is synchronous for a known hash, which prevents a
    // quick A -> B switch from losing A's last block or scroll position.
    previousFlush = flushCurrentPaperState(previousHash ? { paperHash: previousHash } : {});
    paperRevision += 1;
    researchStateRevision += 1;
    fullTranslationRunId += 1;
    fullTranslationBusy = false;
    blockTranslationRunIds.clear();
    pendingPdfFile = null;
    pendingPdfLoadRequestId = 0;
    const translateButton = document.getElementById("btn-translate-all");
    if (translateButton) translateButton.disabled = false;
    if (activeParseController) await cancelActiveParse();
    // Hide and tear down the old reader before exposing the new hash. Without
    // this, a slow GET for B leaves A's text/PDF document interactive while B
    // is shown as the active tab.
    clearCurrentPaperView("正在载入论文…", { preserveView: true });
  }

  activeView = "paper";
  activePaperHash = normalizedHash;
  paperLoadingHash = normalizedHash;
  const libraryItem = libraryItems.find((item) => normalizedPaperHash(item?.paperHash) === normalizedHash);
  upsertPaperTab({
    paperHash: normalizedHash,
    title: libraryItem?.title,
    isPdf: libraryItem ? (libraryItem.parser?.kind === "mineru" || libraryItem.isPdf === true) : undefined,
    pageCount: libraryItem?.pageCount || libraryItem?.parser?.pageCount,
  });
  renderWorkspaceTabs();
  saveTabsState();
  // Show an explicit loading state immediately. Previously the library stayed
  // visible until the GET resolved, which made a slow/failed paper open look
  // like a dead button in the real WebView.
  switchView("paper", normalizedHash);

  if (previousHash === normalizedHash && currentPaper.blocks.length > 0) {
    paperLoadingHash = null;
    // applyPaperViewSnapshot requires an active paper context. Switch back to
    // the reader first when the user returns from the library to the same tab.
    switchView("paper", normalizedHash);
    applyPaperViewSnapshot(normalizedHash);
    return true;
  }

  if (replacingPaper) {
    // A quick return to a tab may race with the previous tab's final snapshot.
    // Wait for that hash-scoped queue so the GET cannot resurrect stale data.
    await previousFlush;
    if (!paperLoadIsCurrent(requestId, normalizedHash)) return false;
    await waitForPaperSync(normalizedHash);
    if (!paperLoadIsCurrent(requestId, normalizedHash)) return false;
  }
  if (!paperLoadIsCurrent(requestId, normalizedHash)) return false;

  try {
    const response = await pluginApiFetch(`/api/research/paper?paperHash=${encodeURIComponent(normalizedHash)}`);
    const data = await response.json();
    recordQaEvent("paper.open.response", { paperHash: normalizedHash, requestId, status: response.status, ok: response.ok, hasPaper: Boolean(data?.paper) });
    if (!paperLoadIsCurrent(requestId, normalizedHash)) return false;
    if (!response.ok || !data.ok || !data.paper) {
      if (response.status === 404) {
        const wasActive = activeView === "paper" && activePaperHash === normalizedHash;
        // Drain an already-created write before accepting the server's 404.
        // Block new writes during the await; otherwise a late paper or
        // translation-cache POST could re-create data for this hash.
        paperSyncBlocked.add(normalizedHash);
        const drained = await waitForPaperSync(normalizedHash);
        if (!drained || !paperLoadIsCurrent(requestId, normalizedHash)) {
          paperSyncBlocked.delete(normalizedHash);
          return false;
        }
        deletedPaperHashes.add(normalizedHash);
        clearPaperSyncTimers(normalizedHash);
        paperViewSnapshots.delete(normalizedHash);
        pdfFilesByHash.delete(normalizedHash);
        removePaperTab(normalizedHash);
        if (normalizedPaperHash(currentPaper.paperHash) === normalizedHash) {
          paperLoadRequestId += 1;
          paperRevision += 1;
          researchStateRevision += 1;
          clearCurrentPaperView("论文已不存在", { preserveView: true });
        }
        if (wasActive) activateLibraryFallback();
        paperSyncBlocked.delete(normalizedHash);
        return false;
      }
      throw new Error(data.error || "读取论文失败");
    }
    const paper = data.paper;
    const parser = paper.parser && typeof paper.parser === "object" ? paper.parser : {};
    const title = paper.metadata?.title || paper.title || "未命名论文";
    const isPdf = parser.kind === "mineru" || paper.isPdf === true;
    const pageCount = Number(parser.pageCount || paper.pageCount || 0);
    upsertPaperTab({ paperHash: normalizedHash, title, isPdf, pageCount });
    if (paper.structureDetached && !paper.blocks?.length) {
      loadDetachedResearchRecord({ ...paper, title, isPdf, pageCount }, { requestId });
    } else {
      const loaded = loadPaper({
        ...paper,
        title,
        isPdf,
        pageCount,
        restored: paper.restored === true || (isPdf && !pdfFilesByHash.has(normalizedHash)),
        cached: true,
      }, {
        requestId,
        loadRequestId: requestId,
        skipPreviousFlush: true,
        pdfFile: isPdf ? pdfFilesByHash.get(normalizedHash) || null : null,
      });
      if (!loaded) return false;
    }
    if (!paperLoadIsCurrent(requestId, normalizedHash)) return false;
    paperLoadingHash = null;
    switchView("paper", normalizedHash);
    void updatePaperMetadataOnServer(normalizedHash, { lastReadAt: new Date().toISOString() }, { requestId })
      .catch(() => {});
    return true;
  } catch (error) {
    if (!paperLoadIsCurrent(requestId, normalizedHash)) return false;
    recordQaEvent("paper.open.failed", { paperHash: normalizedHash, message: String(error?.message || "读取论文失败") }, "error");
    paperLoadingHash = null;
    await safeToast({ message: `打开论文失败：${error?.message || "读取论文失败"}`, type: "error" });
    switchView("paper", normalizedHash);
    return false;
  }
}

function closePaperTab(hash, options = {}) {
  const normalized = normalizedPaperHash(hash);
  const index = openPaperTabs.findIndex((tab) => tab.paperHash === normalized);
  if (index < 0) return;
  const wasActive = activeView === "paper" && activePaperHash === normalized;
  let flush = Promise.resolve(true);
  if (wasActive) {
    // Invalidate UI continuations before changing the active tab. Deletion
    // passes skipFlush because it has already performed the blocked flush.
    paperRevision += 1;
    researchStateRevision += 1;
    paperLoadRequestId += 1;
    paperLoadingHash = null;
    if (activeParseController) void cancelActiveParse();
    if (!options.skipFlush && normalizedPaperHash(currentPaper.paperHash) === normalized) {
      flush = flushCurrentPaperState({ paperHash: normalized });
    }
  }
  openPaperTabs.splice(index, 1);

  if (wasActive && openPaperTabs.length > 0) {
    const nextTab = openPaperTabs[Math.min(index, openPaperTabs.length - 1)];
    activeView = "paper";
    activePaperHash = nextTab.paperHash;
    // Do not let the just-closed paper remain as the global currentPaper while
    // the next tab is loading; otherwise openPaperTab() could flush it again
    // (especially after a confirmed deletion).
    clearCurrentPaperView("正在切换论文…", { preserveView: true });
    renderWorkspaceTabs();
    saveTabsState();
    void flush.then(() => {
      if (activeView === "paper" && activePaperHash === nextTab.paperHash) void openPaperTab(nextTab.paperHash);
    });
  } else if (wasActive) {
    activePaperHash = null;
    clearCurrentPaperView("未载入文献", { preserveView: true });
    switchView("library");
  } else {
    renderWorkspaceTabs();
    saveTabsState();
  }
  // Closing a tab changes the library action from “切换至此” back to “打开”
  // immediately; do not wait for the asynchronous library refresh to repaint
  // the old card DOM.
  if (activeView === "library") renderLibraryList(libraryItems);
}

function reconcileOpenPaperTabs(items) {
  const normalizedItems = (Array.isArray(items) ? items : [])
    .map((item) => ({ ...item, paperHash: normalizedPaperHash(item?.paperHash) }))
    .filter((item) => item.paperHash);
  const byHash = new Map(normalizedItems.map((item) => [item.paperHash, item]));
  const previousActive = normalizedPaperHash(activePaperHash);
  openPaperTabs = openPaperTabs.filter((tab) => byHash.has(tab.paperHash));
  openPaperTabs.forEach((tab) => {
    const item = byHash.get(tab.paperHash);
    if (!item) return;
    tab.title = item.title || tab.title;
    tab.isPdf = item.parser?.kind === "mineru" || item.isPdf === true || tab.isPdf;
    tab.pageCount = Number(item.pageCount || item.parser?.pageCount || tab.pageCount || 0);
  });
  if (previousActive && !byHash.has(previousActive)) {
    // Reconciliation uses the complete archived=all collection. A missing
    // active hash is therefore a deletion seen by another surface; retain a
    // tombstone so a delayed local autosave cannot resurrect it.
    deletedPaperHashes.add(previousActive);
    paperLoadRequestId += 1;
    activePaperHash = null;
    paperLoadingHash = null;
    if (normalizedPaperHash(currentPaper.paperHash) === previousActive) clearCurrentPaperView("论文已不存在", { preserveView: true });
    activeView = "library";
  }
  renderWorkspaceTabs();
  saveTabsState();
  return previousActive ? byHash.has(previousActive) : false;
}

async function loadLibraryItems(options = {}) {
  const requestId = ++libraryRequestId;
  libraryLoading = true;
  const container = document.getElementById("library-list-container");
  const totalBadge = document.getElementById("library-total-badge");
  if (!options.quiet && container) container.innerHTML = `<div class="library-empty-state"><span class="library-empty-icon">⏳</span><div class="library-empty-title">正在载入文库...</div></div>`;

  try {
    const [sortField, sortOrder] = (librarySort || "lastRead_desc").split("_");
    const params = new URLSearchParams();
    if (!options.reconcileTabs && libraryQuery) params.set("q", libraryQuery);
    if (sortField) params.set("sort", sortField);
    if (sortOrder) params.set("order", sortOrder);
    if (!options.reconcileTabs && libraryFilter === "favorite") params.set("favorite", "true");
    if (options.reconcileTabs || options.archived === "all") params.set("archived", "all");
    else if (libraryFilter === "archived") params.set("archived", "true");
    else params.set("archived", "false");

    const res = await pluginApiFetch(`/api/research/library?${params.toString()}`);
    const data = await res.json();
    if (requestId !== libraryRequestId) return false;
    if (!res.ok || !data.ok) throw new Error(data.error || "读取文库失败");
    libraryItems = Array.isArray(data.items) ? data.items : [];
    if (options.reconcileTabs) reconcileOpenPaperTabs(libraryItems);
    if (totalBadge) totalBadge.textContent = `${data.total || libraryItems.length} 篇文献`;
    if (options.render !== false) renderLibraryList(libraryItems);
    return true;
  } catch (err) {
    if (requestId === libraryRequestId) {
      recordQaEvent("library.load.failed", { message: String(err?.message || "读取文库失败") }, "error");
      if (container) container.innerHTML = `<div class="library-empty-state"><span class="library-empty-icon">⚠️</span><div class="library-empty-title">载入文库失败</div><div>${escapeHtml(err.message)}</div></div>`;
    }
    return false;
  } finally {
    if (requestId === libraryRequestId) libraryLoading = false;
  }
}

async function openLibraryPaper(hash, trigger = null) {
  const normalizedHash = normalizedPaperHash(hash);
  if (!normalizedHash || !isPaperHash(normalizedHash)) return false;
  const buttonTrigger = trigger?.tagName === "BUTTON" ? trigger : null;
  const card = trigger?.closest?.(".library-card") || document.querySelector(`.library-card[data-hash="${normalizedHash}"]`);
  if (card?.classList.contains("is-opening")) return false;
  recordQaEvent("paper.open.trigger", { paperHash: normalizedHash, source: buttonTrigger ? "library-action" : "library-card" });
  if (buttonTrigger) {
    buttonTrigger.disabled = true;
    buttonTrigger.dataset.previousLabel = buttonTrigger.textContent || "打开";
    buttonTrigger.textContent = "正在打开…";
  }
  card?.classList.add("is-opening");
  try {
    const opened = await openPaperTab(normalizedHash);
    recordQaEvent("paper.open.result", { paperHash: normalizedHash, opened });
    return opened;
  } finally {
    if (buttonTrigger?.isConnected) {
      buttonTrigger.disabled = false;
      buttonTrigger.textContent = buttonTrigger.dataset.previousLabel || "打开";
      delete buttonTrigger.dataset.previousLabel;
    }
    card?.classList.remove("is-opening");
  }
}

function bindLibraryDeleteHandler(container) {
  if (!container || container.dataset.deleteHandlerBound === "true") return;
  container.dataset.deleteHandlerBound = "true";
  container.addEventListener("click", (event) => {
    const button = event.target?.closest?.("button[data-delete-hash]");
    if (!button || !container.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    void handleLibraryDeleteClick(button);
  });
}

async function handleLibraryDeleteClick(btn) {
  const hash = normalizedPaperHash(btn?.dataset?.deleteHash);
  const item = libraryItems.find((candidate) => normalizedPaperHash(candidate?.paperHash) === hash);
  const title = item?.title || "此论文";
  recordQaEvent("paper.delete.trigger", { paperHash: hash, title });
  if (!hash) return false;
  const confirmed = await requestActionConfirmation(`确认删除论文“${title}”及其全部研究数据？此操作不可逆。`, "删除论文");
  recordQaEvent(confirmed ? "paper.delete.confirmed" : "paper.delete.cancelled", { paperHash: hash, title });
  if (!confirmed) return false;
  btn.disabled = true;
  try {
    await deletePaperRecord(hash, title);
    await safeToast({ message: `论文“${title}”已删除`, type: "success" });
    return true;
  } catch (err) {
    await safeToast({ message: `删除失败：${err?.message || "未知错误"}`, type: "error" });
    return false;
  } finally {
    if (btn.isConnected) btn.disabled = false;
  }
}

function renderLibraryList(items) {
  const container = document.getElementById("library-list-container");
  if (!container) return;

  if (!items.length) {
    container.innerHTML = `
      <div class="library-empty-state">
        <span class="library-empty-icon">📚</span>
        <div class="library-empty-title">${libraryQuery ? "未找到匹配的文献" : (libraryFilter === "favorite" ? "暂无收藏文献" : (libraryFilter === "archived" ? "暂无归档文献" : "文库中还没有文献"))}</div>
        <div style="font-size:0.85rem;color:var(--text-muted)">${libraryQuery ? "尝试更换搜索词或清除筛选条件" : "点击上方「导入新文献」或「体验示例论文」开始阅读"}</div>
      </div>
    `;
    return;
  }

  container.innerHTML = items.map((item) => {
    const authorsText = Array.isArray(item.authors) && item.authors.length ? item.authors.join(", ") : "未知作者";
    const yearText = item.year ? ` · ${item.year}` : "";
    const doiText = item.doi ? ` · DOI: ${item.doi}` : "";
    const progressPercent = Math.min(100, Math.max(0, item.readingProgress?.percent || 0));
    const lastTime = item.lastReadAt ? new Date(item.lastReadAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    const isOpen = openPaperTabs.some((t) => t.paperHash === item.paperHash);

    return `
      <div class="library-card" data-hash="${escapeAttr(item.paperHash)}">
        <div class="library-card-header">
          <div class="library-card-title" title="${escapeAttr(item.title)}">${escapeHtml(item.title)}</div>
          <button type="button" class="library-card-fav-btn ${item.favorite ? "active" : ""}" data-fav-hash="${escapeAttr(item.paperHash)}" title="${item.favorite ? "取消收藏" : "加入收藏"}">★</button>
        </div>
        <div class="library-card-meta">
          <span>${escapeHtml(authorsText)}${escapeHtml(yearText)}${escapeHtml(doiText)}</span>
        </div>
        <div class="library-card-badges">
          <span class="library-card-badge">${item.blockCount} 结构块</span>
          ${item.noteCount > 0 ? `<span class="library-card-badge">📝 ${item.noteCount} 笔记</span>` : ""}
          ${item.bookmarkCount > 0 ? `<span class="library-card-badge">🔖 ${item.bookmarkCount} 书签</span>` : ""}
          ${item.hasGlossary ? `<span class="library-card-badge">📖 术语表</span>` : ""}
          ${item.archived ? `<span class="library-card-badge" style="color:var(--danger)">📦 已归档</span>` : ""}
          ${item.tags?.map((t) => `<span class="library-card-badge" style="background:var(--accent-light);color:var(--accent)">#${escapeHtml(t)}</span>`).join("") || ""}
        </div>
        <div class="library-card-progress-wrap">
          <div style="display:flex;justify-content:space-between;font-size:0.72rem;color:var(--text-muted)">
            <span>阅读进度</span>
            <span>${progressPercent}%</span>
          </div>
          <div class="library-card-progress-bar-bg">
            <div class="library-card-progress-bar-fill" style="width: ${progressPercent}%"></div>
          </div>
        </div>
        <div class="library-card-footer">
          <span class="library-card-time">${lastTime ? `最近: ${lastTime}` : ""}</span>
          <div class="library-card-actions">
            <button type="button" class="library-card-action-btn" data-archive-hash="${escapeAttr(item.paperHash)}">${item.archived ? "取消归档" : "归档"}</button>
            <button type="button" class="library-card-action-btn danger" data-delete-hash="${escapeAttr(item.paperHash)}">删除</button>
            <button type="button" class="library-card-action-btn" data-open-hash="${escapeAttr(item.paperHash)}" style="background:var(--accent);color:#fff;border-color:var(--accent)">${isOpen ? "切换至此" : "打开"}</button>
          </div>
        </div>
      </div>
    `;
  }).join("");

  bindLibraryDeleteHandler(container);

  container.querySelectorAll(".library-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".library-card-actions") || e.target.closest(".library-card-fav-btn")) return;
      const hash = card.dataset.hash;
      if (hash) void openLibraryPaper(hash, card);
    });
  });

  container.querySelectorAll("[data-fav-hash]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const hash = btn.dataset.favHash;
      const item = libraryItems.find((i) => i.paperHash === hash);
      const nextFav = !item?.favorite;
      try {
        await updatePaperMetadataOnServer(hash, { favorite: nextFav });
        if (item) item.favorite = nextFav;
        btn.classList.toggle("active", nextFav);
      } catch (err) {
        await safeToast({ message: `收藏失败：${err.message}`, type: "error" });
      }
    });
  });

  container.querySelectorAll("[data-archive-hash]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const hash = btn.dataset.archiveHash;
      const item = libraryItems.find((i) => i.paperHash === hash);
      const nextArch = !item?.archived;
      try {
        await updatePaperMetadataOnServer(hash, { archived: nextArch });
        void loadLibraryItems();
      } catch (err) {
        await safeToast({ message: `归档失败：${err.message}`, type: "error" });
      }
    });
  });

  container.querySelectorAll("[data-open-hash]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const hash = btn.dataset.openHash;
      if (hash) void openLibraryPaper(hash, btn);
    });
  });
}

function initLayout() {
  if (!root) return;
  root.innerHTML = `
    <header class="navbar">
      <div class="nav-left">
        <div class="app-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          Hana Paper
        </div>
        <div id="workspace-tabs-bar" class="workspace-tabs-bar" role="tablist" aria-label="文献标签页">
          <button id="tab-library" class="workspace-tab-item tab-library active" role="tab" aria-selected="true" title="进入我的文库">
            <span class="tab-icon">📚</span>
            <span class="tab-label">我的文库</span>
          </button>
          <div id="workspace-paper-tabs" class="workspace-paper-tabs"></div>
        </div>
        <div id="paper-badge" class="paper-title-badge" style="display:none">未载入文献</div>
      </div>

      <div class="nav-actions">
        <input type="file" id="file-input" accept=".pdf,.txt,.md" style="display:none">
        <input type="file" id="backup-input" accept=".json,application/json" style="display:none">
        <button id="btn-mineru-settings" class="btn small mineru-config-button" title="配置 MinerU API Token 与解析参数">
          <span id="mineru-status-dot" class="status-dot"></span>
          <span id="mineru-status-text">MinerU 未配置</span>
        </button>
        <button id="btn-open-file" class="btn primary small">📂 导入 PDF / 文档</button>
        <button id="btn-reparse" class="btn small" style="display:none">↻ MinerU 重解析</button>
        <button id="btn-sample" class="btn small">🧪 示例论文</button>
        <button id="btn-research-tools" class="btn small" style="display:none" title="定位、核验与沉淀三条研究工作流">研究工作流</button>
        <div id="reading-mode-control" class="reading-mode-control" style="display:none" role="group" aria-label="阅读模式">
          <button type="button" class="reading-mode-button" data-reading-mode="original">原文</button>
          <button type="button" class="reading-mode-button" data-reading-mode="bilingual">双语</button>
          <button type="button" class="reading-mode-button" data-reading-mode="translation">译文</button>
          <button type="button" class="reading-mode-button" data-reading-mode="contrast">对照</button>
        </div>
        <button id="btn-translate-all" class="btn small" style="display:none">翻译全文</button>
        <button id="btn-locate-sync" class="btn small" style="display:none" title="以当前滚动面板为基准，对齐另一侧的同一段落">⌖ 对齐</button>
      </div>

      <div class="nav-right">
        <label class="thinking-control" title="默认使用当前模型支持的最高思考档位">
          <span>思考</span>
          <select id="thinking-level" class="thinking-select" aria-label="思考档位"></select>
        </label>
        <div class="agent-selector-wrap">
          <div id="agent-btn" class="agent-btn" title="点击切换陪读助手">
            <div id="agent-avatar-slot"></div>
            <span id="agent-name-text">哈基米</span>
            <span id="agent-model-badge" class="agent-model-tag">gemini-3.7-flash</span>
            <span style="font-size:8px;color:var(--text-muted)">▼</span>
          </div>
          <div id="agent-dropdown" class="agent-dropdown-menu"></div>
        </div>
      </div>
    </header>

    <div class="main-layout">
      <div id="panel-notice" class="panel-notice" role="status" aria-live="polite" hidden></div>
      <!-- 拖拽提示遮罩 -->
      <div id="drag-overlay" class="drag-overlay">
        <div class="drag-icon">📑</div>
        <div class="drag-text">松开鼠标即可解析 PDF 文献</div>
      </div>

      <!-- 我的文库视图 -->
      <div id="library-view" class="library-view" style="display:flex">
        <div class="library-header">
          <div class="library-header-main">
            <div class="library-title-group">
              <h2 class="library-title">我的文库</h2>
              <span id="library-total-badge" class="library-total-badge">0 篇文献</span>
            </div>
            <div class="library-actions">
              <button id="btn-library-import" class="btn primary small">📂 导入新文献</button>
              <button id="btn-library-restore" class="btn small">从备份恢复</button>
              <button id="btn-library-sample" class="btn small">🧪 示例论文</button>
            </div>
          </div>
          <div class="library-toolbar">
            <div class="library-search-wrap">
              <span class="library-search-icon">🔍</span>
              <input type="text" id="library-search-input" class="library-search-input" placeholder="搜索论文标题、作者、DOI、标签或指纹..." />
              <button id="library-search-clear" class="library-search-clear" style="display:none">✕</button>
            </div>
            <div class="library-filters" role="group" aria-label="文库筛选">
              <button type="button" class="library-filter-btn active" data-filter="all">全部</button>
              <button type="button" class="library-filter-btn" data-filter="favorite">⭐ 收藏</button>
              <button type="button" class="library-filter-btn" data-filter="archived">📦 归档</button>
            </div>
            <div class="library-sort-wrap">
              <span>排序:</span>
              <select id="library-sort-select" class="library-sort-select">
                <option value="lastRead_desc">最近阅读</option>
                <option value="updated_desc">最新更新</option>
                <option value="created_desc">导入时间</option>
                <option value="title_asc">标题 A-Z</option>
              </select>
            </div>
          </div>
        </div>
        <div id="library-list-container" class="library-list-container"></div>
      </div>

      <!-- 空状态 -->
      <div id="empty-view" class="empty-view" style="display:none">
        <div class="empty-box">
          <div class="empty-icon">📖</div>
          <div class="empty-title">从论文开始，不必先学技术名词</div>
          <div class="empty-desc">选择一个动作即可进入阅读。解析模型、文件指纹和结构块等技术细节只在需要时展开。</div>
          <div class="onboarding-actions">
            <button id="btn-empty-sample" class="onboarding-action">
              <strong>体验示例论文</strong><span>立即看看原文、双语和研究工具</span>
            </button>
            <button id="btn-empty-config" class="onboarding-action">
              <strong>配置 MinerU</strong><span>首次导入 PDF 前填写解析 Token</span>
            </button>
            <button id="btn-empty-import" class="onboarding-action primary">
              <strong>导入我的论文</strong><span>选择 PDF、Markdown 或文本文件</span>
            </button>
          </div>
          <button id="btn-empty-restore" class="btn small">从研究备份恢复</button>
        </div>
      </div>

      <!-- 双栏与逐段对照阅读器 -->
      <div id="reader-container" class="reader-container" data-reading-mode="bilingual" style="display:none">
        <div id="original-pane" class="pane original">
          <div class="pane-header">
            <span>ENGLISH ORIGINAL (英文原文)</span>
            <span id="orig-blocks-count">0 段落</span>
          </div>
          <div id="orig-blocks"></div>
        </div>

        <div id="trans-pane" class="pane translation">
          <div class="pane-header">
            <span>CHINESE TRANSLATION (学术中文对照)</span>
            <span id="trans-status">点击「翻译全文」或各段「译」生成</span>
          </div>
          <div id="trans-blocks"></div>
        </div>

        <div id="contrast-pane" class="pane contrast" aria-label="英文原文与中文译文逐段对照">
          <div class="pane-header">
            <span>CONTRAST (逐段上下对照)</span>
            <span id="contrast-status">英文在上，中文在下</span>
          </div>
          <div id="contrast-blocks"></div>
        </div>
      </div>

      <div id="mineru-settings-modal" class="settings-modal" aria-hidden="true">
        <div class="settings-backdrop" data-close-mineru-settings></div>
        <section class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="mineru-settings-title">
          <div class="settings-dialog-header">
            <div>
              <h2 id="mineru-settings-title">MinerU 精准解析设置</h2>
              <p id="mineru-settings-summary">Token 仅保存在插件服务端，不会回显到页面。</p>
            </div>
            <button id="btn-close-mineru-settings" class="icon-button" type="button" aria-label="关闭设置">✕</button>
          </div>
          <div class="settings-dialog-body">
            <label class="settings-field settings-field-wide">
              <span>API Token</span>
              <input id="mineru-token-input" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴 MinerU API Token">
              <small id="mineru-token-hint">尚未配置。保存后 Token 不会再次显示。</small>
            </label>
            <label class="settings-field">
              <span>解析模型</span>
              <select id="mineru-model-input">
                <option value="vlm">VLM（推荐）</option>
                <option value="pipeline">Pipeline</option>
              </select>
            </label>
            <label class="settings-field">
              <span>文档语言</span>
              <select id="mineru-language-input">
                <option value="ch">中文 / 中英混排</option>
                <option value="en">英文</option>
                <option value="japan">日文</option>
                <option value="latin">拉丁语系</option>
              </select>
            </label>
            <label class="settings-check"><input id="mineru-formula-input" type="checkbox"> 识别公式</label>
            <label class="settings-check"><input id="mineru-table-input" type="checkbox"> 识别表格</label>
            <label class="settings-check"><input id="mineru-ocr-input" type="checkbox"> 强制 OCR</label>
          </div>
          <div class="settings-dialog-footer">
            <button id="btn-clear-mineru-token" class="btn small danger" type="button">清除 Token</button>
            <div class="settings-footer-actions">
              <button id="btn-cancel-mineru-settings" class="btn small" type="button">取消</button>
              <button id="btn-save-mineru-settings" class="btn primary small" type="button">保存设置</button>
            </div>
          </div>
        </section>
      </div>

      <div id="action-confirm-modal" class="settings-modal" aria-hidden="true">
        <div class="settings-backdrop" data-close-action-confirm></div>
        <section class="settings-dialog action-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="action-confirm-title">
          <div class="settings-dialog-header">
            <div>
              <h2 id="action-confirm-title">请确认</h2>
              <p>此操作需要你的明确确认。</p>
            </div>
          </div>
          <div class="settings-dialog-body action-confirm-body">
            <p id="action-confirm-message" class="action-confirm-message"></p>
          </div>
          <div class="settings-dialog-footer">
            <span></span>
            <div class="settings-footer-actions">
              <button id="btn-cancel-action" class="btn small" type="button">取消</button>
              <button id="btn-confirm-action" class="btn primary small danger" type="button">确认</button>
            </div>
          </div>
        </section>
      </div>

      <!-- 划词悬浮操作栏 -->
      <div id="selection-toolbar" class="selection-toolbar">
        <div id="quick-agent-avatars" style="display:flex;gap:4px;margin-right:2px"></div>
        <button id="btn-ask-agent" class="tool-btn primary">
          <span id="tool-agent-text">问当前助手</span>
        </button>
        <button id="btn-ask-formula" class="tool-btn">📐 公式拆解</button>
        <button id="btn-ask-explain" class="tool-btn">🔍 概念解析</button>
        <button id="btn-create-note" class="tool-btn">📝 创建研究笔记</button>
        <button id="btn-send-session" class="tool-btn">✉️ 选择对话…</button>
        <button id="btn-copy-quote" class="tool-btn">📋 复制</button>
      </div>

      <!-- 会话目标选择器 -->
      <div id="session-target-modal" class="session-target-modal" aria-hidden="true">
        <div class="session-target-backdrop" data-close-session-targets></div>
        <section class="session-target-dialog" role="dialog" aria-modal="true" aria-labelledby="session-target-title">
          <div class="session-target-header">
            <div>
              <h2 id="session-target-title">发送到对话</h2>
              <p id="session-target-summary">选择一个已有对话接收这段论文引用。</p>
            </div>
            <button id="btn-close-session-targets" class="icon-button" type="button" aria-label="关闭对话选择">✕</button>
          </div>
          <div id="session-target-status" class="session-target-status" role="status"></div>
          <div id="session-target-list" class="session-target-list"></div>
          <div class="session-target-footer">
            <button id="btn-create-session-and-send" class="btn small">新建对话并发送</button>
            <div class="session-target-footer-actions">
              <button id="btn-cancel-session-targets" class="btn small" type="button">取消</button>
              <button id="btn-confirm-session-target" class="btn primary small" type="button" disabled>发送到所选对话</button>
            </div>
          </div>
        </section>
      </div>

      <!-- 右侧滑出解答抽屉 -->
      <div id="answer-drawer" class="answer-drawer">
        <div class="drawer-header">
          <div class="drawer-agent-info">
            <div id="drawer-avatar-slot"></div>
            <div>
              <span id="drawer-agent-name" style="font-weight:600">哈基米</span>
              <span id="drawer-agent-model" class="agent-model-tag" style="margin-left:6px">gemini-3.7-flash</span>
            </div>
          </div>
          <button id="btn-close-drawer" class="btn small" style="border:none;background:transparent">✕</button>
        </div>
        <div class="drawer-body">
          <div id="drawer-quote" class="drawer-quote"></div>
          <div id="drawer-content" class="drawer-content">正在认真研读并分析文献要点...</div>
        </div>
        <div class="drawer-footer">
          <button id="btn-drawer-send-chat" class="btn small primary">✉️ 选择对话…</button>
          <span style="font-size:0.7rem;color:var(--text-muted)">Hana Paper Companion</span>
        </div>
      </div>
    </div>
  `;

  // Keep the confirmation surface outside .main-layout's overflow clipping.
  // Fixed-position dialogs inside the embedded WebView otherwise may be
  // visually present but fail to receive pointer input.
  const actionConfirmModal = document.getElementById("action-confirm-modal");
  if (actionConfirmModal && actionConfirmModal.parentNode !== document.body) document.body.appendChild(actionConfirmModal);

  bindEvents();
  void loadAgentsAndModels();
  void loadMineruSettings();
  void initializeResearchTools();
  void restoreRecentPaper();
}

function bindEvents() {
  const fileInput = document.getElementById("file-input");
  const backupInput = document.getElementById("backup-input");
  const btnOpenFile = document.getElementById("btn-open-file");
  const btnEmptyImport = document.getElementById("btn-empty-import");
  const btnSample = document.getElementById("btn-sample");
  const btnEmptySample = document.getElementById("btn-empty-sample");
  const btnTranslateAll = document.getElementById("btn-translate-all");
  const btnResearchTools = document.getElementById("btn-research-tools");
  const readingModeControl = document.getElementById("reading-mode-control");
  const btnLocateSync = document.getElementById("btn-locate-sync");
  const btnReparse = document.getElementById("btn-reparse");
  const btnMineruSettings = document.getElementById("btn-mineru-settings");
  const thinkingLevelSelect = document.getElementById("thinking-level");
  const agentBtn = document.getElementById("agent-btn");
  const agentDropdown = document.getElementById("agent-dropdown");
  const dragOverlay = document.getElementById("drag-overlay");
  const btnCloseDrawer = document.getElementById("btn-close-drawer");
  const btnDrawerSendChat = document.getElementById("btn-drawer-send-chat");
  const sessionTargetModal = document.getElementById("session-target-modal");
  const sessionTargetList = document.getElementById("session-target-list");
  const actionConfirmModal = document.getElementById("action-confirm-modal");
  const btnCloseSessionTargets = document.getElementById("btn-close-session-targets");
  const btnCancelSessionTargets = document.getElementById("btn-cancel-session-targets");
  const btnConfirmSessionTarget = document.getElementById("btn-confirm-session-target");
  const btnCreateSessionAndSend = document.getElementById("btn-create-session-and-send");

  btnOpenFile.addEventListener("click", () => fileInput.click());
  btnEmptyImport.addEventListener("click", () => fileInput.click());
  document.getElementById("btn-empty-config").addEventListener("click", openMineruSettings);
  document.getElementById("btn-empty-restore").addEventListener("click", () => backupInput.click());
  btnSample.addEventListener("click", loadSamplePaper);
  btnEmptySample.addEventListener("click", loadSamplePaper);

  const tabLibrary = document.getElementById("tab-library");
  const btnLibraryImport = document.getElementById("btn-library-import");
  const btnLibraryRestore = document.getElementById("btn-library-restore");
  const btnLibrarySample = document.getElementById("btn-library-sample");
  const librarySearchInput = document.getElementById("library-search-input");
  const librarySearchClear = document.getElementById("library-search-clear");
  const librarySortSelect = document.getElementById("library-sort-select");
  const libraryListContainer = document.getElementById("library-list-container");

  if (libraryListContainer) bindLibraryDeleteHandler(libraryListContainer);
  if (tabLibrary) tabLibrary.addEventListener("click", () => switchView("library"));
  if (btnLibraryImport) btnLibraryImport.addEventListener("click", () => fileInput.click());
  if (btnLibraryRestore) btnLibraryRestore.addEventListener("click", () => backupInput.click());
  if (btnLibrarySample) btnLibrarySample.addEventListener("click", loadSamplePaper);

  if (librarySearchInput) {
    let searchDebounce = null;
    librarySearchInput.addEventListener("input", () => {
      libraryQuery = librarySearchInput.value.trim();
      if (librarySearchClear) librarySearchClear.style.display = libraryQuery ? "inline-block" : "none";
      if (searchDebounce) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => void loadLibraryItems(), 250);
    });
  }
  if (librarySearchClear) {
    librarySearchClear.addEventListener("click", () => {
      libraryQuery = "";
      if (librarySearchInput) librarySearchInput.value = "";
      librarySearchClear.style.display = "none";
      void loadLibraryItems();
    });
  }
  document.querySelectorAll(".library-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".library-filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      libraryFilter = btn.dataset.filter || "all";
      void loadLibraryItems();
    });
  });
  if (librarySortSelect) {
    librarySortSelect.addEventListener("change", () => {
      librarySort = librarySortSelect.value || "lastRead_desc";
      void loadLibraryItems();
    });
  }
  btnTranslateAll.addEventListener("click", () => startFullTranslation());
  btnResearchTools.addEventListener("click", () => void openResearchTools());
  readingModeControl.addEventListener("click", (event) => {
    const button = event.target.closest("[data-reading-mode]");
    if (button) setReadingMode(button.dataset.readingMode);
  });
  btnLocateSync.addEventListener("click", () => locateSameBlock(activePane));
  btnReparse.addEventListener("click", () => {
    if (!currentPdfFile) return;
    if (window.confirm("将绕过现有解析缓存，把同一 PDF 重新提交给 MinerU。现有笔记、书签、译文和用户定稿会保留并重新绑定稳定 Evidence。确认继续？")) {
      void parsePdfFile(currentPdfFile, { force: true });
    }
  });
  btnMineruSettings.addEventListener("click", openMineruSettings);
  document.getElementById("btn-close-mineru-settings").addEventListener("click", closeMineruSettings);
  document.getElementById("btn-cancel-mineru-settings").addEventListener("click", closeMineruSettings);
  document.querySelector("[data-close-mineru-settings]").addEventListener("click", closeMineruSettings);
  if (actionConfirmModal) {
    document.querySelector("[data-close-action-confirm]")?.addEventListener("click", () => closeActionConfirm(false));
    document.getElementById("btn-cancel-action")?.addEventListener("click", () => closeActionConfirm(false));
    document.getElementById("btn-confirm-action")?.addEventListener("click", () => closeActionConfirm(true));
  }
  document.getElementById("btn-save-mineru-settings").addEventListener("click", saveMineruSettings);
  document.getElementById("btn-clear-mineru-token").addEventListener("click", clearMineruToken);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (actionConfirmModal?.classList.contains("open")) {
      closeActionConfirm(false);
      return;
    }
    if (document.getElementById("mineru-settings-modal")?.classList.contains("open")) {
      closeMineruSettings(true);
      return;
    }
    if (sessionTargetModal?.classList.contains("open")) closeSessionTargetPicker();
  });
  thinkingLevelSelect.addEventListener("change", () => {
    currentThinkingLevel = normalizeThinkingLevel(thinkingLevelSelect.value);
    effectiveThinkingLevel = null;
    try { localStorage.setItem("hana-paper-reader-thinking-level", currentThinkingLevel); } catch {}
    renderThinkingLevelUI();
  });

  fileInput.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) handleFile(file);
  });
  backupInput.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void restoreResearchBackup(file);
  });

  agentBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    agentDropdown.classList.toggle("show");
  });
  agentDropdown.addEventListener("pointerdown", (event) => event.stopPropagation());
  agentDropdown.addEventListener("mousedown", (event) => event.stopPropagation());
  agentDropdown.addEventListener("click", (event) => event.stopPropagation());
  const closeAgentDropdownOnOutside = (event) => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const selectorWrap = document.querySelector(".agent-selector-wrap");
    if (path.includes(agentDropdown) || path.includes(selectorWrap)) return;
    if (event.target?.closest?.(".agent-selector-wrap")) return;
    agentDropdown.classList.remove("show");
  };
  document.addEventListener("pointerdown", closeAgentDropdownOnOutside);
  document.addEventListener("mousedown", closeAgentDropdownOnOutside);

  // 全局拖拽事件处理
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragOverlay.classList.add("active");
  });
  window.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  document.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  dragOverlay.addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null) dragOverlay.classList.remove("active");
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragOverlay.classList.remove("active");
    if (e.dataTransfer?.files?.[0]) handleFile(e.dataTransfer.files[0]);
  });

  document.addEventListener("mouseup", handleTextSelection);

  document.getElementById("btn-ask-agent").addEventListener("click", () => askAgentQuestion("default"));
  document.getElementById("btn-ask-formula").addEventListener("click", () => askAgentQuestion("formula"));
  document.getElementById("btn-ask-explain").addEventListener("click", () => askAgentQuestion("explain"));
  document.getElementById("btn-create-note").addEventListener("click", () => void createNoteFromSelection());
  document.getElementById("btn-send-session").addEventListener("click", () => void openSessionTargetPicker());
  document.getElementById("btn-copy-quote").addEventListener("click", copyQuoteText);

  btnCloseDrawer.addEventListener("click", () => {
    askAgentRequestId += 1;
    document.getElementById("answer-drawer").classList.remove("open");
  });
  btnDrawerSendChat.addEventListener("click", () => void openSessionTargetPicker());
  btnCloseSessionTargets.addEventListener("click", closeSessionTargetPicker);
  btnCancelSessionTargets.addEventListener("click", closeSessionTargetPicker);
  document.querySelector("[data-close-session-targets]").addEventListener("click", closeSessionTargetPicker);
  sessionTargetList.addEventListener("click", (event) => {
    const option = event.target.closest("[data-session-target-id]");
    if (option) selectSessionTarget(option.dataset.sessionTargetId);
  });
  btnConfirmSessionTarget.addEventListener("click", () => void confirmSelectedSessionTarget());
  btnCreateSessionAndSend.addEventListener("click", () => void createSessionAndSend());

  // 双栏两侧独立滚动；「对照」模式使用自己的单栏滚动位置。
  const origPane = document.getElementById("original-pane");
  const transPane = document.getElementById("trans-pane");
  const contrastPane = document.getElementById("contrast-pane");
  [origPane, transPane, contrastPane].forEach((pane) => {
    pane.addEventListener("wheel", () => { activePane = pane; }, { passive: true });
    pane.addEventListener("pointerdown", () => { activePane = pane; });
    pane.addEventListener("focusin", () => { activePane = pane; });
    pane.addEventListener("scroll", () => {
      if (!syncingPanes) activePane = pane;
      scheduleProgressSync();
    }, { passive: true });
  });
  activePane = origPane;
  renderThinkingLevelUI();
  updateMineruUI();
}

function applyMineruSettings(data) {
  if (!data?.ok) return;
  mineruConfigured = Boolean(data.configured);
  mineruApiVersion = typeof data.apiVersion === "string" ? data.apiVersion : null;
  mineruSettings = {
    modelVersion: data.modelVersion === "pipeline" ? "pipeline" : "vlm",
    language: ["ch", "en", "japan", "latin"].includes(data.language) ? data.language : "ch",
    enableFormula: data.enableFormula !== false,
    enableTable: data.enableTable !== false,
    ocr: data.ocr === true,
    timeoutSeconds: Number(data.timeoutSeconds || 900),
    pollIntervalSeconds: Number(data.pollIntervalSeconds || 5),
  };
  updateMineruUI();
}

async function loadMineruSettings() {
  try {
    const response = await pluginApiFetch("/api/mineru-settings");
    applyMineruSettings(await response.json());
  } catch {
    updateMineruUI();
  }
}

function updateMineruUI() {
  const dot = document.getElementById("mineru-status-dot");
  const label = document.getElementById("mineru-status-text");
  const button = document.getElementById("btn-mineru-settings");
  const reparse = document.getElementById("btn-reparse");
  dot?.classList.toggle("configured", mineruConfigured);
  const modeLabel = mineruSettings.ocr ? " · OCR" : "";
  if (label) label.textContent = mineruConfigured ? `MinerU · ${mineruSettings.modelVersion.toUpperCase()}${modeLabel}` : "MinerU 未配置";
  if (button) button.title = mineruConfigured
    ? `MinerU Token 已配置；UI ${UI_VERSION} / API ${mineruApiVersion || "未知"}；点击修改解析设置`
    : `PDF 解析前需要配置 MinerU API Token；UI ${UI_VERSION} / API ${mineruApiVersion || "未知"}`;
  const canReparse = Boolean(currentPdfFile
    && currentPdfFileHash
    && normalizedPaperHash(currentPdfFileHash) === normalizedPaperHash(currentPaper.paperHash)
    && !activeParseController);
  if (reparse) reparse.style.display = canReparse ? "inline-flex" : "none";
}

function openMineruSettings() {
  const modal = document.getElementById("mineru-settings-modal");
  document.getElementById("mineru-token-input").value = "";
  document.getElementById("mineru-model-input").value = mineruSettings.modelVersion;
  document.getElementById("mineru-language-input").value = mineruSettings.language;
  document.getElementById("mineru-formula-input").checked = mineruSettings.enableFormula;
  document.getElementById("mineru-table-input").checked = mineruSettings.enableTable;
  document.getElementById("mineru-ocr-input").checked = mineruSettings.ocr;
  document.getElementById("mineru-token-hint").textContent = mineruConfigured
    ? "Token 已配置。留空可保持原值；如需替换，请粘贴新 Token。"
    : "尚未配置。保存后 Token 不会再次显示。";
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  window.setTimeout(() => document.getElementById("mineru-token-input").focus(), 0);
}

function closeMineruSettings(eventOrCancel = false) {
  if (eventOrCancel) {
    pendingPdfFile = null;
    pendingPdfLoadRequestId = 0;
  }
  const modal = document.getElementById("mineru-settings-modal");
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  document.getElementById("mineru-token-input").value = "";
}

function mineruSettingsPayload() {
  return {
    token: document.getElementById("mineru-token-input").value,
    modelVersion: document.getElementById("mineru-model-input").value,
    language: document.getElementById("mineru-language-input").value,
    enableFormula: document.getElementById("mineru-formula-input").checked,
    enableTable: document.getElementById("mineru-table-input").checked,
    ocr: document.getElementById("mineru-ocr-input").checked,
    timeoutSeconds: mineruSettings.timeoutSeconds,
    pollIntervalSeconds: mineruSettings.pollIntervalSeconds,
  };
}

async function saveMineruSettings() {
  const button = document.getElementById("btn-save-mineru-settings");
  const payload = mineruSettingsPayload();
  if (!mineruConfigured && !String(payload.token || "").trim()) {
    await safeToast({ message: "首次使用请填写 MinerU API Token", type: "error" });
    document.getElementById("mineru-token-input").focus();
    return;
  }
  button.disabled = true;
  button.textContent = "正在保存…";
  try {
    const response = await pluginApiFetch("/api/mineru-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "保存失败");
    applyMineruSettings(data);
    closeMineruSettings();
    await safeToast({ message: "MinerU 设置已保存", type: "success" });
    const pendingFile = pendingPdfFile;
    const pendingRequestId = pendingPdfLoadRequestId;
    pendingPdfFile = null;
    pendingPdfLoadRequestId = 0;
    if (pendingFile && pendingRequestId === paperLoadRequestId) {
      void parsePdfFile(pendingFile);
    }
  } catch (error) {
    await safeToast({ message: `保存失败：${error?.message || "设置无效"}`, type: "error" });
  } finally {
    button.disabled = false;
    button.textContent = "保存设置";
  }
}

async function clearMineruToken() {
  if (!window.confirm("确认清除已保存的 MinerU Token？之后导入 PDF 时需要重新填写。")) return;
  try {
    const response = await pluginApiFetch("/api/mineru-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clearToken: true }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "清除失败");
    applyMineruSettings(data);
    pendingPdfFile = null;
    pendingPdfLoadRequestId = 0;
    closeMineruSettings();
    await safeToast({ message: "MinerU Token 已清除", type: "success" });
  } catch (error) {
    await safeToast({ message: `清除失败：${error?.message || "未知错误"}`, type: "error" });
  }
}

function normalizeThinkingLevel(value) {
  const level = String(value || "").trim().toLowerCase();
  if (level === "xhigh") return "max";
  if (level === "minimal") return "low";
  return THINKING_LEVEL_ORDER.includes(level) ? level : "max";
}

function renderThinkingLevelUI() {
  const select = document.getElementById("thinking-level");
  if (!select) return;
  currentThinkingLevel = normalizeThinkingLevel(currentThinkingLevel);
  select.innerHTML = THINKING_LEVEL_ORDER.map((level) => (
    `<option value="${level}">${THINKING_LEVEL_LABELS[level]}</option>`
  )).join("");
  select.value = currentThinkingLevel;
  const effective = effectiveThinkingLevel && effectiveThinkingLevel !== currentThinkingLevel
    ? `；当前模型实际：${THINKING_LEVEL_LABELS[effectiveThinkingLevel] || effectiveThinkingLevel}`
    : "";
  select.title = `请求档位：${THINKING_LEVEL_LABELS[currentThinkingLevel]}${effective}（宿主会按模型能力归一化）`;
}

function applyEffectiveThinkingLevel(data) {
  const actual = String(data?.thinkingLevel || "").trim().toLowerCase();
  if (!actual) return;
  effectiveThinkingLevel = normalizeThinkingLevel(actual);
  renderThinkingLevelUI();
}

function setReadingMode(mode, options = {}) {
  if (!READING_MODES.has(mode)) return;
  currentReadingMode = mode;
  try { localStorage.setItem("hana-paper-reader-reading-mode", mode); } catch {}
  const container = document.getElementById("reader-container");
  if (container) container.dataset.readingMode = mode;
  document.querySelectorAll(".reading-mode-button[data-reading-mode]").forEach((button) => {
    const active = button.dataset.readingMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const originalPane = document.getElementById("original-pane");
  const translationPane = document.getElementById("trans-pane");
  const contrastPane = document.getElementById("contrast-pane");
  if (mode === "original" && originalPane) activePane = originalPane;
  if (mode === "translation" && translationPane) activePane = translationPane;
  if (mode === "contrast" && contrastPane) activePane = contrastPane;
  if (mode === "bilingual" && activePane === contrastPane) activePane = originalPane;
  const align = document.getElementById("btn-locate-sync");
  if (align) align.style.display = currentPaper.blocks.length && mode === "bilingual" ? "inline-flex" : "none";
  if (!options.silent) {
    researchTools?.refresh();
    if (currentPaper.blocks.length) {
      scheduleResearchSync();
      scheduleProgressSync();
    }
  }
}

function translationState(blockId) {
  const hasTranslation = Boolean(String(currentPaper.translations?.[blockId] || "").trim());
  const state = currentPaper.translationStates?.[blockId];
  if (hasTranslation && state?.kind === "final") return { kind: "final", locked: state.locked !== false };
  return { kind: hasTranslation ? "ai" : "none", locked: false };
}

function isFinalTranslation(blockId) {
  return translationState(blockId).kind === "final";
}

function researchPaperView() {
  const currentHash = normalizedPaperHash(currentPaper.paperHash);
  const activeHash = normalizedPaperHash(activePaperHash);
  if (activeView !== "paper" || (activeHash && currentHash !== activeHash)) {
    return {
      paperHash: activeHash || null,
      title: activeView === "paper" ? "正在载入论文…" : "我的文库",
      blocks: [],
      translations: {},
      translationStates: {},
      loaded: false,
      structureDetached: false,
      readingMode: currentReadingMode,
    };
  }
  return {
    ...currentPaper,
    loaded: currentPaper.blocks.length > 0,
    blocks: currentPaper.blocks.map((block) => ({
      ...block,
      translatedText: currentPaper.translations?.[block.id] || "",
    })),
    agentId: currentAgent?.id || null,
    modelRef: selectedModelRefForAgent(currentAgent),
    thinkingLevel: currentThinkingLevel,
    glossaryTerms: currentPaper.glossaryTerms || {},
    translationStates: currentPaper.translationStates || {},
    readingMode: currentReadingMode,
  };
}

function selectedResearchBlock() {
  const activeHash = normalizedPaperHash(activePaperHash);
  // A paper can be hidden while its final hash-scoped snapshot is flushing.
  // Do not discard the old pane selection merely because the library view is
  // visible; only an identity mismatch means the DOM belongs to another paper.
  if (activeHash && normalizedPaperHash(currentPaper.paperHash) !== activeHash) return null;
  const visibleId = firstVisibleBlock(activePane)?.dataset?.id;
  const id = selectedBlockId || visibleId;
  return currentPaper.blocks.find((block) => block.id === id) || currentPaper.blocks[0] || null;
}

function currentReadingProgress() {
  const pane = activePane || document.getElementById("original-pane");
  const block = selectedResearchBlock();
  const maximum = pane ? Math.max(0, pane.scrollHeight - pane.clientHeight) : 0;
  const percent = maximum > 0 ? Math.round(Math.max(0, Math.min(1, pane.scrollTop / maximum)) * 100) : 0;
  const uiState = researchTools?.uiState?.() || restoredResearchUiState;
  return {
    paperHash: currentPaper.paperHash,
    page: Number(block?.page || 1),
    percent,
    blockId: block?.id || null,
    pageCount: Number(currentPaper.pageCount || 0),
    originalScrollTop: Math.max(0, Number(document.getElementById("original-pane")?.scrollTop || 0)),
    translationScrollTop: Math.max(0, Number(document.getElementById("trans-pane")?.scrollTop || 0)),
    contrastScrollTop: Math.max(0, Number(document.getElementById("contrast-pane")?.scrollTop || 0)),
    readingMode: currentReadingMode,
    noteDraft: uiState?.noteDraft || {},
    searchState: uiState?.searchState || {},
  };
}

function normalizedPaperHash(value) {
  const hash = String(value || "").trim().toLowerCase();
  return isPaperHash(hash) ? hash : "";
}

function paperRefIsCurrent(revision, paperRef = currentPaper) {
  return paperRef === currentPaper && revision === paperRevision;
}

function paperContextIsCurrent(hash, revision, paperRef = currentPaper) {
  const normalizedHash = normalizedPaperHash(hash);
  return Boolean(normalizedHash)
    && paperRefIsCurrent(revision, paperRef)
    && normalizedPaperHash(currentPaper.paperHash) === normalizedHash;
}

function activePaperContextIsCurrent(hash, revision, paperRef = currentPaper) {
  const normalizedHash = normalizedPaperHash(hash);
  return paperContextIsCurrent(normalizedHash, revision, paperRef)
    && activeView === "paper"
    && normalizedPaperHash(activePaperHash) === normalizedHash
    && !deletedPaperHashes.has(normalizedHash);
}

function researchUiStateSnapshot() {
  try {
    return cloneJson(researchTools?.uiState?.() || restoredResearchUiState) || { searchState: {}, noteDraft: null };
  } catch {
    return cloneJson(restoredResearchUiState) || { searchState: {}, noteDraft: null };
  }
}

function capturePaperViewSnapshot(hash = currentPaper.paperHash) {
  const normalizedHash = normalizedPaperHash(hash);
  if (!normalizedHash || normalizedPaperHash(currentPaper.paperHash) !== normalizedHash) return null;
  const progress = cloneJson(currentReadingProgress()) || {};
  const snapshot = {
    paperHash: normalizedHash,
    revision: paperRevision,
    readingMode: currentReadingMode,
    selectedBlockId,
    activePaneId: activePane?.id || null,
    progress: { ...progress, paperHash: normalizedHash },
    researchUiState: researchUiStateSnapshot(),
  };
  paperViewSnapshots.set(normalizedHash, snapshot);
  return snapshot;
}

function restorePaperProgressInView(progress, hash, revision, paperRef, options = {}) {
  const normalizedHash = normalizedPaperHash(hash);
  if (!normalizedHash || !progress) return false;
  const restoreToken = ++paperViewRestoreRequestId;
  const apply = () => {
    if (restoreToken !== paperViewRestoreRequestId || !activePaperContextIsCurrent(normalizedHash, revision, paperRef)) return false;
    const original = document.getElementById("original-pane");
    const translation = document.getElementById("trans-pane");
    const contrast = document.getElementById("contrast-pane");
    if (original) original.scrollTop = Math.max(0, Number(progress.originalScrollTop || 0));
    if (translation) translation.scrollTop = Math.max(0, Number(progress.translationScrollTop || 0));
    if (contrast) contrast.scrollTop = Math.max(0, Number(progress.contrastScrollTop || 0));
    if (!Number(progress.originalScrollTop) && !Number(progress.translationScrollTop) && !Number(progress.contrastScrollTop) && progress.blockId) locateResearchBlock(progress.blockId);
    if (progress.searchState?.query) highlightSearchInReader(progress.searchState.query);
    capturePaperViewSnapshot(normalizedHash);
    return true;
  };
  const delay = Math.max(0, Number(options.delayMs ?? 0));
  if (delay > 0) window.setTimeout(apply, delay);
  else if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(apply);
  else window.setTimeout(apply, 0);
  return true;
}

function resetResearchUiForPaper() {
  paperViewRestoreRequestId += 1;
  restoredResearchUiState = {
    searchState: { query: "", scope: "all", language: "both", types: [] },
    noteDraft: null,
  };
  activeSearchQuery = "";
  selectedText = "";
  selectedContext = "";
  selectedFromTranslation = false;
  document.getElementById("selection-toolbar")?.style && (document.getElementById("selection-toolbar").style.display = "none");
  document.getElementById("answer-drawer")?.classList.remove("open");
  const sessionModal = document.getElementById("session-target-modal");
  sessionModal?.classList.remove("open");
  sessionModal?.setAttribute("aria-hidden", "true");
  clearSearchHighlights();
  researchTools?.resetPaperState?.();
  researchTools?.restoreUiState(restoredResearchUiState);
}

function applyPaperViewSnapshot(hash, options = {}) {
  const normalizedHash = normalizedPaperHash(hash);
  const snapshot = paperViewSnapshots.get(normalizedHash);
  if (!snapshot || deletedPaperHashes.has(normalizedHash)) return false;
  const revision = options.revision === undefined ? paperRevision : options.revision;
  const paperRef = options.paperRef || currentPaper;
  if (!activePaperContextIsCurrent(normalizedHash, revision, paperRef)) return false;
  if (READING_MODES.has(snapshot.readingMode)) setReadingMode(snapshot.readingMode, { silent: true });
  const pane = ["original-pane", "trans-pane", "contrast-pane"].includes(snapshot.activePaneId)
    ? document.getElementById(snapshot.activePaneId)
    : null;
  if (pane) activePane = pane;
  selectedBlockId = currentPaper.blocks.some((block) => block.id === snapshot.selectedBlockId) ? snapshot.selectedBlockId : null;
  const uiState = cloneJson(snapshot.researchUiState) || { searchState: {}, noteDraft: null };
  if (uiState.noteDraft && normalizedPaperHash(uiState.noteDraft.paperHash) !== normalizedHash) uiState.noteDraft = null;
  restoredResearchUiState = uiState;
  researchTools?.restoreUiState(restoredResearchUiState);
  if (snapshot.progress) restorePaperProgressInView(snapshot.progress, normalizedHash, revision, paperRef, options);
  return true;
}

function buildPaperSyncPayload(source, paperHash, readingMode = currentReadingMode) {
  const parser = typeof source?.parser === "string" ? { kind: source.parser } : (source?.parser && typeof source.parser === "object" ? source.parser : {});
  return {
    paperHash,
    expectedRevision: source?.revision !== undefined ? source.revision : undefined,
    operation: "autosave",
    metadata: { ...(source?.metadata && typeof source.metadata === "object" ? source.metadata : {}), title: String(source?.title || source?.metadata?.title || "未命名论文") },
    parser: {
      kind: parser.kind || (source?.isPdf ? "mineru" : "text"),
      modelVersion: source?.modelVersion || parser.modelVersion || null,
      pageCount: Number(source?.pageCount || parser.pageCount || 0),
      ocrUsed: source?.ocrUsed === true || parser.ocrUsed === true,
      ocrFallback: source?.ocrFallback === true || parser.ocrFallback === true,
    },
    assets: cloneJson(source?.resources || source?.assets || []) || [],
    blocks: cloneJson(Array.isArray(source?.blocks) ? source.blocks : []) || [],
    translations: cloneJson(source?.translations || {}) || {},
    translationStates: cloneJson(source?.translationStates || {}) || {},
    readingMode,
    translationGlossaryVersion: Number(source?.translationGlossaryVersion || source?.glossaryVersion || 0),
    replaceTranslations: source?.replaceTranslations === true,
  };
}

async function resolvePaperHashForSnapshot(paperRef, revision, source) {
  const existing = normalizedPaperHash(source?.paperHash);
  if (existing) return existing;
  const pending = hashPaperSource(source);
  currentPaperHashPromise = pending;
  try {
    const hash = normalizedPaperHash(await pending);
    if (hash && paperRef === currentPaper && revision === paperRevision && !normalizedPaperHash(currentPaper.paperHash)) {
      currentPaper.paperHash = hash;
    }
    return hash;
  } finally {
    if (currentPaperHashPromise === pending) currentPaperHashPromise = null;
  }
}

function makePaperSyncSnapshot({ paperRef, revision, stateRevision, source, paperHash, progress, readingMode, selectedBlockId: snapshotSelectedBlockId, activePaneId, researchUiState }) {
  const snapshot = {
    paperHash,
    revision,
    stateRevision,
    paperRef,
    payload: buildPaperSyncPayload(source, paperHash, readingMode),
    progress: { ...progress, paperHash },
    readingMode,
    selectedBlockId: snapshotSelectedBlockId,
    activePaneId,
    researchUiState,
  };
  if (paperRef === currentPaper && revision === paperRevision && !normalizedPaperHash(currentPaper.paperHash)) {
    currentPaper.paperHash = paperHash;
  }
  paperViewSnapshots.set(paperHash, {
    paperHash,
    revision,
    readingMode,
    selectedBlockId: snapshotSelectedBlockId,
    activePaneId,
    progress: snapshot.progress,
    researchUiState,
  });
  return snapshot;
}

function capturePaperSyncSnapshot(options = {}) {
  const paperRef = currentPaper;
  const revision = paperRevision;
  const stateRevision = researchStateRevision;
  if (!Array.isArray(paperRef?.blocks) || !paperRef.blocks.length) return null;
  const source = cloneJson(paperRef) || {};
  const progress = cloneJson(currentReadingProgress()) || {};
  const researchUiState = researchUiStateSnapshot();
  const readingMode = currentReadingMode;
  const snapshotSelectedBlockId = selectedBlockId;
  const activePaneId = activePane?.id || null;
  const requestedHash = normalizedPaperHash(options.paperHash);
  const existingHash = normalizedPaperHash(source.paperHash);
  if (existingHash) {
    if (requestedHash && requestedHash !== existingHash) return null;
    // Keep the known-hash path synchronous. Close/delete actions can replace
    // currentPaper immediately after calling flushCurrentPaperState(); the
    // snapshot must already own a detached copy at that point.
    return makePaperSyncSnapshot({
      paperRef,
      revision,
      stateRevision,
      source,
      paperHash: existingHash,
      progress,
      readingMode,
      selectedBlockId: snapshotSelectedBlockId,
      activePaneId,
      researchUiState,
    });
  }
  return (async () => {
    const paperHash = await resolvePaperHashForSnapshot(paperRef, revision, source);
    if (!paperHash || (requestedHash && requestedHash !== paperHash)) return null;
    return makePaperSyncSnapshot({
      paperRef,
      revision,
      stateRevision,
      source,
      paperHash,
      progress,
      readingMode,
      selectedBlockId: snapshotSelectedBlockId,
      activePaneId,
      researchUiState,
    });
  })();
}

function clearPaperSyncTimers(paperHash) {
  const hash = normalizedPaperHash(paperHash);
  if (!hash) return;
  const researchTimer = researchSyncTimers.get(hash);
  if (researchTimer !== undefined) window.clearTimeout(researchTimer);
  researchSyncTimers.delete(hash);
  const progressTimer = progressSyncTimers.get(hash);
  if (progressTimer !== undefined) window.clearTimeout(progressTimer);
  progressSyncTimers.delete(hash);
}

async function waitForPaperSync(hash) {
  const normalizedHash = normalizedPaperHash(hash);
  if (!normalizedHash) return true;
  // A paper flush registers progress only after its paper POST resolves. Keep
  // observing the maps until no newer chain appeared during the previous wait;
  // otherwise deletion could start in the small paper->progress handoff gap.
  let rounds = 0;
  while (rounds < 20) {
    rounds += 1;
    const pending = [
      paperSyncChains.get(normalizedHash),
      progressSyncChains.get(normalizedHash),
      translationCacheChains.get(normalizedHash),
    ].filter(Boolean);
    if (!pending.length) break;
    const observed = new Set(pending);
    await Promise.allSettled(pending);
    const newerChain = [
      paperSyncChains.get(normalizedHash),
      progressSyncChains.get(normalizedHash),
      translationCacheChains.get(normalizedHash),
    ].some((chain) => chain && !observed.has(chain));
    if (!newerChain) break;
  }
  return !paperSyncChains.has(normalizedHash)
    && !progressSyncChains.has(normalizedHash)
    && !translationCacheChains.has(normalizedHash)
    && !paperSyncFailures.has(normalizedHash)
    && !progressSyncFailures.has(normalizedHash);
}

function invalidatePaperContext(hash) {
  const normalizedHash = normalizedPaperHash(hash);
  if (!normalizedHash || normalizedPaperHash(currentPaper.paperHash) !== normalizedHash) return false;
  paperLoadRequestId += 1;
  paperRevision += 1;
  researchStateRevision += 1;
  if (activeParseController) void cancelActiveParse();
  return true;
}

async function preparePaperDataMutation(hash, purpose = "数据变更") {
  const normalizedHash = normalizedPaperHash(hash);
  if (!normalizedHash) throw new Error("论文指纹无效");
  paperSyncBlocked.add(normalizedHash);
  clearPaperSyncTimers(normalizedHash);
  const isCurrent = invalidatePaperContext(normalizedHash);
  try {
    if (isCurrent) {
      const hadStructure = Array.isArray(currentPaper.blocks) && currentPaper.blocks.length > 0;
      const flushed = await flushCurrentPaperState({ paperHash: normalizedHash, allowBlocked: true });
      if (hadStructure && flushed !== true) throw new Error(`${purpose}前无法完成论文同步，已停止操作`);
    }
    if (!(await waitForPaperSync(normalizedHash))) throw new Error(`${purpose}前无法完成论文同步，已停止操作`);
    return normalizedHash;
  } catch (error) {
    releasePaperDataMutation(normalizedHash);
    throw error;
  }
}

function releasePaperDataMutation(hash, reschedule = true) {
  const normalizedHash = normalizedPaperHash(hash);
  if (!normalizedHash) return;
  paperSyncBlocked.delete(normalizedHash);
  if (reschedule && normalizedPaperHash(currentPaper.paperHash) === normalizedHash && currentPaper.blocks.length) scheduleResearchSync();
}

async function preparePaperDeletion(hash) {
  return preparePaperDataMutation(hash, "删除");
}

function releasePaperDeletion(hash, reschedule = true) {
  releasePaperDataMutation(hash, reschedule);
}

function finalizePaperDeletion(hash, message = "论文及其全部研究数据已删除。") {
  const normalizedHash = normalizedPaperHash(hash);
  if (!normalizedHash) return;
  const wasCurrent = normalizedPaperHash(currentPaper.paperHash) === normalizedHash;
  const wasActive = activeView === "paper" && normalizedPaperHash(activePaperHash) === normalizedHash;
  deletedPaperHashes.add(normalizedHash);
  clearPaperSyncTimers(normalizedHash);
  paperViewSnapshots.delete(normalizedHash);
  pdfFilesByHash.delete(normalizedHash);
  paperSyncChains.delete(normalizedHash);
  progressSyncChains.delete(normalizedHash);
  translationCacheChains.delete(normalizedHash);
  paperSyncFailures.delete(normalizedHash);
  progressSyncFailures.delete(normalizedHash);
  if (wasActive) {
    // closePaperTab invalidates the old view and selects the next tab, or the
    // library when this was the last one. It intentionally skips another flush
    // because preparePaperDeletion already drained the hash-scoped queues.
    closePaperTab(normalizedHash, { skipFlush: true });
  } else {
    removePaperTab(normalizedHash);
    renderWorkspaceTabs();
    saveTabsState();
  }
  if (wasCurrent && !wasActive) clearCurrentPaperView(message, { preserveView: activeView === "library" });
  paperSyncBlocked.delete(normalizedHash);
  void loadLibraryItems({ quiet: true });
}

async function deletePaperRecord(hash, title = "此论文") {
  const candidateHash = normalizedPaperHash(hash);
  recordQaEvent("paper.delete.start", { paperHash: candidateHash, title });
  let normalizedHash = candidateHash;
  try {
    normalizedHash = await preparePaperDeletion(candidateHash);
    const response = await pluginApiFetch(`/api/research/paper?paperHash=${encodeURIComponent(normalizedHash)}`, { method: "DELETE" });
    let data = {};
    try { data = await response.json(); } catch {}
    recordQaEvent("paper.delete.response", { paperHash: normalizedHash, status: response.status, ok: response.ok, deleted: data.deleted === true });
    if (!response.ok && response.status !== 404) throw new Error(data.error || "删除论文失败");
    if (data.ok === false && response.status !== 404) throw new Error(data.error || "删除论文失败");
    finalizePaperDeletion(normalizedHash);
    return true;
  } catch (error) {
    recordQaEvent("paper.delete.failed", { paperHash: normalizedHash || candidateHash, message: String(error?.message || "删除论文失败") }, "error");
    releasePaperDeletion(normalizedHash || candidateHash);
    throw error;
  }
}

function enqueuePaperSync(snapshot, options = {}) {
  const hash = normalizedPaperHash(snapshot?.paperHash);
  if (!hash || deletedPaperHashes.has(hash) || (paperSyncBlocked.has(hash) && options.allowBlocked !== true)) return Promise.resolve(null);
  paperSyncFailures.delete(hash);
  const previous = paperSyncChains.get(hash) || Promise.resolve({ ok: true });
  const request = previous.then(async () => {
    const response = await pluginApiFetch("/api/research/paper", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot.payload),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "论文工作区同步失败");
    if (!data.paper) throw new Error("论文工作区同步失败：服务端未返回论文");
    return data.paper;
  });
  let tracked;
  tracked = request.then(
    (value) => { paperSyncFailures.delete(hash); return { ok: true, value }; },
    (error) => { paperSyncFailures.set(hash, error); return { ok: false, error }; },
  ).finally(() => {
    if (paperSyncChains.get(hash) === tracked) paperSyncChains.delete(hash);
  });
  paperSyncChains.set(hash, tracked);
  return request;
}

function enqueueProgressSync(progress, options = {}) {
  const hash = normalizedPaperHash(progress?.paperHash);
  if (!hash || deletedPaperHashes.has(hash) || (paperSyncBlocked.has(hash) && options.allowBlocked !== true)) return Promise.resolve(null);
  progressSyncFailures.delete(hash);
  const previousProgress = progressSyncChains.get(hash) || Promise.resolve({ ok: true });
  // A freshly imported paper must be persisted before its progress record. The
  // paper chain is deliberately tracked separately from the progress chain so
  // different papers remain independent while each paper keeps a strict order.
  const previousPaper = paperSyncChains.get(hash) || Promise.resolve({ ok: true });
  const request = previousProgress.then(() => previousPaper).then((paperResult) => {
    if (paperResult?.ok === false) throw paperResult.error || new Error("论文工作区同步失败");
    return true;
  }).then(async () => {
    const response = await pluginApiFetch("/api/research/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...cloneJson(progress), paperHash: hash }),
    });
    if (!response.ok) throw new Error("阅读进度同步失败");
    return true;
  });
  let tracked;
  tracked = request.then(
    (value) => { progressSyncFailures.delete(hash); return { ok: true, value }; },
    (error) => { progressSyncFailures.set(hash, error); return { ok: false, error }; },
  ).finally(() => {
    if (progressSyncChains.get(hash) === tracked) progressSyncChains.delete(hash);
  });
  progressSyncChains.set(hash, tracked);
  return request;
}

function flushPaperSnapshot(snapshot, options = {}) {
  if (!snapshot) return Promise.resolve(false);
  const allowBlocked = options.allowBlocked === true;
  const paperRequest = enqueuePaperSync(snapshot, { allowBlocked });
  // Do not issue progress in parallel with the paper upsert: setProgress is
  // intentionally paper-scoped and rejects a hash that is not persisted yet.
  const progressRequest = paperRequest.then((paper) => {
    if (!paper) throw new Error("论文工作区同步失败：服务端未返回论文");
    return enqueueProgressSync(snapshot.progress, { allowBlocked });
  });
  return Promise.allSettled([paperRequest, progressRequest]).then((results) => {
    const paperSucceeded = results[0].status === "fulfilled" && Boolean(results[0].value);
    const progressSucceeded = results[1].status === "fulfilled" && results[1].value === true;
    if (paperContextIsCurrent(snapshot.paperHash, snapshot.revision, snapshot.paperRef)
        && snapshot.stateRevision === researchStateRevision
        && paperSucceeded) {
      currentPaper.replaceTranslations = false;
    }
    return paperSucceeded && progressSucceeded;
  });
}

function flushCurrentPaperState(options = {}) {
  const hint = normalizedPaperHash(options.paperHash);
  if (hint && hint !== normalizedPaperHash(currentPaper.paperHash)) return Promise.resolve(false);
  const currentHash = normalizedPaperHash(currentPaper.paperHash);
  if (currentHash) clearPaperSyncTimers(currentHash);
  // Capture before returning the Promise. Callers such as closePaperTab() may
  // replace currentPaper in the same JavaScript turn after invoking this
  // function; an initial `await` here would otherwise snapshot the next tab.
  const captured = capturePaperSyncSnapshot(options);
  return Promise.resolve(captured).then((snapshot) => flushPaperSnapshot(snapshot, options));
}

async function initializeResearchTools() {
  if (researchTools) return researchTools;
  if (researchToolsPromise) return researchToolsPromise;
  researchToolsPromise = (async () => {
    const moduleUrl = document.body?.dataset?.researchToolsUrl;
    const mount = document.querySelector(".main-layout");
    if (!moduleUrl || !mount) throw new Error("研究工具资源未加载");
    const module = await import(moduleUrl);
    researchTools = module.createResearchTools({
      root: mount,
      document,
      apiFetch: pluginApiFetch,
      apiUrl: pluginApiUrl,
      resourceOpen: hanaBridge.resources.open,
      clipboardWrite: hanaBridge.clipboard.writeText,
      diagnosticLog: recordQaEvent,
      confirmAction: requestActionConfirmation,
      getPaper: researchPaperView,
      getSelectedBlock: selectedResearchBlock,
      getProgress: currentReadingProgress,
      getSelection: () => ({ text: selectedText, context: selectedContext, blockId: selectedBlockId, fromTranslation: selectedFromTranslation }),
      onLocateBlock: locateResearchBlock,
      onSearchHighlight: highlightSearchInReader,
      onUiStateChanged: (uiState) => {
        const currentHash = normalizedPaperHash(currentPaper.paperHash);
        const stateHash = normalizedPaperHash(uiState?.paperHash || uiState?.noteDraft?.paperHash);
        // UI callbacks from the previous paper may arrive after the drawer has
        // been reset. Never let such a callback overwrite the new paper's
        // progress snapshot, and never schedule a write while in the library.
        if (!currentHash || (stateHash && stateHash !== currentHash)) return;
        restoredResearchUiState = { ...uiState, paperHash: currentHash };
        scheduleProgressSync();
      },
      onPaperStateChanged: async (change) => {
        const changedPaperHash = normalizedPaperHash(change?.paperHash);
        const currentHash = normalizedPaperHash(currentPaper.paperHash);
        if (!currentHash || (changedPaperHash && changedPaperHash !== currentHash)) return;
        if (change?.kind === "glossary") {
          const glossary = change.glossary || change.data?.glossary;
          if (glossary) {
            const applied = applyGlossaryRecord(glossary, { paperHash: changedPaperHash || currentHash });
            if (applied) await refreshGlossaryState({ paperHash: changedPaperHash || currentHash });
          } else if (currentHash) {
            await refreshGlossaryState({ paperHash: changedPaperHash || currentHash });
          }
        }
        researchTools?.refresh();
      },
      onPaperDataChanged: (change) => {
        const changedPaperHash = normalizedPaperHash(change?.paper?.paperHash || change?.paperHash);
        const currentHash = normalizedPaperHash(currentPaper.paperHash);
        if (!currentHash || (changedPaperHash && changedPaperHash !== currentHash)) return;
        if (change?.paper?.blocks?.length) {
          const parser = change.paper.parser || {};
          loadPaper({ ...change.paper, title: change.paper.metadata?.title || currentPaper.title, isPdf: parser.kind === "mineru", pageCount: parser.pageCount || 0, restored: true, cached: true });
        } else if (change?.action === "structure-keep-notes" && change?.paper) {
          loadDetachedResearchRecord({ ...change.paper, structureDetached: true });
        }
      },
      onBeforePaperMutation: ({ paperHash, purpose } = {}) => preparePaperDataMutation(paperHash, purpose || "数据变更"),
      onPaperMutationFailed: ({ paperHash } = {}) => releasePaperDataMutation(paperHash),
      onPaperMutationFinished: ({ paperHash } = {}) => releasePaperDataMutation(paperHash),
      onBeforePaperDeleted: ({ paperHash } = {}) => preparePaperDeletion(paperHash),
      onPaperDeletionFailed: ({ paperHash } = {}) => releasePaperDeletion(paperHash),
      onPaperDeleted: ({ paperHash } = {}) => finalizePaperDeletion(paperHash, "论文及其全部研究数据已删除。"),
      onCancelTask: async (task) => {
        if (task?.id && activeParseController && activeParseTask?.id === task.id) {
          await cancelActiveParse();
          return;
        }
        if (task?.id) {
          const response = await pluginApiFetch(`/api/research/parse-status/tasks/${encodeURIComponent(task.id)}/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          if (!response.ok) throw new Error("解析任务取消失败");
        }
      },
      toast: safeToast,
    });
    return researchTools;
  })().catch((error) => {
    researchToolsPromise = null;
    throw error;
  });
  return researchToolsPromise;
}

async function openResearchTools() {
  try {
    await ensureResearchPaper();
    (await initializeResearchTools()).refresh().open();
  } catch (error) {
    await safeToast({ message: `研究工具打开失败：${error?.message || "资源不可用"}`, type: "error" });
  }
}

function clearCurrentPaperView(message = "未载入文献", options = {}) {
  const previousHash = normalizedPaperHash(currentPaper.paperHash);
  cancelActiveParse();
  resetTranslationRunState();
  hidePaperTransientUi();
  pendingPdfFile = null;
  pendingPdfLoadRequestId = 0;
  resetPdfPreview();
  currentPdfFile = null;
  currentPdfFileHash = null;
  selectedBlockId = null;
  researchStateRevision += 1;
  paperRevision += 1;
  currentPaper = { title: "未导入文献", paperHash: null, blocks: [], translations: {}, translationStates: {}, glossaryVersion: 0, glossaryTerms: {}, translationGlossaryVersion: 0 };
  if (!options.preserveView) {
    activePaperHash = null;
    activeView = "library";
    paperLoadingHash = null;
  }
  if (previousHash) clearPaperSyncTimers(previousHash);
  resetResearchUiForPaper();
  activePane = document.getElementById("original-pane") || activePane;
  const reader = document.getElementById("reader-container");
  const empty = document.getElementById("empty-view");
  if (reader) reader.style.display = "none";
  if (empty) empty.style.display = "flex";
  const readingModeControl = document.getElementById("reading-mode-control");
  const translateButton = document.getElementById("btn-translate-all");
  const researchButton = document.getElementById("btn-research-tools");
  if (readingModeControl) readingModeControl.style.display = "none";
  if (translateButton) translateButton.style.display = "none";
  if (researchButton) researchButton.style.display = "none";
  const badge = document.getElementById("paper-badge");
  if (badge) badge.textContent = message;
  const description = document.querySelector(".empty-desc");
  if (description) description.textContent = "选择一个动作即可进入阅读。解析模型、文件指纹和结构块等技术细节只在需要时展开。";
  updateMineruUI();
  researchTools?.refresh();
}

let activeRestoreRequestId = 0;

async function restoreResearchBackup(file) {
  if (!file || file.size > 256 * 1024 * 1024) {
    await safeToast({ message: "备份文件为空或超过 256 MB", type: "error" });
    return;
  }
  let mutationHash = "";
  const currentRequestId = ++activeRestoreRequestId;
  const initialActiveHash = normalizedPaperHash(activePaperHash);
  try {
    const backup = JSON.parse(await file.text());
    if (backup?.format !== "hana-paper-reader-backup") throw new Error("不是 Hana Paper Reader 备份文件");
    mutationHash = normalizedPaperHash(backup?.paperHash || backup?.paper?.paperHash);
    if (!mutationHash) throw new Error("备份缺少有效论文指纹");
    if (backup?.paperHash && normalizedPaperHash(backup.paperHash) !== mutationHash) throw new Error("备份论文指纹无效");
    if (backup?.paper?.paperHash && normalizedPaperHash(backup.paper.paperHash) !== mutationHash) throw new Error("备份论文指纹不一致");
    if (!window.confirm("恢复会用备份内容替换同一论文当前的数据；其他论文不受影响。确认继续？")) return;
    await preparePaperDataMutation(mutationHash, "恢复备份");
    const response = await pluginApiFetch("/api/research/restore", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(backup),
    });
    const data = await response.json();
    if (!response.ok || !data.ok || !data.paper) throw new Error(data.error || "备份恢复失败");
    // The server has committed the replacement. Release the write block before
    // loading the returned paper so its normal follow-up synchronization can
    // proceed without being mistaken for a stale cleanup request.
    releasePaperDataMutation(mutationHash, false);

    // Check if the user navigated away while restore was in flight
    if (currentRequestId === activeRestoreRequestId && normalizedPaperHash(activePaperHash) === mutationHash) {
      const parser = data.paper.parser || {};
      const loaded = loadPaper({ ...data.paper, title: data.paper.metadata?.title || "已恢复论文", isPdf: parser.kind === "mineru", pageCount: parser.pageCount || 0, restored: true, cached: true });
      if (!loaded) throw new Error("备份已恢复，但阅读器未能载入论文");
      await safeToast({ message: "研究备份已恢复；重新选择同一 PDF 可恢复原页预览，不会重复解析", type: "success" });
    } else {
      void loadLibraryItems({ quiet: true });
      await safeToast({ message: `论文 ${data.paper.metadata?.title || mutationHash.slice(0, 8)} 的备份已在后台恢复完成`, type: "success" });
    }
  } catch (error) {
    if (mutationHash) releasePaperDataMutation(mutationHash);
    await safeToast({ message: `备份恢复失败：${error?.message || "文件无效"}`, type: "error" });
  }
}

async function createNoteFromSelection() {
  document.getElementById("selection-toolbar").style.display = "none";
  if (!selectedBlockId) {
    await safeToast({ message: "请先划选一段原文或译文", type: "error" });
    return;
  }
  try {
    const tools = await initializeResearchTools();
    tools.refresh().open("notes");
  } catch (error) {
    await safeToast({ message: `研究笔记打开失败：${error?.message || "资源不可用"}`, type: "error" });
  }
}

function clearSearchHighlights() {
  document.querySelectorAll("mark[data-hpr-search]").forEach((mark) => mark.replaceWith(mark.textContent || ""));
  document.querySelectorAll(".pdf-visual-preview.search-page-hit").forEach((element) => element.classList.remove("search-page-hit"));
}

function highlightSearchInReader(query, blockId = null, page = null) {
  clearSearchHighlights();
  activeSearchQuery = String(query || "").trim();
  if (!activeSearchQuery) return;
  const targets = blockId
    ? [
      document.getElementById(`orig-${blockId}`),
      document.getElementById(`trans-${blockId}`),
      document.getElementById(`contrast-orig-${blockId}`),
      document.getElementById(`contrast-trans-${blockId}`),
    ].filter(Boolean)
    : [...document.querySelectorAll(".block-copy")];
  const needle = activeSearchQuery.toLocaleLowerCase();
  for (const target of targets) {
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest("button,textarea,script,style,mark") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const value = node.nodeValue || "";
      const lower = value.toLocaleLowerCase();
      let cursor = 0;
      const fragment = document.createDocumentFragment();
      let found = false;
      while (cursor < value.length) {
        const index = lower.indexOf(needle, cursor);
        if (index < 0) { fragment.append(value.slice(cursor)); break; }
        found = true;
        fragment.append(value.slice(cursor, index));
        const mark = document.createElement("mark");
        mark.dataset.hprSearch = "true";
        mark.textContent = value.slice(index, index + activeSearchQuery.length);
        fragment.appendChild(mark);
        cursor = index + activeSearchQuery.length;
      }
      if (found) node.replaceWith(fragment);
    }
  }
  const selectedPage = Number(page || currentPaper.blocks.find((block) => block.id === blockId)?.page || 0);
  if (selectedPage > 0) document.querySelectorAll(`.pdf-visual-preview[data-pdf-page="${selectedPage}"]`).forEach((element) => element.classList.add("search-page-hit"));
}

function loadDetachedResearchRecord(paper, options = {}) {
  const requestId = options.requestId;
  const hash = normalizedPaperHash(paper?.paperHash);
  if (!hash || (requestId !== undefined && !paperLoadIsCurrent(requestId, hash))) return false;
  paperRevision += 1;
  researchStateRevision += 1;
  const parser = paper.parser && typeof paper.parser === "object" ? paper.parser : {};
  currentPaper = {
    ...paper,
    paperHash: hash,
    title: paper.metadata?.title || "保留的研究记录",
    blocks: [],
    translations: {},
    translationStates: {},
    structureDetached: true,
    loaded: true,
    isPdf: parser.kind === "mineru",
    pageCount: Number(parser.pageCount || 0),
  };
  activePaperHash = hash;
  activeView = "paper";
  paperLoadingHash = null;
  upsertPaperTab({ paperHash: hash, title: currentPaper.title, isPdf: currentPaper.isPdf, pageCount: currentPaper.pageCount });
  resetResearchUiForPaper();
  const badge = document.getElementById("paper-badge");
  if (badge) badge.textContent = `${currentPaper.title} · 仅保留研究记录`;
  const empty = document.getElementById("empty-view");
  const reader = document.getElementById("reader-container");
  if (empty) empty.style.display = "flex";
  if (reader) reader.style.display = "none";
  document.getElementById("reading-mode-control").style.display = "none";
  document.getElementById("btn-translate-all").style.display = "none";
  document.getElementById("btn-research-tools").style.display = "inline-flex";
  const description = document.querySelector(".empty-desc");
  if (description) description.textContent = "论文正文结构已按你的操作删除；证据型研究笔记仍可在研究工作流中查看。重新选择同一 PDF 可重新解析并恢复正文。";
  renderWorkspaceTabs();
  saveTabsState();
  researchTools?.refresh();
  return true;
}

async function restoreRecentPaper() {
  const restoreId = ++restoreRequestId;
  const revision = paperRevision;
  const loadRequestId = ++paperLoadRequestId;
  const isCurrent = () => restoreId === restoreRequestId
    && revision === paperRevision
    && loadRequestId === paperLoadRequestId
    && !currentPaper.blocks.length;
  const savedState = restoreTabsState();

  if (savedState && Array.isArray(savedState.openPaperTabs) && savedState.openPaperTabs.length > 0) {
    // localStorage is only a hint: a paper may have been deleted in another
    // WebView or after a data restore. Reconcile against the full server
    // library before opening the saved active tab.
    const loaded = await loadLibraryItems({ reconcileTabs: true, archived: "all", quiet: true, render: false });
    if (restoreId !== restoreRequestId || revision !== paperRevision) return false;
    if (!loaded) {
      // A transient library request failure must not turn a recoverable
      // localStorage tab state into an empty workspace. Keep the saved tabs;
      // the next normal library refresh can reconcile them when the backend is
      // reachable again.
      activeView = "library";
      activePaperHash = null;
      renderWorkspaceTabs();
      saveTabsState();
      return false;
    }
    renderWorkspaceTabs();
    const targetHash = normalizedPaperHash(savedState.activePaperHash);
    if (savedState.activeView === "paper" && targetHash && openPaperTabs.some((tab) => tab.paperHash === targetHash)) {
      return openPaperTab(targetHash, { fromRestore: true });
    }
    activeView = "library";
    activePaperHash = null;
    switchView("library");
    return true;
  }

  try {
    const response = await pluginApiFetch("/api/research/recent");
    const data = await response.json();
    if (!isCurrent() || !response.ok || !data.ok || !data.paper) {
      if (restoreId === restoreRequestId) switchView("library");
      return false;
    }
    const paperHash = normalizedPaperHash(data.paper.paperHash);
    if (!paperHash) {
      switchView("library");
      return false;
    }
    if (data.paper.structureDetached) {
      activeView = "paper";
      activePaperHash = paperHash;
      paperLoadingHash = paperHash;
      if (!loadDetachedResearchRecord(data.paper, { requestId: loadRequestId })) return false;
      switchView("paper", paperHash);
      return true;
    }
    if (!data.paper.blocks?.length) {
      switchView("library");
      return false;
    }
    const parser = data.paper.parser && typeof data.paper.parser === "object" ? data.paper.parser : {};
    const loaded = loadPaper({
      ...data.paper,
      paperHash,
      title: data.paper.metadata?.title || "最近阅读论文",
      pageCount: Number(parser.pageCount || 0),
      isPdf: parser.kind === "mineru",
      modelVersion: parser.modelVersion || null,
      cached: true,
      restored: true,
    }, { loadRequestId });
    if (!loaded) return false;
    switchView("paper", paperHash);
    return true;
  } catch {
    if (restoreId === restoreRequestId) switchView("library");
    return false;
  }
}

function locateResearchBlock(blockId, evidence = null) {
  const id = String(blockId || "");
  if (!id) return;
  selectedBlockId = id;
  for (const [paneId, prefix] of [["original-pane", "orig"], ["trans-pane", "trans"], ["contrast-pane", "contrast-orig"]]) {
    const pane = document.getElementById(paneId);
    const target = document.getElementById(`${prefix}-${id}`);
    if (!pane || !target) continue;
    const paneRect = pane.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    pane.scrollTop = Math.max(0, pane.scrollTop + targetRect.top - paneRect.top - 52);
    target.classList.add("locate-flash", "anchor-selected");
    window.setTimeout(() => target.classList.remove("locate-flash"), 700);
  }
  document.querySelectorAll(".block.anchor-selected").forEach((element) => {
    if (element.dataset.id !== id) element.classList.remove("anchor-selected");
  });
  const page = Number(evidence?.page || currentPaper.blocks.find((block) => block.id === id)?.page || 0);
  if (page > 0) {
    document.querySelectorAll(`.pdf-visual-preview[data-pdf-page="${page}"]`).forEach((preview) => {
      preview.classList.add("locate-flash");
      window.setTimeout(() => preview.classList.remove("locate-flash"), 700);
    });
  }
  researchTools?.refresh();
}

function mergeSyncedPaper(dataPaper, snapshot) {
  if (!dataPaper || !paperContextIsCurrent(snapshot.paperHash, snapshot.revision, snapshot.paperRef)) return false;
  if (snapshot.stateRevision !== researchStateRevision) {
    scheduleResearchSync();
    return false;
  }
  const remoteBlocks = Array.isArray(dataPaper.blocks) ? dataPaper.blocks : [];
  const remoteTranslations = dataPaper.translations && typeof dataPaper.translations === "object" ? dataPaper.translations : {};
  const remoteBlockTranslations = Object.fromEntries(remoteBlocks
    .filter((block) => block?.id && typeof block.translatedText === "string" && block.translatedText.trim())
    .map((block) => [block.id, block.translatedText.trim()]));
  currentPaper.translations = { ...remoteBlockTranslations, ...remoteTranslations };
  currentPaper.translationStates = dataPaper.translationStates && typeof dataPaper.translationStates === "object"
    ? { ...dataPaper.translationStates }
    : {};
  if (remoteBlocks.length) {
    const localById = new Map(currentPaper.blocks.map((block) => [block.id, block]));
    currentPaper.blocks = remoteBlocks.map((block) => {
      const { translatedText: _remoteTranslation, ...remoteBlock } = block;
      return { ...localById.get(block.id), ...remoteBlock, translatedText: currentPaper.translations?.[block.id] || "" };
    });
  }
  currentPaper.translationGlossaryVersion = Number(dataPaper.translationGlossaryVersion || currentPaper.translationGlossaryVersion || 0);
  if (dataPaper.revision !== undefined && dataPaper.revision !== null) {
    const remoteRevision = Number(dataPaper.revision);
    const localRevision = Number(currentPaper.revision);
    if (Number.isInteger(remoteRevision) && remoteRevision >= 0) {
      currentPaper.revision = Math.max(Number.isInteger(localRevision) && localRevision >= 0 ? localRevision : 0, remoteRevision);
    }
  }
  currentPaper.replaceTranslations = false;
  researchTools?.refresh();
  return true;
}

async function ensureResearchPaper(options = {}) {
  let snapshot = options.snapshot;
  if (!snapshot) {
    // Keep the known-hash path synchronous up to enqueuePaperSync(). A scroll
    // event can schedule progress in the same turn as a newly loaded paper;
    // yielding here would let setProgress race ahead of the paper upsert.
    const captured = capturePaperSyncSnapshot({ paperHash: options.paperHash });
    snapshot = captured && typeof captured.then === "function" ? await captured : captured;
  }
  if (!snapshot || (options.paperRef && snapshot.paperRef !== options.paperRef) || (options.revision !== undefined && snapshot.revision !== options.revision)) return null;
  if (paperSyncBlocked.has(snapshot.paperHash) && options.allowBlocked !== true) return null;
  const paper = await enqueuePaperSync(snapshot, { allowBlocked: options.allowBlocked === true });
  if (paper) mergeSyncedPaper(paper, snapshot);
  return paper;
}

function scheduleResearchSync() {
  const hash = normalizedPaperHash(currentPaper.paperHash);
  const paperRef = currentPaper;
  const revision = paperRevision;
  if (!hash || !currentPaper.blocks.length || paperSyncBlocked.has(hash)) return;
  const previous = researchSyncTimers.get(hash);
  if (previous !== undefined) window.clearTimeout(previous);
  const timer = window.setTimeout(() => {
    if (researchSyncTimers.get(hash) === timer) researchSyncTimers.delete(hash);
    if (!activePaperContextIsCurrent(hash, revision, paperRef)) return;
    void ensureResearchPaper({ paperHash: hash, paperRef, revision }).catch(() => {});
  }, 450);
  researchSyncTimers.set(hash, timer);
}

async function restorePaperProgress(hash = currentPaper.paperHash, revision = paperRevision, paperRef = currentPaper, options = {}) {
  const paperHash = normalizedPaperHash(hash);
  if (!paperHash || !paperContextIsCurrent(paperHash, revision, paperRef)) return false;
  // A local view snapshot was captured synchronously before switching away and
  // its progress is queued before the next tab is fetched. Do not let a slower
  // server response overwrite that newer in-memory position.
  if (options.preserveSnapshot === true) return activePaperContextIsCurrent(paperHash, revision, paperRef);
  try {
    const response = await pluginApiFetch(`/api/research/progress?paperHash=${encodeURIComponent(paperHash)}`);
    const data = await response.json();
    if (!activePaperContextIsCurrent(paperHash, revision, paperRef) || !response.ok || !data.ok || !data.progress) return false;
    const progress = data.progress;
    const validBlock = paperRef.blocks.some((block) => block.id === progress.blockId);
    selectedBlockId = validBlock ? progress.blockId : selectedBlockId;
    const noteDraft = progress.noteDraft && typeof progress.noteDraft === "object"
      && (!progress.noteDraft.paperHash || normalizedPaperHash(progress.noteDraft.paperHash) === paperHash)
      ? progress.noteDraft
      : null;
    restoredResearchUiState = { searchState: progress.searchState || {}, noteDraft };
    researchTools?.restoreUiState(restoredResearchUiState);
    if (READING_MODES.has(progress.readingMode)) setReadingMode(progress.readingMode, { silent: true });
    window.setTimeout(() => {
      if (!activePaperContextIsCurrent(paperHash, revision, paperRef)) return;
      const original = document.getElementById("original-pane");
      const translation = document.getElementById("trans-pane");
      const contrast = document.getElementById("contrast-pane");
      if (original) original.scrollTop = Math.max(0, Number(progress.originalScrollTop || 0));
      if (translation) translation.scrollTop = Math.max(0, Number(progress.translationScrollTop || 0));
      if (contrast) contrast.scrollTop = Math.max(0, Number(progress.contrastScrollTop || 0));
      if (!Number(progress.originalScrollTop) && !Number(progress.translationScrollTop) && !Number(progress.contrastScrollTop) && validBlock) locateResearchBlock(progress.blockId);
      if (progress.searchState?.query) highlightSearchInReader(progress.searchState.query);
      capturePaperViewSnapshot(paperHash);
    }, 100);
    if (currentPaper.restored && activePaperContextIsCurrent(paperHash, revision, paperRef)) {
      await safeToast({ message: "研究内容与上次阅读位置已恢复。重新选择同一 PDF 可恢复原页预览，不会重复解析。", type: "success" });
    }
    return true;
  } catch {}
  return false;
}

function applyGlossaryRecord(record, options = {}) {
  const revision = options.revision === undefined ? paperRevision : options.revision;
  const paperHash = normalizedPaperHash(options.paperHash || currentPaper.paperHash);
  if (!paperHash || revision !== paperRevision || paperHash !== normalizedPaperHash(currentPaper.paperHash)) return false;
  const nextVersion = Math.max(0, Number.isInteger(Number(record?.version)) ? Number(record.version) : 0);
  const nextTerms = record?.terms && typeof record.terms === "object" && !Array.isArray(record.terms)
    ? Object.fromEntries(Object.entries(record.terms).filter(([source, target]) => String(source).trim() && typeof target === "string" && target.trim()))
    : {};
  const previousTranslationVersion = Number(currentPaper.translationGlossaryVersion || 0);
  currentPaper.glossaryVersion = nextVersion;
  currentPaper.glossaryTerms = nextTerms;
  glossaryRequestId += 1;
  if (nextVersion === previousTranslationVersion) return true;

  const finalTranslations = {};
  const finalStates = {};
  let invalidated = 0;
  for (const [blockId, translation] of Object.entries(currentPaper.translations || {})) {
    if (isFinalTranslation(blockId)) {
      finalTranslations[blockId] = translation;
      finalStates[blockId] = currentPaper.translationStates?.[blockId];
    } else {
      invalidated += 1;
    }
  }
  currentPaper.translations = finalTranslations;
  currentPaper.translationStates = finalStates;
  researchStateRevision += 1;
  currentPaper.translationGlossaryVersion = nextVersion;
  currentPaper.replaceTranslations = true;
  renderBlocks();
  scheduleResearchSync();
  if (invalidated && options.notifyInvalidated !== false) {
    void safeToast({ message: `术语已更新：${invalidated} 段 AI 译文待重译，用户定稿已保留`, type: "success" });
  }
  return true;
}

async function refreshGlossaryState(options = {}) {
  const revision = options.revision === undefined ? paperRevision : options.revision;
  const paperHash = normalizedPaperHash(options.paperHash || currentPaper.paperHash);
  const paperRef = options.paperRef || currentPaper;
  if (!paperHash || !paperContextIsCurrent(paperHash, revision, paperRef)) return false;
  const requestId = ++glossaryRequestId;
  try {
    const response = await pluginApiFetch(`/api/research/glossary?paperHash=${encodeURIComponent(paperHash)}`, { cache: "no-store" });
    const data = await response.json();
    if (!activePaperContextIsCurrent(paperHash, revision, paperRef) || requestId !== glossaryRequestId || !response.ok || !data.ok) return false;
    return applyGlossaryRecord(data.glossary, { revision, paperHash, notifyInvalidated: options.notifyInvalidated !== false });
  } catch {}
  return false;
}

function scheduleProgressSync() {
  const hash = normalizedPaperHash(currentPaper.paperHash);
  const paperRef = currentPaper;
  const revision = paperRevision;
  if (!hash || !currentPaper.blocks.length || paperSyncBlocked.has(hash)) return;
  const previous = progressSyncTimers.get(hash);
  if (previous !== undefined) window.clearTimeout(previous);
  const timer = window.setTimeout(() => {
    if (progressSyncTimers.get(hash) === timer) progressSyncTimers.delete(hash);
    if (!paperContextIsCurrent(hash, revision, paperRef)) return;
    void syncReadingProgress({ paperHash: hash, paperRef, revision }).catch(() => {});
  }, 650);
  progressSyncTimers.set(hash, timer);
}

async function syncReadingProgress(options = {}) {
  const paperHash = normalizedPaperHash(options.paperHash || currentPaper.paperHash);
  const paperRef = options.paperRef || currentPaper;
  const revision = options.revision === undefined ? paperRevision : options.revision;
  if (!paperHash || !Array.isArray(paperRef?.blocks) || !paperRef.blocks.length) return false;
  if (!options.progress && !paperContextIsCurrent(paperHash, revision, paperRef)) return false;
  const progress = options.progress || { ...currentReadingProgress(), paperHash };
  try {
    const synced = await enqueueProgressSync({ ...cloneJson(progress), paperHash }, { allowBlocked: options.allowBlocked === true });
    return synced === true;
  } catch {}
  return false;
}

async function getCachedBlockTranslation(block, sourceText, allowCache = true, options = {}) {
  const paperHash = normalizedPaperHash(options.paperHash || currentPaper.paperHash);
  if (!allowCache || !paperHash || !block?.id) return "";
  const glossaryVersion = options.glossaryVersion === undefined ? currentPaper.glossaryVersion || 0 : options.glossaryVersion;
  const agentId = options.agentId === undefined ? currentAgent?.id || "" : options.agentId;
  const modelRef = options.modelRef === undefined ? selectedModelRefForAgent(currentAgent) : options.modelRef;
  try {
    const query = new URLSearchParams({
      paperHash,
      blockId: block.id,
      glossaryVersion: String(glossaryVersion),
      agentId,
      modelRef,
    });
    const response = await pluginApiFetch(`/api/research/translation-cache?${query}`);
    const data = await response.json();
    const cached = data?.translation;
    if (response.ok && data.ok && data.hit && cached?.source === sourceText && typeof cached.translation === "string") {
      return cached.translation.trim();
    }
  } catch {}
  return "";
}

function enqueueTranslationCache(hash, payload) {
  if (!hash || deletedPaperHashes.has(hash) || paperSyncBlocked.has(hash)) return Promise.resolve(false);
  const previous = translationCacheChains.get(hash) || Promise.resolve(true);
  const request = previous.catch(() => {}).then(async () => {
    const response = await pluginApiFetch("/api/research/translation-cache", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error("翻译缓存同步失败");
    return true;
  });
  let tracked;
  tracked = request.then(
    (value) => value,
    () => false,
  ).finally(() => {
    if (translationCacheChains.get(hash) === tracked) translationCacheChains.delete(hash);
  });
  translationCacheChains.set(hash, tracked);
  return request;
}

async function cacheBlockTranslation(block, source, translation, options = {}) {
  const paperHash = normalizedPaperHash(options.paperHash || currentPaper.paperHash);
  if (!paperHash || !block?.id || !translation || deletedPaperHashes.has(paperHash) || paperSyncBlocked.has(paperHash)) return false;
  if (options.paperRef && !paperContextIsCurrent(paperHash, options.revision === undefined ? paperRevision : options.revision, options.paperRef)) return false;
  const glossaryVersion = options.glossaryVersion === undefined ? currentPaper.glossaryVersion || 0 : options.glossaryVersion;
  const agentId = options.agentId === undefined ? currentAgent?.id || "" : options.agentId;
  const modelRef = options.modelRef === undefined ? selectedModelRefForAgent(currentAgent) : options.modelRef;
  try {
    return await enqueueTranslationCache(paperHash, {
      paperHash,
      blockId: block.id,
      glossaryVersion,
      agentId,
      modelRef,
      source,
      translation,
    });
  } catch {}
  return false;
}

async function checkParseCache(paperHash) {
  if (!isPaperHash(paperHash)) return null;
  try {
    const response = await pluginApiFetch(`/api/research/parse-cache/check?paperHash=${encodeURIComponent(paperHash)}`);
    const data = await response.json();
    return response.ok && data.ok && data.hit && data.paper ? data.paper : null;
  } catch {
    return null;
  }
}

async function createParseTask(paperHash, fileName) {
  if (!isPaperHash(paperHash)) return null;
  try {
    const response = await pluginApiFetch("/api/research/parse-status/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paperHash, state: "queued", stage: "queued", progress: 0, fileName }),
    });
    const data = await response.json();
    return response.ok && data.ok ? data.task : null;
  } catch {
    return null;
  }
}

async function updateParseTask(task, patch) {
  if (!task?.id) return;
  try {
    const response = await pluginApiFetch(`/api/research/parse-status/tasks/${encodeURIComponent(task.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!response.ok) return;
    researchTools?.refresh();
  } catch {}
}

function translationTextElements(blockId) {
  return [...document.querySelectorAll("[data-translation-text][data-id]")]
    .filter((element) => element.dataset.id === blockId);
}

function translationBlockElements(blockId) {
  return [...document.querySelectorAll("[data-translation-block][data-id]")]
    .filter((element) => element.dataset.id === blockId);
}

function commitBlockTranslation(blockId, translation, options = {}) {
  const value = String(translation || "").trim();
  if (!value) return false;
  const expectedHash = normalizedPaperHash(options.paperHash);
  const expectedRevision = options.revision;
  const expectedPaperRef = options.paperRef || currentPaper;
  if (expectedHash && !activePaperContextIsCurrent(expectedHash, expectedRevision === undefined ? paperRevision : expectedRevision, expectedPaperRef)) return false;
  if (!expectedHash && expectedPaperRef !== currentPaper) return false;
  currentPaper.translations[blockId] = value;
  currentPaper.translationStates ||= {};
  currentPaper.translationStates[blockId] = options.kind === "final"
    ? { kind: "final", locked: true, updatedAt: new Date().toISOString() }
    : { kind: "ai", locked: false, updatedAt: new Date().toISOString() };
  researchStateRevision += 1;
  translationTextElements(blockId).forEach((target) => {
    target.innerHTML = formatMath(escapeHtml(value));
    target.classList.remove("trans-empty-tip");
  });
  setBlockTranslationAction(blockId, options.kind === "final" ? "编辑定稿" : "重新翻译");
  updateTranslationStateUi(blockId);
  scheduleResearchSync();
  return true;
}

async function cachedTranslationsForBlocks(blocks, allowCache = true, options = {}) {
  const paperHash = normalizedPaperHash(options.paperHash || currentPaper.paperHash);
  const paperRef = options.paperRef || currentPaper;
  const revision = options.revision === undefined ? paperRevision : options.revision;
  if (!allowCache || !blocks.length || !paperHash) return new Map();
  await refreshGlossaryState({ paperHash, paperRef, revision });
  if (!activePaperContextIsCurrent(paperHash, revision, paperRef)) return new Map();
  const glossaryVersion = options.glossaryVersion === undefined ? paperRef.glossaryVersion || 0 : options.glossaryVersion;
  const agentId = options.agentId === undefined ? currentAgent?.id || "" : options.agentId;
  const modelRef = options.modelRef === undefined ? selectedModelRefForAgent(currentAgent) : options.modelRef;
  const pairs = await Promise.all(blocks.map(async (block) => [
    block.id,
    await getCachedBlockTranslation(block, translationTextForBlock(block), true, {
      paperHash,
      glossaryVersion,
      agentId,
      modelRef,
    }),
  ]));
  if (!activePaperContextIsCurrent(paperHash, revision, paperRef)) return new Map();
  return new Map(pairs.filter(([, value]) => value));
}

function paneContentTop(pane) {
  const header = pane?.querySelector(".pane-header");
  const headerRect = header?.getBoundingClientRect();
  const paneRect = pane?.getBoundingClientRect();
  if (!paneRect) return 0;
  const paneTop = paneRect.top + 8;
  const headerTop = Math.min(paneRect.bottom - 8, (headerRect?.bottom || paneRect.top) + 8);
  return Math.max(paneTop, headerTop);
}

function firstVisibleBlock(pane) {
  if (!pane) return null;
  const top = paneContentTop(pane);
  const paneRect = pane.getBoundingClientRect();
  const blocks = [...pane.querySelectorAll(".block[data-id]")];
  if (!blocks.length) return null;
  const visible = blocks
    .map((block) => ({ block, rect: block.getBoundingClientRect() }))
    .filter(({ rect }) => rect.bottom > top + 2 && rect.top < paneRect.bottom - 2);
  if (!visible.length) return blocks[blocks.length - 1];
  const nextBlock = visible
    .filter(({ rect }) => rect.top >= top)
    .sort((a, b) => a.rect.top - b.rect.top)[0];
  return (nextBlock || visible[0]).block;
}

function locateSameBlock(sourcePane = activePane) {
  const originalPane = document.getElementById("original-pane");
  const translationPane = document.getElementById("trans-pane");
  if (!originalPane || !translationPane) return;
  const source = sourcePane === translationPane ? translationPane : originalPane;
  const target = source === originalPane ? translationPane : originalPane;
  const sourceBlock = firstVisibleBlock(source);
  const blockId = sourceBlock?.getAttribute("data-id");
  const targetBlock = blockId
    ? document.getElementById(`${target === originalPane ? "orig" : "trans"}-${blockId}`)
    : null;
  if (!sourceBlock || !targetBlock) {
    const maxSource = Math.max(0, source.scrollHeight - source.clientHeight);
    const maxTarget = Math.max(0, target.scrollHeight - target.clientHeight);
    const ratio = maxSource > 0 ? source.scrollTop / maxSource : 0;
    syncingPanes = true;
    target.scrollTop = ratio * maxTarget;
    window.setTimeout(() => { syncingPanes = false; }, 0);
    return;
  }

  const sourceRect = sourceBlock.getBoundingClientRect();
  const targetRect = targetBlock.getBoundingClientRect();
  const nextTop = target.scrollTop + targetRect.top - sourceRect.top;
  const maxTarget = Math.max(0, target.scrollHeight - target.clientHeight);
  syncingPanes = true;
  target.scrollTop = Math.max(0, Math.min(maxTarget, nextTop));
  sourceBlock.classList.add("locate-flash");
  targetBlock.classList.add("locate-flash");
  window.setTimeout(() => {
    sourceBlock.classList.remove("locate-flash");
    targetBlock.classList.remove("locate-flash");
    syncingPanes = false;
  }, 700);

  const button = document.getElementById("btn-locate-sync");
  if (button) {
    const originalText = button.textContent;
    button.textContent = "✓ 已对齐";
    window.setTimeout(() => { button.textContent = originalText; }, 900);
  }
}

function alignTranslationBlock(blockId) {
  const contrastPane = document.getElementById("contrast-pane");
  if (currentReadingMode === "contrast" && contrastPane) {
    const source = document.getElementById(`contrast-orig-${blockId}`);
    const target = document.getElementById(`contrast-trans-${blockId}`);
    activePane = contrastPane;
    source?.classList.add("locate-flash");
    target?.classList.add("locate-flash");
    window.setTimeout(() => {
      source?.classList.remove("locate-flash");
      target?.classList.remove("locate-flash");
    }, 700);
    return;
  }
  const originalPane = document.getElementById("original-pane");
  const translationPane = document.getElementById("trans-pane");
  const sourceBlock = document.getElementById(`orig-${blockId}`);
  const targetBlock = document.getElementById(`trans-${blockId}`);
  if (!originalPane || !translationPane || !sourceBlock || !targetBlock) return;

  const sourceRect = sourceBlock.getBoundingClientRect();
  const targetRect = targetBlock.getBoundingClientRect();
  const maxTarget = Math.max(0, translationPane.scrollHeight - translationPane.clientHeight);
  const nextTop = translationPane.scrollTop + targetRect.top - sourceRect.top;
  syncingPanes = true;
  translationPane.scrollTop = Math.max(0, Math.min(maxTarget, nextTop));
  activePane = originalPane;
  sourceBlock.classList.add("locate-flash");
  targetBlock.classList.add("locate-flash");
  window.requestAnimationFrame(() => { syncingPanes = false; });
  window.setTimeout(() => {
    sourceBlock.classList.remove("locate-flash");
    targetBlock.classList.remove("locate-flash");
  }, 700);
}

function renderAvatar(agent, size = 22) {
  const avatar = typeof agent.avatarUrl === "string" && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(agent.avatarUrl)
    ? agent.avatarUrl
    : null;
  const name = String(agent.name || agent.id || "?");
  if (avatar) {
    return `<img src="${escapeAttr(avatar)}" class="agent-avatar-img" style="width:${size}px;height:${size}px" alt="${escapeAttr(name)}">`;
  }
  const initial = escapeHtml(name.slice(0, 1).toUpperCase());
  return `<div class="agent-avatar-placeholder" style="width:${size}px;height:${size}px;font-size:${size * 0.5}px">${initial}</div>`;
}

async function loadAgentsAndModels() {
  const previousAgentId = currentAgent?.id;
  const [agentsResult, modelsResult] = await Promise.allSettled([
    pluginApiFetch("/api/agents"),
    pluginApiFetch("/api/models"),
  ]);

  if (agentsResult.status === "fulfilled") {
    try {
      const response = agentsResult.value;
      const data = await response.json();
      if (response.ok && data.ok && Array.isArray(data.agents)) {
        agentsList = data.agents;
        currentAgent = agentsList.find((agent) => agent.id === previousAgentId)
          || agentsList.find((agent) => agent.id === "hakimi")
          || agentsList[0]
          || null;
      } else {
        console.log("agents load fallback:", data?.error || "无法读取助手列表");
      }
    } catch (error) {
      console.log("agents load fallback:", error);
    }
  } else {
    console.log("agents load fallback:", agentsResult.reason);
  }

  if (modelsResult.status === "fulfilled") {
    try {
      const response = modelsResult.value;
      const data = await response.json();
      if (response.ok && data.ok && Array.isArray(data.models)) {
        chatModels = data.models.filter((model) => model?.ref && normalizeModelRef(model.ref));
        modelCatalogReady = true;
        modelCatalogError = "";
      } else {
        chatModels = [];
        modelCatalogReady = false;
        modelCatalogError = data?.error || "无法读取聊天模型列表";
      }
    } catch (error) {
      chatModels = [];
      modelCatalogReady = false;
      modelCatalogError = error?.message || "无法读取聊天模型列表";
    }
  } else {
    chatModels = [];
    modelCatalogReady = false;
    modelCatalogError = modelsResult.reason?.message || "无法读取聊天模型列表";
  }

  updateAgentUI();
}

async function loadAgentsList() {
  return loadAgentsAndModels();
}

function updateAgentUI() {
  const agentNameText = document.getElementById("agent-name-text");
  const agentModelBadge = document.getElementById("agent-model-badge");
  const toolAgentText = document.getElementById("tool-agent-text");
  const drawerAgentName = document.getElementById("drawer-agent-name");
  const drawerAgentModel = document.getElementById("drawer-agent-model");
  const agentDropdown = document.getElementById("agent-dropdown");
  const agentAvatarSlot = document.getElementById("agent-avatar-slot");
  const drawerAvatarSlot = document.getElementById("drawer-avatar-slot");
  const quickAvatarsSlot = document.getElementById("quick-agent-avatars");
  if (!agentDropdown) return;
  if (!currentAgent) {
    if (agentNameText) agentNameText.textContent = "暂无可用助手";
    if (agentModelBadge) {
      agentModelBadge.textContent = "模型不可用";
      agentModelBadge.title = "Hana 当前没有可用 Agent";
    }
    if (toolAgentText) toolAgentText.textContent = "暂无助手";
    if (drawerAgentName) drawerAgentName.textContent = "暂无可用助手";
    if (drawerAgentModel) drawerAgentModel.textContent = "模型不可用";
    if (agentAvatarSlot) agentAvatarSlot.replaceChildren();
    if (drawerAvatarSlot) drawerAvatarSlot.replaceChildren();
    if (quickAvatarsSlot) quickAvatarsSlot.replaceChildren();
    agentDropdown.innerHTML = `<div class="agent-menu-empty">未发现可用 Agent</div>`;
    return;
  }

  const displayName = currentAgent.name || currentAgent.id;
  const modelLabel = modelDisplayLabel(currentAgent);
  agentNameText.textContent = displayName;
  agentModelBadge.textContent = modelLabel;
  agentModelBadge.title = modelLabel;
  toolAgentText.textContent = `问${displayName.split(" ")[0]}`;
  drawerAgentName.textContent = displayName;
  drawerAgentModel.textContent = modelLabel;
  drawerAgentModel.title = modelLabel;

  agentAvatarSlot.innerHTML = renderAvatar(currentAgent, 22);
  drawerAvatarSlot.innerHTML = renderAvatar(currentAgent, 24);

  if (quickAvatarsSlot) {
    quickAvatarsSlot.innerHTML = agentsList.slice(0, 8).map((agent) => `
      <div class="quick-agent-btn ${agent.id === currentAgent.id ? "active" : ""}" data-id="${escapeAttr(agent.id)}" title="点击切换并向 ${escapeAttr(agent.name || agent.id)} 提问" style="cursor:pointer;border-radius:50%;padding:1px;border:1.5px solid ${agent.id === currentAgent.id ? "var(--accent)" : "transparent"}">
        ${renderAvatar(agent, 20)}
      </div>
    `).join("");
    quickAvatarsSlot.querySelectorAll(".quick-agent-btn").forEach((element) => {
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        const found = agentsList.find((agent) => agent.id === element.dataset.id);
        if (!found) return;
        currentAgent = found;
        effectiveThinkingLevel = null;
        updateAgentUI();
        void askAgentQuestion("default");
      });
    });
  }

  const catalogOptions = modelCatalogReady
    ? [
      `<option value="${AGENT_DEFAULT_MODEL}">跟随 Agent${currentAgent.model ? ` · ${escapeHtml(currentAgent.model)}` : ""}</option>`,
      ...chatModels.map((model) => `<option value="${escapeAttr(model.ref)}">${escapeHtml(model.name)} · ${escapeHtml(model.ref)}</option>`),
    ].join("")
    : `<option value="${AGENT_DEFAULT_MODEL}">${modelCatalogError ? "模型列表暂不可用" : "正在读取模型列表…"}</option>`;
  const selectedRef = selectedModelRefForAgent(currentAgent);
  const staleOption = selectedRef !== AGENT_DEFAULT_MODEL && !modelByRef(selectedRef)
    ? `<option value="${escapeAttr(selectedRef)}">不可用 · ${escapeHtml(selectedRef)}</option>`
    : "";

  agentDropdown.innerHTML = agentsList.map((agent) => {
    const agentSelectedRef = selectedModelRefForAgent(agent);
    const agentOptions = agent.id === currentAgent.id ? `${staleOption}${catalogOptions}` : "";
    return `<div class="agent-menu-item ${agent.id === currentAgent.id ? "active" : ""}" data-id="${escapeAttr(agent.id)}">
      ${renderAvatar(agent, 26)}
      <div class="agent-menu-copy">
        <div class="agent-menu-heading">
          <span class="agent-menu-name">${escapeHtml(agent.name || agent.id)}</span>
          <span class="agent-model-tag" style="font-size:0.65rem">${escapeHtml(agent.model || "默认模型")}</span>
        </div>
        <div class="agent-menu-description">${escapeHtml(agent.description ? `${agent.description.slice(0, 48)}${agent.description.length > 48 ? "…" : ""}` : "Hana 助手")}</div>
        ${agent.id === currentAgent.id ? `<label class="agent-model-control"><span>模型</span><select class="agent-model-select" aria-label="${escapeAttr(agent.name || agent.id)} 的聊天模型">${agentOptions}</select></label>` : `<div class="agent-menu-preference">${escapeHtml(agentSelectedRef === AGENT_DEFAULT_MODEL ? "跟随 Agent" : modelDisplayLabel(agent))}</div>`}
      </div>
    </div>`;
  }).join("");

  agentDropdown.querySelectorAll(".agent-menu-item").forEach((element) => {
    element.addEventListener("click", (event) => {
      if (event.target.closest("select")) return;
      const found = agentsList.find((agent) => agent.id === element.dataset.id);
      if (!found) return;
      currentAgent = found;
      effectiveThinkingLevel = null;
      updateAgentUI();
    });
  });
  const modelSelect = agentDropdown.querySelector(".agent-model-select");
  if (modelSelect) {
    modelSelect.value = selectedRef;
    modelSelect.addEventListener("change", (event) => {
      event.stopPropagation();
      const value = event.target.value || AGENT_DEFAULT_MODEL;
      if (value !== AGENT_DEFAULT_MODEL && !modelByRef(value)) {
        setSessionTargetStatus("所选模型当前不可用，请重新加载模型列表。", "error");
        return;
      }
      setModelPreference(currentAgent.id, value);
      effectiveThinkingLevel = null;
      updateAgentUI();
    });
  }
}

function resetPdfPreview() {
  pdfPreviewGeneration += 1;
  pdfPreviewPaperHash = null;
  pdfPreviewObserver?.disconnect();
  pdfPreviewObserver = null;
  for (const url of pdfPreviewObjectUrls) URL.revokeObjectURL(url);
  pdfPreviewObjectUrls.clear();
  mineruAssetUrlPromises.clear();
  pdfPageRenderLocks.clear();
  const documentToDestroy = pdfPreviewDocument;
  const taskToDestroy = pdfPreviewLoadingTask;
  pdfPreviewDocument = null;
  pdfPreviewLoadingTask = null;
  if (documentToDestroy?.destroy) Promise.resolve(documentToDestroy.destroy()).catch(() => {});
  else if (taskToDestroy?.destroy) Promise.resolve(taskToDestroy.destroy()).catch(() => {});
  return pdfPreviewGeneration;
}

function pdfPreviewIsCurrent(generation, paperHash = pdfPreviewPaperHash) {
  const expectedHash = normalizedPaperHash(paperHash);
  return generation === pdfPreviewGeneration
    && (!expectedHash || normalizedPaperHash(pdfPreviewPaperHash) === expectedHash)
    && (!expectedHash || normalizedPaperHash(currentPaper.paperHash) === expectedHash);
}

function getPdfJsModule() {
  if (!pdfJsModulePromise) {
    const url = document.body?.dataset?.pdfjsUrl;
    if (!url) return Promise.reject(new Error("PDF.js asset URL is unavailable"));
    pdfJsModulePromise = import(url).catch((error) => {
      pdfJsModulePromise = null;
      throw error;
    });
  }
  return pdfJsModulePromise;
}

function setPdfPreviewStatus(generation, message, isError = false, paperHash = pdfPreviewPaperHash) {
  if (!pdfPreviewIsCurrent(generation, paperHash)) return;
  document.querySelectorAll(".pdf-visual-status").forEach((element) => {
    element.textContent = message;
    element.classList.toggle("error", isError);
  });
}

async function initializePdfPreview(file, generation, paperHash = pdfPreviewPaperHash) {
  const expectedHash = normalizedPaperHash(paperHash);
  if (!file || !pdfPreviewIsCurrent(generation, expectedHash)) return;
  let task = null;
  try {
    const [pdfjs, arrayBuffer] = await Promise.all([getPdfJsModule(), file.arrayBuffer()]);
    if (!pdfPreviewIsCurrent(generation, expectedHash)) return;
    task = pdfjs.getDocument({
      data: new Uint8Array(arrayBuffer),
      isEvalSupported: false,
      useSystemFonts: true,
    });
    pdfPreviewLoadingTask = task;
    const documentProxy = await task.promise;
    if (!pdfPreviewIsCurrent(generation, expectedHash)) {
      await documentProxy.destroy?.();
      return;
    }
    pdfPreviewDocument = documentProxy;
    pdfPreviewLoadingTask = null;
    observePdfPreviewPages(generation);
  } catch (error) {
    if (!pdfPreviewIsCurrent(generation, expectedHash)) return;
    if (pdfPreviewLoadingTask === task) pdfPreviewLoadingTask = null;
    setPdfPreviewStatus(generation, "PDF 原页预览加载失败，提取文本仍可继续阅读", true, expectedHash);
  }
}

function bindPdfPreviewControls() {
  document.querySelectorAll(".pdf-visual-preview").forEach((preview) => {
    const toggle = preview.querySelector(".pdf-visual-toggle");
    toggle?.addEventListener("click", () => {
      const page = Number(preview.dataset.pdfPage);
      const expanded = !preview.classList.contains("expanded");
      document.querySelectorAll(`.pdf-visual-preview[data-pdf-page="${page}"]`).forEach((item) => {
        item.classList.toggle("expanded", expanded);
        const itemToggle = item.querySelector(".pdf-visual-toggle");
        if (itemToggle) {
          itemToggle.textContent = expanded ? "收起" : "放大";
          itemToggle.setAttribute("aria-expanded", String(expanded));
        }
      });
    });
  });
}

function observePdfPreviewPages(generation) {
  if (generation !== pdfPreviewGeneration) return;
  pdfPreviewObserver?.disconnect();
  const targets = [...document.querySelectorAll(
    ".pdf-visual-preview[data-pdf-page], .pdf-visual-crop[data-pdf-page], .mineru-asset[data-cache-id]",
  )];
  if (!targets.length) return;
  const renderTarget = (target) => {
    if (target.classList.contains("pdf-visual-preview")) {
      if (pdfPreviewDocument) void renderPdfPagePreview(target, generation);
      return;
    }
    if (target.classList.contains("pdf-visual-crop")) {
      if (pdfPreviewDocument) void renderPdfVisualCrop(target, generation);
      return;
    }
    if (target.classList.contains("mineru-asset")) void renderMineruAsset(target, generation);
  };
  if (!("IntersectionObserver" in window)) {
    targets.forEach(renderTarget);
    return;
  }
  pdfPreviewObserver = new IntersectionObserver((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      renderTarget(entry.target);
    }
  }, {
    root: null,
    rootMargin: "700px 0px",
    threshold: 0.01,
  });
  targets.forEach((target) => {
    if (target.dataset.state !== "rendered") pdfPreviewObserver.observe(target);
  });
}

async function canvasToPreviewBlob(canvas) {
  if (!canvas.toBlob) return null;
  const webp = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
  if (webp) return webp;
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

async function withPdfPageRenderLock(key, task) {
  const previous = pdfPageRenderLocks.get(key) || Promise.resolve();
  let tracked;
  const current = previous.catch(() => {}).then(task);
  tracked = current.catch(() => {}).finally(() => {
    if (pdfPageRenderLocks.get(key) === tracked) pdfPageRenderLocks.delete(key);
  });
  pdfPageRenderLocks.set(key, tracked);
  return current;
}

async function renderPdfPagePreview(preview, generation) {
  if (generation !== pdfPreviewGeneration || !pdfPreviewDocument || preview.dataset.state === "loading" || preview.dataset.state === "rendered") return;
  const pageNumber = Number(preview.dataset.pdfPage);
  const lockKey = `${generation}:${normalizedPaperHash(pdfPreviewPaperHash)}:page:${pageNumber}`;
  const pagePreviews = [...document.querySelectorAll(`.pdf-visual-preview[data-pdf-page="${pageNumber}"]`)];
  pagePreviews.forEach((item) => {
    item.dataset.state = "loading";
    const itemStatus = item.querySelector(".pdf-visual-status");
    if (itemStatus) itemStatus.textContent = "正在渲染原页图表与版面…";
  });
  try {
    await withPdfPageRenderLock(lockKey, async () => {
      if (!pdfPreviewIsCurrent(generation)) return;
      const page = await pdfPreviewDocument.getPage(pageNumber);
      try {
        if (!pdfPreviewIsCurrent(generation)) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const desiredWidth = Math.min(1400, Math.max(900, (preview.clientWidth || 600) * 2));
        const areaLimitedScale = Math.sqrt(10_000_000 / Math.max(1, baseViewport.width * baseViewport.height));
        const scale = Math.max(0.6, Math.min(desiredWidth / Math.max(1, baseViewport.width), areaLimitedScale));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Canvas is unavailable");
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        const blob = await canvasToPreviewBlob(canvas);
        if (!blob || generation !== pdfPreviewGeneration) throw new Error("Page image encoding failed");
        const objectUrl = URL.createObjectURL(blob);
        pdfPreviewObjectUrls.add(objectUrl);
        pagePreviews.forEach((item) => {
          const image = document.createElement("img");
          image.className = "pdf-page-preview-image";
          image.src = objectUrl;
          image.alt = `PDF 第 ${pageNumber} 页原貌，包含图片、表格、公式与版面`;
          image.loading = "lazy";
          item.querySelector(".pdf-visual-canvas-wrap")?.replaceChildren(image);
          item.dataset.state = "rendered";
        });
        canvas.width = 0;
        canvas.height = 0;
      } finally {
        await page.cleanup?.();
      }
    });
  } catch (error) {
    if (!pdfPreviewIsCurrent(generation)) return;
    pagePreviews.forEach((item) => {
      item.dataset.state = "error";
      const itemStatus = item.querySelector(".pdf-visual-status");
      if (itemStatus) {
        itemStatus.textContent = "本页原貌渲染失败";
        itemStatus.classList.add("error");
      }
    });
  }
}

function parseCropAttribute(element) {
  try {
    const crop = JSON.parse(element.dataset.crop || "[]").map(Number);
    if (crop.length !== 4 || crop.some((value) => !Number.isFinite(value))) return null;
    const normalized = [
      Math.max(0, Math.min(1000, crop[0])),
      Math.max(0, Math.min(1000, crop[1])),
      Math.max(0, Math.min(1000, crop[2])),
      Math.max(0, Math.min(1000, crop[3])),
    ];
    return normalized[2] - normalized[0] >= 3 && normalized[3] - normalized[1] >= 3 ? normalized : null;
  } catch {
    return null;
  }
}

async function renderPdfVisualCrop(preview, generation) {
  if (generation !== pdfPreviewGeneration || !pdfPreviewDocument || preview.dataset.state === "loading" || preview.dataset.state === "rendered") return;
  const pageNumber = Number(preview.dataset.pdfPage);
  const lockKey = `${generation}:${normalizedPaperHash(pdfPreviewPaperHash)}:page:${pageNumber}`;
  const visualId = preview.dataset.visualId || "";
  const crop = parseCropAttribute(preview);
  const peers = [...document.querySelectorAll(".pdf-visual-crop")].filter((item) => item.dataset.visualId === visualId);
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || !crop) return;
  peers.forEach((item) => {
    item.dataset.state = "loading";
    const status = item.querySelector(".structured-visual-status");
    if (status) status.textContent = "正在从本地 PDF 渲染视觉区域…";
  });
  try {
    await withPdfPageRenderLock(lockKey, async () => {
      if (!pdfPreviewIsCurrent(generation)) return;
      const page = await pdfPreviewDocument.getPage(pageNumber);
      try {
        if (!pdfPreviewIsCurrent(generation)) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const x = crop[0] / 1000 * baseViewport.width;
        const y = crop[1] / 1000 * baseViewport.height;
        const width = (crop[2] - crop[0]) / 1000 * baseViewport.width;
        const height = (crop[3] - crop[1]) / 1000 * baseViewport.height;
        const desiredWidth = Math.min(1400, Math.max(650, (preview.clientWidth || 560) * 2));
        const areaLimitedScale = Math.sqrt(7_000_000 / Math.max(1, width * height));
        const scale = Math.max(0.65, Math.min(4, desiredWidth / Math.max(1, width), areaLimitedScale));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(width * scale));
        canvas.height = Math.max(1, Math.floor(height * scale));
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Canvas is unavailable");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: [1, 0, 0, 1, -x * scale, -y * scale],
        }).promise;
        const blob = await canvasToPreviewBlob(canvas);
        if (!blob || generation !== pdfPreviewGeneration) throw new Error("Crop encoding failed");
        const objectUrl = URL.createObjectURL(blob);
        pdfPreviewObjectUrls.add(objectUrl);
        peers.forEach((item) => {
          const image = document.createElement("img");
          image.className = "structured-visual-image";
          image.src = objectUrl;
          image.alt = `PDF 第 ${pageNumber} 页结构化视觉区域`;
          image.loading = "lazy";
          item.querySelector(".structured-visual-media")?.replaceChildren(image);
          item.dataset.state = "rendered";
        });
        canvas.width = 0;
        canvas.height = 0;
      } finally {
        await page.cleanup?.();
      }
    });
  } catch {
    if (!pdfPreviewIsCurrent(generation)) return;
    peers.forEach((item) => {
      item.dataset.state = "error";
      const status = item.querySelector(".structured-visual-status");
      if (status) {
        status.textContent = "本地视觉区域渲染失败，可展开本页原貌查看";
        status.classList.add("error");
      }
    });
  }
}

function mineruAssetObjectUrl(cacheId, assetPath, generation, paperHash = "") {
  const hash = paperHash || currentPaper.paperHash || "";
  const key = `${generation}:${hash}:${cacheId}:${assetPath}`;
  if (mineruAssetUrlPromises.has(key)) return mineruAssetUrlPromises.get(key);
  const promise = (async () => {
    const query = `paperHash=${encodeURIComponent(hash)}&cacheId=${encodeURIComponent(cacheId)}&path=${encodeURIComponent(assetPath)}`;
    const response = await pluginApiFetch(`/api/mineru-asset?${query}`);
    if (!response.ok) throw new Error("MinerU asset fetch failed");
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) throw new Error("MinerU asset is not an image");
    if (generation !== pdfPreviewGeneration) throw new DOMException("Stale MinerU asset", "AbortError");
    const objectUrl = URL.createObjectURL(blob);
    if (generation !== pdfPreviewGeneration) {
      URL.revokeObjectURL(objectUrl);
      throw new DOMException("Stale MinerU asset", "AbortError");
    }
    pdfPreviewObjectUrls.add(objectUrl);
    return objectUrl;
  })().catch((error) => {
    mineruAssetUrlPromises.delete(key);
    throw error;
  });
  mineruAssetUrlPromises.set(key, promise);
  return promise;
}

async function renderMineruAsset(preview, generation) {
  if (generation !== pdfPreviewGeneration || preview.dataset.state === "loading" || preview.dataset.state === "rendered") return;
  const cacheId = preview.dataset.cacheId || "";
  const assetPath = preview.dataset.assetPath || "";
  const hash = preview.dataset.paperHash || currentPaper.paperHash || "";
  if (!cacheId || !assetPath) return;
  preview.dataset.state = "loading";
  try {
    const objectUrl = await mineruAssetObjectUrl(cacheId, assetPath, generation, hash);
    if (generation !== pdfPreviewGeneration) return;
    const image = document.createElement("img");
    image.className = "structured-visual-image";
    image.src = objectUrl;
    image.alt = "MinerU 结构化视觉内容";
    image.loading = "lazy";
    preview.querySelector(".structured-visual-media")?.replaceChildren(image);
    preview.dataset.state = "rendered";
  } catch {
    if (!pdfPreviewIsCurrent(generation)) return;
    preview.dataset.state = "error";
    const status = preview.querySelector(".structured-visual-status");
    if (status) {
      status.textContent = "MinerU 视觉资源加载失败";
      status.classList.add("error");
    }
  }
}

function cancelActiveParse() {
  parseJobId += 1;
  activeParseController?.abort();
  activeParseController = null;
  const task = activeParseTask;
  activeParseTask = null;
  return task?.id
    ? updateParseTask(task, { state: "cancelled", stage: "cancelled", error: "用户取消解析" })
    : Promise.resolve();
}

function loadSamplePaper() {
  cancelActiveParse();
  pendingPdfFile = null;
  pendingPdfLoadRequestId = 0;
  loadPaper(SAMPLE_PAPER, { loadRequestId: ++paperLoadRequestId });
}

async function parsePdfFile(file, options = {}) {
  if (!file) return;
  if (!Number.isFinite(file.size) || file.size <= 0) {
    await safeToast({ message: "PDF 文件为空或无法读取", type: "error" });
    return;
  }
  if (file.size > MAX_PDF_BYTES) {
    await safeToast({ message: "PDF 不得超过 50 MB", type: "error" });
    return;
  }

  cancelActiveParse();
  const loadRequestId = options.loadRequestId === undefined ? ++paperLoadRequestId : options.loadRequestId;
  pendingPdfFile = null;
  pendingPdfLoadRequestId = 0;
  const controller = new AbortController();
  activeParseController = controller;
  const jobId = ++parseJobId;
  const isCurrent = () => jobId === parseJobId
    && loadRequestId === paperLoadRequestId
    && !controller.signal.aborted;
  currentPdfFile = file;
  currentPdfFileHash = null;
  updateMineruUI();
  const paperBadge = document.getElementById("paper-badge");
  paperBadge.textContent = `正在上传论文：${file.name}`;
  paperBadge.title = `文件：${file.name}\nUI ${UI_VERSION} / API ${mineruApiVersion || "未知"}`;
  let paperHash = "";
  let task = null;
  let waitStatusTimer = null;

  try {
    paperHash = await hashFile(file);
    if (!isCurrent()) return;
    currentPdfFileHash = paperHash;
    updateMineruUI();

    const cached = options.force === true ? null : await checkParseCache(paperHash);
    if (!isCurrent()) return;
    if (cached) {
      const loaded = loadPaper({
        ...cached,
        title: file.name,
        paperHash,
        blocks: Array.isArray(cached.blocks) ? cached.blocks : [],
        pageCount: Number(cached.parser?.pageCount || cached.pageCount || 0),
        isPdf: true,
        parser: cached.parser || { kind: "mineru" },
        modelVersion: cached.parser?.modelVersion || mineruSettings.modelVersion,
        cached: true,
      }, { loadRequestId, pdfFile: file });
      if (!loaded || !isCurrent()) return;
      paperBadge.textContent = currentPaper.title;
      paperBadge.title = `论文已准备好\n文件指纹：${paperHash}\n解析缓存命中：${cached.blocks.length} 个结构块`;
      await safeToast({ message: "论文已准备好；已复用本机解析结果", type: "success" });
      void loadLibraryItems({ quiet: true });
      return;
    }

    if (!mineruConfigured) {
      pendingPdfFile = file;
      pendingPdfLoadRequestId = loadRequestId;
      openMineruSettings();
      await safeToast({ message: "请先配置 MinerU API Token，保存后将自动继续解析", type: "error" });
      return;
    }

    task = await createParseTask(paperHash, file.name);
    // Cancellation may happen while the task record is being created. Do not
    // attach that late response to the cancelled job or mark it running again.
    if (!isCurrent()) return;
    activeParseTask = task;
    await updateParseTask(task, { state: "running", stage: "uploading", progress: 10 });
    if (!isCurrent()) return;
    paperBadge.textContent = `正在上传论文：${file.name}`;

    const fileName = encodeURIComponent(file.name || "paper.pdf");
    waitStatusTimer = window.setTimeout(() => {
      if (isCurrent()) paperBadge.textContent = "正在等待 MinerU 解析";
    }, 600);
    const forceQuery = options.force === true ? "&force=1" : "";
    const response = await pluginApiFetch(`/api/parse-pdf?parser=mineru&fileName=${fileName}${forceQuery}`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: file,
      signal: controller.signal,
    });
    window.clearTimeout(waitStatusTimer);
    waitStatusTimer = null;
    const data = await response.json();
    if (!isCurrent()) return;
    if (!response.ok || !data.ok || Number(data.pageCount) <= 0) throw new Error(data.error || "MinerU 未返回有效页面");
    paperBadge.textContent = "正在整理正文和图表";
    await updateParseTask(task, { state: "running", stage: "organizing", progress: 88 });
    if (!isCurrent()) return;
    const parsedHash = normalizedPaperHash(data.paperHash || paperHash);
    if (!parsedHash || parsedHash !== normalizedPaperHash(paperHash)) throw new Error("解析结果文件指纹不一致");
    const loaded = loadPaper({
      title: file.name,
      paperHash: parsedHash,
      revision: Number.isInteger(Number(data.revision ?? data.paper?.revision)) ? Number(data.revision ?? data.paper.revision) : 0,
      blocks: Array.isArray(data.blocks) ? data.blocks : [],
      pageCount: Number(data.pageCount),
      isPdf: true,
      parser: {
        kind: "mineru",
        modelVersion: data.modelVersion || mineruSettings.modelVersion,
        pageCount: Number(data.pageCount),
        ocrUsed: data.ocrUsed === true,
        ocrFallback: data.ocrFallback === true,
      },
      modelVersion: data.modelVersion || mineruSettings.modelVersion,
      ocrUsed: data.ocrUsed === true,
      ocrFallback: data.ocrFallback === true,
      truncated: Boolean(data.truncated),
    }, { loadRequestId, pdfFile: file });
    if (!loaded || !isCurrent()) return;
    await updateParseTask(task, { state: "succeeded", stage: "complete", progress: 100 });
    if (!isCurrent()) return;
    paperBadge.textContent = currentPaper.title;
    paperBadge.title = `论文已准备好\n文件指纹：${parsedHash}\n${options.force === true ? "已强制重新解析" : "首次解析"}`;
    const versionMismatch = data.apiVersion && data.apiVersion !== UI_VERSION;
    const routeDetail = data.transport === "legacy-base64" ? "；已兼容旧版卡片传输" : "";
    const ocrDetail = data.ocrFallback ? "；普通解析失败后已由 OCR 重试完成" : data.ocrUsed ? "；OCR 模式" : "";
    const versionDetail = versionMismatch ? `；UI ${UI_VERSION} / API ${data.apiVersion}` : "";
    if (!data.blocks?.length) {
      await safeToast({ message: `MinerU 没有返回结构块，已保留原页视觉预览${routeDetail}${ocrDetail}${versionDetail}`, type: "success" });
    } else {
      await safeToast({ message: `MinerU 解析完成：${data.blockCount || data.blocks.length} 个结构块${routeDetail}${ocrDetail}${versionDetail}`, type: "success" });
    }
    void loadLibraryItems({ quiet: true });
  } catch (error) {
    window.clearTimeout(waitStatusTimer);
    waitStatusTimer = null;
    if (!isCurrent() || error?.name === "AbortError") return;
    const message = String(error?.message || "接口连接异常").slice(0, 240);
    recordQaEvent("parse-pdf.failed", { fileName: file.name, message, jobId }, "error");
    await updateParseTask(task, { state: "failed", stage: "failed", progress: 0, error: message });
    if (!isCurrent()) return;
    paperBadge.textContent = `MinerU 解析失败：${message}`;
    paperBadge.title = `文件：${file.name}\nUI ${UI_VERSION} / API ${mineruApiVersion || "未知"}`;
    await safeToast({ message: `MinerU 解析失败：${message}`, type: "error" });
    if (/\b(?:401|403)\b|token|未授权|无权限/i.test(message)) {
      pendingPdfFile = file;
      pendingPdfLoadRequestId = loadRequestId;
      openMineruSettings();
    }
  } finally {
    window.clearTimeout(waitStatusTimer);
    if (activeParseController === controller) activeParseController = null;
    if (activeParseTask === task) activeParseTask = null;
    if (isCurrent()) updateMineruUI();
  }
}

async function handleFile(file) {
  if (!file) return;
  const paperBadge = document.getElementById("paper-badge");
  const fileName = String(file.name || "");
  const lowerName = fileName.toLowerCase();
  if (!lowerName.endsWith(".pdf") && !lowerName.endsWith(".txt") && !lowerName.endsWith(".md")) {
    await safeToast({ message: "只支持 PDF、TXT 或 Markdown 文件", type: "error" });
    return;
  }
  if (file.size > 50 * 1024 * 1024) {
    await safeToast({ message: "导入文件不能超过 50 MB", type: "error" });
    return;
  }
  if (lowerName.endsWith(".pdf")) {
    await parsePdfFile(file);
    return;
  }

  cancelActiveParse();
  const loadRequestId = ++paperLoadRequestId;
  pendingPdfFile = null;
  pendingPdfLoadRequestId = 0;
  currentPdfFile = null;
  currentPdfFileHash = null;
  updateMineruUI();
  paperBadge.textContent = `正在读取: ${fileName}...`;
  let text;
  try {
    text = await file.text();
  } catch {
    paperBadge.textContent = "文件读取失败";
    await safeToast({ message: "文本文件读取失败", type: "error" });
    return;
  }
  if (text.length > 2_000_000) {
    await safeToast({ message: "文本文件不能超过 2 MB", type: "error" });
    return;
  }
  const paragraphs = text.split(/\n\s*\n/).filter((item) => item.trim().length > 0);
  const blocks = paragraphs.map((paragraph, index) => ({
    id: `p_${index + 1}`,
    type: paragraph.trim().length < 80 && !paragraph.trim().endsWith(".") ? "heading" : "paragraph",
    text: paragraph.trim(),
  }));
  if (loadRequestId !== paperLoadRequestId) return;
  loadPaper({ title: file.name, blocks, parser: "text" }, { loadRequestId });
}

function translatableBlocks() {
  return currentPaper.blocks.filter((block) => Boolean(translationTextForBlock(block)));
}

function loadPaper(paper, options = {}) {
  const requestId = options.requestId;
  const loadToken = options.loadRequestId === undefined
    ? (requestId === undefined ? ++paperLoadRequestId : requestId)
    : options.loadRequestId;
  if (loadToken !== paperLoadRequestId) return false;
  const previousHash = normalizedPaperHash(currentPaper.paperHash);
  const nextHash = normalizedPaperHash(paper?.paperHash);
  if (requestId !== undefined && (!nextHash || !paperLoadIsCurrent(requestId, nextHash))) return false;
  // Direct imports/reparses invalidate the previous paper before replacing the
  // global view. The known-hash path captures the old paper synchronously; the
  // queued write is therefore safe even though the DOM changes immediately.
  if (previousHash && previousHash !== nextHash && options.skipPreviousFlush !== true) {
    void flushCurrentPaperState({ paperHash: previousHash });
  }
  paperRevision += 1;
  researchStateRevision += 1;
  const revision = paperRevision;
  fullTranslationRunId += 1;
  fullTranslationBusy = false;
  blockTranslationRunIds.clear();
  sanitizedTableCache.clear();
  selectedBlockId = null;
  hidePaperTransientUi();
  resetResearchUiForPaper();

  const isPdf = paper?.isPdf === true || (typeof paper?.parser === "object" && paper.parser?.kind === "mineru");
  const pdfFile = options.pdfFile || (nextHash ? pdfFilesByHash.get(nextHash) : null);
  const previousPreviewHash = normalizedPaperHash(pdfPreviewPaperHash);
  const previewNeedsReset = !isPdf
    || (previousPreviewHash && previousPreviewHash !== nextHash)
    || (!previousPreviewHash && (pdfPreviewDocument || pdfPreviewLoadingTask));
  if (previewNeedsReset) resetPdfPreview();
  currentPdfFile = isPdf ? pdfFile || null : null;
  currentPdfFileHash = isPdf && pdfFile && nextHash ? nextHash : null;
  if (isPdf && nextHash) {
    pdfPreviewPaperHash = nextHash;
    if (pdfFile) pdfFilesByHash.set(nextHash, pdfFile);
  }

  const blocks = Array.isArray(paper?.blocks) ? paper.blocks : [];
  const persistedTranslations = paper?.translations && typeof paper.translations === "object" ? paper.translations : {};
  const persistedTranslationStates = paper?.translationStates && typeof paper.translationStates === "object" ? paper.translationStates : {};
  const blockTranslations = Object.fromEntries(blocks
    .filter((block) => typeof block?.translatedText === "string" && block.translatedText.trim())
    .map((block) => [block.id, block.translatedText.trim()]));
  currentPaper = {
    ...paper,
    revision: Number.isInteger(Number(paper?.revision)) ? Number(paper.revision) : 0,
    title: String(paper?.title || "未命名论文"),
    blocks,
    translations: { ...blockTranslations, ...persistedTranslations },
    translationStates: { ...persistedTranslationStates },
    paperHash: nextHash || null,
    isPdf,
    glossaryVersion: Number(paper?.glossaryVersion || 0),
    translationGlossaryVersion: Number(paper?.translationGlossaryVersion || paper?.glossaryVersion || 0),
    glossaryTerms: paper?.glossaryTerms && typeof paper.glossaryTerms === "object" ? paper.glossaryTerms : {},
    replaceTranslations: false,
  };
  currentPaper.parser = typeof paper?.parser === "object"
    ? { ...paper.parser, kind: paper.parser.kind || (isPdf ? "mineru" : "text") }
    : (paper?.parser || (isPdf ? "mineru" : "text"));

  const emptyView = document.getElementById("empty-view");
  const reader = document.getElementById("reader-container");
  if (emptyView) emptyView.style.display = "none";
  if (reader) reader.style.display = "flex";
  const readingControl = document.getElementById("reading-mode-control");
  if (readingControl) readingControl.style.display = "inline-flex";
  const translateButton = document.getElementById("btn-translate-all");
  const researchButton = document.getElementById("btn-research-tools");
  if (translateButton) {
    translateButton.style.display = translatableBlocks().length ? "inline-flex" : "none";
    translateButton.disabled = false;
    translateButton.textContent = "翻译全文";
  }
  if (researchButton) researchButton.style.display = currentPaper.blocks.length ? "inline-flex" : "none";
  const storedMode = READING_MODES.has(paper?.readingMode) ? paper.readingMode : currentReadingMode;
  setReadingMode(storedMode, { silent: true });
  const badge = document.getElementById("paper-badge");
  if (badge) badge.textContent = currentPaper.title;
  const visualCount = currentPaper.blocks.filter((block) => block.assetRef || block.crop || block.tableHtml || ["image", "table", "chart", "equation"].includes(block.type)).length;
  const parserLabel = isPdf ? `MinerU ${paper.modelVersion || currentPaper.parser?.modelVersion || mineruSettings.modelVersion || ""}`.trim() : "文本";
  const count = document.getElementById("orig-blocks-count");
  if (count) count.textContent = isPdf
    ? `${paper.pageCount || currentPaper.parser?.pageCount || 0} 页 · ${currentPaper.blocks.length} 块 · ${visualCount} 视觉 · ${parserLabel}${paper.cached ? " · 缓存" : ""}`
    : `${currentPaper.blocks.length} 段落`;
  updateMineruUI();
  renderBlocks();
  const original = document.getElementById("original-pane");
  const translation = document.getElementById("trans-pane");
  const contrast = document.getElementById("contrast-pane");
  if (original) original.scrollTop = 0;
  if (translation) translation.scrollTop = 0;
  if (contrast) contrast.scrollTop = 0;

  if (nextHash) {
    deletedPaperHashes.delete(nextHash);
    paperSyncBlocked.delete(nextHash);
    upsertPaperTab({ paperHash: nextHash, title: currentPaper.title, isPdf, pageCount: Number(paper.pageCount || currentPaper.parser?.pageCount || 0) });
    activePaperHash = nextHash;
    activeView = "paper";
    paperLoadingHash = null;
    renderWorkspaceTabs();
    saveTabsState();
  } else {
    // Text/sample imports do not have a file fingerprint yet. Keep the reader
    // visible but detach it from the previous tab until hashing finishes.
    activePaperHash = null;
    activeView = "paper";
    paperLoadingHash = "pending-paper-hash";
    renderWorkspaceTabs();
    saveTabsState();
  }

  if (isPdf && pdfFile && nextHash && !pdfPreviewDocument && !pdfPreviewLoadingTask) {
    // renderBlocks() above has created the preview targets. Centralising PDF
    // initialisation here avoids two concurrent PDF.js documents for one tab.
    void initializePdfPreview(pdfFile, pdfPreviewGeneration, nextHash);
  }

  const paperRef = currentPaper;
  const appliedViewSnapshot = nextHash ? applyPaperViewSnapshot(nextHash, { revision, paperRef }) : false;
  void (async () => {
    let hash = nextHash;
    if (!hash) {
      try { hash = await resolvePaperHashForSnapshot(paperRef, revision, paperRef); } catch {}
    }
    if (!hash || loadToken !== paperLoadRequestId || !paperRefIsCurrent(revision, paperRef)) return;
    if (!normalizedPaperHash(paperRef.paperHash)) paperRef.paperHash = hash;
    if (activeView === "paper" && (!normalizedPaperHash(activePaperHash) || activePaperHash === "pending-paper-hash")) activePaperHash = hash;
    if (!activePaperContextIsCurrent(hash, revision, paperRef)) return;
    upsertPaperTab({ paperHash: hash, title: paperRef.title, isPdf, pageCount: Number(paperRef.pageCount || paperRef.parser?.pageCount || 0) });
    activePaperHash = hash;
    activeView = "paper";
    renderWorkspaceTabs();
    saveTabsState();

    const ensuredPaper = await ensureResearchPaper({ paperHash: hash, paperRef, revision }).catch((error) => {
      recordQaEvent("paper.autosave.failed", { paperHash: hash, message: String(error?.message || "论文同步失败") }, "error");
      return null;
    });
    if (ensuredPaper) void loadLibraryItems({ quiet: true });
    if (!activePaperContextIsCurrent(hash, revision, paperRef)) return;
    await refreshGlossaryState({ paperHash: hash, paperRef, revision });
    await restorePaperProgress(hash, revision, paperRef, { preserveSnapshot: appliedViewSnapshot });
    if (!activePaperContextIsCurrent(hash, revision, paperRef)) return;
    const cacheable = paperRef.blocks.filter((block) => !paperRef.translations?.[block.id]);
    const cached = await cachedTranslationsForBlocks(cacheable, true, {
      paperHash: hash,
      paperRef,
      revision,
      glossaryVersion: paperRef.glossaryVersion || 0,
    });
    if (!activePaperContextIsCurrent(hash, revision, paperRef)) return;
    cached.forEach((translation, blockId) => {
      paperRef.translations[blockId] = translation;
      paperRef.translationStates[blockId] = { kind: "ai", locked: false, updatedAt: new Date().toISOString() };
    });
    if (cached.size && activePaperContextIsCurrent(hash, revision, paperRef)) {
      researchStateRevision += 1;
      renderBlocks();
      scheduleResearchSync();
    }
    if (activePaperContextIsCurrent(hash, revision, paperRef)) {
      paperLoadingHash = null;
      renderWorkspaceTabs();
      saveTabsState();
      researchTools?.refresh();
    }
  })();
  return true;
}

function blockGroupsByPage() {
  const pages = new Map();
  if (currentPaper.isPdf) {
    for (let page = 1; page <= Number(currentPaper.pageCount || 0); page += 1) pages.set(page, []);
  }
  currentPaper.blocks.forEach((block, index) => {
    const page = Number(block.page) > 0 ? Number(block.page) : 1;
    if (!pages.has(page)) pages.set(page, []);
    pages.get(page).push({ ...block, page, _order: index });
  });
  return [...pages.entries()].sort((a, b) => a[0] - b[0]);
}

const sanitizedTableCache = new Map();
const SAFE_TABLE_TAGS = new Set(["TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD", "CAPTION"]);
const DROP_TABLE_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE", "META", "LINK"]);

function sanitizeTableHtml(rawHtml) {
  const source = String(rawHtml || "");
  if (!source || source.length > 1_000_000) return "";
  if (sanitizedTableCache.has(source)) return sanitizedTableCache.get(source);
  try {
    const parsed = new DOMParser().parseFromString(source, "text/html");
    const sourceTable = parsed.querySelector("table");
    if (!sourceTable) return "";
    const targetDocument = document.implementation.createHTMLDocument("");
    let copiedNodeCount = 0;
    const copyNode = (node, depth = 0) => {
      copiedNodeCount += 1;
      if (depth > 30 || copiedNodeCount > 12000) return null;
      if (node.nodeType === Node.TEXT_NODE) return targetDocument.createTextNode(node.textContent || "");
      if (node.nodeType === Node.ELEMENT_NODE && DROP_TABLE_TAGS.has(node.tagName)) return null;
      if (node.nodeType !== Node.ELEMENT_NODE || !SAFE_TABLE_TAGS.has(node.tagName)) {
        const fragment = targetDocument.createDocumentFragment();
        [...(node.childNodes || [])].forEach((child) => {
          const copied = copyNode(child, depth + 1);
          if (copied) fragment.appendChild(copied);
        });
        return fragment;
      }
      const element = targetDocument.createElement(node.tagName.toLowerCase());
      if (node.tagName === "TD" || node.tagName === "TH") {
        ["rowspan", "colspan"].forEach((attribute) => {
          const numeric = Number(node.getAttribute(attribute));
          if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 50) element.setAttribute(attribute, String(numeric));
        });
        if (node.tagName === "TH" && ["row", "col", "rowgroup", "colgroup"].includes(node.getAttribute("scope"))) {
          element.setAttribute("scope", node.getAttribute("scope"));
        }
      }
      [...node.childNodes].forEach((child) => {
        const copied = copyNode(child, depth + 1);
        if (copied) element.appendChild(copied);
      });
      return element;
    };
    const safeTable = copyNode(sourceTable);
    const container = targetDocument.createElement("div");
    if (safeTable) container.appendChild(safeTable);
    const result = container.innerHTML;
    if (sanitizedTableCache.size > 20) sanitizedTableCache.clear();
    sanitizedTableCache.set(source, result);
    return result;
  } catch {
    return "";
  }
}

function blockTypeLabel(block) {
  const labels = {
    heading: "章节",
    image: "图片",
    chart: "图表",
    table: "表格",
    equation: "公式",
    list: "列表",
    code: "代码",
    algorithm: "算法",
    caption: "图注",
  };
  return labels[block.type] || "正文";
}

function normalizedComparableMath(value) {
  return String(value || "").replace(/^\$\$|\$\$$/g, "").replace(/\s+/g, "").trim();
}

function translationTextForBlock(block) {
  const value = typeof block?.text === "string" ? block.text.trim() : "";
  if (!value) return "";
  if (block.type === "equation" && block.latex && normalizedComparableMath(value) === normalizedComparableMath(block.latex)) return "";
  return value;
}

function renderStructuredVisual(block, translated) {
  const id = escapeAttr(block.id);
  const page = Number(block.page || 1);
  const label = blockTypeLabel(block);
  let media = "";
  if (block.assetRef?.cacheId && block.assetRef?.path) {
    media = `<div class="structured-visual mineru-asset" data-paper-hash="${escapeAttr(currentPaper.paperHash || "")}" data-cache-id="${escapeAttr(block.assetRef.cacheId)}" data-asset-path="${escapeAttr(block.assetRef.path)}" data-state="waiting">
      <div class="structured-visual-head"><span>${escapeHtml(label)} · MinerU 结构资源</span><span>${translated ? "视觉原样保留" : `Page ${page}`}</span></div>
      <div class="structured-visual-media"><div class="structured-visual-status">等待加载 MinerU 视觉资源…</div></div>
    </div>`;
  } else if (Array.isArray(block.crop) && block.crop.length === 4 && currentPaper.isPdf) {
    media = `<div class="structured-visual pdf-visual-crop" data-pdf-page="${page}" data-visual-id="${id}" data-crop="${escapeAttr(JSON.stringify(block.crop))}" data-state="waiting">
      <div class="structured-visual-head"><span>${escapeHtml(label)} · MinerU 定位 / 本地原页渲染</span><span>${translated ? "视觉原样保留" : `Page ${page}`}</span></div>
      <div class="structured-visual-media"><div class="structured-visual-status">等待渲染视觉区域…</div></div>
    </div>`;
  }

  const table = block.tableHtml
    ? `<div class="structured-table-wrap" aria-label="结构化表格">${sanitizeTableHtml(block.tableHtml)}</div>`
    : "";
  const latex = block.latex
    ? `<div class="equation-display"><div class="equation-label">${block.source === "mineru" ? "LaTeX" : "公式文本"}</div><code>${escapeHtml(String(block.latex).replace(/^\$\$|\$\$$/g, "").trim())}</code></div>`
    : "";
  const visualType = ["image", "chart", "table", "equation"].includes(block.type);
  const fallback = visualType && !media && !table && !latex
    ? `<div class="structured-visual-fallback">该结构块没有独立资源，可在上方原页预览中查看。</div>`
    : "";
  return `${media}${table}${latex}${fallback}`;
}

function renderBlock(block, translated, options = {}) {
  const id = escapeAttr(block.id);
  const rawId = String(block.id || "");
  const anchor = escapeAttr(citationAnchorForBlock(block));
  const page = Number(block.page) > 0 ? Number(block.page) : 1;
  const translationSource = translationTextForBlock(block);
  const existingTranslation = currentPaper.translations?.[rawId];
  const blockPrefix = options.blockPrefix || (translated ? "trans" : "orig");
  const textPrefix = options.textPrefix || "trans-text";
  const visual = options.showVisual === false ? "" : renderStructuredVisual(block, translated);
  let text = "";
  if (translationSource) {
    text = translated
      ? (existingTranslation
        ? `<span id="${textPrefix}-${id}" class="block-text" data-id="${id}" data-translation-text>${formatMath(escapeHtml(existingTranslation))}</span>`
        : `<span id="${textPrefix}-${id}" class="block-text trans-empty-tip" data-id="${id}" data-translation-text>[ 点击翻译本段 ]</span>`)
      : `<span class="block-text">${formatMath(escapeHtml(translationSource))}</span>`;
  }
  const state = translationState(rawId);
  const action = state.kind === "final" ? "编辑定稿" : (existingTranslation ? "重新翻译" : "译");
  const translateAction = options.showTranslateAction !== false && translationSource
    ? `<button class="btn-block-action btn-trans-single" data-id="${id}" title="${state.kind === "final" ? "编辑用户定稿" : "翻译此段"}">${action}</button>`
    : "";
  const finalizeAction = options.showFinalizeAction !== false && translated && existingTranslation
    ? `<button class="btn-block-action btn-edit-translation" data-id="${id}" title="编辑并保存为用户定稿">${state.kind === "final" ? "已定稿" : "定稿"}</button>`
    : "";
  const citationAction = options.showCitationAction === false
    ? ""
    : `<button class="btn-block-action btn-copy-citation" data-id="${id}" title="复制 Page ${page} / block ${escapeAttr(rawId)} 引用">引用</button>`;
  const actions = `${citationAction}${translateAction}${finalizeAction}`;
  const actionButton = actions ? `<div class="block-actions">${actions}</div>` : "";
  const tag = block.type !== "paragraph"
    ? `<span class="tag-pill">${translated && translationSource ? "对照 · " : ""}${escapeHtml(blockTypeLabel(block))}</span>`
    : "";
  return `<div id="${blockPrefix}-${id}" class="block ${escapeAttr(block.type || "paragraph")}${visual ? " structured-block" : ""}" data-id="${id}" data-citation-anchor="${anchor}" data-page="${page}"${translated ? " data-translation-block" : ""}>
    ${actionButton}
    ${tag}
    ${translated && existingTranslation ? `<span class="translation-state-badge ${state.kind === "final" ? "final" : "ai"}" data-translation-state="${id}">${state.kind === "final" ? "用户定稿" : "AI 译文"}</span>` : ""}
    ${visual}
    ${text ? `<div class="block-copy">${text}</div>` : ""}
  </div>`;
}

function renderContrastPair(block) {
  const id = escapeAttr(block.id);
  const translationSource = translationTextForBlock(block);
  const original = renderBlock(block, false, {
    blockPrefix: "contrast-orig",
    showFinalizeAction: false,
  });
  const translation = translationSource
    ? `<div class="contrast-part contrast-translation">
        <div class="contrast-language-label">中文译文</div>
        ${renderBlock(block, true, {
          blockPrefix: "contrast-trans",
          textPrefix: "contrast-trans-text",
          showVisual: false,
          showTranslateAction: false,
          showCitationAction: false,
        })}
      </div>`
    : "";
  return `<article id="contrast-pair-${id}" class="contrast-pair${translationSource ? "" : " contrast-source-only"}" data-id="${id}">
    <div class="contrast-part contrast-original">
      <div class="contrast-language-label">English original</div>
      ${original}
    </div>
    ${translation}
  </article>`;
}

function renderPdfVisualPreview(page, translated) {
  if (!currentPaper.isPdf) return "";
  const needsLocalPdf = currentPaper.restored === true && !currentPdfFile;
  const noText = translated && !blocksForPage(page).some((block) => translationTextForBlock(block))
    ? `<div class="pdf-no-text">本页没有可翻译文字；原页和结构化视觉内容仍保留。</div>`
    : "";
  const state = needsLocalPdf ? "unavailable" : "waiting";
  const status = needsLocalPdf ? "已恢复解析结构；重新选择同一 PDF 可恢复原页预览" : "正在准备原页预览…";
  return `<div class="pdf-visual-preview${translated ? " pdf-visual-translation" : ""}" data-pdf-page="${page}" data-state="${state}">
    <div class="pdf-visual-head">
      <span>${translated ? "原页视觉参考" : "原始 PDF 页面"} · 不参与正文排栏</span>
      <button type="button" class="pdf-visual-toggle" aria-expanded="false"${needsLocalPdf ? " disabled" : ""}>放大</button>
    </div>
    <div class="pdf-visual-canvas-wrap"><div class="pdf-visual-status">${status}</div></div>
  </div>${noText}`;
}

function blocksForPage(page) {
  return currentPaper.blocks.filter((block) => (Number(block.page) > 0 ? Number(block.page) : 1) === Number(page));
}

function renderPage(page, blocks, translated) {
  const pageLabel = `<div class="pdf-page-label">Page ${page} · 单栏阅读流</div>`;
  const visualPreview = renderPdfVisualPreview(page, translated);
  return `<section class="pdf-page single-page" data-page="${page}">
    ${pageLabel}
    ${visualPreview}
    <div class="pdf-page-flow">${blocks.map((block) => renderBlock(block, translated)).join("")}</div>
  </section>`;
}

function renderContrastPage(page, blocks) {
  const pageLabel = `<div class="pdf-page-label">Page ${page} · 逐段上下对照</div>`;
  const visualPreview = renderPdfVisualPreview(page, false);
  return `<section class="pdf-page contrast-page" data-page="${page}">
    ${pageLabel}
    ${visualPreview}
    <div class="contrast-page-flow">${blocks.map((block) => renderContrastPair(block)).join("")}</div>
  </section>`;
}

function updateTranslationStateUi(blockId) {
  const state = translationState(blockId);
  if (state.kind === "none") return;
  translationBlockElements(blockId).forEach((translationBlock) => {
    let badge = translationBlock.querySelector("[data-translation-state]");
    if (!badge) {
      badge = document.createElement("span");
      badge.dataset.translationState = blockId;
      const insertionPoint = translationBlock.querySelector(".structured-visual, .structured-table-wrap, .equation-display, .block-copy");
      translationBlock.insertBefore(badge, insertionPoint || null);
    }
    badge.className = `translation-state-badge ${state.kind === "final" ? "final" : "ai"}`;
    badge.textContent = state.kind === "final" ? "用户定稿" : "AI 译文";
    let actions = translationBlock.querySelector(".block-actions");
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "block-actions";
      translationBlock.prepend(actions);
    }
    let editButton = actions.querySelector(".btn-edit-translation");
    if (!editButton) {
      editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "btn-block-action btn-edit-translation";
      editButton.dataset.id = blockId;
      editButton.title = "编辑并保存为用户定稿";
      editButton.addEventListener("click", (event) => {
        event.stopPropagation();
        openTranslationEditor(blockId);
      });
      actions.appendChild(editButton);
    }
    editButton.textContent = state.kind === "final" ? "已定稿" : "定稿";
  });
}

function openTranslationEditor(blockId) {
  if (currentReadingMode === "original") setReadingMode("translation");
  const target = currentReadingMode === "contrast"
    ? document.getElementById(`contrast-trans-text-${blockId}`)
    : document.getElementById(`trans-text-${blockId}`);
  const current = String(currentPaper.translations?.[blockId] || "");
  if (!target || !current || target.parentElement?.querySelector(".translation-editor")) return;
  const editor = document.createElement("div");
  editor.className = "translation-editor";
  const textarea = document.createElement("textarea");
  textarea.className = "translation-editor-input";
  textarea.value = current;
  textarea.setAttribute("aria-label", "编辑用户定稿译文");
  const actions = document.createElement("div");
  actions.className = "translation-editor-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn small primary";
  save.textContent = "保存为定稿";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn small";
  cancel.textContent = "取消";
  actions.append(save, cancel);
  editor.append(textarea, actions);
  const parent = target.parentElement;
  target.hidden = true;
  parent.appendChild(editor);
  const closeEditor = () => { editor.remove(); target.hidden = false; };
  cancel.addEventListener("click", closeEditor);
  save.addEventListener("click", () => {
    const value = textarea.value.trim();
    if (!value) return;
    commitBlockTranslation(blockId, value, { kind: "final" });
    closeEditor();
    scheduleResearchSync();
    void safeToast({ message: "用户定稿已保存并锁定", type: "success" });
  });
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function renderBlocks() {
  const origContainer = document.getElementById("orig-blocks");
  const transContainer = document.getElementById("trans-blocks");
  const contrastContainer = document.getElementById("contrast-blocks");
  const pages = blockGroupsByPage();

  origContainer.innerHTML = pages.map(([page, blocks]) => renderPage(page, blocks, false)).join("");
  transContainer.innerHTML = pages.map(([page, blocks]) => renderPage(page, blocks, true)).join("");
  contrastContainer.innerHTML = pages.map(([page, blocks]) => renderContrastPage(page, blocks)).join("");
  bindPdfPreviewControls();
  observePdfPreviewPages(pdfPreviewGeneration);

  document.querySelectorAll(".btn-trans-single, .trans-empty-tip").forEach(el => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = el.getAttribute("data-id");
      translateSingleBlock(id);
    });
  });

  document.querySelectorAll(".btn-edit-translation").forEach((el) => {
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      openTranslationEditor(el.getAttribute("data-id"));
    });
  });

  document.querySelectorAll(".btn-copy-citation").forEach((el) => {
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      void copyBlockCitation(el.getAttribute("data-id"));
    });
  });

  document.querySelectorAll(".block[data-id]").forEach((el) => {
    el.addEventListener("click", () => { selectedBlockId = el.getAttribute("data-id"); });
  });

  origContainer.querySelectorAll(".block").forEach(el => {
    el.addEventListener("mouseenter", () => {
      const id = el.getAttribute("data-id");
      document.getElementById(`trans-${id}`)?.classList.add("highlight");
    });
    el.addEventListener("mouseleave", () => {
      const id = el.getAttribute("data-id");
      document.getElementById(`trans-${id}`)?.classList.remove("highlight");
    });
  });

  transContainer.querySelectorAll(".block").forEach(el => {
    el.addEventListener("mouseenter", () => {
      const id = el.getAttribute("data-id");
      document.getElementById(`orig-${id}`)?.classList.add("highlight");
    });
    el.addEventListener("mouseleave", () => {
      const id = el.getAttribute("data-id");
      document.getElementById(`orig-${id}`)?.classList.remove("highlight");
    });
  });
}

function setBlockTranslationAction(blockId, label) {
  document.querySelectorAll(".btn-trans-single").forEach((button) => {
    if (button.dataset.id === blockId) button.textContent = label;
  });
}

function setTranslationPlaceholder(blockId, message, retryable = false) {
  translationTextElements(blockId).forEach((target) => {
    if (retryable) {
      target.textContent = message;
      target.classList.add("trans-empty-tip");
    } else {
      target.innerHTML = `<span class="trans-loading">${escapeHtml(message)}</span>`;
      target.classList.remove("trans-empty-tip");
    }
  });
}

function citationTextForBlock(block, selected = "") {
  const page = Number(block?.page) > 0 ? Number(block.page) : 1;
  const id = String(block?.id || "unknown");
  const source = String(selected || block?.text || "").trim();
  return `【论文引用】\n论文：${currentPaper.title}\n来源：Page ${page} / block ${id}\n锚点：#${citationAnchorForBlock(block)}\n原文：${source}`;
}

async function copyBlockCitation(blockId) {
  const block = currentPaper.blocks.find((item) => item.id === blockId);
  if (!block) return;
  selectedBlockId = block.id;
  if (await copyTextToClipboard(citationTextForBlock(block))) {
    await safeToast({ message: `已复制 Page ${Number(block.page || 1)} / block ${block.id} 引用`, type: "success" });
  } else {
    await safeToast({ message: "浏览器未允许复制，请手动复制引用", type: "error" });
  }
}

async function translateSingleBlock(blockId) {
  if (fullTranslationBusy) return;
  if (isFinalTranslation(blockId)) {
    openTranslationEditor(blockId);
    return;
  }
  const paperRef = currentPaper;
  const paperHash = normalizedPaperHash(paperRef.paperHash);
  const revision = paperRevision;
  if (!paperHash || !activePaperContextIsCurrent(paperHash, revision, paperRef)) return;
  const block = paperRef.blocks.find((item) => item.id === blockId);
  const sourceText = translationTextForBlock(block);
  if (!block || !sourceText) return;
  const runId = (blockTranslationRunIds.get(blockId) || 0) + 1;
  blockTranslationRunIds.set(blockId, runId);
  const hadTranslation = Boolean(paperRef.translations?.[blockId]);
  const glossaryVersion = Number(paperRef.glossaryVersion || 0);
  const agentId = currentAgent?.id || "";
  const modelRef = selectedModelRefForAgent(currentAgent);
  const thinkingLevel = currentThinkingLevel;
  const glossaryTerms = cloneJson(paperRef.glossaryTerms || {}) || {};
  const isCurrent = () => activePaperContextIsCurrent(paperHash, revision, paperRef)
    && blockTranslationRunIds.get(blockId) === runId;
  alignTranslationBlock(blockId);
  setTranslationPlaceholder(blockId, "正在检查翻译缓存...");
  window.requestAnimationFrame(() => { if (isCurrent()) alignTranslationBlock(blockId); });

  try {
    const cached = await getCachedBlockTranslation(block, sourceText, !hadTranslation, {
      paperHash,
      glossaryVersion,
      agentId,
      modelRef,
    });
    if (!isCurrent()) return;
    if (cached) {
      commitBlockTranslation(blockId, cached, { paperHash, paperRef, revision });
      window.requestAnimationFrame(() => { if (isCurrent()) alignTranslationBlock(blockId); });
      return;
    }
    setTranslationPlaceholder(blockId, "正在翻译中...");
    const res = await pluginApiFetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: sourceText, agentId, modelRef, thinkingLevel, glossaryTerms }),
    });
    const data = await res.json();
    if (!isCurrent()) return;
    applyEffectiveThinkingLevel(data);
    const transText = Array.isArray(data.translations) && typeof data.translations[0] === "string"
      ? data.translations[0].trim()
      : "";
    if (!data.ok || !transText) throw new Error(data.error || "翻译模型未返回有效结果");
    if (!commitBlockTranslation(blockId, transText, { paperHash, paperRef, revision })) return;
    await cacheBlockTranslation(block, sourceText, transText, { paperHash, paperRef, revision, glossaryVersion, agentId, modelRef });
    if (!isCurrent()) return;
    scheduleResearchSync();
    window.requestAnimationFrame(() => { if (isCurrent()) alignTranslationBlock(blockId); });
  } catch (error) {
    if (!isCurrent()) return;
    setTranslationPlaceholder(blockId, "翻译失败，点击重试", true);
  }
}

async function startFullTranslation() {
  if (fullTranslationBusy) return;
  const paperRef = currentPaper;
  const paperHash = normalizedPaperHash(paperRef.paperHash);
  const revision = paperRevision;
  let blocks = paperRef.blocks.filter((block) => Boolean(translationTextForBlock(block)));
  const button = document.getElementById("btn-translate-all");
  if (!paperHash || !blocks.length) return;
  const runId = ++fullTranslationRunId;
  const agentId = currentAgent?.id || "";
  const modelRef = selectedModelRefForAgent(currentAgent);
  const thinkingLevel = currentThinkingLevel;
  const isCurrent = () => runId === fullTranslationRunId
    && paperContextIsCurrent(paperHash, revision, paperRef);
  fullTranslationBusy = true;
  if (!button) {
    fullTranslationBusy = false;
    return;
  }
  button.disabled = true;
  button.textContent = "正在准备翻译…";
  let failedCount = 0;
  try {
    await refreshGlossaryState({ paperHash, paperRef, revision });
    if (!isCurrent()) return;
    blocks = paperRef.blocks.filter((block) => Boolean(translationTextForBlock(block)));
    const mutableBlocks = blocks.filter((block) => !isFinalTranslation(block.id));
    const force = mutableBlocks.length > 0 && mutableBlocks.every((block) => Boolean(paperRef.translations[block.id]));
    if (force) {
      mutableBlocks.forEach((block) => {
        delete paperRef.translations[block.id];
        delete paperRef.translationStates[block.id];
      });
      paperRef.replaceTranslations = true;
      researchStateRevision += 1;
    }
    const pending = mutableBlocks.filter((block) => !paperRef.translations[block.id]);
    if (!pending.length) {
      fullTranslationBusy = false;
      button.disabled = false;
      button.textContent = mutableBlocks.length ? "重新翻译全文" : "译文均已定稿";
      return;
    }

    blockTranslationRunIds.clear();
    button.textContent = "正在翻译中…";
    pending.forEach((block) => setTranslationPlaceholder(block.id, "正在翻译中..."));

    const batchSize = 2;
    const glossaryVersion = Number(paperRef.glossaryVersion || 0);
    const glossaryTerms = cloneJson(paperRef.glossaryTerms || {}) || {};
    const cache = force ? new Map() : await cachedTranslationsForBlocks(pending, true, {
      paperHash,
      paperRef,
      revision,
      glossaryVersion,
      agentId,
      modelRef,
    });
    if (!isCurrent()) return;
    cache.forEach((translation, blockId) => {
      if (isCurrent()) commitBlockTranslation(blockId, translation, { paperHash, paperRef, revision });
    });
    const uncached = pending.filter((block) => !paperRef.translations[block.id]);
    for (let index = 0; index < uncached.length; index += batchSize) {
      if (!isCurrent()) return;
      const slice = uncached.slice(index, index + batchSize);
      const texts = slice.map((block) => translationTextForBlock(block));
      try {
        const res = await pluginApiFetch("/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ texts, agentId, modelRef, thinkingLevel, glossaryTerms }),
        });
        const data = await res.json();
        if (!isCurrent()) return;
        applyEffectiveThinkingLevel(data);
        if (!data.ok || !Array.isArray(data.translations) || data.translations.length !== slice.length) {
          throw new Error(data.error || "翻译模型返回格式无效");
        }
        const translations = data.translations.map((value) => typeof value === "string" ? value.trim() : "");
        if (translations.some((value) => !value)) throw new Error("翻译模型返回空结果");
        for (let offset = 0; offset < slice.length; offset += 1) {
          if (!isCurrent()) return;
          const block = slice[offset];
          const transText = translations[offset];
          if (!commitBlockTranslation(block.id, transText, { paperHash, paperRef, revision })) return;
          await cacheBlockTranslation(block, texts[offset], transText, {
            paperHash,
            paperRef,
            revision,
            glossaryVersion,
            agentId,
            modelRef,
          });
        }
        if (!isCurrent()) return;
        scheduleResearchSync();
      } catch (error) {
        if (!isCurrent()) return;
        failedCount += slice.length;
        slice.forEach((block) => setTranslationPlaceholder(block.id, "翻译失败，点击重试", true));
      }
    }
  } finally {
    if (isCurrent()) {
      fullTranslationBusy = false;
      button.disabled = false;
      button.textContent = failedCount ? `重试未完成段落 (${failedCount})` : "重新翻译全文";
      renderBlocks();
      scheduleResearchSync();
    }
  }
}

function handleTextSelection() {
  const selection = window.getSelection();
  const text = selection ? selection.toString().trim() : "";
  const toolbar = document.getElementById("selection-toolbar");

  if (!text || text.length < 2) {
    toolbar.style.display = "none";
    return;
  }

  let node = selection.anchorNode;
  while (node && !node.classList?.contains("block")) node = node.parentElement;
  if (!node) {
    toolbar.style.display = "none";
    return;
  }
  selectedText = text;
  selectedContext = node.textContent.trim();
  selectedBlockId = node.getAttribute("data-id") || selectedBlockId;
  selectedFromTranslation = Boolean(node.closest("[data-translation-block]"));

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  const layout = document.querySelector(".main-layout")?.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;

  toolbar.style.display = "flex";
  toolbar.style.left = `${rect.left - (layout?.left || 0) + rect.width / 2}px`;
  toolbar.style.top = `${rect.top - (layout?.top || 0)}px`;
}

async function askAgentQuestion(questionType = "default") {
  document.getElementById("selection-toolbar").style.display = "none";
  const requestId = ++askAgentRequestId;
  const paperRef = currentPaper;
  const paperHash = normalizedPaperHash(paperRef.paperHash);
  const revision = paperRevision;
  const drawer = document.getElementById("answer-drawer");
  const drawerQuote = document.getElementById("drawer-quote");
  const drawerContent = document.getElementById("drawer-content");
  const selectedBlock = paperRef.blocks.find((block) => block.id === selectedBlockId) || null;
  const citation = selectedBlock ? `Page ${Number(selectedBlock.page || 1)} / block ${selectedBlock.id}` : "";
  const isCurrent = () => requestId === askAgentRequestId
    && paperRefIsCurrent(revision, paperRef)
    && normalizedPaperHash(currentPaper.paperHash) === paperHash
    && activeView === "paper";

  drawer.classList.add("open");
  drawerQuote.textContent = citation ? `“${selectedText}” · ${citation}` : `“${selectedText}”`;
  drawerContent.innerHTML = `<span class="trans-loading">${escapeHtml(currentAgent.name)}（${escapeHtml(currentAgent.model || "")}）正在深度推导与解析中...</span>`;

  try {
    const res = await pluginApiFetch("/api/ask-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: currentAgent.id,
        quote: selectedText,
        context: `${selectedContext}${citation ? `\n来源：${citation}` : ""}`,
        questionType,
        paperTitle: paperRef.title,
        paperHash: paperHash,
        blockId: selectedBlock?.id || null,
        page: selectedBlock?.page || null,
        modelRef: selectedModelRefForAgent(currentAgent),
        thinkingLevel: currentThinkingLevel,
        glossaryTerms: currentPaper.glossaryTerms || {},
      })
    });
    const data = await res.json();
    if (!isCurrent()) return;
    applyEffectiveThinkingLevel(data);
    if (data.ok) {
      const verifiedCitation = typeof data.citation === "string" ? data.citation : "";
      drawerQuote.textContent = verifiedCitation ? `“${selectedText}” · ${verifiedCitation}` : `“${selectedText}”`;
      drawerContent.innerHTML = formatMarkdown(data.answer);
      if (verifiedCitation && !String(data.answer || "").includes(verifiedCitation)) {
        drawerContent.insertAdjacentText("beforeend", `\n\n${verifiedCitation}`);
      }
    } else {
      drawerContent.textContent = `解析遇到问题: ${data.error || "未知异常"}`;
    }
  } catch (err) {
    if (isCurrent()) drawerContent.textContent = "请求异常，请检查网络或后端状态。";
  }
}

function sessionQuotePayload() {
  const selectedBlock = currentPaper.blocks.find((block) => block.id === selectedBlockId) || null;
  const citation = selectedBlock ? `Page ${Number(selectedBlock.page || 1)} / block ${selectedBlock.id}` : "";
  return {
    agentId: currentAgent.id,
    quote: selectedText,
    context: `${selectedContext}${citation ? `\n来源：${citation}` : ""}`,
    paperTitle: currentPaper.title,
    paperHash: currentPaper.paperHash,
    blockId: selectedBlock?.id || null,
    page: selectedBlock?.page || null,
    modelRef: selectedModelRefForAgent(currentAgent),
    thinkingLevel: currentThinkingLevel,
    citation,
  };
}

function sessionQuoteForClipboard(payload = {}) {
  return `【论文划选研讨】\n论文：${payload.paperTitle || currentPaper.title}\n${payload.citation ? `来源：${payload.citation}\n` : ""}选中文本：${payload.quote || selectedText}\n上下文：${payload.context || selectedContext}`;
}

function formatSessionTargetDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" });
}

function setSessionTargetStatus(message, tone = "") {
  const status = document.getElementById("session-target-status");
  if (!status) return;
  status.textContent = String(message || "");
  status.dataset.tone = tone;
}

function renderSessionTargets() {
  const list = document.getElementById("session-target-list");
  const confirm = document.getElementById("btn-confirm-session-target");
  if (!list || !confirm) return;
  confirm.disabled = sessionPickerBusy || !selectedSessionTargetId;
  if (!sessionTargets.length) {
    list.innerHTML = `<div class="session-target-empty">没有可选的已有对话。你可以新建一个对话并发送。</div>`;
    return;
  }
  list.innerHTML = sessionTargets.map((target) => {
    const selected = target.targetId === selectedSessionTargetId;
    const agent = target.agentName || target.agentId || "Hana 助手";
    const modified = formatSessionTargetDate(target.modified);
    const meta = [agent, modified, Number(target.messageCount) > 0 ? `${target.messageCount} 条消息` : ""].filter(Boolean).join(" · ");
    return `<button type="button" class="session-target-option${selected ? " selected" : ""}" data-session-target-id="${escapeAttr(target.targetId)}" aria-pressed="${selected}">
      <span class="session-target-option-main">
        <strong>${escapeHtml(target.title || "未命名对话")}</strong>
        <span>${escapeHtml(meta || "公开对话")}</span>
      </span>
      <span class="session-target-option-mark" aria-hidden="true">${selected ? "✓" : ""}</span>
    </button>`;
  }).join("");
}

function closeSessionTargetPicker(force = false) {
  const modal = document.getElementById("session-target-modal");
  if (!modal || (sessionPickerBusy && !force)) return;
  sessionPickerRequestId += 1;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  selectedSessionTargetId = null;
  sessionTargets = [];
  setSessionTargetStatus("");
}

function selectSessionTarget(targetId) {
  if (sessionPickerBusy) return;
  const target = sessionTargets.find((item) => item.targetId === targetId);
  if (!target) return;
  selectedSessionTargetId = target.targetId;
  setSessionTargetStatus(`已选择：${target.title || "未命名对话"}`);
  renderSessionTargets();
}

async function openSessionTargetPicker() {
  document.getElementById("selection-toolbar").style.display = "none";
  if (!selectedText || selectedText.length < 2) {
    await safeToast({ message: "请先划选一段原文或译文", type: "error" });
    return;
  }
  const modal = document.getElementById("session-target-modal");
  if (!modal || sessionPickerBusy) return;
  const requestId = ++sessionPickerRequestId;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  selectedSessionTargetId = null;
  sessionTargets = [];
  setSessionTargetStatus("正在读取可选对话…", "loading");
  renderSessionTargets();
  sessionPickerBusy = true;
  renderSessionTargets();
  try {
    const res = await pluginApiFetch("/api/session-targets");
    const data = await res.json();
    if (requestId !== sessionPickerRequestId || !modal.classList.contains("open")) return;
    if (!res.ok || !data.ok) throw new Error(data.error || "无法读取对话列表");
    sessionTargets = Array.isArray(data.sessions) ? data.sessions.filter((item) => item?.targetId) : [];
    setSessionTargetStatus(sessionTargets.length ? "请选择一个已有对话。" : "没有可选的已有对话。", sessionTargets.length ? "" : "empty");
    renderSessionTargets();
  } catch (error) {
    if (requestId !== sessionPickerRequestId || !modal.classList.contains("open")) return;
    sessionTargets = [];
    setSessionTargetStatus(error?.message || "无法读取对话列表，请稍后重试。", "error");
    renderSessionTargets();
  } finally {
    if (requestId === sessionPickerRequestId) {
      sessionPickerBusy = false;
      renderSessionTargets();
    }
  }
}

async function postSessionQuote(route, extra = {}) {
  const payload = sessionQuotePayload();
  const res = await pluginApiFetch(route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, ...extra }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    const error = new Error(data.error || "发送失败");
    error.code = data.code || null;
    error.status = res.status;
    throw error;
  }
  return { data, payload };
}

async function confirmSelectedSessionTarget() {
  if (sessionPickerBusy || !selectedSessionTargetId) return;
  sessionPickerBusy = true;
  setSessionTargetStatus("正在发送到所选对话…", "loading");
  renderSessionTargets();
  try {
    const result = await postSessionQuote("/api/send-to-session", { targetId: selectedSessionTargetId });
    const verifiedPayload = { ...result.payload, citation: typeof result.data.citation === "string" ? result.data.citation : "" };
    const copied = await copyTextToClipboard(sessionQuoteForClipboard(verifiedPayload));
    const title = result.data.session?.title || "所选对话";
    closeSessionTargetPicker(true);
    await safeToast({ message: copied ? `已发送到“${title}”，引用也已复制` : `已发送到“${title}”`, type: "success" });
  } catch (error) {
    setSessionTargetStatus(error?.message || "发送失败，请稍后重试。", "error");
    if (error?.code === "session_target_expired") {
      sessionTargets = [];
      selectedSessionTargetId = null;
      await reloadSessionTargetsInPicker();
    }
  } finally {
    sessionPickerBusy = false;
    renderSessionTargets();
  }
}

async function reloadSessionTargetsInPicker() {
  const modal = document.getElementById("session-target-modal");
  if (!modal?.classList.contains("open")) return;
  const requestId = ++sessionPickerRequestId;
  sessionPickerBusy = true;
  setSessionTargetStatus("正在刷新对话列表…", "loading");
  renderSessionTargets();
  try {
    const res = await pluginApiFetch("/api/session-targets");
    const data = await res.json();
    if (requestId !== sessionPickerRequestId || !modal.classList.contains("open")) return;
    if (!res.ok || !data.ok) throw new Error(data.error || "无法读取对话列表");
    sessionTargets = Array.isArray(data.sessions) ? data.sessions.filter((item) => item?.targetId) : [];
    setSessionTargetStatus("请选择一个已有对话。", "");
  } catch (error) {
    if (requestId !== sessionPickerRequestId || !modal.classList.contains("open")) return;
    setSessionTargetStatus(error?.message || "无法读取对话列表，请稍后重试。", "error");
  } finally {
    if (requestId === sessionPickerRequestId) {
      sessionPickerBusy = false;
      renderSessionTargets();
    }
  }
}

async function createSessionAndSend() {
  if (sessionPickerBusy) return;
  sessionPickerBusy = true;
  setSessionTargetStatus("正在新建对话并发送…", "loading");
  renderSessionTargets();
  try {
    const result = await postSessionQuote("/api/create-session-and-send");
    const verifiedPayload = { ...result.payload, citation: typeof result.data.citation === "string" ? result.data.citation : "" };
    const copied = await copyTextToClipboard(sessionQuoteForClipboard(verifiedPayload));
    closeSessionTargetPicker(true);
    await safeToast({ message: copied ? "已新建对话并发送，引用也已复制" : "已新建对话并发送", type: "success" });
  } catch (error) {
    setSessionTargetStatus(error?.message || "新建对话失败，请稍后重试。", "error");
  } finally {
    sessionPickerBusy = false;
    renderSessionTargets();
  }
}

async function sendQuoteToSession() {
  await openSessionTargetPicker();
}

async function copyQuoteText() {
  document.getElementById("selection-toolbar").style.display = "none";
  const selectedBlock = currentPaper.blocks.find((block) => block.id === selectedBlockId) || null;
  const value = selectedBlock ? citationTextForBlock(selectedBlock, selectedText) : selectedText;
  if (await copyTextToClipboard(value)) {
    await safeToast({ message: selectedBlock ? "已复制带来源引用" : "已复制选中内容", type: "success" });
  } else {
    await safeToast({ message: "浏览器未允许复制，请手动复制选中文本", type: "error" });
  }
}

async function safeToast(input) {
  showPanelNotice(input);
  try {
    return await hanaBridge.toast.show(input);
  } catch (error) {
    // Keep an in-panel fallback visible when the host toast bridge is missing,
    // delayed, or rejected by an older renderer.
    return { shown: false, error: String(error?.message || "宿主提示不可用") };
  }
}

function escapeHtml(text) {
  return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/`/g, "&#96;");
}

function formatMath(text) {
  return String(text || "")
    // Use phrasing elements: block-level <div> inside the reader's <span>
    // produces invalid HTML and Chromium may move or drop surrounding text.
    .replace(/\\\[([\s\S]+?)\\\]/g, '<span class="math-display" role="math">$1</span>')
    .replace(/\$\$([\s\S]+?)\$\$/g, '<span class="math-display" role="math">$1</span>')
    .replace(/\\\(([^\n]+?)\\\)/g, '<span class="math-inline" role="math">$1</span>')
    .replace(/\$([^$\n]+?)\$/g, '<span class="math-inline" role="math">$1</span>');
}

function formatMarkdown(text) {
  return formatMath(
    escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--accent)">$1</strong>')
      .replace(/`([^`]+)`/g, '<code style="font-family:var(--font-mono);background:var(--accent-light);padding:1px 4px;border-radius:3px">$1</code>')
      .replace(/\n/g, "<br>")
  );
}

initLayout();
hanaBridge.ready();
