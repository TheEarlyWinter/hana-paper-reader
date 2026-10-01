import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import * as boundaries from "../ui/assets/pdf-preview-core.js";

test("PDF.js CJK resources are bundled and configured for the preview", () => {
  const source = fs.readFileSync(new URL("../ui/assets/pdf-preview.js", import.meta.url), "utf8");
  const panel = fs.readFileSync(new URL("../ui/assets/panel.js", import.meta.url), "utf8");
  assert.match(source, /cMapUrl:\s*new URL\("\.\/cmaps\/", import\.meta\.url\)\.href/);
  assert.match(source, /cMapPacked:\s*true/);
  assert.match(source, /standardFontDataUrl:\s*new URL\("\.\/standard_fonts\/", import\.meta\.url\)\.href/);
  assert.match(panel, /cMapUrl:\s*new URL\("\.\/assets\/cmaps\/", document\.baseURI\)\.href/);
  assert.match(panel, /cMapPacked:\s*true/);
  assert.match(panel, /standardFontDataUrl:\s*new URL\("\.\/assets\/standard_fonts\/", document\.baseURI\)\.href/);
  for (const asset of [
    "../ui/assets/cmaps/UniGB-UCS2-H.bcmap",
    "../ui/assets/standard_fonts/LiberationSans-Regular.ttf",
    "../ui/assets/cmaps/LICENSE",
    "../ui/assets/standard_fonts/LICENSE_FOXIT",
    "../ui/assets/standard_fonts/LICENSE_LIBERATION",
  ]) {
    const path = new URL(asset, import.meta.url);
    assert.ok(fs.statSync(path).size > 0, `${asset} must be present and non-empty`);
  }
});

const context = {
  appId: "hana-paper-reader", capabilities: ["read"], generation: 1,
  documentId: "synthetic-document", viewId: "synthetic-view", providerId: "app:hana-paper-reader/pdf",
  version: { size: 100 }, resource: { name: "fixture.pdf" },
};

// Execute the actual view controller with in-memory DOM/host substitutes.
// No browser, native window, resource picker or installed App is opened.
class Element {
  constructor() {
    this.value = ""; this.textContent = ""; this.hidden = false;
    this.dataset = {}; this.style = { setProperty() {} }; this.options = [];
    this.clientWidth = 900; this.clientHeight = 700;
    this.listeners = new Map(); this.children = [];
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  dispatch(name) { return this.listeners.get(name)?.({ preventDefault() {}, target: this }); }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this[name] = value; }
  getContext() { return {}; }
  focus() {}
  select() {}
  matches() { return false; }
  close() { this.open = false; }
  showModal() { this.open = true; }
}

function view() {
  const nodes = new Map();
  const windowEvents = new Map();
  const documentEvents = new Map();
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) {
        const node = new Element(); node.firstElementChild = new Element(); nodes.set(id, node);
      }
      return nodes.get(id);
    },
    querySelectorAll() { return []; }, createElement() { return new Element(); },
    addEventListener(name, callback) { documentEvents.set(name, callback); },
    documentElement: new Element(), body: new Element(), visibilityState: "visible",
  };
  const hana = {
    document: { async getContext() { return context; }, async reportStatus() { return { ok: true }; }, onRequest() { return () => {}; } },
    surface: { getContext() { return { slot: "preview" }; }, onContextChanged() { return () => {}; } },
    theme: { getSnapshot() { return {}; }, subscribe() { return () => {}; } },
  };
  const sandbox = vm.createContext({
    ...boundaries, hana, document, HTMLElement: Element, AbortController,
    window: { devicePixelRatio: 1, addEventListener(name, callback) { windowEvents.set(name, callback); } },
    ResizeObserver: class { observe() {} disconnect() {} }, setTimeout, clearTimeout,
  });
  const source = fs.readFileSync(new URL("../ui/assets/pdf-preview.js", import.meta.url), "utf8")
    .replace(/import\s[\s\S]*?from\s+"[^"\n]+";\s*/g, "")
    .replaceAll("import.meta.url", JSON.stringify(new URL("../ui/assets/pdf-preview.js", import.meta.url).href))
    .replace(/document\.body\.dataset\.previewBooted = "true";\s*void loadDocument\(\);\s*$/, "");
  vm.runInContext(`${source}\nglobalThis.fixture = { state, elements, findText, cancelSearch, releaseDocument, shutdown, openDocument };`, sandbox);
  const fixture = sandbox.fixture;
  fixture.state.context = context;
  fixture.state.identity = boundaries.documentIdentity(context);
  fixture.state.page = 1;
  return { ...fixture, hana, windowEvents, documentEvents };
}

test("a person can keep the PDF picker open beyond the SDK default and then cancel", async () => {
  const fixture = view();
  fixture.hana.surface.getContext = () => ({ slot: "card" });
  let elapsed = 0;
  let deadline;
  let reply;
  let reject;
  fixture.hana.resources = {
    pick(_input, options) {
      deadline = options?.timeoutMs ?? 10000;
      return new Promise((resolve, fail) => { reply = resolve; reject = fail; });
    },
  };
  const operation = fixture.openDocument();
  elapsed += 12000;
  if (elapsed >= deadline) reject(Object.assign(new Error("Synthetic picker deadline"), { code: "TIMEOUT" }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.elements.openDocument.disabled, true, "selection remains pending after twelve seconds");
  reply({ resources: [] });
  await operation;
  assert.equal(fixture.elements.openDocument.disabled, false);
  assert.equal(fixture.elements.previewMessage.textContent, "已取消打开 PDF。");
});

async function until(predicate) {
  for (let i = 0; i < 40; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail("Synthetic asynchronous operation did not reach its checkpoint");
}

function pendingSearch(fixture) {
  let requested = false;
  let cancelled = 0;
  let cleaned = 0;
  const page = {
    streamTextContent() {
      requested = true;
      return new ReadableStream({ cancel() { cancelled++; } });
    },
    cleanup() { cleaned++; },
  };
  fixture.state.pdf = { numPages: 1, async getPage() { return page; }, async destroy() {} };
  fixture.elements.findQuery.value = "transformer";
  const operation = fixture.findText();
  return { operation, get requested() { return requested; }, get cancelled() { return cancelled; }, get cleaned() { return cleaned; } };
}

test("stopping PDF search cancels a pending text read without waiting for the worker", async () => {
  const fixture = view();
  const search = pendingSearch(fixture);
  await until(() => search.requested);
  fixture.elements.cancelFind.dispatch("click");
  assert.equal(search.cancelled, 1);
  await search.operation;
  assert.equal(fixture.state.searching, false);
  assert.deepEqual(Array.from(fixture.state.matches), []);
  assert.match(fixture.elements.findStatus.textContent, /已停止/);
  assert.equal(search.cleaned, 1);
});

test("releasing a PDF cancels its pending search and prevents old results from returning", async () => {
  const fixture = view();
  const search = pendingSearch(fixture);
  await until(() => search.requested);
  await fixture.releaseDocument();
  assert.equal(search.cancelled, 1);
  await search.operation;
  assert.equal(fixture.state.pdf, null);
  assert.equal(fixture.state.query, "");
  assert.equal(fixture.elements.findStatus.textContent, "");
  assert.deepEqual(Array.from(fixture.state.matches), []);
});

test("PDF search can restart while the previous worker read is still pending", async () => {
  const fixture = view();
  const oldSearch = pendingSearch(fixture);
  await until(() => oldSearch.requested);
  let requests = 0;
  const page = {
    streamTextContent() {
      requests++;
      return new ReadableStream({ start(controller) {
        controller.enqueue({ items: [{ str: "A different query" }] }); controller.close();
      } });
    }, cleanup() {},
  };
  fixture.state.pdf = { numPages: 1, async getPage() { return page; } };
  fixture.elements.findQuery.value = "no matching phrase";
  await fixture.findText();
  await oldSearch.operation;
  assert.equal(oldSearch.cancelled, 1);
  assert.equal(requests, 1);
  assert.equal(fixture.state.query, "no matching phrase");
  assert.match(fixture.elements.findStatus.textContent, /未找到/);
});

test("closing the preview cancels a pending search and retires its document", async () => {
  const fixture = view();
  const search = pendingSearch(fixture);
  await until(() => search.requested);
  fixture.windowEvents.get("pagehide")();
  await search.operation;
  assert.equal(search.cancelled, 1);
  assert.equal(fixture.state.closed, true);
  assert.equal(fixture.state.pdf, null);
});

test("text extraction stays bounded and reports partial results for overlong pages", async () => {
  let cancelled = 0;
  const page = {
    streamTextContent() {
      return new ReadableStream({
        start(controller) { controller.enqueue({ items: [{ str: "A".repeat(boundaries.MAX_SEARCH_PAGE_CHARS + 10) }] }); },
        cancel() { cancelled++; },
      });
    },
  };
  const result = await boundaries.readSearchPageText(page);
  assert.equal(result.text.length, boundaries.MAX_SEARCH_PAGE_CHARS);
  assert.equal(result.text, "a".repeat(boundaries.MAX_SEARCH_PAGE_CHARS));
  assert.equal(result.truncated, true);
  assert.equal(cancelled, 1);
});

test("cancellation does not wait for a worker acknowledgement and releases its reader", async () => {
  const controller = new AbortController();
  let cancellations = 0;
  let releases = 0;
  const reader = {
    read() { return new Promise(() => {}); },
    cancel() { cancellations++; return new Promise(() => {}); },
    releaseLock() { releases++; },
  };
  const operation = boundaries.readSearchPageText({ streamTextContent() { return { getReader() { return reader; } }; } }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(operation, error => error.code === "PDF_SEARCH_CANCELLED");
  assert.equal(cancellations, 1);
  assert.equal(releases, 1);
  await assert.rejects(boundaries.readSearchPageText({ streamTextContent() { assert.fail("Cancelled search must not read a page"); } }, { signal: controller.signal }), error => error.code === "PDF_SEARCH_CANCELLED");
});

test("host document identity requires a readable binding and changes with its generation", () => {
  const identity = boundaries.documentIdentity(context);
  assert.notEqual(boundaries.documentIdentity({ ...context, generation: 2 }), identity);
  for (const change of [{ appId: "another-app" }, { capabilities: [] }, { generation: -1 }, { viewId: "" }, { generation: 1.5 }]) {
    assert.throws(() => boundaries.documentIdentity({ ...context, ...change }), error => error.code === "DOCUMENT_UNAVAILABLE");
  }
});

test("PDF input refuses oversized declarations, invalid envelopes and non-PDF bytes", () => {
  assert.throws(() => boundaries.checkDeclaredSize({ version: { size: boundaries.MAX_PDF_BYTES + 1 } }), error => error.code === "PDF_TOO_LARGE");
  assert.throws(() => boundaries.decodePdfBytes({ encoding: "text", content: "%PDF-1.7" }), error => error.code === "DOCUMENT_RESPONSE_INVALID");
  for (const content of ["", "%%%?", "YWJj", "YQ==="]) {
    assert.throws(() => boundaries.decodePdfBytes({ encoding: "base64", content }));
  }
  const bytes = Buffer.from("short preamble\n%PDF-1.7\nsynthetic fixture");
  assert.deepEqual(Buffer.from(boundaries.decodePdfBytes({ encoding: "base64", content: bytes.toString("base64") })), bytes);
  assert.throws(() => boundaries.decodePdfBytes({ ok: false, error: { code: "permission_denied", message: "private fixture path" } }), error => error.code === "permission_denied" && !error.message.includes("private"));
});

test("canvas allocation stays inside pixel and side limits at large page sizes", () => {
  for (const [width, height, ratio] of [[612, 792, 2], [8000, 8000, 2], [100000, 10, 2], [10, 100000, 2], [100000, 100000, 1]]) {
    const scale = boundaries.canvasScale(width, height, ratio);
    const w = Math.max(1, Math.floor(width * scale));
    const h = Math.max(1, Math.floor(height * scale));
    assert.ok(w * h <= boundaries.MAX_CANVAS_PIXELS);
    assert.ok(w <= boundaries.MAX_CANVAS_SIDE && h <= boundaries.MAX_CANVAS_SIDE);
  }
  for (const width of [0, -1, Infinity, NaN, 100001]) assert.throws(() => boundaries.canvasScale(width, 100));
});

test("PDF errors and display names do not expose arbitrary paths or host messages", () => {
  assert.equal(boundaries.displayName({ resource: { name: "C:\\synthetic\\fixture.pdf" } }), "fixture.pdf");
  for (const code of ["permission_denied", "binding_stale", "ENOENT", "SDK_FAILURE", "InvalidPDFException"]) {
    const detail = boundaries.publicError({ code, message: "C:\\private\\token=synthetic-secret" });
    assert.doesNotMatch(JSON.stringify(detail), /private|token=|synthetic-secret/);
  }
});
