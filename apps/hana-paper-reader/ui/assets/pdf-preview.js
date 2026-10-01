import { hana } from "./sdk.js";
import {
  MAX_PAGE_COUNT, MAX_SEARCH_RESULTS, canvasScale, checkDeclaredSize,
  decodePdfBytes, displayName, documentIdentity, previewError, publicError, readSearchPageText, unwrapHostResult,
} from "./pdf-preview-core.js";

const elements = Object.fromEntries([
  "document-name", "open-document", "previous-page", "page-number", "page-count", "next-page",
  "zoom-out", "zoom-mode", "zoom-in", "custom-zoom", "rotate-page", "reload-document",
  "preview-message", "page-stage", "page-host", "preview-empty", "render-detail",
  "find-form", "find-query", "start-find", "cancel-find", "previous-match", "next-match", "find-status",
  "password-dialog", "password-form", "pdf-password", "password-hint", "cancel-password",
].map(id => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), document.getElementById(id)]));

const state = {
  epoch: 0, closed: false, context: null, identity: null, pdfjs: null,
  pdf: null, loadingTask: null, page: 1, rotation: 0, zoom: "width", scale: 1,
  renderSerial: 0, renderRunning: false, renderWork: null, displayed: null,
  searchEpoch: 0, searchController: null, searching: false, matches: [], matchIndex: -1, query: "", searchSummary: "",
  passwordCallback: null, passwordCancelledEpoch: null, statusError: null,
};
let resizeTimer = null;
let openingDocument = false;
const disposers = [];

function message(text, level = "info") {
  elements.previewMessage.textContent = text;
  elements.previewMessage.dataset.level = level;
}

function status() {
  // Reading position and zoom do not edit the PDF or advance its revision.
  return { revision: 0, dirty: false, canUndo: false, canRedo: false, error: state.statusError };
}

function alive(epoch) { return !state.closed && epoch === state.epoch; }

function closePassword() {
  state.passwordCallback = null;
  elements.pdfPassword.value = "";
  if (elements.passwordDialog.open) elements.passwordDialog.close();
}

function cancelSearch({ clear = false } = {}) {
  state.searchEpoch++;
  state.searchController?.abort();
  state.searchController = null;
  state.searching = false;
  elements.cancelFind.hidden = true;
  if (clear) {
    state.matches = [];
    state.matchIndex = -1;
    state.query = "";
    state.searchSummary = "";
    elements.findStatus.textContent = "";
  }
  updateControls();
}

function clearDisplayed() {
  const displayed = state.displayed;
  state.displayed = null;
  elements.pageHost.replaceChildren();
  elements.pageHost.hidden = true;
  if (displayed) {
    displayed.textLayer?.cancel();
    displayed.canvas.width = displayed.canvas.height = 0;
    displayed.page.cleanup();
  }
}

function cancelRender() {
  state.renderSerial++;
  state.renderWork?.task?.cancel();
  state.renderWork?.textLayer?.cancel();
}

async function releaseDocument() {
  cancelRender();
  cancelSearch({ clear: true });
  closePassword();
  clearDisplayed();
  const task = state.loadingTask;
  const pdf = state.pdf;
  state.loadingTask = state.pdf = null;
  state.context = state.identity = null;
  updateControls();
  // LoadingTask.destroy owns its document and worker. Do not destroy both.
  try { if (task) await task.destroy(); else if (pdf) await pdf.destroy(); } catch { /* Already cancelled by the host. */ }
  state.pdfjs?.TextLayer?.cleanup();
}

function updateControls() {
  const available = Boolean(state.pdf) && !state.closed;
  for (const control of document.querySelectorAll("[data-document-control]")) control.disabled = !available;
  elements.previousPage.disabled = !available || state.page <= 1;
  elements.nextPage.disabled = !available || state.page >= state.pdf.numPages;
  elements.pageNumber.value = String(state.page);
  elements.pageNumber.max = String(state.pdf?.numPages || 1);
  elements.pageCount.textContent = `/ ${state.pdf?.numPages || "—"}`;
  elements.startFind.disabled = !available || state.searching;
  elements.previousMatch.disabled = !available || state.matches.length === 0;
  elements.nextMatch.disabled = !available || state.matches.length === 0;
  elements.zoomOut.disabled = !available || (typeof state.zoom === "number" && state.zoom <= .25);
  elements.zoomIn.disabled = !available || (typeof state.zoom === "number" && state.zoom >= 4);
  elements.openDocument.hidden = hana.surface.getContext()?.slot !== "card";
  elements.openDocument.disabled = openingDocument || state.closed;
}

async function currentContext(epoch, expectedIdentity) {
  const context = await hana.document.getContext({ timeoutMs: 10000 });
  if (!alive(epoch)) throw previewError("VIEW_STALE", "页面已关闭。");
  const identity = documentIdentity(context);
  if (expectedIdentity && identity !== expectedIdentity) throw previewError("DOCUMENT_BINDING_CHANGED", "当前文档已被替换。");
  return context;
}

async function authorizeView(epoch, identity) {
  await currentContext(epoch, identity);
  // getContext only exposes mounted metadata. reportStatus also resolves the
  // binding and current App read grant on the host, without reading another file.
  const result = await hana.document.reportStatus(status(), { timeoutMs: 10000 });
  if (result !== undefined && result !== null) unwrapHostResult(result);
  await currentContext(epoch, identity);
}

async function fail(error, epoch) {
  if (!alive(epoch)) return;
  const detail = publicError(error);
  const context = state.context;
  const identity = state.identity;
  state.epoch++;
  const errorEpoch = state.epoch;
  await releaseDocument();
  if (!alive(errorEpoch)) return;
  state.statusError = detail;
  message(detail.message, "error");
  elements.previewEmpty.hidden = false;
  elements.previewEmpty.firstElementChild.textContent = detail.message;
  elements.pageStage.setAttribute("aria-busy", "false");
  elements.renderDetail.textContent = "";
  // Report only if this is still the same binding. Revocation is an error,
  // never a successful empty PDF. No raw paths or SDK error text are retained.
  if (context && identity) {
    try {
      await currentContext(errorEpoch, identity);
      await hana.document.reportStatus(status(), { timeoutMs: 5000 });
    } catch { /* The closed/revoked binding may no longer accept status. */ }
  }
}

function askPassword(updatePassword, reason, epoch) {
  if (!alive(epoch)) return;
  state.passwordCallback = { updatePassword, epoch };
  elements.pdfPassword.value = "";
  elements.passwordHint.textContent = reason === state.pdfjs.PasswordResponses.INCORRECT_PASSWORD
    ? "密码不正确，请重新输入。" : "这份 PDF 需要打开密码。";
  if (!elements.passwordDialog.open) elements.passwordDialog.showModal();
  elements.pdfPassword.focus();
}

async function loadDocument() {
  if (state.closed) return;
  const epoch = ++state.epoch;
  state.statusError = null;
  await releaseDocument();
  if (!alive(epoch)) return;
  state.page = 1;
  state.rotation = 0;
  elements.pageStage.scrollTop = elements.pageStage.scrollLeft = 0;
  elements.previewEmpty.hidden = false;
  elements.previewEmpty.firstElementChild.textContent = "正在加载论文 PDF…";
  elements.pageStage.setAttribute("aria-busy", "true");
  message("正在读取当前文档…");
  try {
    const context = await currentContext(epoch);
    checkDeclaredSize(context);
    const identity = documentIdentity(context);
    state.context = context;
    state.identity = identity;
    elements.documentName.textContent = displayName(context);
    let source = await hana.document.read({ timeoutMs: 60000 });
    await currentContext(epoch, identity);
    const bytes = decodePdfBytes(source);
    source = null;
    const pdfjs = state.pdfjs || await import("./pdfjs.mjs");
    if (!alive(epoch)) return;
    state.pdfjs = pdfjs;
    const task = pdfjs.getDocument({
      data: bytes, isEvalSupported: false, useSystemFonts: true, enableXfa: false,
      cMapUrl: new URL("./cmaps/", import.meta.url).href, cMapPacked: true,
      standardFontDataUrl: new URL("./standard_fonts/", import.meta.url).href,
      maxImageSize: 32 * 1024 * 1024, canvasMaxAreaInBytes: 64 * 1024 * 1024,
    });
    state.loadingTask = task;
    task.onPassword = (updatePassword, reason) => askPassword(updatePassword, reason, epoch);
    const pdf = await task.promise;
    if (!alive(epoch)) { await task.destroy(); return; }
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > MAX_PAGE_COUNT) {
      throw previewError("PDF_PAGE_COUNT_INVALID", "PDF 页数异常或超过 10000 页上限。");
    }
    await authorizeView(epoch, identity);
    if (!alive(epoch)) return;
    closePassword();
    state.pdf = pdf;
    updateControls();
    queueRender();
  } catch (error) {
    if (state.passwordCancelledEpoch === epoch) error = previewError("PASSWORD_CANCELLED", "已取消解锁。");
    await fail(error, epoch);
  }
}

async function openDocument() {
  if (openingDocument || state.closed || hana.surface.getContext()?.slot !== "card") return;
  openingDocument = true;
  updateControls();
  const epoch = state.epoch;
  let phase = "pick";
  try {
    // The picker and document.open hand the selection to the host. The view
    // never reads a picked path itself or turns it into document authority.
    message("请选择一份 PDF 文档。");
    // A native picker waits for a person. The SDK's 10-second RPC default
    // can expire while its dialog is still open and discard the selection.
    const selection = unwrapHostResult(await hana.resources.pick(
      { mode: "file", multiple: false }, { timeoutMs: 10 * 60 * 1000 },
    ));
    if (!alive(epoch)) return;
    if (!selection.resources?.length) { message("已取消打开 PDF。"); return; }
    if (selection.resources.length !== 1) throw previewError("PDF_SELECTION_INVALID", "请选择一份 PDF。");
    const resource = selection.resources[0];
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) throw previewError("PDF_SELECTION_INVALID", "请选择一份 PDF。");
    phase = "open";
    message("正在打开所选 PDF…");
    const result = unwrapHostResult(await hana.document.open(
      { providerId: "app:hana-paper-reader/pdf", resource }, { timeoutMs: 60000 },
    ));
    if (result.opened !== true) throw previewError("DOCUMENT_OPEN_FAILED", "宿主无法打开当前 PDF。");
    if (alive(epoch)) await loadDocument();
  } catch (error) {
    if (alive(epoch)) {
      const detail = publicError(error);
      const text = detail.code === "DOCUMENT_TIMEOUT"
        ? phase === "pick" ? "选择文件等待时间已到，请再次点击打开 PDF。" : "打开文档超时，请再次打开 PDF。"
        : detail.message;
      message(text, "error");
    }
  } finally { openingDocument = false; updateControls(); }
}

function pageScale(page) {
  const viewport = page.getViewport({ scale: 1, rotation: state.rotation });
  canvasScale(viewport.width, viewport.height);
  const availableWidth = Math.max(100, elements.pageStage.clientWidth - 40);
  const availableHeight = Math.max(100, elements.pageStage.clientHeight - 40);
  let scale = typeof state.zoom === "number" ? state.zoom : availableWidth / viewport.width;
  if (state.zoom === "page") scale = Math.min(scale, availableHeight / viewport.height);
  return Math.max(.1, Math.min(scale, 4));
}

function highlightCurrentPage() {
  const layer = state.displayed?.textLayer;
  if (!layer) return;
  for (const span of layer.textDivs) {
    span.classList.toggle("find-hit", Boolean(state.query && span.textContent.toLowerCase().includes(state.query)));
  }
}

async function renderPage(serial) {
  const epoch = state.epoch;
  const pdf = state.pdf;
  const identity = state.identity;
  const pageNumber = state.page;
  let work = null;
  const current = () => alive(epoch) && serial === state.renderSerial && state.pdf === pdf;
  try {
    await authorizeView(epoch, identity);
    if (!current()) return;
    // Only the current page has a canvas/text layer. Retire the old one before
    // allocating the new bitmap, even on a very large multi-page document.
    clearDisplayed();
    elements.previewEmpty.hidden = false;
    elements.previewEmpty.firstElementChild.textContent = `正在绘制第 ${pageNumber} 页…`;
    const page = await pdf.getPage(pageNumber);
    if (!current()) { page.cleanup(); return; }
    const scale = pageScale(page);
    const viewport = page.getViewport({ scale, rotation: state.rotation });
    const outputScale = canvasScale(viewport.width, viewport.height, window.devicePixelRatio);
    const node = document.createElement("div");
    node.className = "pdf-page";
    node.style.width = `${viewport.width}px`;
    node.style.height = `${viewport.height}px`;
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-label", `PDF 第 ${pageNumber} 页`);
    canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
    canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const textNode = document.createElement("div");
    textNode.className = "textLayer";
    textNode.style.setProperty("--total-scale-factor", String(scale * (page.userUnit || 1)));
    node.append(canvas, textNode);
    work = { page, node, canvas, textLayer: null, task: null };
    state.renderWork = work;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw previewError("PDF_CANVAS_UNAVAILABLE", "无法创建绘图区域。");
    work.task = page.render({
      canvasContext: context, viewport, background: "rgb(255,255,255)",
      transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
      annotationMode: state.pdfjs.AnnotationMode.DISABLE,
    });
    await work.task.promise;
    if (!current()) return;
    let textWarning = false;
    try {
      work.textLayer = new state.pdfjs.TextLayer({
        textContentSource: page.streamTextContent(), container: textNode, viewport,
      });
      await work.textLayer.render();
    } catch (error) {
      if (!current()) return;
      work.textLayer?.cancel();
      work.textLayer = null;
      textNode.replaceChildren();
      textWarning = true;
    }
    if (!current()) return;
    await authorizeView(epoch, identity);
    if (!current()) return;
    state.scale = scale;
    state.displayed = work;
    work = null;
    elements.pageHost.replaceChildren(state.displayed.node);
    elements.pageHost.hidden = false;
    elements.previewEmpty.hidden = true;
    elements.pageStage.setAttribute("aria-busy", "false");
    elements.renderDetail.textContent = `第 ${pageNumber} / ${pdf.numPages} 页 · ${Math.round(scale * 100)}%${outputScale < Math.min(window.devicePixelRatio || 1, 2) ? " · 已限制绘图内存" : ""}`;
    highlightCurrentPage();
    message(textWarning ? "页面已显示；此页文字层无法加载，可继续阅读。" : "可选择 PDF 文字；扫描页需要先进行文字识别。");
  } catch (error) {
    if (current()) await fail(error, epoch);
  } finally {
    if (state.renderWork?.page === (work?.page || state.displayed?.page)) state.renderWork = null;
    if (work) {
      work.textLayer?.cancel();
      work.canvas.width = work.canvas.height = 0;
      work.page.cleanup();
    }
  }
}

function queueRender() {
  if (!state.pdf || state.closed) return;
  cancelRender();
  elements.pageStage.setAttribute("aria-busy", "true");
  if (state.renderRunning) return;
  state.renderRunning = true;
  void (async () => {
    try {
      let finished = -1;
      while (!state.closed && state.pdf && finished !== state.renderSerial) {
        finished = state.renderSerial;
        await renderPage(finished);
      }
    } finally { state.renderRunning = false; }
  })();
}

function setPage(page) {
  if (!state.pdf) return;
  const next = Number(page);
  if (!Number.isSafeInteger(next) || next < 1 || next > state.pdf.numPages) { updateControls(); return; }
  if (next === state.page && state.displayed) return;
  state.page = next;
  elements.pageStage.scrollTop = elements.pageStage.scrollLeft = 0;
  updateControls();
  queueRender();
}

function setZoom(zoom) {
  state.zoom = typeof zoom === "number" ? Math.min(4, Math.max(.25, zoom)) : zoom;
  const value = String(state.zoom);
  const option = [...elements.zoomMode.options].find(item => item.value === value && item.value !== "custom");
  elements.customZoom.hidden = Boolean(option);
  if (option) elements.zoomMode.value = value;
  else {
    elements.customZoom.textContent = `${Math.round(state.zoom * 100)}%`;
    elements.zoomMode.value = "custom";
  }
  updateControls();
  queueRender();
}

function updateMatchStatus(prefix = "") {
  const total = state.matches.length;
  elements.findStatus.textContent = total
    ? `${prefix}${state.matchIndex >= 0 ? state.matchIndex + 1 : "—"} / ${total} 个匹配页${state.searchSummary}`
    : `${prefix}${state.searchSummary}`;
  updateControls();
}

function goToMatch(offset) {
  if (!state.matches.length) return;
  state.matchIndex = (state.matchIndex + offset + state.matches.length) % state.matches.length;
  setPage(state.matches[state.matchIndex]);
  highlightCurrentPage();
  updateMatchStatus(state.searching ? "仍在查找 · " : "");
}

async function findText() {
  if (!state.pdf) return;
  cancelSearch({ clear: true });
  const query = elements.findQuery.value.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 128);
  if (!query) { highlightCurrentPage(); return; }
  const epoch = state.epoch;
  const searchEpoch = state.searchEpoch;
  const pdf = state.pdf;
  const identity = state.identity;
  const controller = new AbortController();
  state.searchController = controller;
  const stillCurrent = () => alive(epoch) && state.searchEpoch === searchEpoch && state.pdf === pdf;
  state.query = query;
  state.searching = true;
  elements.cancelFind.hidden = false;
  updateControls();
  highlightCurrentPage();
  let truncatedPages = 0;
  let scannedPages = 0;
  try {
    await authorizeView(epoch, identity);
    for (let pageNumber = 1; pageNumber <= pdf.numPages && stillCurrent(); pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      try {
        const result = await readSearchPageText(page, { signal: controller.signal });
        if (!stillCurrent()) return;
        scannedPages = pageNumber;
        if (result.truncated) truncatedPages++;
        if (result.text.includes(query)) state.matches.push(pageNumber);
      } finally {
        // Do not retire a proxy that the current canvas/text layer is using.
        if (page !== state.displayed?.page && page !== state.renderWork?.page) page.cleanup();
      }
      elements.findStatus.textContent = `正在查找 ${pageNumber} / ${pdf.numPages} 页 · ${state.matches.length} 个匹配页`;
      updateControls();
      if (state.matches.length >= MAX_SEARCH_RESULTS) break;
      if (pageNumber % 10 === 0) {
        await authorizeView(epoch, identity);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    if (!stillCurrent()) return;
    await authorizeView(epoch, identity);
    if (!stillCurrent()) return;
    state.searching = false;
    elements.cancelFind.hidden = true;
    const partial = scannedPages < pdf.numPages || truncatedPages > 0;
    const suffix = partial ? ` · 部分结果（查找 ${scannedPages} 页${truncatedPages ? `，${truncatedPages} 页文字过多已截断` : ""}）` : "";
    state.searchSummary = suffix;
    if (state.matches.length) {
      state.matchIndex = 0;
      setPage(state.matches[0]);
      updateMatchStatus();
    } else {
      elements.findStatus.textContent = `未找到匹配文字${suffix}`;
      updateControls();
    }
  } catch (error) {
    if (stillCurrent()) await fail(error, epoch);
  } finally {
    if (state.searchController === controller) state.searchController = null;
    if (stillCurrent()) { state.searching = false; elements.cancelFind.hidden = true; updateControls(); }
  }
}

elements.previousPage.addEventListener("click", () => setPage(state.page - 1));
elements.openDocument.addEventListener("click", () => { void openDocument(); });
elements.nextPage.addEventListener("click", () => setPage(state.page + 1));
elements.pageNumber.addEventListener("change", () => setPage(elements.pageNumber.value));
elements.zoomMode.addEventListener("change", () => {
  const value = elements.zoomMode.value;
  if (value !== "custom") setZoom(value === "width" || value === "page" ? value : Number(value));
});
elements.zoomIn.addEventListener("click", () => setZoom(state.scale * 1.25));
elements.zoomOut.addEventListener("click", () => setZoom(state.scale / 1.25));
elements.rotatePage.addEventListener("click", () => { state.rotation = (state.rotation + 90) % 360; queueRender(); });
elements.reloadDocument.addEventListener("click", () => { void loadDocument(); });
elements.findForm.addEventListener("submit", event => { event.preventDefault(); void findText(); });
elements.findQuery.addEventListener("input", () => {
  cancelSearch({ clear: true });
  highlightCurrentPage();
});
elements.cancelFind.addEventListener("click", () => { cancelSearch(); state.searchSummary = " · 已停止，部分结果"; updateMatchStatus(); });
elements.previousMatch.addEventListener("click", () => goToMatch(-1));
elements.nextMatch.addEventListener("click", () => goToMatch(1));
elements.passwordForm.addEventListener("submit", event => {
  event.preventDefault();
  const callback = state.passwordCallback;
  if (!callback || !alive(callback.epoch)) { closePassword(); return; }
  const password = elements.pdfPassword.value;
  closePassword();
  callback.updatePassword(password);
});
function cancelPassword() {
  if (!state.passwordCallback) return;
  state.passwordCancelledEpoch = state.passwordCallback.epoch;
  closePassword();
  void fail(previewError("PASSWORD_CANCELLED", "已取消解锁。"), state.epoch);
}
elements.cancelPassword.addEventListener("click", cancelPassword);
elements.passwordDialog.addEventListener("cancel", event => { event.preventDefault(); cancelPassword(); });

document.addEventListener("keydown", event => {
  if (elements.passwordDialog.open || event.altKey || event.metaKey) return;
  const target = event.target;
  const editing = target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable);
  if (event.ctrlKey && event.key.toLowerCase() === "f") {
    event.preventDefault(); elements.findQuery.focus(); elements.findQuery.select(); return;
  }
  if (!state.pdf || editing) return;
  if (event.ctrlKey && ["+", "=", "-", "0"].includes(event.key)) {
    event.preventDefault();
    setZoom(event.key === "0" ? "width" : event.key === "-" ? state.scale / 1.25 : state.scale * 1.25);
  } else if (!event.ctrlKey && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    if (window.getSelection()?.isCollapsed === false) return;
    event.preventDefault();
    setPage(event.key === "Home" ? 1 : event.key === "End" ? state.pdf.numPages : state.page + (event.key === "ArrowLeft" ? -1 : 1));
  }
});

const observer = new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.zoom === "width" || state.zoom === "page") queueRender();
  }, 120);
});
observer.observe(elements.pageStage);

function applyTheme(theme) {
  if (theme?.appearance === "light" || theme?.appearance === "dark") document.documentElement.dataset.previewAppearance = theme.appearance;
  else delete document.documentElement.dataset.previewAppearance;
}
applyTheme(hana.theme.getSnapshot());
disposers.push(hana.theme.subscribe(applyTheme));
disposers.push(hana.surface.onContextChanged(() => {
  updateControls();
  if (!state.context || state.closed) return;
  const epoch = state.epoch;
  void currentContext(epoch, state.identity).catch(error => fail(error, epoch));
}));
disposers.push(hana.document.onRequest(async ({ requestId, kind }) => {
  if (kind === "prepareClose") return { requestId, ...status() };
  throw previewError("PDF_READ_ONLY", "PDF 预览为只读，无法执行保存、撤销或编辑操作。");
}));

function shutdown() {
  if (state.closed) return;
  state.closed = true;
  state.epoch++;
  clearTimeout(resizeTimer);
  observer.disconnect();
  for (const dispose of disposers.splice(0)) dispose();
  void releaseDocument();
}
window.addEventListener("pagehide", shutdown);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !state.context || state.closed) return;
  const epoch = state.epoch;
  void authorizeView(epoch, state.identity).catch(error => fail(error, epoch));
});
document.body.dataset.previewBooted = "true";
void loadDocument();
