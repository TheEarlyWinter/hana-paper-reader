import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  copyTextWithFallback,
  createResearchTools,
  csvText,
  downloadBlob,
  runConfirmedAction,
  visualActionLabels,
} from "../assets/research-tools.js";
import registerApiRoutes from "../routes/api.js";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
    delete(route, handler) { routes.set(`DELETE ${route}`, handler); },
  };
}

function requestContext(body = {}, query = {}) {
  return {
    req: {
      json: async () => body,
      query: (key) => query[key] ?? "",
      param: () => "",
    },
    json(value, status = 200) { return { value, status }; },
  };
}

test("cancelled library action never invokes the destructive operation", async () => {
  let calls = 0;
  const result = await runConfirmedAction({
    message: "delete fixture",
    title: "delete",
    confirmAction: async () => false,
    action: async () => { calls += 1; },
  });
  assert.equal(result, false);
  assert.equal(calls, 0);
});

test("confirmed library action invokes the operation exactly once", async () => {
  let calls = 0;
  const result = await runConfirmedAction({
    message: "delete fixture",
    title: "delete",
    confirmAction: async () => true,
    action: async () => { calls += 1; },
  });
  assert.equal(result, true);
  assert.equal(calls, 1);
});

test("downloadBlob reports a blocked click so callers can use another download path", () => {
  const document = {
    defaultView: { setTimeout: (_callback, _delay) => 0, URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} } },
    body: { appendChild() {} },
    createElement() { return { click() { throw new Error("blocked by WebView"); }, remove() {} }; },
  };
  assert.equal(downloadBlob(document, new Blob(["x"]), "fixture.csv"), false);
});

test("clipboard API rejection falls back to a selected textarea", async () => {
  let selected = false;
  let removed = false;
  let command = "";
  const textarea = {
    value: "",
    style: {},
    setAttribute() {},
    select() { selected = true; },
    remove() { removed = true; },
  };
  const document = {
    createElement(tag) {
      assert.equal(tag, "textarea");
      return textarea;
    },
    body: { appendChild(node) { assert.equal(node, textarea); } },
    execCommand(name) { command = name; return true; },
  };
  const copied = await copyTextWithFallback("fallback text", {
    document,
    clipboard: { writeText: async () => { throw new Error("NotAllowedError"); } },
  });
  assert.equal(copied, true);
  assert.equal(textarea.value, "fallback text");
  assert.equal(selected, true);
  assert.equal(removed, true);
  assert.equal(command, "copy");
});

test("CSV quoting protects quotes, commas, line breaks and formula cells", () => {
  assert.equal(
    csvText([["Name", "Note"], ["A, B", "say \"hi\"\nnext"], ["=SUM(A1)", "-cmd"]]),
    '"Name","Note"\r\n"A, B","say ""hi""\nnext"\r\n"\'=SUM(A1)","\'-cmd"',
  );
});

test("visual action labels expose LaTeX and CSV actions for structured blocks", () => {
  assert.ok(visualActionLabels({ type: "equation", latex: "E=mc^2" }).includes("复制 LaTeX"));
  assert.ok(visualActionLabels({ type: "table", tableHtml: "<table><tr><td>x</td></tr></table>" }).includes("导出 CSV"));
});

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...values) { values.forEach((value) => this.values.add(value)); }
  remove(...values) { values.forEach((value) => this.values.delete(value)); }
  toggle(value, force) {
    const next = force === undefined ? !this.values.has(value) : Boolean(force);
    if (next) this.values.add(value); else this.values.delete(value);
    return next;
  }
  contains(value) { return this.values.has(value); }
}

class FakeNode {
  constructor(document, tagName = "div") {
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.parentElement = null;
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.listeners = new Map();
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
  }
  get isConnected() { return Boolean(this.parentNode); }
  append(...items) { items.flat(Infinity).forEach((item) => { if (item && typeof item === "object") this.appendChild(item); }); }
  appendChild(item) { this.children.push(item); item.parentNode = this; item.parentElement = this; return item; }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_m, char) => char.toUpperCase())] = String(value);
  }
  remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  focus() {}
  select() {}
  contains(node) { return node === this || this.children.some((child) => child.contains?.(node)); }
}

class FakeDocument {
  constructor() {
    this.defaultView = { setTimeout, clearTimeout, Blob, navigator: {} };
    this.body = new FakeNode(this, "body");
    this.activeElement = null;
  }
  createElement(tagName) { return new FakeNode(this, tagName); }
  createDocumentFragment() { return new FakeNode(this, "fragment"); }
}

function walk(node) {
  return [node, ...node.children.flatMap((child) => walk(child))];
}

test("lab rendering puts a visible LaTeX copy button on an equation card", () => {
  const document = new FakeDocument();
  const root = document.createElement("main");
  const paperHash = "f".repeat(64);
  const tools = createResearchTools({
    root,
    document,
    apiFetch: async () => { throw new Error("not expected for a resource-free equation"); },
    getPaper: () => ({ paperHash, title: "Formula fixture", blocks: [{ id: "eq-1", type: "equation", page: 1, latex: "E=mc^2" }] }),
    toast: async () => ({ shown: true }),
  });
  tools.open("lab");
  const buttonLabels = walk(root).filter((node) => node.tagName === "BUTTON").map((node) => node.textContent);
  assert.ok(buttonLabels.includes("复制 LaTeX"));
  tools.destroy();
});

test("research-tools keeps delegated library deletion and resilient export paths", () => {
  const panel = read("assets/panel.js");
  const tools = read("assets/research-tools.js");
  assert.match(panel, /function handleLibraryDeleteClick\(/);
  assert.match(panel, /library-list-container[\s\S]*?addEventListener\("click"/);
  assert.match(panel, /actionConfirmModal[\s\S]*?document\.body\.appendChild/);
  assert.match(tools, /csv:\s*"\/api\/research\/csv"/);
  assert.match(tools, /startDownload\([\s\S]*?endpoints\.csv/);
  assert.match(tools, /copyTextWithFallback\(/);
});

test("CSV API returns an attachment and supports isolated direct save", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-csv-api-"));
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-csv-home-"));
  fs.mkdirSync(path.join(tempHome, "Downloads"), { recursive: true });
  const previousUserProfile = process.env.USERPROFILE;
  const previousHome = process.env.HOME;
  process.env.USERPROFILE = tempHome;
  process.env.HOME = tempHome;
  t.after(() => {
    if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });
  const app = makeApp();
  const ctx = {
    pluginId: "hana-paper-reader",
    dataDir,
    config: { get: () => "", setMany() {} },
    log: { error() {}, warn() {} },
    bus: { request: async () => { throw new Error("not called"); } },
    network: { fetch: async () => { throw new Error("not called"); } },
  };
  registerApiRoutes(app, ctx);
  const paperHash = "e".repeat(64);
  const paper = {
    paperHash,
    metadata: { title: "CSV Fixture" },
    blocks: [{ id: "table_1", type: "table", page: 1, text: "Table", tableHtml: "<table><tr><th>A</th><th>B</th></tr><tr><td>x,y</td><td>z</td></tr></table>" }],
  };
  await app.routes.get("POST /api/research/paper")(requestContext(paper));

  const response = app.routes.get("GET /api/research/csv")(requestContext({}, { paperHash, blockId: "table_1" }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /attachment/);
  assert.match(await response.text(), /A.*B/);
  const secondResponse = app.routes.get("GET /api/research/csv")(requestContext({}, { paperHash, blockId: "table_1" }));
  assert.match(await secondResponse.text(), /"x,y","z"/);

  const saved = await app.routes.get("POST /api/research/csv")(requestContext({ paperHash, blockId: "table_1", saveToDisk: true }));
  assert.equal(saved.value.ok, true);
  assert.equal(saved.value.saved, true);
  assert.ok(fs.existsSync(saved.value.filePath));
  assert.match(saved.value.fileName, /table_1\.csv$/);
});
