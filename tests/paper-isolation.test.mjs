import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createPaperWorkspace } from "../lib/paper-workspace.js";

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hpr-isolation-test-"));
}

function samplePaper(hash, title = "Sample Paper") {
  return {
    paperHash: hash,
    metadata: { title, authors: ["Author"], year: 2026 },
    blocks: [
      { id: `block_1`, type: "text", page: 1, text: `Original text for ${title} page 1` },
      { id: `block_2`, type: "text", page: 2, text: `Original text for ${title} page 2` },
    ],
  };
}

test("paper isolation: note/bookmark/task mutations are bound to paperHash", async (t) => {
  const tmpDir = createTmpDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const ws = createPaperWorkspace({ dataDir: tmpDir });
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);

  await ws.upsertPaper(samplePaper(hashA, "Paper A"));
  await ws.upsertPaper(samplePaper(hashB, "Paper B"));

  // 1. Create notes and bookmarks in Paper A and B
  const noteA = await ws.putNote({
    paperHash: hashA,
    blockId: "block_1",
    note: "Note in A",
    noteType: "finding",
  });
  const noteB = await ws.putNote({
    paperHash: hashB,
    blockId: "block_1",
    note: "Note in B",
    noteType: "finding",
  });

  const taskA = await ws.createTask({
    paperHash: hashA,
    state: "queued",
    stage: "init",
  });
  const taskB = await ws.createTask({
    paperHash: hashB,
    state: "queued",
    stage: "init",
  });

  // HPR-001 Verification:
  // Cannot delete noteB by passing paperHash = hashA
  const deleteResultWrongPaper = await ws.deleteItem("notes", noteB.id, hashA);
  assert.equal(deleteResultWrongPaper, false, "deleting noteB with hashA should fail");
  assert.ok(ws.getItem("notes", noteB.id), "noteB should still exist");

  // Cannot delete note without providing paperHash (or mismatch)
  await assert.rejects(
    async () => ws.deleteItem("notes", noteB.id, null),
    /paperHash required|invalid paperHash/i,
    "deleteItem without paperHash should throw"
  );

  // Cannot update taskB with expectedPaperHash = hashA
  await assert.rejects(
    async () => ws.updateTask(taskB.id, { stage: "running" }, hashA),
    /paperHash mismatch|task not found/i,
    "updateTask with mismatched paperHash should throw"
  );
  assert.equal(ws.getTask(taskB.id).stage, "init", "taskB stage should be untouched");

  // Cannot overwrite noteB by creating note in Paper A with noteB.id
  await assert.rejects(
    async () => ws.putNote({
      id: noteB.id,
      paperHash: hashA,
      blockId: "block_1",
      note: "Malicious overwrite attempt",
    }),
    /conflict|id already exists/i,
    "putNote in paper A reusing noteB.id should fail"
  );
  assert.equal(ws.getItem("notes", noteB.id).note, "Note in B", "noteB content must not be overwritten");

  // Delete noteA with hashA succeeds
  const deleteResultCorrect = await ws.deleteItem("notes", noteA.id, hashA);
  assert.equal(deleteResultCorrect, true, "deleting noteA with hashA should succeed");
  assert.equal(ws.getItem("notes", noteA.id), null, "noteA should now be deleted");

  // Update taskA with correct paperHash succeeds
  const updatedTaskA = await ws.updateTask(taskA.id, { state: "running", stage: "processing" }, hashA);
  assert.equal(updatedTaskA.stage, "processing");
});
