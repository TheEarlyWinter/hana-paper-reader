import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createPaperWorkspace } from "../lib/paper-workspace.js";

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hpr-qa-test-"));
}

function samplePaper(hash, title = "Sample Paper") {
  return {
    paperHash: hash,
    metadata: { title, authors: ["Author"], year: 2026 },
    blocks: [
      { id: "block_1", type: "text", page: 1, text: `Original text for ${title} page 1` },
      { id: "block_2", type: "text", page: 2, text: `Original text for ${title} page 2` },
    ],
  };
}

test("tombstone persistence across workspace restarts prevents resurrection", async (t) => {
  const tmpDir = createTmpDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const hash = "c".repeat(64);
  const ws1 = createPaperWorkspace({ dataDir: tmpDir });
  await ws1.upsertPaper(samplePaper(hash, "Paper to Delete"));
  assert.ok(ws1.getPaper(hash));

  // Remove paper
  const removed = await ws1.removePaper(hash);
  assert.equal(removed, true);
  assert.equal(ws1.getPaper(hash), null);

  // Re-create workspace (simulate process restart)
  const ws2 = createPaperWorkspace({ dataDir: tmpDir });
  assert.equal(ws2.getPaper(hash), null);

  // Delayed autosave with old snapshot must be rejected with 409 / tombstone
  await assert.rejects(
    async () => ws2.upsertPaper(samplePaper(hash, "Stale Resurrection Attempt"), { operation: "autosave" }),
    /deleted|tombstone/i
  );
  assert.equal(ws2.getPaper(hash), null);

  // Explicit re-import clears tombstone
  const imported = await ws2.upsertPaper(samplePaper(hash, "Fresh Import"), { operation: "import" });
  assert.ok(imported);
  assert.equal(ws2.getPaper(hash).metadata.title, "Fresh Import");
});

test("clearPaperData('structure-keep-notes') followed by re-import clears detached state", async (t) => {
  const tmpDir = createTmpDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const hash = "d".repeat(64);
  const ws = createPaperWorkspace({ dataDir: tmpDir });
  await ws.upsertPaper(samplePaper(hash, "Paper Structure Test"));

  // Detach structure
  await ws.clearPaperData(hash, "structure-keep-notes");
  const detached = ws.getPaper(hash);
  assert.equal(detached.structureDetached, true);
  assert.equal(detached.blocks.length, 0);

  // Re-importing complete paper clears detached state
  await ws.upsertPaper(samplePaper(hash, "Re-imported Paper"), { operation: "import" });
  const restored = ws.getPaper(hash);
  assert.equal(restored.structureDetached, false);
  assert.equal(restored.blocks.length, 2);
});

test("CAS revision conflict rejection", async (t) => {
  const tmpDir = createTmpDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const hash = "e".repeat(64);
  const ws = createPaperWorkspace({ dataDir: tmpDir });
  const initial = await ws.upsertPaper(samplePaper(hash, "CAS Test"));
  assert.equal(initial.revision, 1);

  // Client A updates with expectedRevision = 1 -> succeeds, rev becomes 2
  const updatedA = await ws.upsertPaper({ ...samplePaper(hash, "Update A"), revision: 1 }, { expectedRevision: 1 });
  assert.equal(updatedA.revision, 2);

  // Client B sends stale expectedRevision = 1 -> fails with 409
  await assert.rejects(
    async () => ws.upsertPaper({ ...samplePaper(hash, "Update B"), revision: 1 }, { expectedRevision: 1 }),
    /revision conflict/i
  );
  assert.equal(ws.getPaper(hash).metadata.title, "Update A");
});
