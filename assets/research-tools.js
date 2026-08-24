const DEFAULT_ENDPOINTS = {
  search: "/api/research/search",
  notes: "/api/research/notes",
  bookmarks: "/api/research/bookmarks",
  progress: "/api/research/progress",
  parse: "/api/research/parse-status/tasks",
  evidence: "/api/research/evidence",
  glossary: "/api/research/glossary",
  export: "/api/research/export",
  storage: "/api/research/storage",
  cleanup: "/api/research/cleanup",
  backup: "/api/research/backup",
  restore: "/api/research/restore",
  paper: "/api/research/paper",
  asset: "/api/mineru-asset",
};

const VISUAL_BLOCK_TYPES = new Set(["image", "chart", "equation", "table"]);
const NOTE_TYPES = [
  ["finding", "研究发现"],
  ["method", "方法与条件"],
  ["question", "疑问"],
  ["limitation", "局限与风险"],
];
const NOTE_TYPE_LABELS = Object.fromEntries(NOTE_TYPES);
const SEARCH_TYPES = [
  ["title", "标题"], ["body", "正文"], ["figure", "图题/图片"], ["table", "表格"], ["equation", "公式"],
];

const WORKFLOW_DEFINITIONS = [
  ["locate", "定位", "找到章节、关键词、书签与阅读位置"],
  ["verify", "核验", "核对助手回答、原文引用与视觉证据"],
  ["capture", "沉淀", "保存笔记、术语、译文与研究导出"],
];

const TOOL_DEFINITIONS = [
  ["search", "全文搜索", "在当前论文块中查找并跳转命中", "locate"],
  ["outline", "自动大纲", "按标题块快速浏览论文结构", "locate"],
  ["markers", "书签与进度", "回到已标记位置并同步阅读进度", "locate"],
  ["evidence", "证据助手", "带当前论文上下文提问", "verify"],
  ["lab", "图表、表格与公式", "浏览视觉对象并回到真实证据", "verify"],
  ["notes", "研究笔记", "把个人判断绑定到论文证据", "capture"],
  ["glossary", "术语与译文", "管理固定译法和翻译缓存", "capture"],
  ["export", "研究导出", "导出当前论文的双语 Markdown", "capture"],
  ["parse", "数据与任务", "查看解析任务和工作区状态", "system"],
];

function makeElement(doc, tag, className, text) {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function button(doc, text, className = "") {
  const element = makeElement(doc, "button", `research-tools-button ${className}`, text);
  element.type = "button";
  return element;
}

function paperBlocks(paper) {
  return Array.isArray(paper?.blocks) ? paper.blocks : [];
}

function blockText(block) {
  return [block?.text, block?.translatedText, block?.caption, block?.latex].filter((value) => typeof value === "string").join(" ");
}

function hasPaper(paper) {
  return paperBlocks(paper).length > 0 || paper?.loaded === true || paper?.isLoaded === true || paper?.structureDetached === true;
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
}

function highlightFragment(doc, value, query) {
  const fragment = doc.createDocumentFragment();
  const source = String(value || "");
  const needle = String(query || "").toLocaleLowerCase();
  if (!needle) { fragment.append(source); return fragment; }
  let cursor = 0;
  const lower = source.toLocaleLowerCase();
  while (cursor < source.length) {
    const index = lower.indexOf(needle, cursor);
    if (index < 0) { fragment.append(source.slice(cursor)); break; }
    if (index > cursor) fragment.append(source.slice(cursor, index));
    const mark = makeElement(doc, "mark", "research-tools-highlight", source.slice(index, index + needle.length));
    fragment.append(mark);
    cursor = index + needle.length;
  }
  return fragment;
}

function downloadBlob(doc, blob, fileName) {
  const link = doc.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.rel = "noopener";
  doc.body?.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

async function copyText(value) {
  const text = String(value || "");
  if (!text) return false;
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  return false;
}

function tableRowsFromHtml(html) {
  const parsed = new DOMParser().parseFromString(String(html || ""), "text/html");
  return [...parsed.querySelectorAll("tr")].map((row) => [...row.querySelectorAll("th,td")].map((cell) => cell.textContent.trim()));
}

function csvText(rows) {
  return rows.map((row) => row.map((value) => `"${String(value || "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
}

async function responseData(response) {
  if (!response) return {};
  const type = response.headers?.get?.("content-type") || "";
  if (type.includes("json")) return response.json();
  return response.text();
}

export function createResearchTools(options = {}) {
  const root = options.root;
  const doc = options.document || root?.ownerDocument;
  if (!root || !doc) throw new TypeError("createResearchTools requires root and document");
  if (typeof options.apiFetch !== "function") throw new TypeError("createResearchTools requires apiFetch");

  const endpoints = { ...DEFAULT_ENDPOINTS, ...(options.endpoints || {}) };
  const state = {
    open: false,
    activeWorkflow: "locate",
    activeTool: "search",
    paper: null,
    query: "",
    results: [],
    outline: [],
    filter: "all",
    searchScope: "all",
    searchLanguage: "both",
    searchTypes: new Set(),
    note: "",
    noteType: "finding",
    noteTags: "",
    noteFilterType: "all",
    noteFilterSection: "all",
    noteFilterTag: "",
    noteUnresolvedOnly: false,
    noteDraft: null,
    editingNoteId: null,
    glossary: {},
    notes: [],
    bookmarks: [],
    progress: null,
    tasks: [],
    renderToken: 0,
    destroyed: false,
  };
  const addListener = (element, type, handler) => element.addEventListener(type, handler);

  const shell = makeElement(doc, "aside", "research-tools-drawer", "");
  shell.setAttribute("aria-label", "研究工具");
  const header = makeElement(doc, "header", "research-tools-header");
  const headerText = makeElement(doc, "div", "research-tools-heading");
  const paperTitle = makeElement(doc, "span", "research-tools-paper", "");
  headerText.append(makeElement(doc, "strong", "research-tools-title", "研究工具"), paperTitle);
  const close = button(doc, "关闭", "research-tools-close");
  close.setAttribute("aria-label", "关闭研究工具");
  header.append(headerText, close);
  const workflowNav = makeElement(doc, "nav", "research-workflow-nav");
  workflowNav.setAttribute("aria-label", "研究工作流");
  const nav = makeElement(doc, "nav", "research-tools-nav");
  nav.setAttribute("aria-label", "当前工作流工具");
  const body = makeElement(doc, "div", "research-tools-body");
  const empty = makeElement(doc, "div", "research-tools-empty", "当前没有可分析的论文");
  const content = makeElement(doc, "div", "research-tools-content");
  body.append(empty, content);
  shell.append(header, workflowNav, nav, body);
  root.appendChild(shell);

  const workflowButtons = new Map();
  for (const [id, label, description] of WORKFLOW_DEFINITIONS) {
    const workflowButton = button(doc, label, "research-workflow-button");
    workflowButton.dataset.workflow = id;
    workflowButton.title = description;
    addListener(workflowButton, "click", () => {
      state.activeWorkflow = id;
      const firstTool = TOOL_DEFINITIONS.find((definition) => definition[3] === id)?.[0];
      if (firstTool) state.activeTool = firstTool;
      render();
    });
    workflowNav.appendChild(workflowButton);
    workflowButtons.set(id, workflowButton);
  }
  const systemButton = button(doc, "数据与任务", "research-tools-system-button");
  systemButton.title = "查看解析任务、缓存与工作区状态";
  addListener(systemButton, "click", () => {
    state.activeWorkflow = "system";
    state.activeTool = "parse";
    render();
  });
  headerText.appendChild(systemButton);

  const toolButtons = new Map();
  const views = new Map();
  for (const [id, label, description, workflow] of TOOL_DEFINITIONS) {
    const navButton = button(doc, label, "research-tools-nav-button");
    navButton.dataset.tool = id;
    navButton.dataset.workflow = workflow;
    navButton.title = description;
    navButton.setAttribute("aria-controls", `research-tool-${id}`);
    addListener(navButton, "click", () => {
      state.activeTool = id;
      render();
    });
    nav.appendChild(navButton);
    toolButtons.set(id, navButton);
    const view = makeElement(doc, "section", "research-tools-view");
    view.id = `research-tool-${id}`;
    view.setAttribute("aria-label", label);
    content.appendChild(view);
    views.set(id, view);
  }

  function notify(message, type = "info") {
    try { options.toast?.({ message, type }); } catch {}
  }

  async function call(path, init = {}) {
    try {
      const response = await options.apiFetch(path, init);
      const data = await responseData(response);
      const errorMessage = typeof data === "string" ? data : data?.error;
      if (!response.ok) throw new Error(errorMessage || `请求失败 (${response.status})`);
      return data;
    } catch (error) {
      notify(String(error?.message || "研究工具请求失败"), "error");
      throw error;
    }
  }

  function getPaper() {
    try { return options.getPaper?.() || null; } catch { return null; }
  }

  function locate(block) {
    const evidence = block?.evidence || block;
    const id = evidence?.blockId || evidence?.id || evidence?._id;
    if (!id) return;
    try { options.onLocateBlock?.(id, evidence); } catch {}
  }

  function evidenceMeta(evidence) {
    if (!evidence) return "未核验证据";
    const parts = [`Page ${Number(evidence.page || 1)}`, `block ${evidence.blockId || evidence.id || "?"}`];
    if (evidence.sectionTitle) parts.push(evidence.sectionTitle);
    return parts.join(" · ");
  }

  function evidenceResult(evidence, label, className = "") {
    const item = button(doc, "", `research-tools-result ${className}`.trim());
    item.dataset.evidenceId = evidence?.evidenceId || "";
    item.append(
      makeElement(doc, "span", "research-tools-result-index", `P${Number(evidence?.page || 1)}`),
      makeElement(doc, "span", "research-tools-result-text", label),
    );
    item.title = evidenceMeta(evidence);
    addListener(item, "click", () => locate(evidence));
    return item;
  }

  function renderMessage(view, message, className = "research-tools-muted") {
    view.replaceChildren(makeElement(doc, "p", className, message));
  }

  function searchStateSnapshot() {
    return {
      query: state.query,
      scope: state.searchScope,
      language: state.searchLanguage,
      types: [...state.searchTypes],
    };
  }

  function emitUiState() {
    try { options.onUiStateChanged?.({ searchState: searchStateSnapshot(), noteDraft: state.noteDraft }); } catch {}
  }

  function renderSearch(view, token) {
    const controls = makeElement(doc, "div", "research-tools-search-controls");
    const scope = makeElement(doc, "select", "research-tools-select");
    scope.setAttribute("aria-label", "搜索范围");
    [["page", "当前页面"], ["section", "当前章节"], ["all", "全文"]].forEach(([value, label]) => {
      const option = makeElement(doc, "option", "", label); option.value = value; option.selected = value === state.searchScope; scope.appendChild(option);
    });
    const language = makeElement(doc, "select", "research-tools-select");
    language.setAttribute("aria-label", "搜索语种");
    [["original", "原文"], ["translation", "译文"], ["both", "原文 + 译文"]].forEach(([value, label]) => {
      const option = makeElement(doc, "option", "", label); option.value = value; option.selected = value === state.searchLanguage; language.appendChild(option);
    });
    controls.append(scope, language);

    const types = makeElement(doc, "div", "research-tools-filter-pills");
    SEARCH_TYPES.forEach(([value, label]) => {
      const typeButton = button(doc, label, "research-tools-filter-pill");
      typeButton.classList.toggle("active", state.searchTypes.has(value));
      typeButton.setAttribute("aria-pressed", String(state.searchTypes.has(value)));
      addListener(typeButton, "click", () => {
        if (state.searchTypes.has(value)) state.searchTypes.delete(value); else state.searchTypes.add(value);
        emitUiState();
        render();
      });
      types.appendChild(typeButton);
    });

    const form = makeElement(doc, "form", "research-tools-form");
    const input = makeElement(doc, "input", "research-tools-input");
    input.type = "search";
    input.placeholder = "输入关键词";
    input.value = state.query;
    input.setAttribute("aria-label", "搜索论文");
    const submit = button(doc, "搜索", "research-tools-button-primary");
    submit.type = "submit";
    form.append(input, submit);
    const resultBox = makeElement(doc, "div", "research-tools-results");
    addListener(scope, "change", () => { state.searchScope = scope.value; emitUiState(); render(); });
    addListener(language, "change", () => { state.searchLanguage = language.value; emitUiState(); render(); });
    addListener(form, "submit", (event) => {
      event.preventDefault();
      state.query = input.value.trim();
      emitUiState();
      try { options.onSearchHighlight?.(state.query); } catch {}
      render();
    });
    view.append(controls, types, form, resultBox);
    if (!state.query) {
      renderMessage(resultBox, "选择范围、语种和块类型后搜索；排序只使用词频、标题权重、当前页和邻近块。");
      return;
    }
    renderMessage(resultBox, "正在执行可解释检索…");
    const hash = paperHash();
    const selected = selectedBlock();
    const query = new URLSearchParams({
      paperHash: hash,
      q: state.query,
      limit: "100",
      scope: state.searchScope,
      language: state.searchLanguage,
      types: [...state.searchTypes].join(","),
      page: String(Number(selected?.page || 1)),
      sectionId: String(selected?.sectionId || ""),
      currentBlockId: String(selected?.id || ""),
    });
    void call(`${endpoints.search}?${query}`).then((data) => {
      if (!isCurrentRender("search", token, hash)) return;
      state.results = Array.isArray(data?.results) ? data.results : [];
      resultBox.replaceChildren();
      const ranking = makeElement(doc, "p", "research-tools-muted", `排序规则：${data?.ranking || "可解释词频排序"}`);
      resultBox.appendChild(ranking);
      if (!state.results.length) {
        resultBox.appendChild(makeElement(doc, "p", "research-tools-muted", "没有找到匹配内容"));
        return;
      }
      state.results.forEach((result) => {
        const evidence = result.evidence || { ...result, blockId: result.id };
        const item = button(doc, "", "research-tools-result research-tools-search-result");
        item.dataset.evidenceId = evidence?.evidenceId || "";
        const head = makeElement(doc, "span", "research-tools-result-head");
        head.append(
          makeElement(doc, "span", "research-tools-result-index", `P${Number(result.page || 1)}`),
          makeElement(doc, "span", "research-tools-result-score", `${Number(result.score || 0)} 分`),
          makeElement(doc, "span", "research-tools-result-kind", result.typeGroup || result.type || "正文"),
        );
        const snippet = makeElement(doc, "span", "research-tools-result-text");
        snippet.appendChild(highlightFragment(doc, result.snippets?.original || result.snippets?.translation || blockText(result).slice(0, 240), state.query));
        const explanation = makeElement(doc, "span", "research-tools-result-explain", (result.scoreExplanation || []).join(" · "));
        item.append(head, snippet, explanation);
        addListener(item, "click", () => {
          locate(evidence);
          try { options.onSearchHighlight?.(state.query, evidence.blockId, evidence.page); } catch {}
        });
        resultBox.appendChild(item);
      });
    }).catch(() => {
      if (isCurrentRender("search", token, hash)) renderMessage(resultBox, "搜索暂时不可用");
    });
  }

  function renderOutline(view, token) {
    state.outline = paperBlocks(state.paper).map((block, index) => ({ block, index })).filter(({ block }) => ["heading", "title", "section"].includes(String(block?.type || "").toLowerCase()) || /^\s*(\d+(?:\.\d+)*|abstract|introduction|conclusion|references)\b/i.test(String(block?.text || "")));
    if (!state.outline.length) {
      renderMessage(view, "当前论文没有可识别的标题块");
      return;
    }
    const summary = makeElement(doc, "div", "research-tools-outline-summary");
    summary.append(
      makeElement(doc, "span", "research-tools-status-chip", "阅读进度读取中"),
      makeElement(doc, "span", "research-tools-status-chip", "书签读取中"),
      makeElement(doc, "span", "research-tools-status-chip", "疑问读取中"),
    );
    const list = makeElement(doc, "ol", "research-tools-list research-tools-outline-list");
    const rows = new Map();
    state.outline.forEach(({ block }) => {
      const item = makeElement(doc, "li", "research-tools-outline-item");
      const jump = button(doc, "", "research-tools-link");
      jump.append(
        makeElement(doc, "span", "research-tools-outline-title", blockText(block).slice(0, 160)),
        makeElement(doc, "span", "research-tools-outline-meta", `Page ${Number(block.page || 1)}`),
      );
      addListener(jump, "click", () => locate(block));
      item.appendChild(jump);
      list.appendChild(item);
      rows.set(block.id, item);
    });
    view.append(summary, list);
    const hash = paperHash();
    void loadAnchoredState(hash).then((anchored) => {
      if (!isCurrentRender("outline", token, hash)) return;
      state.notes = anchored.notes;
      state.bookmarks = anchored.bookmarks;
      state.progress = anchored.progress;
      const unresolved = state.notes.filter((item) => item.noteType === "question" && item.resolved !== true);
      summary.replaceChildren(
        makeElement(doc, "span", "research-tools-status-chip", `阅读 ${Number(state.progress?.percent || 0)}%`),
        makeElement(doc, "span", "research-tools-status-chip", `书签 ${state.bookmarks.length}`),
        makeElement(doc, "span", "research-tools-status-chip warning", `未解决疑问 ${unresolved.length}`),
      );
      for (const { block } of state.outline) {
        const row = rows.get(block.id);
        if (!row) continue;
        const sectionBookmarks = state.bookmarks.filter((item) => item.evidence?.sectionId === block.id).length;
        const sectionQuestions = unresolved.filter((item) => item.evidence?.sectionId === block.id).length;
        const badges = makeElement(doc, "span", "research-tools-outline-badges");
        if (state.progress?.blockId === block.id || state.progress?.page === block.page) badges.appendChild(makeElement(doc, "span", "research-tools-mini-badge active", "上次读到"));
        if (sectionBookmarks) badges.appendChild(makeElement(doc, "span", "research-tools-mini-badge", `书签 ${sectionBookmarks}`));
        if (sectionQuestions) badges.appendChild(makeElement(doc, "span", "research-tools-mini-badge warning", `疑问 ${sectionQuestions}`));
        if (badges.childNodes.length) row.appendChild(badges);
      }
    }).catch(() => { summary.textContent = "大纲已载入，研究标记暂时不可用"; });
  }

  function paperHash() {
    return String(state.paper?.paperHash || "");
  }

  function selectedBlock() {
    return options.getSelectedBlock?.() || state.paper?.blocks?.[0] || null;
  }

  function progressPayload() {
    const progress = options.getProgress?.() || {};
    return {
      ...progress,
      paperHash: paperHash(),
      blockId: progress.blockId || selectedBlock()?.id || null,
      page: Number(progress.page || selectedBlock()?.page || 1),
    };
  }

  async function saveNote(kind, value) {
    const input = value && typeof value === "object" ? value : { note: value };
    const selected = selectedBlock();
    const block = paperBlocks(state.paper).find((item) => item.id === input.blockId)
      || (input.blockId ? { id: input.blockId, page: input.page, text: input.quote, translatedText: input.translation } : null)
      || selected;
    if (!paperHash() || !block?.id) throw new Error("当前论文没有可引用的段落");
    const body = kind === "notes"
      ? {
        paperHash: paperHash(),
        blockId: block.id,
        page: Number(block.page || 1),
        id: input.id || undefined,
        note: String(input.note || "").trim(),
        noteType: input.noteType || "finding",
        tags: Array.isArray(input.tags) ? input.tags : [],
        quote: String(input.quote || block.text || "").trim(),
        translation: String(input.translation || block.translatedText || "").trim(),
        evidenceSnapshot: input.evidenceSnapshot || undefined,
        resolved: input.resolved === true,
      }
      : { paperHash: paperHash(), blockId: block.id, page: Number(block.page || 1), bbox: block.bbox || null, label: "重点" };
    if (kind === "notes" && !body.note) throw new Error("请先填写用户笔记");
    const data = await call(endpoints[kind], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    options.onPaperStateChanged?.({ kind, blockId: block.id, value: input, data });
    notify(kind === "notes" ? "证据型研究笔记已保存" : "书签已保存", "success");
    return data;
  }

  async function loadAnchoredState(hash) {
    if (!hash) return { notes: [], bookmarks: [], progress: null };
    const query = `?paperHash=${encodeURIComponent(hash)}`;
    const [notes, bookmarks, progress] = await Promise.all([
      call(`${endpoints.notes}${query}`),
      call(`${endpoints.bookmarks}${query}`),
      call(`${endpoints.progress}${query}`),
    ]);
    return {
      notes: Array.isArray(notes?.notes) ? notes.notes : [],
      bookmarks: Array.isArray(bookmarks?.bookmarks) ? bookmarks.bookmarks : [],
      progress: progress?.progress || null,
    };
  }

  function appendStateList(view, title, items, renderItem) {
    if (!items.length) return;
    view.appendChild(makeElement(doc, "h3", "research-tools-subtitle", title));
    const list = makeElement(doc, "div", "research-tools-results");
    items.forEach((item) => list.appendChild(renderItem(item)));
    view.appendChild(list);
  }

  async function deleteAnchoredItem(collection, item) {
    const id = String(item?.id || "");
    if (!id) throw new Error("记录缺少可删除的 ID");
    await call(`${endpoints[collection]}/${encodeURIComponent(id)}`, { method: "DELETE" });
    options.onPaperStateChanged?.({ kind: collection, deletedId: id });
    notify(collection === "notes" ? "笔记已删除" : "书签已删除", "success");
    render();
  }

  function anchoredStateRow(collection, item, label) {
    const row = makeElement(doc, "div", "research-tools-state-row");
    const jump = button(doc, label, "research-tools-result");
    jump.title = `Page ${item.page || 1} · block ${item.blockId || ""}`;
    addListener(jump, "click", () => locate(item.evidence || { evidenceId: item.evidenceId, blockId: item.blockId, page: item.page }));
    const remove = button(doc, "删除", "research-tools-button-danger");
    addListener(remove, "click", () => {
      remove.disabled = true;
      void deleteAnchoredItem(collection, item).catch(() => { remove.disabled = false; });
    });
    row.append(jump, remove);
    return row;
  }

  function isCurrentRender(tool, token, hash = paperHash()) {
    return !state.destroyed && state.activeTool === tool && state.renderToken === token && paperHash() === hash;
  }

  function renderNotes(view, token) {
    const selected = selectedBlock();
    const selection = options.getSelection?.() || {};
    const draft = state.noteDraft && state.noteDraft.paperHash === paperHash() ? state.noteDraft : null;
    const activeNote = state.editingNoteId ? state.notes.find((item) => item.id === state.editingNoteId) : null;
    const sourceBlock = activeNote ? paperBlocks(state.paper).find((block) => block.id === activeNote.blockId) || selected : selected;
    const selectedHere = selection.blockId === sourceBlock?.id ? String(selection.text || "") : "";
    const quote = activeNote?.quote || (!selection.fromTranslation ? selectedHere : "") || sourceBlock?.text || "";
    const translation = activeNote?.translation || (selection.fromTranslation ? selectedHere : "") || sourceBlock?.translatedText || "";
    const context = makeElement(doc, "div", "research-tools-context research-tools-note-evidence");
    context.append(
      makeElement(doc, "strong", "", sourceBlock ? `证据：Page ${Number(sourceBlock.page || 1)} · block ${sourceBlock.id}${sourceBlock.sectionTitle ? ` · ${sourceBlock.sectionTitle}` : ""}` : "未选择证据"),
      makeElement(doc, "span", "research-tools-note-quote", quote.slice(0, 700) || "没有可用原文摘录"),
    );
    if (translation) context.appendChild(makeElement(doc, "span", "research-tools-note-translation", `当前译文：${translation.slice(0, 500)}`));

    const type = makeElement(doc, "select", "research-tools-select");
    type.setAttribute("aria-label", "笔记类型");
    NOTE_TYPES.forEach(([value, label]) => { const option = makeElement(doc, "option", "", label); option.value = value; option.selected = value === (activeNote?.noteType || draft?.noteType || state.noteType); type.appendChild(option); });
    const tags = makeElement(doc, "input", "research-tools-input");
    tags.placeholder = "标签，用逗号分隔";
    tags.setAttribute("aria-label", "笔记标签");
    tags.value = activeNote?.tags?.join(", ") || draft?.tags || state.noteTags;
    const fields = makeElement(doc, "div", "research-tools-note-fields");
    fields.append(type, tags);

    const note = makeElement(doc, "textarea", "research-tools-textarea");
    note.placeholder = "写下你的研究判断；原文摘录、页码、结构块和当前译文会自动附上。";
    note.value = activeNote?.note || draft?.note || state.note;
    const updateDraft = () => {
      state.note = note.value;
      state.noteType = type.value;
      state.noteTags = tags.value;
      state.noteDraft = {
        paperHash: paperHash(), blockId: sourceBlock?.id || null, note: note.value, noteType: type.value, tags: tags.value,
      };
      emitUiState();
    };
    addListener(note, "input", updateDraft);
    addListener(type, "change", updateDraft);
    addListener(tags, "input", updateDraft);
    const actions = makeElement(doc, "div", "research-tools-actions");
    const save = button(doc, activeNote ? "更新研究笔记" : "保存研究笔记", "research-tools-button-primary");
    addListener(save, "click", () => {
      updateDraft();
      save.disabled = true;
      void saveNote("notes", {
        id: activeNote?.id,
        blockId: sourceBlock?.id || activeNote?.blockId,
        page: sourceBlock?.page || activeNote?.page,
        evidenceSnapshot: activeNote?.evidenceSnapshot,
        note: note.value,
        noteType: type.value,
        tags: tags.value.split(/[，,]/).map((value) => value.trim()).filter(Boolean),
        quote,
        translation,
        resolved: activeNote?.resolved === true,
      }).then(() => {
        state.note = ""; state.noteDraft = null; state.editingNoteId = null; emitUiState(); render();
      }).catch((error) => notify(error.message, "error")).finally(() => { save.disabled = false; });
    });
    actions.append(save);
    if (activeNote) {
      const cancel = button(doc, "取消编辑");
      addListener(cancel, "click", () => { state.editingNoteId = null; render(); });
      actions.append(cancel);
    }
    view.append(context, fields, note, actions);

    const filters = makeElement(doc, "div", "research-tools-note-filters");
    const filterType = makeElement(doc, "select", "research-tools-select");
    [["all", "全部类型"], ...NOTE_TYPES].forEach(([value, label]) => { const option = makeElement(doc, "option", "", label); option.value = value; option.selected = value === state.noteFilterType; filterType.appendChild(option); });
    const sectionFilter = makeElement(doc, "select", "research-tools-select");
    sectionFilter.appendChild(Object.assign(makeElement(doc, "option", "", "全部章节"), { value: "all" }));
    const sections = [...new Map(paperBlocks(state.paper).filter((block) => block.sectionId && block.sectionTitle).map((block) => [block.sectionId, block.sectionTitle])).entries()];
    sections.forEach(([value, label]) => { const option = makeElement(doc, "option", "", label); option.value = value; option.selected = value === state.noteFilterSection; sectionFilter.appendChild(option); });
    const filterTag = makeElement(doc, "input", "research-tools-input");
    filterTag.placeholder = "按标签筛选"; filterTag.value = state.noteFilterTag;
    const unresolved = button(doc, "只看未解决疑问", "research-tools-filter-pill");
    unresolved.classList.toggle("active", state.noteUnresolvedOnly);
    unresolved.setAttribute("aria-pressed", String(state.noteUnresolvedOnly));
    addListener(filterType, "change", () => { state.noteFilterType = filterType.value; render(); });
    addListener(sectionFilter, "change", () => { state.noteFilterSection = sectionFilter.value; render(); });
    addListener(filterTag, "change", () => { state.noteFilterTag = filterTag.value.trim(); render(); });
    addListener(unresolved, "click", () => { state.noteUnresolvedOnly = !state.noteUnresolvedOnly; render(); });
    filters.append(filterType, sectionFilter, filterTag, unresolved);
    view.appendChild(filters);

    const status = makeElement(doc, "p", "research-tools-muted", "正在读取已保存的研究记录…");
    view.appendChild(status);
    const hash = paperHash();
    const query = new URLSearchParams({ paperHash: hash, limit: "100" });
    if (state.noteFilterType !== "all") query.set("noteType", state.noteFilterType);
    if (state.noteFilterSection !== "all") query.set("sectionId", state.noteFilterSection);
    if (state.noteFilterTag) query.set("tag", state.noteFilterTag);
    if (state.noteUnresolvedOnly) query.set("unresolvedOnly", "true");
    void call(`${endpoints.notes}?${query}`).then((data) => {
      if (!isCurrentRender("notes", token, hash)) return;
      state.notes = Array.isArray(data?.notes) ? data.notes : [];
      status.remove();
      const exportNotes = button(doc, "整理为论文阅读笔记");
      addListener(exportNotes, "click", () => {
        const groups = NOTE_TYPES.map(([value, label]) => [label, state.notes.filter((item) => item.noteType === value)]).filter(([, items]) => items.length);
        const markdown = [`# ${state.paper?.title || "论文"}｜研究笔记`, "", ...groups.flatMap(([label, items]) => [`## ${label}`, "", ...items.flatMap((item) => [
          `### Page ${item.page || 1} · ${item.evidence?.sectionTitle || item.blockId}`,
          "", `> ${item.quote || item.evidence?.originalQuote || ""}`, "", item.translation ? `译文：${item.translation}` : "", "", item.note || "", "",
          item.tags?.length ? `标签：${item.tags.join("、")}` : "", "",
        ])])].filter(Boolean).join("\n");
        downloadBlob(doc, new Blob([markdown], { type: "text/markdown;charset=utf-8" }), `${String(state.paper?.title || "paper").replace(/[\\/:*?"<>|]/g, "_")}-研究笔记.md`);
      });
      view.appendChild(exportNotes);
      if (!state.notes.length) { view.appendChild(makeElement(doc, "p", "research-tools-muted", "当前筛选条件下没有笔记")); return; }
      const list = makeElement(doc, "div", "research-tools-notes-list");
      state.notes.forEach((item) => {
        const card = makeElement(doc, "article", "research-tools-note-card");
        const head = makeElement(doc, "div", "research-tools-note-card-head");
        head.append(
          makeElement(doc, "span", `research-tools-note-type ${item.noteType || "finding"}`, NOTE_TYPE_LABELS[item.noteType] || "研究发现"),
          makeElement(doc, "span", "research-tools-muted", `Page ${item.page || 1} · ${item.evidence?.sectionTitle || item.blockId}`),
        );
        card.append(head, makeElement(doc, "blockquote", "research-tools-note-card-quote", item.quote || item.evidence?.originalQuote || "证据结构已分离"));
        if (item.translation) card.appendChild(makeElement(doc, "p", "research-tools-note-card-translation", item.translation));
        card.appendChild(makeElement(doc, "p", "research-tools-note-card-body", item.note || ""));
        if (item.tags?.length) card.appendChild(makeElement(doc, "p", "research-tools-note-tags", item.tags.map((tag) => `#${tag}`).join(" ")));
        const row = makeElement(doc, "div", "research-tools-actions");
        const jump = button(doc, "回到原文"); addListener(jump, "click", () => locate(item.evidence || item)); row.appendChild(jump);
        const edit = button(doc, "编辑"); addListener(edit, "click", () => { state.editingNoteId = item.id; render(); }); row.appendChild(edit);
        if (item.noteType === "question") {
          const resolve = button(doc, item.resolved ? "标记未解决" : "标记已解决");
          addListener(resolve, "click", () => { resolve.disabled = true; void saveNote("notes", { ...item, resolved: !item.resolved }).then(() => render()).finally(() => { resolve.disabled = false; }); });
          row.appendChild(resolve);
        }
        const remove = button(doc, "删除", "research-tools-button-danger");
        addListener(remove, "click", () => { remove.disabled = true; void deleteAnchoredItem("notes", item).catch(() => { remove.disabled = false; }); });
        row.appendChild(remove);
        card.appendChild(row);
        list.appendChild(card);
      });
      view.appendChild(list);
    }).catch(() => { if (isCurrentRender("notes", token, hash)) status.textContent = "暂时无法读取已保存笔记"; });
  }

  function renderMarkers(view, token) {
    const selected = selectedBlock();
    const context = makeElement(doc, "p", "research-tools-context", selected ? `当前位置：Page ${Number(selected.page || 1)} · block ${selected.id}` : "未选择段落");
    const actions = makeElement(doc, "div", "research-tools-actions");
    const bookmark = button(doc, "添加证据书签", "research-tools-button-primary");
    const progress = button(doc, "同步阅读进度");
    addListener(bookmark, "click", () => {
      bookmark.disabled = true;
      void saveNote("bookmarks", true).catch((error) => notify(error.message, "error")).finally(() => { bookmark.disabled = false; });
    });
    addListener(progress, "click", () => {
      progress.disabled = true;
      void call(endpoints.progress, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(progressPayload()) })
        .then((data) => { state.progress = data.progress || state.progress; notify("阅读进度已同步", "success"); render(); })
        .catch((error) => notify(error.message, "error"))
        .finally(() => { progress.disabled = false; });
    });
    actions.append(bookmark, progress);
    view.append(context, actions);
    const status = makeElement(doc, "p", "research-tools-muted", "正在读取书签与进度…");
    view.appendChild(status);
    const hash = paperHash();
    void loadAnchoredState(hash).then((anchored) => {
      if (!isCurrentRender("markers", token, hash)) return;
      state.bookmarks = anchored.bookmarks;
      state.progress = anchored.progress;
      status.remove();
      appendStateList(view, "证据书签", state.bookmarks, (item) => anchoredStateRow("bookmarks", item, item.label || "书签"));
      if (state.progress) view.appendChild(makeElement(doc, "p", "research-tools-muted", `最近进度：Page ${state.progress.page || 1} · ${Number(state.progress.percent || 0)}%`));
    }).catch(() => { if (isCurrentRender("markers", token, hash)) status.textContent = "暂时无法读取书签与进度"; });
  }

  async function renderParse(view, token) {
    const status = makeElement(doc, "p", "research-tools-muted", "正在统计当前论文的数据与任务…");
    view.appendChild(status);
    const hash = paperHash();
    try {
      const [taskData, storageData] = await Promise.all([
        call(`${endpoints.parse}?paperHash=${encodeURIComponent(hash)}`),
        call(`${endpoints.storage}?paperHash=${encodeURIComponent(hash)}`),
      ]);
      if (!isCurrentRender("parse", token, hash)) return;
      state.tasks = Array.isArray(taskData?.tasks) ? taskData.tasks : [];
      const storage = storageData?.storage || {};
      status.remove();

      view.appendChild(makeElement(doc, "h3", "research-tools-subtitle", "数据所有权"));
      const ownership = makeElement(doc, "div", "research-tools-storage-card");
      [
        ["论文原始结构", storage.structureBytes, `${storage.counts?.blocks || 0} 个结构块`],
        ["图片与表格缓存", storage.assetsBytes, `${storage.counts?.visualBlocks || 0} 个视觉对象`],
        ["译文缓存", storage.translationBytes, `${storage.counts?.translations || 0} 段译文，其中 ${storage.counts?.finalTranslations || 0} 段用户定稿`],
        ["笔记与书签", storage.researchBytes, `${storage.counts?.notes || 0} 条笔记，${storage.counts?.bookmarks || 0} 个书签`],
      ].forEach(([label, bytes, detail]) => {
        const row = makeElement(doc, "div", "research-tools-storage-row");
        row.append(
          makeElement(doc, "span", "research-tools-storage-label", label),
          makeElement(doc, "strong", "research-tools-storage-value", formatBytes(bytes)),
          makeElement(doc, "small", "research-tools-storage-detail", detail),
        );
        ownership.appendChild(row);
      });
      const total = makeElement(doc, "div", "research-tools-storage-total");
      total.append(makeElement(doc, "span", "", "合计"), makeElement(doc, "strong", "", formatBytes(storage.totalBytes)));
      ownership.appendChild(total);
      view.appendChild(ownership);

      const runCleanup = async (action, message) => {
        if (!window.confirm(message)) return;
        const result = await call(endpoints.cleanup, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paperHash: hash, action }),
        });
        options.onPaperDataChanged?.({ action, ...(result?.result || {}), storage: result?.storage || null });
        notify("指定范围的数据已处理", "success");
        render();
      };
      const operations = makeElement(doc, "div", "research-tools-data-actions");
      const clearAssets = button(doc, "仅清理解析缓存");
      clearAssets.title = "删除 MinerU 图片与表格资源缓存；保留论文结构、译文、笔记、书签与用户定稿。视觉本体需重新解析后恢复。";
      addListener(clearAssets, "click", () => void runCleanup("assets", "将删除当前论文的 MinerU 图片与表格资源缓存。\n\n会保留：论文结构、正文、译文、用户定稿、笔记、书签和阅读进度。\n影响：视觉本体需要重新解析同一 PDF 才能恢复。\n\n确认继续？"));
      const clearAi = button(doc, "仅清理 AI 译文");
      clearAi.title = "删除 AI 译文与翻译缓存；保留用户定稿、原文结构、笔记和书签。";
      addListener(clearAi, "click", () => void runCleanup("ai-translations", "将删除当前论文的所有 AI 译文和翻译缓存。\n\n会保留：用户定稿、论文原文结构、图片缓存、笔记、书签和术语表。\n\n确认继续？"));
      const detach = button(doc, "保留笔记后删除论文结构", "research-tools-button-danger");
      detach.title = "保留证据快照、研究笔记和术语；删除正文结构、视觉缓存、译文、书签、进度与任务。";
      addListener(detach, "click", () => void runCleanup("structure-keep-notes", "将删除当前论文的正文结构、视觉缓存、全部译文、书签、阅读进度和解析任务。\n\n只保留：论文标题、基本解析信息、术语表，以及带原文证据快照的研究笔记。\n此操作后阅读正文需要重新导入同一 PDF。\n\n确认继续？"));
      const removeAll = button(doc, "删除整篇论文及其研究数据", "research-tools-button-danger");
      removeAll.title = "删除论文结构、视觉缓存、全部译文、用户定稿、笔记、书签、进度、术语和任务。";
      addListener(removeAll, "click", async () => {
        if (!window.confirm("将永久删除当前论文及其全部研究数据：\n\n论文结构、图片与表格缓存、AI 译文、用户定稿、笔记、书签、阅读进度、术语和任务记录。\n\n建议先导出备份。确认继续？")) return;
        await call(`${endpoints.paper}?paperHash=${encodeURIComponent(hash)}`, { method: "DELETE" });
        options.onPaperDeleted?.({ paperHash: hash });
        notify("整篇论文及其研究数据已删除", "success");
      });
      operations.append(clearAssets, clearAi, detach, removeAll);
      view.appendChild(operations);

      const backupActions = makeElement(doc, "div", "research-tools-actions research-tools-backup-actions");
      const backup = button(doc, "导出完整备份", "research-tools-button-primary");
      addListener(backup, "click", async () => {
        backup.disabled = true;
        try {
          const data = await call(endpoints.backup, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paperHash: hash, includeAssets: true }) });
          downloadBlob(doc, new Blob([JSON.stringify(data)], { type: "application/json;charset=utf-8" }), `hana-paper-reader-${hash.slice(0, 12)}.backup.json`);
          notify("论文结构、译文、研究记录与视觉缓存已导出", "success");
        } finally { backup.disabled = false; }
      });
      const restoreInput = makeElement(doc, "input", "");
      restoreInput.type = "file"; restoreInput.accept = ".json,application/json"; restoreInput.hidden = true;
      const restore = button(doc, "从备份恢复");
      addListener(restore, "click", () => restoreInput.click());
      addListener(restoreInput, "change", async () => {
        const file = restoreInput.files?.[0]; restoreInput.value = "";
        if (!file) return;
        if (file.size > 256 * 1024 * 1024) { notify("备份文件超过 256 MB，拒绝读取", "error"); return; }
        if (!window.confirm("恢复会用备份内容替换同一论文当前的结构、译文、笔记、书签、术语和任务数据。其他论文不受影响。确认继续？")) return;
        restore.disabled = true;
        try {
          const parsed = JSON.parse(await file.text());
          const data = await call(endpoints.restore, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed) });
          options.onPaperDataChanged?.({ action: "restore", ...data });
          notify("备份恢复成功", "success");
          render();
        } catch (error) { notify(`备份恢复失败：${error.message}`, "error"); }
        finally { restore.disabled = false; }
      });
      backupActions.append(backup, restore, restoreInput);
      view.appendChild(backupActions);
      view.appendChild(makeElement(doc, "p", "research-tools-muted", `存储布局：${storage.layout || "未知"}；每篇论文独立目录，不包含 MinerU Token 或模型会话。`));

      view.appendChild(makeElement(doc, "h3", "research-tools-subtitle", "解析任务"));
      if (!state.tasks.length) {
        view.appendChild(makeElement(doc, "p", "research-tools-muted", "当前论文暂无解析任务"));
        return;
      }
      const list = makeElement(doc, "div", "research-tools-results");
      state.tasks.forEach((task) => {
        const row = makeElement(doc, "div", "research-tools-task");
        const label = makeElement(doc, "div", "research-tools-task-label", `${task.stage || task.state} · ${Number(task.progress || 0)}%`);
        const detail = makeElement(doc, "p", "research-tools-muted", task.error || `${task.state} · ${task.updatedAt || ""}`);
        row.append(label, detail);
        if (["queued", "running"].includes(task.state)) {
          const cancel = button(doc, "取消任务", "research-tools-button-danger");
          addListener(cancel, "click", async () => {
            cancel.disabled = true;
            try {
              if (typeof options.onCancelTask === "function") await options.onCancelTask(task);
              else await call(`/api/research/parse-status/tasks/${encodeURIComponent(task.id)}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
              notify("解析任务已取消", "success"); render();
            } catch (error) { cancel.disabled = false; notify(error.message, "error"); }
          });
          row.appendChild(cancel);
        }
        list.appendChild(row);
      });
      view.appendChild(list);
    } catch { if (isCurrentRender("parse", token, hash)) status.textContent = "数据统计或任务状态暂时不可用"; }
  }

  function renderEvidence(view) {
    const selected = selectedBlock();
    const prompt = makeElement(doc, "textarea", "research-tools-textarea");
    prompt.placeholder = "询问方法、结论或证据链";
    const context = makeElement(doc, "p", "research-tools-context", selected ? `当前证据：Page ${Number(selected.page || 1)} / block ${selected.id}${selected.sectionTitle ? ` · ${selected.sectionTitle}` : ""}` : "当前论文全部证据块");
    const ask = button(doc, "提交问题", "research-tools-button-primary");
    const answer = makeElement(doc, "div", "research-tools-answer");
    const evidenceList = makeElement(doc, "div", "research-tools-results");
    addListener(ask, "click", async () => {
      const text = prompt.value.trim();
      if (!text) { notify("请先输入问题", "error"); return; }
      ask.disabled = true;
      answer.textContent = "正在依据论文证据分析…";
      evidenceList.replaceChildren();
      try {
        const data = await call(endpoints.evidence, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paperHash: paperHash(),
            question: text,
            evidenceId: selected?.evidenceId || null,
            blockId: selected?.id || null,
            selectedBlockId: selected?.id || null,
            agentId: state.paper?.agentId || null,
            thinkingLevel: state.paper?.thinkingLevel || "max",
          }),
        });
        answer.textContent = data.answer || data.text || "助手没有返回内容";
        const evidence = Array.isArray(data.evidence) ? data.evidence : [];
        evidence.forEach((item) => {
          evidenceList.appendChild(evidenceResult(item, `${item.sectionTitle ? `${item.sectionTitle} · ` : ""}${String(item.originalQuote || item.text || "").slice(0, 180)}`));
        });
      } catch { answer.textContent = "证据助手暂时不可用"; }
      finally { ask.disabled = false; }
    });
    view.append(context, prompt, ask, answer, evidenceList);
  }

  async function renderGlossary(view, token) {
    const status = makeElement(doc, "p", "research-tools-muted", "正在读取术语与翻译缓存…");
    view.appendChild(status);
    const hash = paperHash();
    try {
      const [data, snapshot] = await Promise.all([
        call(`${endpoints.glossary}?paperHash=${encodeURIComponent(hash)}`),
        call(`/api/research/snapshot?paperHash=${encodeURIComponent(hash)}&limit=1`),
      ]);
      if (!isCurrentRender("glossary", token, hash)) return;
      const glossary = data?.glossary || {};
      state.glossary = glossary.terms && typeof glossary.terms === "object" ? glossary.terms : {};
      const terms = Object.keys(state.glossary).length;
      const cached = Number(snapshot?.snapshot?.translationCount || 0);
      status.textContent = `术语 ${terms} · 翻译缓存 ${Number.isFinite(cached) ? cached : 0} · 版本 ${Number(glossary.version || 0)}`;

      const form = makeElement(doc, "form", "research-tools-glossary-form");
      const term = makeElement(doc, "input", "research-tools-input");
      term.placeholder = "原文术语";
      term.setAttribute("aria-label", "原文术语");
      const translation = makeElement(doc, "input", "research-tools-input");
      translation.placeholder = "固定译法";
      translation.setAttribute("aria-label", "固定译法");
      const save = button(doc, "添加术语", "research-tools-button-primary");
      save.type = "submit";
      form.append(term, translation, save);
      addListener(form, "submit", async (event) => {
        event.preventDefault();
        const source = term.value.trim();
        const target = translation.value.trim();
        if (!source || !target) { notify("请填写原文术语和固定译法", "error"); return; }
        save.disabled = true;
        try {
          const result = await call(endpoints.glossary, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paperHash: paperHash(), terms: { [source]: target } }),
          });
          state.glossary = result?.glossary?.terms || state.glossary;
          options.onPaperStateChanged?.({ kind: "glossary", glossary: result?.glossary });
          notify("术语已保存；后续翻译将使用新版本", "success");
          render();
        } catch {}
        finally { save.disabled = false; }
      });
      view.appendChild(form);
      const list = makeElement(doc, "div", "research-tools-glossary-list");
      Object.entries(state.glossary).forEach(([source, target]) => {
        const row = makeElement(doc, "div", "research-tools-glossary-row");
        row.append(makeElement(doc, "span", "research-tools-glossary-term", source), makeElement(doc, "span", "research-tools-glossary-arrow", "→"), makeElement(doc, "span", "research-tools-glossary-translation", target));
        const remove = button(doc, "删除", "research-tools-button-danger");
        addListener(remove, "click", async () => {
          remove.disabled = true;
          try {
            await call(`${endpoints.glossary}?paperHash=${encodeURIComponent(paperHash())}&term=${encodeURIComponent(source)}`, { method: "DELETE" });
            options.onPaperStateChanged?.({ kind: "glossary", deletedTerm: source });
            notify("术语已删除", "success");
            render();
          } catch {} finally { remove.disabled = false; }
        });
        row.appendChild(remove);
        list.appendChild(row);
      });
      if (Object.keys(state.glossary).length) view.appendChild(list);
    } catch { if (isCurrentRender("glossary", token, hash)) status.textContent = "暂无术语或翻译缓存状态"; }
  }

  function renderLab(view) {
    const select = makeElement(doc, "select", "research-tools-select");
    select.setAttribute("aria-label", "图表证据类型");
    [["all", "全部证据"], ["image", "图片"], ["chart", "图表"], ["equation", "公式"], ["table", "表格"]].forEach(([value, label]) => {
      const option = makeElement(doc, "option", "", label); option.value = value; option.selected = value === state.filter; select.appendChild(option);
    });
    const list = makeElement(doc, "div", "research-tools-visual-list");
    addListener(select, "change", () => { state.filter = select.value; render(); });
    view.append(select, makeElement(doc, "p", "research-tools-muted", "每个视觉对象都绑定正文证据；复制或导出时自动附上页码、块 ID 和 Evidence ID。"), list);
    const blocks = paperBlocks(state.paper);
    const matches = blocks.map((block, index) => ({ block, index })).filter(({ block }) => {
      const type = String(block?.type || "").toLowerCase();
      return VISUAL_BLOCK_TYPES.has(type) && (state.filter === "all" || type === state.filter);
    });
    if (!matches.length) { renderMessage(list, "没有符合筛选条件的图表证据"); return; }
    matches.forEach(({ block, index }) => {
      const evidence = {
        evidenceId: block.evidenceId,
        blockId: block.id,
        page: block.page,
        blockType: block.type,
        sectionId: block.sectionId,
        sectionTitle: block.sectionTitle,
        originalQuote: block.text,
        translation: block.translatedText,
      };
      const card = makeElement(doc, "article", "research-tools-visual-card");
      const head = makeElement(doc, "div", "research-tools-visual-head");
      head.append(
        makeElement(doc, "strong", "research-tools-visual-title", block.text || `${block.type} ${index + 1}`),
        makeElement(doc, "span", "research-tools-mini-badge", `${String(block.type || "视觉")} · Page ${Number(block.page || 1)}`),
      );
      card.appendChild(head);

      const media = makeElement(doc, "div", "research-tools-visual-media");
      if (block.assetRef?.cacheId && block.assetRef?.path) {
        media.appendChild(makeElement(doc, "span", "research-tools-muted", "正在载入图表本体…"));
        const query = new URLSearchParams({ cacheId: block.assetRef.cacheId, path: block.assetRef.path });
        void options.apiFetch(`${endpoints.asset}?${query}`).then(async (response) => {
          if (!response.ok || !media.isConnected) throw new Error("asset unavailable");
          const blob = await response.blob();
          if (!blob.type.startsWith("image/")) throw new Error("asset is not image");
          const image = makeElement(doc, "img", "research-tools-visual-image");
          const url = URL.createObjectURL(blob);
          image.src = url; image.alt = block.text || `${block.type} Page ${block.page}`;
          image.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
          image.addEventListener("error", () => URL.revokeObjectURL(url), { once: true });
          media.replaceChildren(image);
        }).catch(() => { if (media.isConnected) media.replaceChildren(makeElement(doc, "span", "research-tools-muted", "图表缓存不可用；可重新解析同一 PDF 恢复")); });
      } else if (block.tableHtml) {
        const rows = tableRowsFromHtml(block.tableHtml).slice(0, 30);
        if (rows.length) {
          const table = makeElement(doc, "table", "research-tools-table-preview");
          rows.forEach((cells, rowIndex) => {
            const tr = makeElement(doc, "tr");
            cells.slice(0, 12).forEach((value) => tr.appendChild(makeElement(doc, rowIndex === 0 ? "th" : "td", "", value)));
            table.appendChild(tr);
          });
          media.appendChild(table);
        }
      } else if (block.latex) {
        media.appendChild(makeElement(doc, "code", "research-tools-latex", String(block.latex).replace(/^\$\$|\$\$$/g, "").trim()));
      } else {
        media.appendChild(makeElement(doc, "span", "research-tools-muted", "该对象没有独立资源，请回到 PDF 原页查看"));
      }
      card.appendChild(media);

      card.appendChild(makeElement(doc, "p", "research-tools-visual-meta", `${block.sectionTitle || "未识别章节"} · Page ${Number(block.page || 1)} · block ${block.id}`));
      const neighbors = blocks.slice(Math.max(0, index - 2), index + 3).filter((item) => item.id !== block.id && !VISUAL_BLOCK_TYPES.has(String(item.type || "").toLowerCase()) && item.text).slice(0, 2);
      if (neighbors.length) {
        const related = makeElement(doc, "div", "research-tools-related-text");
        related.appendChild(makeElement(doc, "strong", "", "正文如何解释它"));
        neighbors.forEach((item) => related.appendChild(makeElement(doc, "p", "", item.text.slice(0, 420))));
        card.appendChild(related);
      }
      if (block.translatedText) card.appendChild(makeElement(doc, "p", "research-tools-visual-translation", `对应译文：${block.translatedText.slice(0, 600)}`));

      const actions = makeElement(doc, "div", "research-tools-actions research-tools-visual-actions");
      const jump = button(doc, "回到正文", "research-tools-button-primary"); addListener(jump, "click", () => locate(evidence)); actions.appendChild(jump);
      const markdown = `![${block.text || block.type}](attachments/${block.assetRef?.path || "visual"})\n\n> 来源：${state.paper?.title || "当前论文"} · Page ${Number(block.page || 1)} · block ${block.id} · Evidence ${block.evidenceId || ""}\n\n${neighbors.map((item) => item.text).join("\n\n")}`;
      const copy = button(doc, "复制带来源 Markdown");
      addListener(copy, "click", async () => { const copied = await copyText(markdown); notify(copied ? "带来源 Markdown 已复制" : "浏览器拒绝剪贴板写入", copied ? "success" : "error"); });
      actions.appendChild(copy);
      if (block.tableHtml) {
        const csv = button(doc, "导出 CSV");
        addListener(csv, "click", () => downloadBlob(doc, new Blob(["\uFEFF", csvText(tableRowsFromHtml(block.tableHtml))], { type: "text/csv;charset=utf-8" }), `${block.id}.csv`));
        actions.appendChild(csv);
      }
      if (block.latex) {
        const latex = button(doc, "复制 LaTeX");
        addListener(latex, "click", async () => { const copied = await copyText(String(block.latex).replace(/^\$\$|\$\$$/g, "").trim()); notify(copied ? "LaTeX 已复制" : "浏览器拒绝剪贴板写入", copied ? "success" : "error"); });
        actions.appendChild(latex);
      }
      card.appendChild(actions);
      list.appendChild(card);
    });
  }

  async function exportMarkdown() {
    const data = await call(endpoints.export, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paperHash: paperHash(), translations: state.paper?.translations || {}, options: { attachmentBasePath: "attachments" } }),
    });
    const markdown = typeof data === "string" ? data : data?.markdown;
    if (!markdown) throw new Error("导出接口没有返回 Markdown");
    const link = doc.createElement("a");
    link.href = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    link.download = `${String(state.paper?.title || "paper").replace(/[\\/:*?"<>|]/g, "_")}.md`;
    link.rel = "noopener";
    doc.body?.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
    notify("双语 Markdown 已导出", "success");
  }

  function renderExport(view) {
    view.append(makeElement(doc, "p", "research-tools-muted", "导出当前论文的原文与翻译对照。"));
    const exportButton = button(doc, "导出双语 Markdown", "research-tools-button-primary");
    addListener(exportButton, "click", () => { exportButton.disabled = true; void exportMarkdown().catch(() => notify("导出失败", "error")).finally(() => { exportButton.disabled = false; }); });
    view.appendChild(exportButton);
  }

  function renderView(id, view, token) {
    view.replaceChildren();
    if (!hasPaper(state.paper)) { renderMessage(view, "载入论文后可使用此工具"); return; }
    if (id === "search") renderSearch(view, token);
    if (id === "outline") renderOutline(view, token);
    if (id === "markers") renderMarkers(view, token);
    if (id === "notes") renderNotes(view, token);
    if (id === "parse") void renderParse(view, token);
    if (id === "evidence") renderEvidence(view);
    if (id === "glossary") void renderGlossary(view, token);
    if (id === "lab") renderLab(view);
    if (id === "export") renderExport(view);
  }

  function render() {
    if (state.destroyed) return;
    const token = ++state.renderToken;
    state.paper = getPaper();
    shell.classList.toggle("open", state.open);
    if (!state.open && shell.contains(doc.activeElement)) doc.activeElement?.blur?.();
    shell.inert = !state.open;
    shell.setAttribute("aria-hidden", String(!state.open));
    paperTitle.textContent = String(state.paper?.title || "未载入文献");
    empty.hidden = hasPaper(state.paper);
    content.hidden = !hasPaper(state.paper);
    for (const [id, workflowButton] of workflowButtons) workflowButton.classList.toggle("active", id === state.activeWorkflow);
    systemButton.classList.toggle("active", state.activeWorkflow === "system");
    for (const [id, navButton] of toolButtons) {
      const visible = navButton.dataset.workflow === state.activeWorkflow;
      navButton.hidden = !visible;
      navButton.classList.toggle("active", visible && id === state.activeTool);
    }
    for (const [id, view] of views) { view.hidden = id !== state.activeTool; if (id === state.activeTool) renderView(id, view, token); }
  }

  function refresh() { render(); return api; }
  function open(tool = null) {
    if (tool && toolButtons.has(tool)) {
      state.activeTool = tool;
      state.activeWorkflow = TOOL_DEFINITIONS.find((definition) => definition[0] === tool)?.[3] || state.activeWorkflow;
    }
    state.open = true; render(); return api;
  }
  function restoreUiState(value = {}) {
    const search = value.searchState || {};
    if (typeof search.query === "string") state.query = search.query.slice(0, 200);
    if (["page", "section", "all"].includes(search.scope)) state.searchScope = search.scope;
    if (["original", "translation", "both"].includes(search.language)) state.searchLanguage = search.language;
    if (Array.isArray(search.types)) state.searchTypes = new Set(search.types.filter((item) => SEARCH_TYPES.some(([value]) => value === item)));
    if (value.noteDraft && typeof value.noteDraft === "object") {
      state.noteDraft = value.noteDraft;
      state.note = String(value.noteDraft.note || "");
      state.noteType = NOTE_TYPE_LABELS[value.noteDraft.noteType] ? value.noteDraft.noteType : "finding";
      state.noteTags = String(value.noteDraft.tags || "");
    }
    return api;
  }
  function uiState() { return { searchState: searchStateSnapshot(), noteDraft: state.noteDraft }; }
  function closeDrawer() { state.open = false; render(); return api; }
  function destroy() { shell.remove(); state.destroyed = true; }
  const api = { open, close: closeDrawer, destroy, refresh, restoreUiState, uiState };
  addListener(close, "click", closeDrawer);
  render();
  return api;
}

export default createResearchTools;
