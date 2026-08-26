const ASSET_VERSION = "0.7.1-r1";

export default function registerPluginUiRoutes(app, ctx) {
  app.get("/card", (c) => c.html(renderShell(c, ctx, "card")));
  app.get("/page", (c) => c.html(renderShell(c, ctx, "page")));
}

function renderShell(c, ctx, surface) {
  const rawHanaCss = c.req.query("hana-css") || "";
  const hanaCss = sameOriginStylesheet(rawHanaCss, c.req.url);
  const theme = c.req.query("hana-theme") || "inherit";
  const assetBase = c.req.query("hana-asset-base") || `/api/plugins/${encodeURIComponent(ctx.pluginId)}/assets`;
  const panelCssUrl = pluginAssetUrl(assetBase, "panel.css");
  const panelJsUrl = pluginAssetUrl(assetBase, "panel.js");
  const researchToolsCssUrl = pluginAssetUrl(assetBase, "research-tools.css");
  const researchToolsJsUrl = pluginAssetUrl(assetBase, "research-tools.js");
  const sha256JsUrl = pluginAssetUrl(assetBase, "sha256.js");
  const pdfJsUrl = pluginAssetUrl(assetBase, "pdfjs.mjs");
  const title = "Hana Paper Reader";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  ${hanaCss ? `<link rel="stylesheet" href="${escapeAttr(hanaCss)}">` : ""}
  <link rel="stylesheet" href="${escapeAttr(panelCssUrl)}">
  <link rel="stylesheet" href="${escapeAttr(researchToolsCssUrl)}">
</head>
<body data-hana-theme="${escapeAttr(theme)}" data-surface="${surface}" data-pdfjs-url="${escapeAttr(pdfJsUrl)}" data-research-tools-url="${escapeAttr(researchToolsJsUrl)}" data-sha256-url="${escapeAttr(sha256JsUrl)}">
  <div id="root" data-surface="${surface}">
    <div style="min-height:100vh;display:grid;place-items:center;padding:24px;color:#537d96;background:#f8f5ed;font:14px/1.6 system-ui,sans-serif;text-align:center">
      正在加载 Hana Paper Reader…<br><small style="color:#7a7369">若此提示持续显示，说明前端资源未成功加载。</small>
    </div>
  </div>
  <script type="module" src="${escapeAttr(panelJsUrl)}"></script>
</body>
</html>`;
}

function sameOriginStylesheet(value, requestUrl) {
  if (!value) return "";
  try {
    const stylesheet = new URL(value, requestUrl);
    const request = new URL(requestUrl);
    return stylesheet.origin === request.origin && (stylesheet.protocol === "http:" || stylesheet.protocol === "https:")
      ? stylesheet.toString()
      : "";
  } catch {
    return "";
  }
}

function pluginAssetUrl(assetBase, assetPath) {
  const rawBase = String(assetBase || "");
  const encodedPath = String(assetPath)
    .split("/")
    .map(segment => encodeURIComponent(segment))
    .join("/");
  try {
    const parsed = new URL(rawBase, "http://hana.local");
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/${encodedPath}`;
    parsed.searchParams.set("hpr-version", ASSET_VERSION);
    if (/^https?:\/\//i.test(rawBase)) return parsed.toString();
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    const fallbackBase = rawBase.replace(/\/+$/, "");
    return `${fallbackBase}/${encodedPath}`;
  }
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function escapeHtml(value) {
  return escapeAttr(value).replace(/>/g, "&gt;");
}
