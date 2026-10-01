import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPaperWorkspace } from "../server/domain/paper-workspace.js";

const PAPER_HASH = "f".repeat(64);

test("v2 workspace rejects an implicit process.cwd storage fallback", () => {
  assert.throws(() => createPaperWorkspace(), /absolute App data directory or file path/);
});

test("v2 workspace keeps corruption distinct from an empty workspace", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-reuse-corrupt-"));
  try {
    fs.writeFileSync(path.join(dataDir, "paper-workspace.json"), "{not-json", "utf8");
    const workspace = createPaperWorkspace({ dataDir });
    assert.throws(() => workspace.load(), (error) => error.code === "workspace_integrity_error");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("v2 workspace rejects a missing per-paper shard instead of skipping it", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-reuse-missing-"));
  const paperHash = "a".repeat(64);
  try {
    fs.mkdirSync(path.join(dataDir, "papers", paperHash), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "paper-workspace.json"), JSON.stringify({
      schemaVersion: 3,
      storageLayout: "per-paper-v1",
      papers: { [paperHash]: { paperHash } },
    }), "utf8");
    const workspace = createPaperWorkspace({ dataDir });
    assert.throws(() => workspace.load(), (error) => error.code === "workspace_integrity_error");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("vendored v1 workspace preserves anchored writes and per-paper persistence", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-reuse-"));
  try {
    const workspace = createPaperWorkspace({ dataDir });
    await workspace.upsertPaper({
      paperHash: PAPER_HASH,
      metadata: { title: "Reusable workspace fixture", authors: ["Tester"] },
      parser: { pageCount: 2 },
      blocks: [
        { id: "h1", page: 1, type: "heading", level: 1, text: "Introduction" },
        { id: "b1", page: 1, type: "paragraph", text: "Anchored evidence" },
      ],
    });

    const note = await workspace.putNote({ paperHash: PAPER_HASH, blockId: "b1", note: "Keep this finding", noteType: "finding" });
    const bookmark = await workspace.putBookmark({ paperHash: PAPER_HASH, blockId: "b1", label: "Important" });
    const progress = await workspace.setProgress({ paperHash: PAPER_HASH, percent: 42, page: 1, readingMode: "bilingual" });
    const glossary = await workspace.putGlossary({ paperHash: PAPER_HASH, terms: { evidence: "证据" } });
    const task = await workspace.createTask({ paperHash: PAPER_HASH, stage: "parse" });
    const runningTask = await workspace.updateTask(task.id, { state: "running", progress: 25 });

    assert.equal(note.validationStatus, "verified");
    assert.equal(note.evidence.blockId, "b1");
    assert.equal(bookmark.validationStatus, "verified");
    assert.equal(bookmark.evidence.blockId, "b1");
    assert.equal(progress.percent, 42);
    assert.equal(glossary.version, 1);
    assert.equal(runningTask.state, "running");
    assert.equal(workspace.listLibrary()[0].noteCount, 1);
    assert.equal(workspace.listLibrary()[0].bookmarkCount, 1);
    assert.equal(workspace.listItems("notes", PAPER_HASH).length, 1);
    assert.equal(workspace.listItems("bookmarks", PAPER_HASH).length, 1);
    assert.equal(workspace.getProgress(PAPER_HASH).percent, 42);
    assert.equal(workspace.getGlossary(PAPER_HASH).terms.evidence, "证据");
    assert.equal(workspace.listTasks(PAPER_HASH)[0].state, "running");
    await workspace.close();

    const reopened = createPaperWorkspace({ dataDir });
    assert.equal(reopened.getPaper(PAPER_HASH).metadata.title, "Reusable workspace fixture");
    assert.equal(reopened.getPaper(PAPER_HASH).blocks[1].evidenceId.startsWith("ev-"), true);
    assert.equal(reopened.getProgress(PAPER_HASH).percent, 42);
    assert.equal(reopened.listItems("notes", PAPER_HASH)[0].evidence.blockId, "b1");
    assert.equal(reopened.listTasks(PAPER_HASH)[0].state, "running");
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "paper-workspace.json"), "utf8")).storageLayout, "per-paper-v1");
    await reopened.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
