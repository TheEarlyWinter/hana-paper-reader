const PROTOCOL = "hana.plugin.ui";
const VERSION = 1;
const UI_VERSION = "0.6.2";
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

function currentPluginId() {
  const match = /^\/api\/plugins\/([^/]+)(?:\/|$)/.exec(window.location.pathname || "");
  return match ? decodeURIComponent(match[1]) : "hana-paper-reader";
}

function pluginApiFetch(path, init = {}) {
  const base = `/api/plugins/${encodeURIComponent(currentPluginId())}`;
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${window.location.origin}${base}${cleanPath}`;
  const surfaceSession = new URLSearchParams(window.location.search).get("pluginSurfaceSession");
  const headers = new Headers(init.headers || {});
  if (surfaceSession) headers.set("X-Hana-Plugin-Surface-Session", surfaceSession);
  headers.set("X-Hana-Paper-Reader-UI-Version", UI_VERSION);
  return fetch(url, { ...init, headers });
}

const hana = {
  ready: () => event("hana.ready"),
  ui: { resize: (size) => event("ui.resize", size) },
  toast: { show: (input) => request("toast.show", input) },
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
let currentAgent = agentsList[0];
let currentPaper = {
  title: "未导入文献",
  paperHash: null,
  blocks: [],
  translations: {},
  translationStates: {},
  glossaryVersion: 0,
  translationGlossaryVersion: 0,
};
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
let pendingPdfFile = null;
let parseJobId = 0;
let activeParseController = null;
let paperRevision = 0;
let fullTranslationRunId = 0;
let fullTranslationBusy = false;
const blockTranslationRunIds = new Map();
let selectedText = "";
let selectedContext = "";
let selectedFromTranslation = false;
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
let pdfPreviewDocument = null;
let pdfPreviewLoadingTask = null;
let pdfPreviewObserver = null;
let pdfJsModulePromise = null;
const pdfPreviewObjectUrls = new Set();
const mineruAssetUrlPromises = new Map();
const pdfPageRenderLocks = new Map();
let researchTools = null;
let researchToolsPromise = null;
let selectedBlockId = null;
let activeParseTask = null;
let progressSyncTimer = null;
let researchSyncTimer = null;
let researchStateRevision = 0;
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

function initLayout() {
  if (!root) return;
  root.innerHTML = `
    <header class="navbar">
      <div class="nav-left">
        <div class="app-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          Hana Paper Reader
        </div>
        <div id="paper-badge" class="paper-title-badge">未载入文献</div>
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
      <!-- 拖拽提示遮罩 -->
      <div id="drag-overlay" class="drag-overlay">
        <div class="drag-icon">📑</div>
        <div class="drag-text">松开鼠标即可解析 PDF 文献</div>
      </div>

      <!-- 空状态 -->
      <div id="empty-view" class="empty-view">
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

      <!-- 划词悬浮操作栏 -->
      <div id="selection-toolbar" class="selection-toolbar">
        <div id="quick-agent-avatars" style="display:flex;gap:4px;margin-right:2px"></div>
        <button id="btn-ask-agent" class="tool-btn primary">
          <span id="tool-agent-text">问当前助手</span>
        </button>
        <button id="btn-ask-formula" class="tool-btn">📐 公式拆解</button>
        <button id="btn-ask-explain" class="tool-btn">🔍 概念解析</button>
        <button id="btn-create-note" class="tool-btn">📝 创建研究笔记</button>
        <button id="btn-send-session" class="tool-btn">✉️ 发送到会话</button>
        <button id="btn-copy-quote" class="tool-btn">📋 复制</button>
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
          <button id="btn-drawer-send-chat" class="btn small primary">✉️ 发送到主聊天</button>
          <span style="font-size:0.7rem;color:var(--text-muted)">Hana Paper Companion</span>
        </div>
      </div>
    </div>
  `;

  bindEvents();
  loadAgentsList();
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

  btnOpenFile.addEventListener("click", () => fileInput.click());
  btnEmptyImport.addEventListener("click", () => fileInput.click());
  document.getElementById("btn-empty-config").addEventListener("click", openMineruSettings);
  document.getElementById("btn-empty-restore").addEventListener("click", () => backupInput.click());
  btnSample.addEventListener("click", loadSamplePaper);
  btnEmptySample.addEventListener("click", loadSamplePaper);
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
  document.getElementById("btn-save-mineru-settings").addEventListener("click", saveMineruSettings);
  document.getElementById("btn-clear-mineru-token").addEventListener("click", clearMineruToken);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.getElementById("mineru-settings-modal")?.classList.contains("open")) {
      closeMineruSettings(true);
    }
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
  window.addEventListener("click", () => agentDropdown.classList.remove("show"));

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
  document.getElementById("btn-send-session").addEventListener("click", sendQuoteToSession);
  document.getElementById("btn-copy-quote").addEventListener("click", copyQuoteText);

  btnCloseDrawer.addEventListener("click", () => {
    document.getElementById("answer-drawer").classList.remove("open");
  });
  btnDrawerSendChat.addEventListener("click", sendQuoteToSession);

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
  if (reparse) reparse.style.display = currentPdfFile ? "inline-flex" : "none";
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
  if (eventOrCancel) pendingPdfFile = null;
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
    if (pendingPdfFile) {
      const file = pendingPdfFile;
      pendingPdfFile = null;
      void parsePdfFile(file);
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
  return {
    ...currentPaper,
    loaded: currentPaper.blocks.length > 0,
    blocks: currentPaper.blocks.map((block) => ({
      ...block,
      translatedText: currentPaper.translations?.[block.id] || "",
    })),
    agentId: currentAgent?.id || null,
    thinkingLevel: currentThinkingLevel,
    glossaryTerms: currentPaper.glossaryTerms || {},
    translationStates: currentPaper.translationStates || {},
    readingMode: currentReadingMode,
  };
}

function selectedResearchBlock() {
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
      getPaper: researchPaperView,
      getSelectedBlock: selectedResearchBlock,
      getProgress: currentReadingProgress,
      getSelection: () => ({ text: selectedText, context: selectedContext, blockId: selectedBlockId, fromTranslation: selectedFromTranslation }),
      onLocateBlock: locateResearchBlock,
      onSearchHighlight: highlightSearchInReader,
      onUiStateChanged: (uiState) => { restoredResearchUiState = uiState; scheduleProgressSync(); },
      onPaperStateChanged: (change) => {
        if (change?.kind === "glossary") void refreshGlossaryState();
        researchTools?.refresh();
      },
      onPaperDataChanged: (change) => {
        if (change?.paper?.blocks?.length) {
          const parser = change.paper.parser || {};
          loadPaper({ ...change.paper, title: change.paper.metadata?.title || currentPaper.title, isPdf: parser.kind === "mineru", pageCount: parser.pageCount || 0, restored: true });
        } else if (change?.action === "structure-keep-notes" && change?.paper) {
          loadDetachedResearchRecord({ ...change.paper, structureDetached: true });
        }
      },
      onPaperDeleted: () => clearCurrentPaperView("论文及其全部研究数据已删除。"),
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

function clearCurrentPaperView(message = "未载入文献") {
  cancelActiveParse();
  resetPdfPreview();
  currentPdfFile = null;
  currentPaper = { title: "未导入文献", paperHash: null, blocks: [], translations: {}, translationStates: {}, glossaryVersion: 0, translationGlossaryVersion: 0 };
  selectedBlockId = null;
  paperRevision += 1;
  document.getElementById("reader-container").style.display = "none";
  document.getElementById("empty-view").style.display = "flex";
  document.getElementById("reading-mode-control").style.display = "none";
  document.getElementById("btn-translate-all").style.display = "none";
  document.getElementById("btn-research-tools").style.display = "none";
  document.getElementById("paper-badge").textContent = message;
  const description = document.querySelector(".empty-desc");
  if (description) description.textContent = "选择一个动作即可进入阅读。解析模型、文件指纹和结构块等技术细节只在需要时展开。";
  updateMineruUI();
  researchTools?.refresh();
}

async function restoreResearchBackup(file) {
  if (!file || file.size > 256 * 1024 * 1024) {
    await safeToast({ message: "备份文件为空或超过 256 MB", type: "error" });
    return;
  }
  try {
    const backup = JSON.parse(await file.text());
    if (backup?.format !== "hana-paper-reader-backup") throw new Error("不是 Hana Paper Reader 备份文件");
    if (!window.confirm("恢复会用备份内容替换同一论文当前的数据；其他论文不受影响。确认继续？")) return;
    const response = await pluginApiFetch("/api/research/restore", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(backup),
    });
    const data = await response.json();
    if (!response.ok || !data.ok || !data.paper) throw new Error(data.error || "备份恢复失败");
    const parser = data.paper.parser || {};
    loadPaper({ ...data.paper, title: data.paper.metadata?.title || "已恢复论文", isPdf: parser.kind === "mineru", pageCount: parser.pageCount || 0, restored: true, cached: true });
    await safeToast({ message: "研究备份已恢复；重新选择同一 PDF 可恢复原页预览，不会重复解析", type: "success" });
  } catch (error) {
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

function loadDetachedResearchRecord(paper) {
  const parser = paper.parser && typeof paper.parser === "object" ? paper.parser : {};
  currentPaper = {
    ...paper,
    title: paper.metadata?.title || "保留的研究记录",
    blocks: [],
    translations: {},
    translationStates: {},
    structureDetached: true,
    loaded: true,
    isPdf: parser.kind === "mineru",
    pageCount: Number(parser.pageCount || 0),
  };
  document.getElementById("paper-badge").textContent = `${currentPaper.title} · 仅保留研究记录`;
  document.getElementById("empty-view").style.display = "flex";
  document.getElementById("reader-container").style.display = "none";
  document.getElementById("reading-mode-control").style.display = "none";
  document.getElementById("btn-translate-all").style.display = "none";
  document.getElementById("btn-research-tools").style.display = "inline-flex";
  const description = document.querySelector(".empty-desc");
  if (description) description.textContent = "论文正文结构已按你的操作删除；证据型研究笔记仍可在研究工作流中查看。重新选择同一 PDF 可重新解析并恢复正文。";
  researchTools?.refresh();
}

async function restoreRecentPaper() {
  const revision = paperRevision;
  try {
    const response = await pluginApiFetch("/api/research/recent");
    const data = await response.json();
    if (revision !== paperRevision || currentPaper.blocks.length || !response.ok || !data.ok || !data.paper) return false;
    if (data.paper.structureDetached) {
      loadDetachedResearchRecord(data.paper);
      return true;
    }
    if (!data.paper.blocks?.length) return false;
    const parser = data.paper.parser && typeof data.paper.parser === "object" ? data.paper.parser : {};
    loadPaper({
      ...data.paper,
      title: data.paper.metadata?.title || "最近阅读论文",
      pageCount: Number(parser.pageCount || 0),
      isPdf: parser.kind === "mineru",
      modelVersion: parser.modelVersion || null,
      cached: true,
      restored: true,
    });
    return true;
  } catch {
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

async function ensureResearchPaper() {
  if (!currentPaper.blocks.length) return null;
  if (!isPaperHash(currentPaper.paperHash)) currentPaper.paperHash = await hashPaperSource(currentPaper);
  const revision = paperRevision;
  const stateRevision = researchStateRevision;
  const paperHash = currentPaper.paperHash;
  const payload = {
    paperHash: currentPaper.paperHash,
    metadata: { title: currentPaper.title },
    parser: {
      kind: typeof currentPaper.parser === "string" ? currentPaper.parser : (currentPaper.parser?.kind || (currentPaper.isPdf ? "mineru" : "text")),
      modelVersion: currentPaper.modelVersion || currentPaper.parser?.modelVersion || null,
      pageCount: Number(currentPaper.pageCount || currentPaper.parser?.pageCount || 0),
      ocrUsed: currentPaper.ocrUsed === true || currentPaper.parser?.ocrUsed === true,
      ocrFallback: currentPaper.ocrFallback === true || currentPaper.parser?.ocrFallback === true,
    },
    assets: currentPaper.resources || [],
    blocks: currentPaper.blocks,
    translations: currentPaper.translations || {},
    translationStates: currentPaper.translationStates || {},
    readingMode: currentReadingMode,
    translationGlossaryVersion: Number(currentPaper.translationGlossaryVersion || currentPaper.glossaryVersion || 0),
    replaceTranslations: currentPaper.replaceTranslations === true,
  };
  const response = await pluginApiFetch("/api/research/paper", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || "论文工作区同步失败");
  if (revision !== paperRevision || paperHash !== currentPaper.paperHash) return data.paper;
  const remoteBlocks = Array.isArray(data.paper?.blocks) ? data.paper.blocks : [];
  const remoteTranslations = data.paper?.translations && typeof data.paper.translations === "object" ? data.paper.translations : {};
  const remoteBlockTranslations = Object.fromEntries(remoteBlocks
    .filter((block) => block?.id && typeof block.translatedText === "string" && block.translatedText.trim())
    .map((block) => [block.id, block.translatedText.trim()]));
  if (stateRevision === researchStateRevision) {
    currentPaper.translations = { ...remoteBlockTranslations, ...remoteTranslations };
    currentPaper.translationStates = data.paper?.translationStates && typeof data.paper.translationStates === "object"
      ? { ...data.paper.translationStates }
      : {};
  } else {
    scheduleResearchSync();
  }
  if (remoteBlocks.length) {
    const localById = new Map(currentPaper.blocks.map((block) => [block.id, block]));
    currentPaper.blocks = remoteBlocks.map((block) => {
      const { translatedText: _remoteTranslation, ...remoteBlock } = block;
      return { ...localById.get(block.id), ...remoteBlock, translatedText: currentPaper.translations?.[block.id] || "" };
    });
  }
  currentPaper.translationGlossaryVersion = Number(data.paper?.translationGlossaryVersion || currentPaper.translationGlossaryVersion || 0);
  currentPaper.replaceTranslations = false;
  await refreshGlossaryState();
  researchTools?.refresh();
  return data.paper;
}

function scheduleResearchSync() {
  window.clearTimeout(researchSyncTimer);
  researchSyncTimer = window.setTimeout(() => {
    void ensureResearchPaper().catch(() => {});
  }, 450);
}

async function restorePaperProgress(revision = paperRevision) {
  if (!isPaperHash(currentPaper.paperHash)) return;
  try {
    const response = await pluginApiFetch(`/api/research/progress?paperHash=${encodeURIComponent(currentPaper.paperHash)}`);
    const data = await response.json();
    if (revision !== paperRevision || !response.ok || !data.ok || !data.progress) return;
    const progress = data.progress;
    selectedBlockId = progress.blockId || selectedBlockId;
    restoredResearchUiState = { searchState: progress.searchState || {}, noteDraft: progress.noteDraft || null };
    researchTools?.restoreUiState(restoredResearchUiState);
    if (READING_MODES.has(progress.readingMode)) setReadingMode(progress.readingMode, { silent: true });
    window.setTimeout(() => {
      if (revision !== paperRevision) return;
      const original = document.getElementById("original-pane");
      const translation = document.getElementById("trans-pane");
      const contrast = document.getElementById("contrast-pane");
      if (original) original.scrollTop = Math.max(0, Number(progress.originalScrollTop || 0));
      if (translation) translation.scrollTop = Math.max(0, Number(progress.translationScrollTop || 0));
      if (contrast) contrast.scrollTop = Math.max(0, Number(progress.contrastScrollTop || 0));
      if (!Number(progress.originalScrollTop) && !Number(progress.translationScrollTop) && !Number(progress.contrastScrollTop) && progress.blockId) locateResearchBlock(progress.blockId);
      if (progress.searchState?.query) highlightSearchInReader(progress.searchState.query);
    }, 100);
    if (currentPaper.restored) {
      await safeToast({ message: "研究内容与上次阅读位置已恢复。重新选择同一 PDF 可恢复原页预览，不会重复解析。", type: "success" });
    }
  } catch {}
}

async function refreshGlossaryState() {
  if (!isPaperHash(currentPaper.paperHash)) return false;
  try {
    const response = await pluginApiFetch(`/api/research/glossary?paperHash=${encodeURIComponent(currentPaper.paperHash)}`);
    const data = await response.json();
    if (!response.ok || !data.ok) return false;
    const nextVersion = Number(data.glossary?.version || 0);
    const previousTranslationVersion = Number(currentPaper.translationGlossaryVersion || 0);
    currentPaper.glossaryVersion = nextVersion;
    currentPaper.glossaryTerms = data.glossary?.terms && typeof data.glossary.terms === "object" ? data.glossary.terms : {};
    if (nextVersion !== previousTranslationVersion) {
      const finalTranslations = {};
      const finalStates = {};
      let invalidated = 0;
      for (const [blockId, translation] of Object.entries(currentPaper.translations || {})) {
        if (isFinalTranslation(blockId)) {
          finalTranslations[blockId] = translation;
          finalStates[blockId] = currentPaper.translationStates[blockId];
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
      if (invalidated) void safeToast({ message: `术语已更新：${invalidated} 段 AI 译文待重译，用户定稿已保留`, type: "success" });
      return true;
    }
  } catch {}
  return false;
}

function scheduleProgressSync() {
  if (!isPaperHash(currentPaper.paperHash) || !currentPaper.blocks.length) return;
  window.clearTimeout(progressSyncTimer);
  progressSyncTimer = window.setTimeout(() => {
    void syncReadingProgress();
  }, 650);
}

async function syncReadingProgress() {
  if (!isPaperHash(currentPaper.paperHash)) return;
  try {
    await pluginApiFetch("/api/research/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentReadingProgress()),
    });
  } catch {}
}

async function getCachedBlockTranslation(block, sourceText, allowCache = true) {
  if (!allowCache || !isPaperHash(currentPaper.paperHash) || !block?.id) return "";
  try {
    const query = new URLSearchParams({
      paperHash: currentPaper.paperHash,
      blockId: block.id,
      glossaryVersion: String(currentPaper.glossaryVersion || 0),
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

async function cacheBlockTranslation(block, source, translation) {
  if (!isPaperHash(currentPaper.paperHash) || !block?.id || !translation) return;
  try {
    await pluginApiFetch("/api/research/translation-cache", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paperHash: currentPaper.paperHash,
        blockId: block.id,
        glossaryVersion: currentPaper.glossaryVersion || 0,
        source,
        translation,
      }),
    });
  } catch {}
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
  if (!value) return;
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
}

async function cachedTranslationsForBlocks(blocks, allowCache = true) {
  if (!allowCache || !blocks.length) return new Map();
  await refreshGlossaryState();
  const pairs = await Promise.all(blocks.map(async (block) => [block.id, await getCachedBlockTranslation(block, translationTextForBlock(block), true)]));
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

async function loadAgentsList() {
  try {
    const res = await pluginApiFetch("/api/agents");
    const data = await res.json();
    if (data.ok && Array.isArray(data.agents) && data.agents.length > 0) {
      agentsList = data.agents;
      // 优先将哈基米设为默认助手
      const foundHakimi = agentsList.find(a => a.id === "hakimi");
      currentAgent = foundHakimi || agentsList[0];
      updateAgentUI();
    }
  } catch (err) {
    console.log("agents load fallback:", err);
  }
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

  const displayName = currentAgent.name || currentAgent.id;
  agentNameText.textContent = displayName;
  agentModelBadge.textContent = currentAgent.model || "默认模型";
  toolAgentText.textContent = `问${displayName.split(" ")[0]}`;
  drawerAgentName.textContent = displayName;
  drawerAgentModel.textContent = currentAgent.model || "默认模型";

  agentAvatarSlot.innerHTML = renderAvatar(currentAgent, 22);
  drawerAvatarSlot.innerHTML = renderAvatar(currentAgent, 24);

  // 划词浮窗中的多助手快捷头像按钮
  if (quickAvatarsSlot) {
    quickAvatarsSlot.innerHTML = agentsList.slice(0, 4).map(a => `
      <div class="quick-agent-btn ${a.id === currentAgent.id ? 'active' : ''}" data-id="${escapeAttr(a.id)}" title="点击切换并向 ${escapeAttr(a.name || a.id)} 提问" style="cursor:pointer;border-radius:50%;padding:1px;border:1.5px solid ${a.id === currentAgent.id ? 'var(--accent)' : 'transparent'}">
        ${renderAvatar(a, 20)}
      </div>
    `).join("");

    quickAvatarsSlot.querySelectorAll(".quick-agent-btn").forEach(el => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const targetId = el.getAttribute("data-id");
        const found = agentsList.find(a => a.id === targetId);
        if (found) {
          currentAgent = found;
          effectiveThinkingLevel = null;
          updateAgentUI();
          askAgentQuestion("default");
        }
      });
    });
  }

  // 渲染完整下拉菜单
  agentDropdown.innerHTML = agentsList.map(a => `
    <div class="agent-menu-item ${a.id === currentAgent.id ? 'active' : ''}" data-id="${escapeAttr(a.id)}">
      ${renderAvatar(a, 26)}
      <div style="flex:1;overflow:hidden">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:600">${escapeHtml(a.name || a.id)}</span>
          <span class="agent-model-tag" style="font-size:0.65rem">${escapeHtml(a.model || "")}</span>
        </div>
        <div style="font-size:0.7rem;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(a.description ? a.description.slice(0, 20) + '...' : 'Hanako 助手')}</div>
      </div>
    </div>
  `).join("");

  agentDropdown.querySelectorAll(".agent-menu-item").forEach(el => {
    el.addEventListener("click", () => {
      const targetId = el.getAttribute("data-id");
      const found = agentsList.find(a => a.id === targetId);
      if (found) {
        currentAgent = found;
        effectiveThinkingLevel = null;
        updateAgentUI();
      }
    });
  });
}

function resetPdfPreview() {
  pdfPreviewGeneration += 1;
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

function setPdfPreviewStatus(generation, message, isError = false) {
  if (generation !== pdfPreviewGeneration) return;
  document.querySelectorAll(".pdf-visual-status").forEach((element) => {
    element.textContent = message;
    element.classList.toggle("error", isError);
  });
}

async function initializePdfPreview(file, generation) {
  try {
    const [pdfjs, arrayBuffer] = await Promise.all([getPdfJsModule(), file.arrayBuffer()]);
    if (generation !== pdfPreviewGeneration) return;
    const task = pdfjs.getDocument({
      data: new Uint8Array(arrayBuffer),
      isEvalSupported: false,
      useSystemFonts: true,
    });
    pdfPreviewLoadingTask = task;
    const documentProxy = await task.promise;
    if (generation !== pdfPreviewGeneration) {
      await documentProxy.destroy?.();
      return;
    }
    pdfPreviewDocument = documentProxy;
    pdfPreviewLoadingTask = null;
    observePdfPreviewPages(generation);
  } catch (error) {
    setPdfPreviewStatus(generation, "PDF 原页预览加载失败，提取文本仍可继续阅读", true);
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

async function withPdfPageRenderLock(pageNumber, task) {
  const previous = pdfPageRenderLocks.get(pageNumber) || Promise.resolve();
  let tracked;
  const current = previous.catch(() => {}).then(task);
  tracked = current.catch(() => {}).finally(() => {
    if (pdfPageRenderLocks.get(pageNumber) === tracked) pdfPageRenderLocks.delete(pageNumber);
  });
  pdfPageRenderLocks.set(pageNumber, tracked);
  return current;
}

async function renderPdfPagePreview(preview, generation) {
  if (generation !== pdfPreviewGeneration || !pdfPreviewDocument || preview.dataset.state === "loading" || preview.dataset.state === "rendered") return;
  const pageNumber = Number(preview.dataset.pdfPage);
  const pagePreviews = [...document.querySelectorAll(`.pdf-visual-preview[data-pdf-page="${pageNumber}"]`)];
  pagePreviews.forEach((item) => {
    item.dataset.state = "loading";
    const itemStatus = item.querySelector(".pdf-visual-status");
    if (itemStatus) itemStatus.textContent = "正在渲染原页图表与版面…";
  });
  try {
    await withPdfPageRenderLock(pageNumber, async () => {
      const page = await pdfPreviewDocument.getPage(pageNumber);
      try {
        if (generation !== pdfPreviewGeneration) return;
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
    await withPdfPageRenderLock(pageNumber, async () => {
      const page = await pdfPreviewDocument.getPage(pageNumber);
      try {
        if (generation !== pdfPreviewGeneration) return;
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

function mineruAssetObjectUrl(cacheId, assetPath, generation) {
  const key = `${generation}:${cacheId}:${assetPath}`;
  if (mineruAssetUrlPromises.has(key)) return mineruAssetUrlPromises.get(key);
  const promise = (async () => {
    const query = `cacheId=${encodeURIComponent(cacheId)}&path=${encodeURIComponent(assetPath)}`;
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
  if (!cacheId || !assetPath) return;
  preview.dataset.state = "loading";
  try {
    const objectUrl = await mineruAssetObjectUrl(cacheId, assetPath, generation);
    if (generation !== pdfPreviewGeneration) return;
    const image = document.createElement("img");
    image.className = "structured-visual-image";
    image.src = objectUrl;
    image.alt = "MinerU 结构化视觉内容";
    image.loading = "lazy";
    preview.querySelector(".structured-visual-media")?.replaceChildren(image);
    preview.dataset.state = "rendered";
  } catch {
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
  loadPaper(SAMPLE_PAPER);
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
  const controller = new AbortController();
  activeParseController = controller;
  const jobId = ++parseJobId;
  currentPdfFile = file;
  updateMineruUI();
  const paperBadge = document.getElementById("paper-badge");
  paperBadge.textContent = `正在上传论文：${file.name}`;
  paperBadge.title = `文件：${file.name}\nUI ${UI_VERSION} / API ${mineruApiVersion || "未知"}`;
  let paperHash = "";
  let task = null;
  let waitStatusTimer = null;

  try {
    paperHash = await hashFile(file);
    if (jobId !== parseJobId || controller.signal.aborted) return;

    const cached = options.force === true ? null : await checkParseCache(paperHash);
    if (jobId !== parseJobId || controller.signal.aborted) return;
    if (cached) {
      const generation = resetPdfPreview();
      loadPaper({
        ...cached,
        title: file.name,
        paperHash,
        blocks: Array.isArray(cached.blocks) ? cached.blocks : [],
        pageCount: Number(cached.parser?.pageCount || cached.pageCount || 0),
        isPdf: true,
        parser: cached.parser || { kind: "mineru" },
        modelVersion: cached.parser?.modelVersion || mineruSettings.modelVersion,
        cached: true,
      });
      void initializePdfPreview(file, generation);
      paperBadge.textContent = currentPaper.title;
      paperBadge.title = `论文已准备好\n文件指纹：${paperHash}\n解析缓存命中：${cached.blocks.length} 个结构块`;
      await safeToast({ message: "论文已准备好；已复用本机解析结果", type: "success" });
      return;
    }

    if (!mineruConfigured) {
      pendingPdfFile = file;
      openMineruSettings();
      await safeToast({ message: "请先配置 MinerU API Token，保存后将自动继续解析", type: "error" });
      return;
    }

    task = await createParseTask(paperHash, file.name);
    activeParseTask = task;
    await updateParseTask(task, { state: "running", stage: "uploading", progress: 10 });
    paperBadge.textContent = `正在上传论文：${file.name}`;

    const fileName = encodeURIComponent(file.name || "paper.pdf");
    waitStatusTimer = window.setTimeout(() => {
      if (jobId === parseJobId && !controller.signal.aborted) paperBadge.textContent = "正在等待 MinerU 解析";
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
    if (jobId !== parseJobId || controller.signal.aborted) return;
    if (!response.ok || !data.ok || Number(data.pageCount) <= 0) throw new Error(data.error || "MinerU 未返回有效页面");
    paperBadge.textContent = "正在整理正文和图表";
    await updateParseTask(task, { state: "running", stage: "organizing", progress: 88 });
    const generation = resetPdfPreview();
    loadPaper({
      title: file.name,
      paperHash: data.paperHash || paperHash,
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
    });
    void initializePdfPreview(file, generation);
    await updateParseTask(task, { state: "succeeded", stage: "complete", progress: 100 });
    paperBadge.textContent = currentPaper.title;
    paperBadge.title = `论文已准备好\n文件指纹：${data.paperHash || paperHash}\n${options.force === true ? "已强制重新解析" : "首次解析"}`;
    const versionMismatch = data.apiVersion && data.apiVersion !== UI_VERSION;
    const routeDetail = data.transport === "legacy-base64" ? "；已兼容旧版卡片传输" : "";
    const ocrDetail = data.ocrFallback ? "；普通解析失败后已由 OCR 重试完成" : data.ocrUsed ? "；OCR 模式" : "";
    const versionDetail = versionMismatch ? `；UI ${UI_VERSION} / API ${data.apiVersion}` : "";
    if (!data.blocks?.length) {
      await safeToast({ message: `MinerU 没有返回结构块，已保留原页视觉预览${routeDetail}${ocrDetail}${versionDetail}`, type: "success" });
    } else {
      await safeToast({ message: `MinerU 解析完成：${data.blockCount || data.blocks.length} 个结构块${routeDetail}${ocrDetail}${versionDetail}`, type: "success" });
    }
  } catch (error) {
    window.clearTimeout(waitStatusTimer);
    waitStatusTimer = null;
    if (jobId !== parseJobId || controller.signal.aborted || error?.name === "AbortError") return;
    const message = String(error?.message || "接口连接异常").slice(0, 240);
    await updateParseTask(task, { state: "failed", stage: "failed", progress: 0, error: message });
    paperBadge.textContent = `MinerU 解析失败：${message}`;
    paperBadge.title = `文件：${file.name}\nUI ${UI_VERSION} / API ${mineruApiVersion || "未知"}`;
    await safeToast({ message: `MinerU 解析失败：${message}`, type: "error" });
    if (/\b(?:401|403)\b|token|未授权|无权限/i.test(message)) {
      pendingPdfFile = file;
      openMineruSettings();
    }
  } finally {
    window.clearTimeout(waitStatusTimer);
    if (activeParseController === controller) activeParseController = null;
    if (activeParseTask === task) activeParseTask = null;
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
  currentPdfFile = null;
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
  loadPaper({ title: file.name, blocks, parser: "text" });
}

function translatableBlocks() {
  return currentPaper.blocks.filter((block) => Boolean(translationTextForBlock(block)));
}

function loadPaper(paper) {
  paperRevision += 1;
  researchStateRevision += 1;
  const revision = paperRevision;
  fullTranslationRunId += 1;
  fullTranslationBusy = false;
  blockTranslationRunIds.clear();
  sanitizedTableCache.clear();
  selectedBlockId = null;
  if (!paper?.isPdf) {
    resetPdfPreview();
    currentPdfFile = null;
  }
  const blocks = Array.isArray(paper?.blocks) ? paper.blocks : [];
  const persistedTranslations = paper?.translations && typeof paper.translations === "object" ? paper.translations : {};
  const persistedTranslationStates = paper?.translationStates && typeof paper.translationStates === "object" ? paper.translationStates : {};
  const blockTranslations = Object.fromEntries(blocks.filter((block) => typeof block?.translatedText === "string" && block.translatedText.trim()).map((block) => [block.id, block.translatedText.trim()]));
  currentPaper = {
    ...paper,
    title: String(paper?.title || "未命名论文"),
    blocks,
    translations: { ...blockTranslations, ...persistedTranslations },
    translationStates: { ...persistedTranslationStates },
    paperHash: isPaperHash(paper?.paperHash) ? paper.paperHash : null,
    glossaryVersion: Number(paper?.glossaryVersion || 0),
    translationGlossaryVersion: Number(paper?.translationGlossaryVersion || paper?.glossaryVersion || 0),
    glossaryTerms: paper?.glossaryTerms && typeof paper.glossaryTerms === "object" ? paper.glossaryTerms : {},
    replaceTranslations: false,
  };
  document.getElementById("empty-view").style.display = "none";
  document.getElementById("reader-container").style.display = "flex";
  document.getElementById("reading-mode-control").style.display = "inline-flex";
  const translateButton = document.getElementById("btn-translate-all");
  const researchButton = document.getElementById("btn-research-tools");
  translateButton.style.display = translatableBlocks().length ? "inline-flex" : "none";
  translateButton.disabled = false;
  translateButton.textContent = "翻译全文";
  researchButton.style.display = currentPaper.blocks.length ? "inline-flex" : "none";
  setReadingMode(READING_MODES.has(paper?.readingMode) ? paper.readingMode : currentReadingMode, { silent: true });
  document.getElementById("paper-badge").textContent = currentPaper.title;
  const visualCount = currentPaper.blocks.filter((block) => block.assetRef || block.crop || block.tableHtml || ["image", "table", "chart", "equation"].includes(block.type)).length;
  const parserKind = typeof paper?.parser === "string" ? paper.parser : paper?.parser?.kind;
  const parserLabel = paper.isPdf
    ? `MinerU ${paper.modelVersion || paper.parser?.modelVersion || mineruSettings.modelVersion || ""}`.trim()
    : "文本";
  document.getElementById("orig-blocks-count").textContent = paper.isPdf
    ? `${paper.pageCount || paper.parser?.pageCount || 0} 页 · ${currentPaper.blocks.length} 块 · ${visualCount} 视觉 · ${parserLabel}${paper.cached ? " · 缓存" : ""}`
    : `${currentPaper.blocks.length} 段落`;
  currentPaper.parser = typeof paper?.parser === "object" ? { ...paper.parser, kind: parserKind || "text" } : (paper?.parser || "text");
  updateMineruUI();
  renderBlocks();
  setReadingMode(currentReadingMode, { silent: true });
  document.getElementById("original-pane").scrollTop = 0;
  document.getElementById("trans-pane").scrollTop = 0;
  document.getElementById("contrast-pane").scrollTop = 0;
  void (async () => {
    if (!isPaperHash(currentPaper.paperHash)) {
      try { currentPaper.paperHash = await hashPaperSource(currentPaper); } catch {}
    }
    if (revision !== paperRevision) return;
    await ensureResearchPaper().catch(() => {});
    await refreshGlossaryState();
    await restorePaperProgress(revision);
    const cacheable = translatableBlocks().filter((block) => !currentPaper.translations[block.id]);
    const cached = await cachedTranslationsForBlocks(cacheable, true);
    if (revision !== paperRevision) return;
    cached.forEach((translation, blockId) => {
      currentPaper.translations[blockId] = translation;
      currentPaper.translationStates[blockId] = { kind: "ai", locked: false, updatedAt: new Date().toISOString() };
    });
    if (cached.size) {
      researchStateRevision += 1;
      renderBlocks();
      scheduleResearchSync();
    }
    researchTools?.refresh();
  })();
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
    media = `<div class="structured-visual mineru-asset" data-cache-id="${escapeAttr(block.assetRef.cacheId)}" data-asset-path="${escapeAttr(block.assetRef.path)}" data-state="waiting">
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
  const block = currentPaper.blocks.find((item) => item.id === blockId);
  const sourceText = translationTextForBlock(block);
  if (!block || !sourceText) return;
  const revision = paperRevision;
  const runId = (blockTranslationRunIds.get(blockId) || 0) + 1;
  blockTranslationRunIds.set(blockId, runId);
  const hadTranslation = Boolean(currentPaper.translations?.[blockId]);
  alignTranslationBlock(blockId);
  setTranslationPlaceholder(blockId, "正在检查翻译缓存...");
  window.requestAnimationFrame(() => alignTranslationBlock(blockId));

  try {
    const cached = await getCachedBlockTranslation(block, sourceText, !hadTranslation);
    if (revision !== paperRevision || blockTranslationRunIds.get(blockId) !== runId) return;
    if (cached) {
      commitBlockTranslation(blockId, cached);
      window.requestAnimationFrame(() => alignTranslationBlock(blockId));
      return;
    }
    setTranslationPlaceholder(blockId, "正在翻译中...");
    const res = await pluginApiFetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: sourceText,
        agentId: currentAgent.id,
        thinkingLevel: currentThinkingLevel,
        glossaryTerms: currentPaper.glossaryTerms || {},
      }),
    });
    const data = await res.json();
    if (revision !== paperRevision || blockTranslationRunIds.get(blockId) !== runId) return;
    applyEffectiveThinkingLevel(data);
    const transText = Array.isArray(data.translations) && typeof data.translations[0] === "string"
      ? data.translations[0].trim()
      : "";
    if (!data.ok || !transText) throw new Error(data.error || "翻译模型未返回有效结果");
    commitBlockTranslation(blockId, transText);
    await cacheBlockTranslation(block, sourceText, transText);
    scheduleResearchSync();
    window.requestAnimationFrame(() => alignTranslationBlock(blockId));
  } catch (error) {
    if (revision !== paperRevision || blockTranslationRunIds.get(blockId) !== runId) return;
    setTranslationPlaceholder(blockId, "翻译失败，点击重试", true);
  }
}

async function startFullTranslation() {
  if (fullTranslationBusy) return;
  let blocks = translatableBlocks();
  const button = document.getElementById("btn-translate-all");
  if (!blocks.length) return;
  const revision = paperRevision;
  const runId = ++fullTranslationRunId;
  fullTranslationBusy = true;
  button.disabled = true;
  button.textContent = "正在准备翻译…";
  await refreshGlossaryState();
  if (revision !== paperRevision || runId !== fullTranslationRunId) return;
  blocks = translatableBlocks();
  const mutableBlocks = blocks.filter((block) => !isFinalTranslation(block.id));
  const force = mutableBlocks.length > 0 && mutableBlocks.every((block) => Boolean(currentPaper.translations[block.id]));
  if (force) {
    mutableBlocks.forEach((block) => {
      delete currentPaper.translations[block.id];
      delete currentPaper.translationStates[block.id];
    });
    currentPaper.replaceTranslations = true;
    researchStateRevision += 1;
  }
  const pending = mutableBlocks.filter((block) => !currentPaper.translations[block.id]);
  if (!pending.length) {
    fullTranslationBusy = false;
    button.disabled = false;
    button.textContent = mutableBlocks.length ? "重新翻译全文" : "译文均已定稿";
    return;
  }

  blockTranslationRunIds.clear();
  button.textContent = "正在翻译中…";
  pending.forEach((block) => setTranslationPlaceholder(block.id, "正在翻译中..."));

  let failedCount = 0;
  const batchSize = 2;
  try {
    const cache = force ? new Map() : await cachedTranslationsForBlocks(pending, true);
    cache.forEach((translation, blockId) => commitBlockTranslation(blockId, translation));
    const uncached = pending.filter((block) => !currentPaper.translations[block.id]);
    for (let index = 0; index < uncached.length; index += batchSize) {
      if (revision !== paperRevision || runId !== fullTranslationRunId) return;
      const slice = uncached.slice(index, index + batchSize);
      const texts = slice.map((block) => translationTextForBlock(block));
      try {
        const res = await pluginApiFetch("/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            texts,
            agentId: currentAgent.id,
            thinkingLevel: currentThinkingLevel,
            glossaryTerms: currentPaper.glossaryTerms || {},
          }),
        });
        const data = await res.json();
        if (revision !== paperRevision || runId !== fullTranslationRunId) return;
        applyEffectiveThinkingLevel(data);
        if (!data.ok || !Array.isArray(data.translations) || data.translations.length !== slice.length) {
          throw new Error(data.error || "翻译模型返回格式无效");
        }
        const translations = data.translations.map((value) => typeof value === "string" ? value.trim() : "");
        if (translations.some((value) => !value)) throw new Error("翻译模型返回空结果");
        for (let offset = 0; offset < slice.length; offset += 1) {
          const block = slice[offset];
          const transText = translations[offset];
          commitBlockTranslation(block.id, transText);
          await cacheBlockTranslation(block, texts[offset], transText);
        }
        scheduleResearchSync();
      } catch (error) {
        if (revision !== paperRevision || runId !== fullTranslationRunId) return;
        failedCount += slice.length;
        slice.forEach((block) => setTranslationPlaceholder(block.id, "翻译失败，点击重试", true));
      }
    }
  } finally {
    if (revision === paperRevision && runId === fullTranslationRunId) {
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
  const drawer = document.getElementById("answer-drawer");
  const drawerQuote = document.getElementById("drawer-quote");
  const drawerContent = document.getElementById("drawer-content");
  const selectedBlock = currentPaper.blocks.find((block) => block.id === selectedBlockId) || null;
  const citation = selectedBlock ? `Page ${Number(selectedBlock.page || 1)} / block ${selectedBlock.id}` : "";

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
        paperTitle: currentPaper.title,
        paperHash: currentPaper.paperHash,
        blockId: selectedBlock?.id || null,
        page: selectedBlock?.page || null,
        thinkingLevel: currentThinkingLevel,
        glossaryTerms: currentPaper.glossaryTerms || {},
      })
    });
    const data = await res.json();
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
    drawerContent.textContent = "请求异常，请检查网络或后端状态。";
  }
}

async function sendQuoteToSession() {
  document.getElementById("selection-toolbar").style.display = "none";
  const selectedBlock = currentPaper.blocks.find((block) => block.id === selectedBlockId) || null;
  const citation = selectedBlock ? `Page ${Number(selectedBlock.page || 1)} / block ${selectedBlock.id}` : "";
  const textToCopy = `【论文划选研讨】\n论文：${currentPaper.title}\n${citation ? `来源：${citation}\n` : ""}选中文本：${selectedText}\n上下文：${selectedContext}`;
  let copied = false;
  copied = await copyTextToClipboard(textToCopy);

  try {
    const res = await pluginApiFetch("/api/send-to-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: currentAgent.id,
        quote: selectedText,
        context: `${selectedContext}${citation ? `\n来源：${citation}` : ""}`,
        paperTitle: currentPaper.title,
        paperHash: currentPaper.paperHash,
        blockId: selectedBlock?.id || null,
        page: selectedBlock?.page || null,
        thinkingLevel: currentThinkingLevel,
      })
    });
    const data = await res.json();
    applyEffectiveThinkingLevel(data);
    if (!data.ok) throw new Error(data.error || "send failed");
    await safeToast({ message: copied ? "已发送到助手会话，引用也已复制" : "已发送到助手会话", type: "success" });
  } catch (err) {
    await safeToast({ message: copied ? "已复制引用；会话发送失败，请稍后重试" : "会话发送失败，请稍后重试", type: "error" });
  }
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
  try { await hana.toast.show(input); } catch {}
}

function escapeHtml(text) {
  return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/`/g, "&#96;");
}

function formatMath(text) {
  return text
    .replace(/\$\$([\s\S]+?)\$\$/g, '<div style="font-family:var(--font-mono);background:var(--accent-light);padding:6px 10px;margin:6px 0;border-radius:4px;text-align:center">$1</div>')
    .replace(/\$([^$\n]+?)\$/g, '<code style="font-family:var(--font-mono);background:var(--accent-light);padding:1px 4px;border-radius:3px">$1</code>');
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
hana.ready();
