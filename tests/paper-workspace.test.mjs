import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildOutline, createPaperWorkspace, searchBlocks, sha256 } from "../lib/paper-workspace.js";

function fixture() {
  return {
    paperHash: "a".repeat(64),
    metadata: { title: "A test paper", authors: ["Ada"] },
    parser: { modelVersion: "vlm", pageCount: 3 },
    blocks: [
      { id: "mineru_p1_b1", page: 1, type: "heading", level: 1, text: "Introduction" },
      { id: "mineru_p1_b2", page: 1, type: "paragraph", text: "Water stress affects crop yield.", translatedText: "水分胁迫影响作物产量。", bbox: [1, 2, 3, 4] },
      { id: "mineru_p2_b1", page: 2, type: "equation", text: "Growth model", latex: "y = ax", bbox: [2, 3, 4, 5] },
      { id: "mineru_p3_b1", page: 3, type: "chart", text: "Yield by treatment", assetRef: { cacheId: "b".repeat(24), path: "figure.png" } },
    ],
  };
}

let tempDir;
let workspace;
const hash = "a".repeat(64);

test.beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paper-workspace-test-"));
  workspace = createPaperWorkspace({ dataDir: tempDir });
});

test.afterEach(async () => {
  await workspace.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("paper metadata, block anchors, resources, search and outline persist", async () => {
  const paper = await workspace.upsertPaper(fixture());
  assert.equal(paper.paperHash, hash);
  assert.deepEqual(workspace.outline(hash), [{ id: "mineru_p1_b1", title: "Introduction", page: 1, level: 1 }]);
  assert.deepEqual(workspace.search(hash, "water"), [{ id: "mineru_p1_b2", page: 1, type: "paragraph", text: "Water stress affects crop yield.", translatedText: "水分胁迫影响作物产量。", matches: { original: true, translated: false }, bbox: [1, 2, 3, 4] }]);
  assert.equal(workspace.search(hash, "产量")[0].matches.translated, true);
  assert.equal(paper.resources.length, 2);
  assert.equal(paper.resources[0].type, "equation");
  assert.equal(sha256(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

  const reopened = createPaperWorkspace({ dataDir: tempDir });
  assert.equal(reopened.getPaper(hash).metadata.title, "A test paper");
  await reopened.close();
});

test("most recently updated paper can be restored after reopening the workspace", async () => {
  const olderHash = "b".repeat(64);
  await workspace.upsertPaper({ ...fixture(), paperHash: olderHash, metadata: { title: "Older paper" } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await workspace.upsertPaper(fixture());
  assert.equal(workspace.getRecentPaper().paperHash, hash);

  const reopened = createPaperWorkspace({ dataDir: tempDir });
  assert.equal(reopened.getRecentPaper().metadata.title, "A test paper");
  assert.equal(reopened.getRecentPaper().blocks.length, fixture().blocks.length);
  await reopened.close();
});

test("task center enforces states and records lifecycle timestamps", async () => {
  await workspace.upsertPaper(fixture());
  const task = await workspace.createTask({ paperHash: hash, id: "task-1" });
  assert.equal(task.state, "queued");
  const running = await workspace.updateTask(task.id, { state: "running", stage: "upload", progress: 15 });
  assert.ok(running.startedAt);
  const done = await workspace.updateTask(task.id, { state: "succeeded", stage: "complete", progress: 80 });
  assert.equal(done.progress, 100);
  assert.ok(done.finishedAt);
  await assert.rejects(() => workspace.updateTask(task.id, { state: "running" }), /transition/);
});

test("notes, bookmarks, progress and glossary CRUD are paper-scoped", async () => {
  await workspace.upsertPaper(fixture());
  const note = await workspace.putNote({ paperHash: hash, blockId: "mineru_p1_b2", note: "Check the field trial", tags: ["todo"] });
  const bookmark = await workspace.putBookmark({ paperHash: hash, blockId: "mineru_p2_b1", label: "Formula", page: 2 });
  assert.equal(note.blockId, "mineru_p1_b2");
  assert.equal(bookmark.page, 2);
  assert.equal(await workspace.deleteItem("notes", note.id), true);
  assert.equal(await workspace.deleteItem("notes", note.id), false);
  const progress = await workspace.setProgress({ paperHash: hash, page: 2, percent: 48 });
  assert.equal(progress.percent, 48);
  const glossary = await workspace.putGlossary({ paperHash: hash, terms: { "water stress": "水分胁迫" } });
  assert.equal(glossary.version, 1);
  await workspace.putGlossary({ paperHash: hash, terms: { yield: "产量" } });
  assert.equal(workspace.getGlossary(hash).version, 2);
  assert.equal(await workspace.deleteGlossaryTerm(hash, "yield"), true);
  assert.equal(workspace.getGlossary(hash).terms.yield, undefined);
  assert.equal(workspace.getProgress(hash).page, 2);
  assert.ok(workspace.snapshot(hash).bookmarks.some((item) => item.id === bookmark.id));
});

test("translation cache is keyed by paper, block and glossary version", async () => {
  await workspace.upsertPaper(fixture());
  await workspace.putTranslation({ paperHash: hash, blockId: "mineru_p1_b2", glossaryVersion: 1, source: "Water stress", translation: "水分胁迫" });
  assert.equal(workspace.getTranslation(hash, "mineru_p1_b2", 1).translation, "水分胁迫");
  assert.equal(workspace.getTranslation(hash, "mineru_p1_b2", 2), null);
});

test("snapshot is bounded and corrupted storage is recovered", async () => {
  await workspace.upsertPaper({ ...fixture(), blocks: Array.from({ length: 150 }, (_, i) => ({ id: `b${i}`, page: i + 1, type: "paragraph", text: `text ${i}` })) });
  const snapshot = workspace.snapshot(hash, { limit: 5 });
  assert.equal(snapshot.paper.blockIndex.length, 5);
  assert.equal(snapshot.paper.resources.length, 0);
  assert.equal("blocks" in snapshot.paper, true);
  assert.equal(snapshot.paper.blocks, undefined);
  await workspace.close();
  const filePath = path.join(tempDir, "paper-workspace.json");
  fs.writeFileSync(filePath, "{broken", "utf8");
  const recovered = createPaperWorkspace({ dataDir: tempDir });
  assert.deepEqual(recovered.load().papers, {});
  assert.ok(fs.readdirSync(tempDir).some((name) => name.startsWith("paper-workspace.json.corrupt-")));
  await recovered.close();
});

test("outline and search are pure bounded functions", () => {
  const blocks = Array.from({ length: 200 }, (_, i) => ({ id: `b${i}`, page: 1, type: "heading", level: 1, text: "same" }));
  assert.equal(buildOutline(blocks).length, 200);
  assert.equal(searchBlocks(blocks, "same", { limit: 3 }).length, 3);
  assert.deepEqual(searchBlocks(blocks, "", { limit: 3 }), []);
});
