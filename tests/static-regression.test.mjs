import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import registerApiRoutes from "../routes/api.js";
import registerPluginUiRoutes from "../routes/ui.js";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(root, relative));

const manifest = JSON.parse(read("manifest.json"));
const apiSource = read("routes/api.js");
const panelSource = read("assets/panel.js");
const cssSource = read("assets/panel.css");
const mineruSource = read("lib/mineru.js");
const readme = read("README.md");

assert.equal(manifest.version, "0.9.0");
assert.equal(manifest.contributes.configuration.properties.mineruApiToken.sensitive, true);
assert.equal(manifest.contributes.configuration.properties.mineruApiToken.scope, "global");
assert.ok(manifest.capabilities.includes("network.fetch"));
assert.ok(manifest.capabilities.includes("provider.read"));
assert.ok(manifest.network.allowedHosts.includes("mineru.net"));
assert.ok(manifest.network.allowedHosts.includes("mineru.oss-cn-shanghai.aliyuncs.com"));

assert.equal(exists("vendor/unpdf.mjs"), false);
assert.equal(exists("vendor/pdfjs.mjs"), false);
assert.equal(exists("scripts/parse_pdf.py"), false);
assert.equal(exists("assets/pdfjs.mjs"), true, "browser PDF.js preview must remain");
assert.equal(exists("licenses/PDFJS-APACHE-2.0.txt"), true);
assert.equal(exists("THIRD_PARTY_NOTICES.md"), true);
assert.equal(exists("LICENSE"), true);

for (const forbidden of ["parsePdfBuffer", "getPdfRuntime", "currentParser", "pdf-parser", "defaultParser"]) {
  assert.equal(apiSource.includes(forbidden) || panelSource.includes(forbidden), false, `obsolete symbol remains: ${forbidden}`);
}
assert.match(apiSource, /本地解析已移除/);
assert.match(panelSource, /MinerU 精准解析设置/);
assert.match(panelSource, /UI_VERSION = "0\.9\.0"/);
assert.match(panelSource, /UI_ASSET_CACHE_VERSION = "0\.9\.0-r1"/);
assert.match(panelSource, /function pluginApiUrl[\s\S]*?hana\.api\.url/);
assert.match(panelSource, /id="panel-notice"/);
assert.match(panelSource, /function showPanelNotice[\s\S]*?panelNoticeTimer/);
assert.match(panelSource, /hanaBridge\.toast\.show/);
assert.doesNotMatch(panelSource, /const hana =/);
for (const mode of ["original", "bilingual", "translation", "contrast"]) assert.match(panelSource, new RegExp(`data-reading-mode=\\"${mode}\\"`));
assert.match(panelSource, /逐段上下对照/);
assert.match(panelSource, /renderContrastPair/);
assert.match(panelSource, /showVisual:\s*false/);
assert.match(panelSource, /translationStates/);
assert.match(panelSource, /用户定稿/);
assert.match(panelSource, /AI 译文/);
assert.match(panelSource, /X-Hana-Paper-Reader-UI-Version/);
assert.match(panelSource, /选择对话…/);
assert.match(panelSource, /新建对话并发送/);
assert.doesNotMatch(panelSource, /发送到主聊天/);
assert.match(apiSource, /session_target_required/);
assert.match(apiSource, /session:create/);
assert.match(apiSource, /send-to-session/);
assert.match(panelSource, /parser=mineru/);
assert.match(panelSource, /"Content-Type": "application\/pdf"/);
assert.match(panelSource, /body: file/);
assert.match(panelSource, /restoreRecentPaper\(\)/);
assert.match(panelSource, /pluginApiFetch\("\/api\/research\/recent"\)/);
assert.match(panelSource, /paperRefIsCurrent\(revision, paperRef\)|paperContextIsCurrent\(hash, revision, paperRef\)/);
assert.match(panelSource, /重新选择同一 PDF 可恢复原页预览/);
assert.doesNotMatch(panelSource, /readAsDataURL|fileToBase64/);
assert.match(apiSource, /PLUGIN_API_VERSION = "0\.9\.0"/);
assert.match(apiSource, /paper-export\.js\?hpr=0\.9\.0-r1/);
assert.match(apiSource, /paper-workspace\.js\?hpr=0\.9\.0-r1/);
assert.match(apiSource, /provider:models-by-type/);
assert.match(apiSource, /app\.get\("\/api\/models"/);
assert.match(panelSource, /modelRef: selectedModelRefForAgent/);
assert.match(panelSource, /loadAgentsAndModels/);
assert.match(panelSource, /agent-default/);
assert.match(panelSource, /path\.includes\(agentDropdown\)/, "clicking inside the Agent/model dropdown must not close it");
assert.match(panelSource, /selectorWrap = document\.querySelector\("\.agent-selector-wrap"\)/, "outside-click handling must identify the selector wrapper");
assert.equal(exists("lib/paper-evidence.js"), true);
assert.match(apiSource, /GET \/api\/research\/evidence|"\/api\/research\/evidence"/);
assert.match(apiSource, /stream\.getReader\(\)/);
assert.match(apiSource, /decodeLegacyPdfBase64/);
assert.doesNotMatch(apiSource, /\^\[A-Za-z0-9\+\/=\\s\]\+\$/);
assert.match(cssSource, /@media \(max-width: 1180px\)/);
assert.match(cssSource, /@media \(max-width: 760px\)/);
assert.match(cssSource, /\.reader-container\[data-reading-mode="bilingual"\]\s*\{\s*flex-direction:\s*column;/s);
assert.match(cssSource, /\.reading-mode-button\.active/);
assert.match(cssSource, /\.translation-state-badge\.final/);
assert.match(cssSource, /\.settings-modal\.open\s*\{\s*display:\s*grid;/s);
assert.match(mineruSource, /files:\s*\[\{[\s\S]*?is_ocr:/);
assert.match(mineruSource, /model_version:\s*options\.modelVersion/);
assert.match(mineruSource, /enable_formula:\s*options\.enableFormula/);
assert.match(mineruSource, /enable_table:\s*options\.enableTable/);
assert.match(mineruSource, /language:\s*options\.language/);
assert.doesNotMatch(mineruSource, /file-urls\/batch\?/);
assert.match(mineruSource, /shouldRetryWithOcr/);
assert.match(mineruSource, /ocrFallback/);
assert.match(read("routes/ui.js"), /ASSET_CACHE_VERSION = "0\.9\.0-r1"/);

const uiRoutes = new Map();
registerPluginUiRoutes({ get(route, handler) { uiRoutes.set(route, handler); } }, { pluginId: "hana-paper-reader" });
const renderUi = (url) => uiRoutes.get("/card")({
  req: {
    url,
    query(name) { return new URL(url).searchParams.get(name) || ""; },
  },
  html(value) { return value; },
});
const sessionAssetHtml = renderUi("https://hana.test/card?hana-asset-base=%2Fapi%2Fplugins%2Fhana-paper-reader%2Fassets%3FpluginSurfaceSession%3Dfixture-session");
assert.match(sessionAssetHtml, /api\/plugins\/hana-paper-reader\/assets\/panel\.js\?pluginSurfaceSession=fixture-session&amp;hpr-version=0\.9\.0-r1/);
const externalAssetHtml = renderUi("https://hana.test/card?hana-asset-base=https%3A%2F%2Fevil.test%2Fassets");
assert.match(externalAssetHtml, /api\/plugins\/hana-paper-reader\/assets\/panel\.js\?hpr-version=0\.9\.0-r1/);
assert.doesNotMatch(externalAssetHtml, /evil\.test/);
assert.match(readme, /^# Hana Paper Reader/m);
assert.match(readme, /MIT License/);
assert.match(readme, /application\/pdf/);
assert.doesNotMatch(readme, /本地 · 默认|两种解析路线|默认本地解析/);

const routes = new Map();
const app = {
  get(route, handler) { routes.set(`GET ${route}`, handler); },
  post(route, handler) { routes.set(`POST ${route}`, handler); },
};
const replacementToken = `replacement_${"y".repeat(32)}`;
const configState = {
  mineruApiToken: `fixture_${"x".repeat(32)}`,
  mineruModelVersion: "vlm",
  mineruLanguage: "ch",
  mineruEnableFormula: true,
  mineruEnableTable: true,
  mineruOcr: false,
  mineruTimeoutSeconds: 900,
  mineruPollIntervalSeconds: 5,
};
const ctx = {
  pluginId: "hana-paper-reader",
  dataDir: path.join(root, ".tmp-route-test"),
  config: {
    get(key) { return configState[key]; },
    setMany(patch, options) {
      assert.deepEqual(options, { scope: "global" });
      Object.assign(configState, patch);
    },
  },
  log: { error() {} },
  bus: {},
  network: {
    async fetch() {
      throw new Error(`binary-route-network-sentinel ${configState.mineruApiToken}`);
    },
  },
};
registerApiRoutes(app, ctx);

function jsonContext(body = {}, query = {}) {
  return {
    req: {
      json: async () => body,
      query: (key) => query[key],
    },
    json(value, status = 200) {
      return { value, status };
    },
    get() { return null; },
  };
}

function binaryContext(bytes, query = {}, headers = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
  if (!normalizedHeaders.has("content-type")) normalizedHeaders.set("content-type", "application/pdf");
  const stream = new Response(bytes).body;
  return {
    req: {
      query: (key) => query[key],
      header: (key) => normalizedHeaders.get(String(key).toLowerCase()) || "",
      raw: { body: stream },
    },
    json(value, status = 200) {
      return { value, status };
    },
    get() { return null; },
  };
}

const getSettings = routes.get("GET /api/mineru-settings");
const saveSettings = routes.get("POST /api/mineru-settings");
const parsePdf = routes.get("POST /api/parse-pdf");
assert.equal(typeof getSettings, "function");
assert.equal(typeof saveSettings, "function");
assert.equal(typeof parsePdf, "function");
assert.equal(typeof routes.get("GET /api/session-targets"), "function");
assert.equal(typeof routes.get("GET /api/models"), "function");
assert.equal(typeof routes.get("POST /api/send-to-session"), "function");
assert.equal(typeof routes.get("POST /api/create-session-and-send"), "function");

const publicSettings = getSettings(jsonContext()).value;
assert.equal(publicSettings.configured, true);
assert.equal(publicSettings.apiVersion, "0.9.0");
assert.equal("token" in publicSettings, false);
assert.equal("mineruApiToken" in publicSettings, false);
assert.equal(JSON.stringify(publicSettings).includes(configState.mineruApiToken), false);

const saved = await saveSettings(jsonContext({
  token: replacementToken,
  modelVersion: "pipeline",
  language: "en",
  enableFormula: false,
  enableTable: true,
  ocr: true,
  timeoutSeconds: 600,
  pollIntervalSeconds: 4,
}));
assert.equal(saved.status, 200);
assert.equal(saved.value.configured, true);
assert.equal("token" in saved.value, false);
assert.equal(configState.mineruApiToken, replacementToken);
assert.equal(configState.mineruModelVersion, "pipeline");

const invalid = await saveSettings(jsonContext({ modelVersion: "invalid" }));
assert.equal(invalid.status, 400);
assert.match(invalid.value.error, /vlm|pipeline/);

const rejectedLocal = await parsePdf(binaryContext(
  Buffer.from("%PDF-1.4\n%%EOF\n"),
  { parser: "local", fileName: "legacy.pdf" },
));
assert.equal(rejectedLocal.status, 400);
assert.equal(rejectedLocal.value.parser, "mineru");
assert.match(rejectedLocal.value.error, /本地解析已移除/);

const legacyJsonUpload = await parsePdf(binaryContext(
  Buffer.from('{"base64":"JVBERi0=","fileName":"legacy-json.pdf","parser":"mineru"}'),
  { parser: "mineru" },
  { "content-type": "application/json" },
));
assert.equal(legacyJsonUpload.status, 502);
assert.match(legacyJsonUpload.value.error, /binary-route-network-sentinel/);
assert.doesNotMatch(legacyJsonUpload.value.error, /call stack|RegExp/i);

const legacyPdf = Buffer.alloc(9 * 1024 * 1024, 0x20);
legacyPdf.write("%PDF-1.7\n", 0, "ascii");
legacyPdf.write("\n%%EOF\n", legacyPdf.length - 8, "ascii");
const legacyLargeBody = Buffer.from(JSON.stringify({
  base64: legacyPdf.toString("base64"),
  fileName: "legacy-large.pdf",
  parser: "mineru",
}));
const acceptedLargeLegacy = await parsePdf(binaryContext(
  legacyLargeBody,
  { parser: "mineru" },
  { "content-type": "application/json", "content-length": String(legacyLargeBody.length) },
));
assert.equal(acceptedLargeLegacy.status, 502);
assert.match(acceptedLargeLegacy.value.error, /binary-route-network-sentinel/);
assert.doesNotMatch(acceptedLargeLegacy.value.error, /call stack|RegExp/i);

const rejectedOversize = await parsePdf(binaryContext(
  Buffer.alloc(0),
  { parser: "mineru", fileName: "oversize.pdf" },
  { "content-type": "application/pdf", "content-length": String(50 * 1024 * 1024 + 1) },
));
assert.equal(rejectedOversize.status, 413);
assert.match(rejectedOversize.value.error, /50 MB/);

const largePdf = Buffer.alloc(20 * 1024 * 1024, 0x20);
largePdf.write("%PDF-1.7\n", 0, "ascii");
largePdf.write("\n%%EOF\n", largePdf.length - 8, "ascii");
const acceptedLargeBinary = await parsePdf(binaryContext(
  largePdf,
  { parser: "mineru", fileName: "large-binary.pdf" },
  { "content-type": "application/pdf", "content-length": String(largePdf.length) },
));
assert.equal(acceptedLargeBinary.status, 502);
assert.match(acceptedLargeBinary.value.error, /binary-route-network-sentinel/);
assert.match(acceptedLargeBinary.value.error, /\[REDACTED\]/);
assert.equal(acceptedLargeBinary.value.error.includes(configState.mineruApiToken), false);
assert.doesNotMatch(acceptedLargeBinary.value.error, /call stack|RegExp/i);

fs.rmSync(ctx.dataDir, { recursive: true, force: true });
console.log("static and route regression: ok");
