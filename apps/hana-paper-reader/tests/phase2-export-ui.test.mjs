import assert from "node:assert/strict";
import test from "node:test";

import { startDownload } from "../ui/assets/research-tools.js";

function makeDocument() {
  const state = { clicks: 0, appended: 0, removed: 0 };
  return {
    state,
    baseURI: "https://hana.local/reader.html",
    defaultView: { setTimeout(callback) { callback(); } },
    body: {
      appendChild() { state.appended += 1; },
    },
    createElement() {
      return {
        style: {},
        click() { state.clicks += 1; },
        remove() { state.removed += 1; },
      };
    },
  };
}

test("export UI reports a server-confirmed App save even when reveal fails", async () => {
  const document = makeDocument();
  const opened = [];
  const result = await startDownload(
    document,
    "/api/research/export",
    { paperHash: "a".repeat(64) },
    () => "https://hana.local/api/research/export",
    async (input) => {
      opened.push(input);
      if (input.mode === "reveal") throw new Error("reveal unavailable");
    },
    async (_path, init) => {
      assert.equal(init.body.includes('"saveToDisk":true'), true);
      return { ok: true, saved: true, paperHash: "a".repeat(64), sourceRevision: 1, sourceGeneration: 1,
        filePath: "C:\\App\\data\\exports\\paper.md", fileName: "paper.md", size: 100, sha256: "c".repeat(64) };
    },
  );
  assert.equal(result.method, "direct");
  assert.equal(result.fileName, "paper.md");
  assert.equal(opened.length, 1);
  assert.equal(document.state.clicks, 0);
});

test("without a direct API an explicit host refusal permits a native download attempt", async () => {
  const document = makeDocument();
  const result = await startDownload(
      document,
      "/api/research/export",
      { paperHash: "b".repeat(64) },
      () => "https://hana.local/api/research/export",
      async () => ({ opened: false }),
      undefined,
    );
  assert.equal(result.method, "native");
  assert.equal(document.state.clicks, 1);
  assert.equal(document.state.appended, 1);
  assert.equal(document.state.removed, 1);
});
