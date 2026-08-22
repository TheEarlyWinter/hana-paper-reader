const DEFAULT_ENDPOINTS = {
  notes: "/api/research/notes",
  bookmarks: "/api/research/bookmarks",
  progress: "/api/research/progress",
  parse: "/api/research/parse-status/tasks",
  evidence: "/api/research/evidence",
  glossary: "/api/research/glossary",
  export: "/api/research/export",
};

const VISUAL_BLOCK_TYPES = new Set(["image", "chart", "equation", "table"]);

const TOOL_DEFINITIONS = [
  ["search", "全文搜索", "在当前论文块中查找并跳转命中"],
  ["outline", "自动大纲", "按标题块快速浏览论文结构"],
  ["notes", "笔记 / 书签 / 进度", "保存当前选中段落的研究标记"],
  ["parse", "解析任务状态", "查看文档解析与资源准备状态"],
  ["evidence", "证据助手", "带当前论文上下文提问"],
  ["glossary", "术语表 / 翻译缓存", "查看术语和翻译缓存状态"],
  ["lab", "图表 / 公式 / 图片实验室", "按结构块类型筛选视觉与公式"],
  ["export", "双语 Markdown", "导出当前论文的双语 Markdown"],
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
  return paperBlocks(paper).length > 0 || paper?.loaded === true || paper?.isLoaded === true;
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
    activeTool: "search",
    paper: null,
    query: "",
    results: [],
    outline: [],
    filter: "all",
    note: "",
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
  const nav = makeElement(doc, "nav", "research-tools-nav");
  nav.setAttribute("aria-label", "研究工具入口");
  const body = makeElement(doc, "div", "research-tools-body");
  const empty = makeElement(doc, "div", "research-tools-empty", "当前没有可分析的论文");
  const content = makeElement(doc, "div", "research-tools-content");
  body.append(empty, content);
  shell.append(header, nav, body);
  root.appendChild(shell);

  const toolButtons = new Map();
  const views = new Map();
  for (const [id, label, description] of TOOL_DEFINITIONS) {
    const navButton = button(doc, label, "research-tools-nav-button");
    navButton.dataset.tool = id;
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
    const id = block?.id || block?._id;
    if (!id) return;
    try { options.onLocateBlock?.(id, block); } catch {}
  }

  function renderMessage(view, message, className = "research-tools-muted") {
    view.replaceChildren(makeElement(doc, "p", className, message));
  }

  function renderSearch(view) {
    const form = makeElement(doc, "form", "research-tools-form");
    const input = makeElement(doc, "input", "research-tools-input");
    input.type = "search";
    input.placeholder = "搜索全文";
    input.value = state.query;
    input.setAttribute("aria-label", "搜索全文");
    const submit = button(doc, "搜索", "research-tools-button-primary");
    submit.type = "submit";
    form.append(input, submit);
    const resultBox = makeElement(doc, "div", "research-tools-results");
    addListener(form, "submit", (event) => {
      event.preventDefault();
      state.query = input.value.trim();
      const query = state.query.toLocaleLowerCase();
      state.results = query ? paperBlocks(state.paper).map((block, index) => ({ block, index })).filter(({ block }) => blockText(block).toLocaleLowerCase().includes(query)) : [];
      render();
    });
    view.append(form, resultBox);
    if (!state.query) {
      renderMessage(resultBox, "输入关键词后搜索当前论文");
      return;
    }
    if (!state.results.length) {
      renderMessage(resultBox, "没有找到匹配内容");
      return;
    }
    state.results.forEach(({ block, index }) => {
      const item = button(doc, "", "research-tools-result");
      item.append(
        makeElement(doc, "span", "research-tools-result-index", `P${Number(block.page || 1)}`),
        makeElement(doc, "span", "research-tools-result-text", `${block.id || `block-${index + 1}`} · ${blockText(block).slice(0, 180)}`),
      );
      addListener(item, "click", () => locate(block));
      resultBox.appendChild(item);
    });
  }

  function renderOutline(view) {
    state.outline = paperBlocks(state.paper).map((block, index) => ({ block, index })).filter(({ block }) => ["heading", "title", "section"].includes(String(block?.type || "").toLowerCase()) || /^\s*(\d+(?:\.\d+)*|abstract|introduction|conclusion|references)\b/i.test(String(block?.text || "")));
    if (!state.outline.length) {
      renderMessage(view, "当前论文没有可识别的标题块");
      return;
    }
    const list = makeElement(doc, "ol", "research-tools-list");
    state.outline.forEach(({ block }) => {
      const item = makeElement(doc, "li");
      const jump = button(doc, blockText(block).slice(0, 160), "research-tools-link");
      addListener(jump, "click", () => locate(block));
      item.appendChild(jump);
      list.appendChild(item);
    });
    view.appendChild(list);
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
    const block = selectedBlock();
    if (!paperHash() || !block?.id) throw new Error("当前论文没有可引用的段落");
    const body = kind === "notes"
      ? { paperHash: paperHash(), blockId: block.id, page: Number(block.page || 1), note: String(value || "").trim() }
      : { paperHash: paperHash(), blockId: block.id, page: Number(block.page || 1), bbox: block.bbox || null, label: "重点" };
    const data = await call(endpoints[kind], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    options.onPaperStateChanged?.({ kind, blockId: block.id, value, data });
    notify(kind === "notes" ? "笔记已保存" : "书签已保存", "success");
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
    addListener(jump, "click", () => locate({ id: item.blockId }));
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
    const context = makeElement(doc, "p", "research-tools-context", selected ? `Page ${Number(selected.page || 1)} · block ${selected.id}: ${blockText(selected).slice(0, 140)}` : "未选择段落");
    const note = makeElement(doc, "textarea", "research-tools-textarea");
    note.placeholder = "写下研究笔记";
    note.value = state.note;
    addListener(note, "input", () => { state.note = note.value; });
    const actions = makeElement(doc, "div", "research-tools-actions");
    const save = button(doc, "保存笔记", "research-tools-button-primary");
    const bookmark = button(doc, "添加书签");
    const progress = button(doc, "同步阅读进度");
    addListener(save, "click", () => {
      state.note = note.value;
      save.disabled = true;
      void saveNote("notes", note.value).catch((error) => notify(error.message, "error")).finally(() => { save.disabled = false; });
    });
    addListener(bookmark, "click", () => {
      bookmark.disabled = true;
      void saveNote("bookmarks", true).catch((error) => notify(error.message, "error")).finally(() => { bookmark.disabled = false; });
    });
    addListener(progress, "click", () => {
      progress.disabled = true;
      void call(endpoints.progress, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(progressPayload()) })
        .then((data) => { state.progress = data.progress || state.progress; notify("阅读进度已同步", "success"); })
        .catch((error) => notify(error.message, "error"))
        .finally(() => { progress.disabled = false; });
    });
    actions.append(save, bookmark, progress);
    view.append(context, note, actions);
    const status = makeElement(doc, "p", "research-tools-muted", "正在读取已保存的研究标记…");
    view.appendChild(status);
    const hash = paperHash();
    void loadAnchoredState(hash).then((anchored) => {
      if (!isCurrentRender("notes", token, hash)) return;
      state.notes = anchored.notes;
      state.bookmarks = anchored.bookmarks;
      state.progress = anchored.progress;
      status.remove();
      appendStateList(view, "笔记", state.notes, (item) => anchoredStateRow("notes", item, item.note || "笔记"));
      appendStateList(view, "书签", state.bookmarks, (item) => anchoredStateRow("bookmarks", item, item.label || "书签"));
      if (state.progress) view.appendChild(makeElement(doc, "p", "research-tools-muted", `最近进度：Page ${state.progress.page || 1} · ${Number(state.progress.percent || 0)}%`));
    }).catch(() => { if (isCurrentRender("notes", token, hash)) status.textContent = "暂时无法读取已保存标记"; });
  }

  async function renderParse(view, token) {
    const status = makeElement(doc, "p", "research-tools-muted", "正在读取解析任务状态…");
    view.appendChild(status);
    const hash = paperHash();
    try {
      const data = await call(`${endpoints.parse}?paperHash=${encodeURIComponent(hash)}`);
      if (!isCurrentRender("parse", token, hash)) return;
      state.tasks = Array.isArray(data?.tasks) ? data.tasks : [];
      status.remove();
      if (!state.tasks.length) {
        renderMessage(view, "当前论文暂无解析任务");
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
              notify("解析任务已取消", "success");
              render();
            } catch (error) { cancel.disabled = false; notify(error.message, "error"); }
          });
          row.appendChild(cancel);
        }
        list.appendChild(row);
      });
      view.appendChild(list);
    } catch { if (isCurrentRender("parse", token, hash)) status.textContent = "暂无可用解析任务状态"; }
  }

  function renderEvidence(view) {
    const selected = selectedBlock();
    const prompt = makeElement(doc, "textarea", "research-tools-textarea");
    prompt.placeholder = "询问方法、结论或证据链";
    const context = makeElement(doc, "p", "research-tools-context", selected ? `当前证据：Page ${Number(selected.page || 1)} / block ${selected.id}` : "当前论文全部结构块");
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
            blockId: selected?.id || null,
            selectedBlockId: selected?.id || null,
            agentId: state.paper?.agentId || null,
            thinkingLevel: state.paper?.thinkingLevel || "max",
          }),
        });
        answer.textContent = data.answer || data.text || "助手没有返回内容";
        const evidence = Array.isArray(data.evidence) ? data.evidence : [];
        evidence.forEach((item) => {
          const row = button(doc, `Page ${item.page || 1} / block ${item.id}`, "research-tools-result");
          row.title = String(item.text || "").slice(0, 240);
          addListener(row, "click", () => locate({ id: item.id, page: item.page }));
          evidenceList.appendChild(row);
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
    select.setAttribute("aria-label", "结构块筛选");
    [["all", "全部"], ["image", "图片"], ["chart", "图表"], ["equation", "公式"], ["table", "表格"]].forEach(([value, label]) => {
      const option = makeElement(doc, "option", "", label); option.value = value; option.selected = value === state.filter; select.appendChild(option);
    });
    const list = makeElement(doc, "div", "research-tools-results");
    addListener(select, "change", () => { state.filter = select.value; render(); });
    view.append(select, list);
    const matches = paperBlocks(state.paper).map((block, index) => ({ block, index })).filter(({ block }) => {
      const type = String(block?.type || "").toLowerCase();
      return VISUAL_BLOCK_TYPES.has(type) && (state.filter === "all" || type === state.filter);
    });
    if (!matches.length) { renderMessage(list, "没有符合筛选条件的结构块"); return; }
    matches.forEach(({ block, index }) => {
      const item = button(doc, `${index + 1} · ${blockText(block).slice(0, 150) || String(block?.type || "结构块")}`, "research-tools-result");
      addListener(item, "click", () => locate(block)); list.appendChild(item);
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
    if (id === "search") renderSearch(view);
    if (id === "outline") renderOutline(view);
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
    for (const [id, navButton] of toolButtons) navButton.classList.toggle("active", id === state.activeTool);
    for (const [id, view] of views) { view.hidden = id !== state.activeTool; if (id === state.activeTool) renderView(id, view, token); }
  }

  function refresh() { render(); return api; }
  function open() { state.open = true; render(); return api; }
  function closeDrawer() { state.open = false; render(); return api; }
  function destroy() { shell.remove(); state.destroyed = true; }
  const api = { open, close: closeDrawer, destroy, refresh };
  addListener(close, "click", closeDrawer);
  render();
  return api;
}

export default createResearchTools;
