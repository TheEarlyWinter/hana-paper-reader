import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const source = read("assets/research-tools.js");
const css = read("assets/research-tools.css");

assert.match(source, /export function createResearchTools\s*\(/);
assert.match(source, /export default createResearchTools/);
for (const symbol of ["open", "close", "destroy", "refresh", "apiFetch", "getPaper", "getSelectedBlock", "onLocateBlock", "onPaperStateChanged", "toast"]) {
  assert.match(source, new RegExp(symbol));
}
for (const entry of ["全文搜索", "自动大纲", "笔记 \/ 书签 \/ 进度", "解析任务状态", "证据助手", "术语表 \/ 翻译缓存", "图表 \/ 公式 \/ 图片实验室", "双语 Markdown"]) {
  assert.match(source, new RegExp(entry));
}
for (const endpoint of ["notes", "bookmarks", "progress", "parse", "evidence", "glossary", "export"]) {
  assert.match(source, new RegExp(`\\b${endpoint}: \\"/api/research/`));
}
assert.match(source, /endpoints\[kind\]/);
for (const dangerous of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function("]) {
  assert.equal(source.includes(dangerous), false, `unsafe DOM or code string remains: ${dangerous}`);
}
assert.match(source, /textContent/);
assert.match(source, /createElement/);
assert.match(source, /JSON\.stringify/);
assert.match(source, /const submit = button[\s\S]*?submit\.type = "submit"/);
assert.match(source, /const save = button[\s\S]*?save\.type = "submit"/);
assert.match(source, /deleteAnchoredItem\("?notes"?|deleteAnchoredItem\(collection/);
assert.match(source, /method: "DELETE"/);
assert.match(source, /shell\.inert = !state\.open/);
assert.match(source, /shell\.contains\(doc\.activeElement\)/);
assert.match(css, /\.research-tools-drawer\s*\{/);
assert.match(css, /\.research-tools-drawer\.open/);
assert.match(css, /@media \(max-width: 760px\)/);
assert.match(css, /var\(--accent/);

const cssClasses = [
  "research-tools-drawer", "research-tools-header", "research-tools-heading", "research-tools-title",
  "research-tools-paper", "research-tools-close", "research-tools-nav", "research-tools-nav-button",
  "research-tools-body", "research-tools-empty", "research-tools-content", "research-tools-view",
  "research-tools-form", "research-tools-actions", "research-tools-input", "research-tools-select",
  "research-tools-textarea", "research-tools-context", "research-tools-muted", "research-tools-results",
  "research-tools-result", "research-tools-result-index", "research-tools-result-text", "research-tools-state-row", "research-tools-list",
  "research-tools-link", "research-tools-answer", "research-tools-button", "research-tools-button-primary",
];
for (const cls of cssClasses) {
  assert.ok(css.includes(cls), `missing CSS rule for .${cls}`);
}

assert.match(source, /shell\.remove\(\)/);
assert.match(source, /state\.destroyed = true/);
assert.doesNotMatch(source, /lastChild\.textContent/);

console.log("research tools static checks: ok");
console.log("DOM behavior tests not run: no browser DOM test dependency is installed in this repository.");
