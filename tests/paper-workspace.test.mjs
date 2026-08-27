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
  const searchHit = workspace.search(hash, "water")[0];
  assert.equal(searchHit.id, "mineru_p1_b2");
  assert.equal(searchHit.matches.original, true);
  assert.equal(searchHit.evidence.evidenceId, searchHit.evidenceId);
  assert.equal(searchHit.evidence.validationStatus, "verified");
  assert.equal(searchHit.evidence.sectionTitle, "Introduction");
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
  assert.match(note.evidenceId, /^ev-[a-f0-9-]+$/);
  assert.equal(note.evidence.evidenceId, note.evidenceId);
  assert.equal(note.validationStatus, "verified");
  assert.equal(bookmark.page, 2);
  assert.equal(bookmark.evidence.blockType, "equation");
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

test("Evidence IDs stay stable and visual evidence resolves from either evidenceId or blockId", async () => {
  const first = await workspace.upsertPaper(fixture());
  const paragraph = workspace.getEvidence(hash, { blockId: "mineru_p1_b2" });
  const equation = workspace.getEvidence(hash, { blockId: "mineru_p2_b1" });
  assert.equal(paragraph.evidenceId, first.blocks[1].evidenceId);
  assert.equal(workspace.getEvidence(hash, { evidenceId: paragraph.evidenceId }).blockId, "mineru_p1_b2");
  assert.equal(equation.visualResource.type, "equation");
  assert.equal(equation.visualResource.latex, "y = ax");

  await workspace.upsertPaper({ ...fixture(), metadata: { title: "Updated title" } });
  assert.equal(workspace.getEvidence(hash, { blockId: "mineru_p1_b2" }).evidenceId, paragraph.evidenceId);
  assert.equal(workspace.listEvidence(hash).length, fixture().blocks.length);
});

test("schema 1 data migrates with a backup and Evidence relations", async () => {
  const filePath = path.join(tempDir, "paper-workspace.json");
  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-08-22T00:00:00.000Z",
    papers: { [hash]: fixture() },
    tasks: {},
    notes: {
      "legacy-note": {
        id: "legacy-note",
        paperHash: hash,
        blockId: "mineru_p1_b2",
        note: "Legacy note",
        createdAt: "2026-08-22T00:00:00.000Z",
        updatedAt: "2026-08-22T00:00:00.000Z"
      }
    },
    bookmarks: {},
    progress: {},
    glossaries: {},
    translationCache: {}
  }, null, 2), "utf8");

  const migrated = workspace.load();
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).storageLayout, "per-paper-v1");
  assert.ok(fs.existsSync(path.join(tempDir, "papers", hash, "paper.json")));
  assert.match(migrated.papers[hash].blocks[1].evidenceId, /^ev-/);
  assert.equal(workspace.getItem("notes", "legacy-note").validationStatus, "verified");
  assert.equal(workspace.getItem("notes", "legacy-note").evidence.originalQuote, "Water stress affects crop yield.");
  assert.ok(fs.readdirSync(tempDir).some((name) => name.startsWith("paper-workspace.json.schema-v1-") && name.endsWith(".backup")));
});

test("translation cache is keyed by paper, block, glossary version, agent and model", async () => {
  await workspace.upsertPaper(fixture());
  await workspace.putTranslation({ paperHash: hash, blockId: "mineru_p1_b2", glossaryVersion: 1, agentId: "hakimi", modelRef: "fixture/model-a", source: "Water stress", translation: "水分胁迫 A" });
  await workspace.putTranslation({ paperHash: hash, blockId: "mineru_p1_b2", glossaryVersion: 1, agentId: "hakimi", modelRef: "fixture/model-b", source: "Water stress", translation: "水分胁迫 B" });
  assert.equal(workspace.getTranslation(hash, "mineru_p1_b2", 1, { agentId: "hakimi", modelRef: "fixture/model-a" }).translation, "水分胁迫 A");
  assert.equal(workspace.getTranslation(hash, "mineru_p1_b2", 1, { agentId: "hakimi", modelRef: "fixture/model-b" }).translation, "水分胁迫 B");
  assert.equal(workspace.getTranslation(hash, "mineru_p1_b2", 1, { agentId: "other", modelRef: "fixture/model-a" }), null);
  assert.equal(workspace.getTranslation(hash, "mineru_p1_b2", 2, { agentId: "hakimi", modelRef: "fixture/model-a" }), null);

  // 旧版未带模型上下文的缓存仍可被旧调用方读取。
  await workspace.putTranslation({ paperHash: hash, blockId: "mineru_p1_b2", glossaryVersion: 3, source: "Water stress", translation: "旧版缓存" });
  assert.equal(workspace.getTranslation(hash, "mineru_p1_b2", 3).translation, "旧版缓存");
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

test("scoped search ranks explainably and filters language and block groups", async () => {
  const paper = fixture();
  paper.blocks.push(
    { id: "mineru_p2_b2", page: 2, type: "paragraph", text: "Water appears twice: water.", translatedText: "这里没有目标词。" },
    { id: "mineru_p2_b3", page: 2, type: "heading", level: 2, text: "Water methods" },
  );
  await workspace.upsertPaper(paper);
  const pageHits = workspace.search(hash, "water", { scope: "page", page: 2, language: "original", types: "title,body", currentBlockId: "mineru_p2_b2" });
  assert.equal(pageHits.length, 2);
  assert.equal(pageHits[0].id, "mineru_p2_b3", "title weight must be visible in deterministic ranking");
  assert.ok(pageHits[0].scoreExplanation.some((item) => item.includes("标题块")));
  assert.equal(workspace.search(hash, "产量", { language: "original" }).length, 0);
  assert.equal(workspace.search(hash, "产量", { language: "translation" })[0].matches.translated, true);
  assert.equal(workspace.search(hash, "Growth", { types: "equation" })[0].typeGroup, "equation");
});

test("typed notes retain Evidence snapshots and support filters", async () => {
  await workspace.upsertPaper(fixture());
  const finding = await workspace.putNote({ paperHash: hash, blockId: "mineru_p1_b2", noteType: "finding", note: "Yield finding", tags: ["yield"] });
  const question = await workspace.putNote({ paperHash: hash, blockId: "mineru_p1_b2", noteType: "question", note: "Why?", tags: ["todo"] });
  assert.equal(finding.quote, "Water stress affects crop yield.");
  assert.equal(finding.translation, "水分胁迫影响作物产量。");
  assert.equal(finding.evidenceSnapshot.evidenceId, finding.evidenceId);
  assert.deepEqual(workspace.listItems("notes", hash, 100, { noteType: "question" }).map((item) => item.id), [question.id]);
  assert.deepEqual(workspace.listItems("notes", hash, 100, { tag: "yield" }).map((item) => item.id), [finding.id]);
  assert.deepEqual(workspace.listItems("notes", hash, 100, { unresolvedOnly: true }).map((item) => item.id), [question.id]);
  const resolved = await workspace.putNote({ ...question, resolved: true });
  assert.equal(resolved.resolved, true);
  assert.equal(workspace.listItems("notes", hash, 100, { unresolvedOnly: true }).length, 0);
});

test("schema 3 writes each paper to an independent directory", async () => {
  await workspace.upsertPaper(fixture());
  await workspace.putNote({ paperHash: hash, blockId: "mineru_p1_b2", note: "Independent note" });
  await workspace.close();
  const index = JSON.parse(fs.readFileSync(path.join(tempDir, "paper-workspace.json"), "utf8"));
  assert.equal(index.storageLayout, "per-paper-v1");
  assert.equal(index.papers[hash].metadata.title, "A test paper");
  assert.equal("blocks" in index.papers[hash], false, "global index must not duplicate paper blocks");
  for (const name of ["paper.json", "research.json", "translations.json", "tasks.json"]) {
    assert.ok(fs.existsSync(path.join(tempDir, "papers", hash, name)), `missing per-paper ${name}`);
  }
  const reopened = createPaperWorkspace({ dataDir: tempDir });
  assert.equal(reopened.getPaper(hash).blocks.length, fixture().blocks.length);
  assert.equal(reopened.listItems("notes", hash)[0].note, "Independent note");
  await reopened.close();
});

test("independent workspace instances preserve glossary writes during stale paper sync", async () => {
  await workspace.upsertPaper(fixture());
  const stale = createPaperWorkspace({ dataDir: tempDir });
  stale.getPaper(hash); // Load a pre-glossary snapshot, as a hot-reloaded route can do.
  await workspace.putGlossary({ paperHash: hash, terms: { azobenzene: "偶氮苯" } });
  await stale.upsertPaper({ ...fixture(), metadata: { title: "Updated from stale instance" } });
  assert.equal(stale.getGlossary(hash).terms.azobenzene, "偶氮苯");
  const reopened = createPaperWorkspace({ dataDir: tempDir });
  assert.equal(reopened.getGlossary(hash).terms.azobenzene, "偶氮苯");
  assert.equal(reopened.getPaper(hash).metadata.title, "Updated from stale instance");
  await stale.close();
  await reopened.close();
});

test("concurrent glossary mutations from separate instances are serialized", async () => {
  await workspace.upsertPaper(fixture());
  const first = createPaperWorkspace({ dataDir: tempDir });
  const second = createPaperWorkspace({ dataDir: tempDir });
  await Promise.all([
    first.putGlossary({ paperHash: hash, terms: { alpha: "阿尔法" } }),
    second.putGlossary({ paperHash: hash, terms: { beta: "贝塔" } }),
  ]);
  const reopened = createPaperWorkspace({ dataDir: tempDir });
  assert.equal(reopened.getGlossary(hash).terms.alpha, "阿尔法");
  assert.equal(reopened.getGlossary(hash).terms.beta, "贝塔");
  assert.equal(reopened.getGlossary(hash).version, 2);
  await first.close();
  await second.close();
  await reopened.close();
});

test("data ownership actions preserve user finals and Evidence-bound notes", async () => {
  await workspace.upsertPaper({
    ...fixture(),
    translations: { mineru_p1_b2: "AI", mineru_p2_b1: "用户定稿" },
    translationStates: { mineru_p1_b2: { kind: "ai" }, mineru_p2_b1: { kind: "final", locked: true } },
  });
  await workspace.putTranslation({ paperHash: hash, blockId: "mineru_p1_b2", glossaryVersion: 0, source: "Water", translation: "AI" });
  const note = await workspace.putNote({ paperHash: hash, blockId: "mineru_p1_b2", noteType: "limitation", note: "Keep this" });
  const stats = workspace.storageStats(hash);
  assert.equal(stats.layout, "per-paper-v1");
  assert.equal(stats.counts.notes, 1);
  const cleared = await workspace.clearPaperData(hash, "ai-translations");
  assert.equal(cleared.paper.translations.mineru_p1_b2, undefined);
  assert.equal(cleared.paper.translations.mineru_p2_b1, "用户定稿");
  assert.equal(cleared.preservedFinals, 1);
  const detached = await workspace.clearPaperData(hash, "structure-keep-notes");
  assert.equal(detached.notesKept, 1);
  assert.equal(workspace.getPaper(hash).blocks.length, 0);
  const kept = workspace.getItem("notes", note.id);
  assert.equal(kept.validationStatus, "detached");
  assert.equal(kept.evidence.originalQuote, "Water stress affects crop yield.");
});

test("backup round-trip restores paper research and assets after full deletion", async () => {
  const cacheId = "d".repeat(24);
  const source = fixture();
  source.blocks[3].assetRef = { cacheId, path: "figures/plot.png" };
  fs.mkdirSync(path.join(tempDir, "mineru-cache", cacheId, "figures"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "mineru-cache", cacheId, "figures", "plot.png"), Buffer.from("png-bytes"));
  await workspace.upsertPaper(source);
  await workspace.putNote({ paperHash: hash, blockId: "mineru_p1_b2", noteType: "method", note: "Backup me" });
  const backup = workspace.exportBackup(hash);
  assert.equal(backup.assets.length, 1);
  assert.equal(await workspace.removePaper(hash), true);
  assert.equal(workspace.getPaper(hash), null);
  await workspace.restoreBackup(backup);
  assert.equal(workspace.getPaper(hash).metadata.title, "A test paper");
  assert.equal(workspace.listItems("notes", hash)[0].note, "Backup me");
  assert.equal(fs.readFileSync(path.join(tempDir, "mineru-cache", cacheId, "figures", "plot.png"), "utf8"), "png-bytes");
  await assert.rejects(() => workspace.restoreBackup({ ...backup, assets: [{ cacheId, path: "../escape", data: "eA==" }] }), /path/);
});

test("precise progress persists reading mode scroll positions drafts and search filters", async () => {
  await workspace.upsertPaper(fixture());
  await workspace.setProgress({
    paperHash: hash,
    blockId: "mineru_p1_b2",
    page: 1,
    percent: 21,
    readingMode: "contrast",
    originalScrollTop: 120,
    translationScrollTop: 340,
    contrastScrollTop: 560,
    noteDraft: { note: "unfinished", noteType: "question" },
    searchState: { query: "water", scope: "section", language: "both", types: ["body"] },
  });
  const progress = workspace.getProgress(hash);
  assert.equal(progress.readingMode, "contrast");
  assert.equal(progress.originalScrollTop, 120);
  assert.equal(progress.translationScrollTop, 340);
  assert.equal(progress.contrastScrollTop, 560);
  assert.equal(progress.noteDraft.note, "unfinished");
  assert.equal(progress.searchState.scope, "section");
});
