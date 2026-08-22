import assert from "node:assert/strict";
import test from "node:test";
import { generatePaperMarkdown } from "../lib/paper-export.js";

test("exports anchors, bilingual text, outline, and configured attachments", () => {
  const markdown = generatePaperMarkdown({
    metadata: {
      title: "A [Careful] Paper",
      authors: ["A. Author", "B. Author"],
      year: 2026,
      doi: "10.1000/example",
    },
    blocks: [
      { id: "intro", page: 2, type: "heading", level: 1, text: "1. Introduction" },
      { id: "p-1", page: 2, type: "paragraph", text: "Original *claim*" },
    ],
    translations: { "p-1": "中文译文" },
    options: { attachmentBasePath: "media/papers" },
  });

  assert.equal(markdown.split("\n", 1)[0], String.raw`# A \[Careful\] Paper`);
  assert.match(markdown, /<a id="paper-p2-b-intro"><\/a>/);
  assert.match(markdown, /<!-- page:2 block:p-1 -->/);
  assert.match(markdown, /- \[1\. Introduction\]\(#paper-p2-b-intro\)/);
  assert.ok(markdown.includes(["Original ", String.fromCharCode(92), "*claim", String.fromCharCode(92), "*"].join("")));
  assert.match(markdown, /> \*\*译文：\*\* 中文译文/);
});

test("exports visual blocks without executing user supplied HTML", () => {
  const markdown = generatePaperMarkdown({
    blocks: [
      { id: "fig", page: 3, type: "image", text: "Figure *caption*", assetPath: "images/figure 1.png" },
      { id: "tab", page: 3, type: "table", text: "Table 1", tableHtml: '<table><tr><td onclick="alert(1)">x</td></tr></table>' },
      { id: "eq", page: 4, type: "equation", latex: "E = mc^2", text: "" },
    ],
    assets: [{ blockId: "fig", path: "images/figure 1.png", alt: "Figure 1" }],
  });

  assert.match(markdown, /!\[Figure 1\]\(attachments\/images\/figure%201\.png\)/);
  assert.ok(markdown.includes("```html\n<table>"));
  assert.ok(markdown.includes('onclick="alert(1)"'));
  assert.ok(markdown.includes("</table>\n```"));
  assert.match(markdown, /\$\$\nE = mc\^2\n\$\$/);
  assert.doesNotMatch(markdown, /<table>[^`]*<\/table>\n\n(?:[^`]*\n)*<\/table>/);
});

test("exports notes, bookmarks, progress, and glossary references", () => {
  const markdown = generatePaperMarkdown({
    metadata: { title: "Notes" },
    blocks: [{ id: "b1", page: 5, type: "paragraph", text: "A paragraph" }],
    notes: [{ blockId: "b1", title: "My note", text: "Remember [this]" }],
    bookmarks: [{ blockId: "b1", label: "Important" }],
    progress: { page: 5, totalPages: 10, percent: 50, updatedAt: "2026-08-22" },
    glossary: [{ term: "attention", translation: "注意力", definition: "a mechanism" }],
  });

  assert.match(markdown, /阅读页：\*\* 5 \/ 10/);
  assert.match(markdown, /阅读进度：\*\* 50%/);
  assert.match(markdown, /### My note/);
  assert.ok(markdown.includes(String.raw`Remember \[this\]`));
  assert.match(markdown, /\[Page 5 · block b1\]\(#paper-p5-b-b1\)/);
  assert.match(markdown, /\*\*attention\*\*：注意力：a mechanism/);
});

test("escapes ordered-list-looking translated headings without moving the backslash", () => {
  const markdown = generatePaperMarkdown({
    blocks: [{ id: "section-2", page: 1, type: "heading", text: "2. Model Architecture" }],
    translations: { "section-2": "2. 模型架构" },
  });

  assert.match(markdown, /> \*\*译文：\*\* 2\\\. 模型架构/);
  assert.doesNotMatch(markdown, /> \*\*译文：\*\* \\2\. 模型架构/);
});

test("preserves inline and display LaTeX while escaping surrounding Markdown", () => {
  const source = String.raw`The input has $d_k$, *emphasis*, and $$\text{Attention}(Q,K,V)=\text{softmax}(QK^T/\sqrt{d_k})$$.`;
  const markdown = generatePaperMarkdown({
    blocks: [{ id: "math", page: 1, type: "paragraph", text: source }],
  });

  assert.ok(markdown.includes(String.raw`$d_k$`));
  assert.ok(markdown.includes(String.raw`$$\text{Attention}(Q,K,V)=\text{softmax}(QK^T/\sqrt{d_k})$$`));
  assert.ok(markdown.includes(String.raw`\*emphasis\*`));
  assert.doesNotMatch(markdown, /\$d\\_k\$/);
  assert.doesNotMatch(markdown, /\$\$\\\\text/);
});

test("empty input produces a valid minimal UTF-8 markdown document", () => {
  const markdown = generatePaperMarkdown();
  assert.equal(markdown, "# 未命名论文\n");
  assert.equal(Buffer.from(markdown, "utf8").toString("utf8"), markdown);
});
