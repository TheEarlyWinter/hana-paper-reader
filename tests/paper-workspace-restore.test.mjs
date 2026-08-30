import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPaperWorkspace } from "../lib/paper-workspace.js";
import { assertCacheId, isReservedKey, safeId } from "../lib/paper-identity.js";

function makePaper(hash, title, cacheId = "a".repeat(24)) {
  return {
    paperHash: hash,
    metadata: { title, authors: ["Author"], tags: ["test"] },
    parser: { kind: "mineru", pageCount: 1 },
    blocks: [
      {
        id: "b1",
        page: 1,
        type: "image",
        text: "Figure 1",
        assetRef: { cacheId: cacheId.toUpperCase(), path: "figures/fig1.png" },
      },
    ],
  };
}

test("restoreBackup transactional rollback on asset failure restores previous state byte-for-byte", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-tx-restore-test-"));
  const workspace = createPaperWorkspace({ filePath: path.join(tempDir, "paper-workspace.json") });

  try {
    const hash = "a".repeat(64);
    const initialPaper = makePaper(hash, "Original Paper");
    await workspace.upsertPaper(initialPaper);
    await workspace.putNote({
      paperHash: hash,
      id: "note-1",
      note: "Original Note",
      blockId: "b1",
    });

    const beforeState = workspace.load();
    const beforeDiskContent = fs.readFileSync(workspace.filePath, "utf8");

    // Create a backup with corrupted asset data that will fail during staging/write
    const candidateBackup = {
      format: "hana-paper-reader-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      paperHash: hash,
      paper: makePaper(hash, "Mutated Paper"),
      notes: [
        {
          id: "note-mutated",
          paperHash: hash,
          note: "Mutated Note",
          blockId: "b1",
        },
      ],
      bookmarks: [],
      progress: null,
      glossary: null,
      translationCache: [],
      tasks: [],
      assets: [
        {
          cacheId: "c".repeat(24),
          path: "figures/valid.png",
          data: Buffer.from("valid png image").toString("base64"),
        },
      ],
    };

    // Inject failure during asset staging
    let rejected = false;
    try {
      await workspace.restoreBackup(candidateBackup, {
        beforeAssetWrite: (index) => {
          if (index === 0) {
            throw new Error("Simulated disk write failure during asset restore");
          }
        },
      });
    } catch (err) {
      rejected = true;
      assert.match(err.message, /恢复失败，原有数据未改变/);
    }

    assert.equal(rejected, true, "Restore with failed asset write must reject");

    // Verify in-memory state is rolled back
    const afterState = workspace.load();
    assert.equal(afterState.papers[hash].metadata.title, "Original Paper");
    assert.equal(afterState.notes["note-1"].note, "Original Note");
    assert.equal(afterState.notes["note-mutated"], undefined);

    // Verify disk content is byte-for-byte identical
    const afterDiskContent = fs.readFileSync(workspace.filePath, "utf8");
    assert.equal(afterDiskContent, beforeDiskContent, "Disk content must be byte-for-byte identical after rollback");

    // Verify transaction directory is cleaned up
    const txRoot = path.join(tempDir, ".transactions");
    if (fs.existsSync(txRoot)) {
      const remainingTx = fs.readdirSync(txRoot);
      assert.equal(remainingTx.length, 0, "All transaction staging folders must be deleted on rollback");
    }
  } finally {
    await workspace.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("restoreBackup rejects symlink/junction in cache root or target paths", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-junc-restore-test-"));
  const workspace = createPaperWorkspace({ filePath: path.join(tempDir, "paper-workspace.json") });
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-outside-"));

  try {
    const hash = "e".repeat(64);
    const cacheId = "b".repeat(24);
    const cacheDir = path.join(tempDir, "mineru-cache", cacheId);
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });

    // Create a junction inside mineru-cache pointing outside
    try {
      fs.symlinkSync(outsideDir, cacheDir, "junction");
    } catch {
      // If junction creation is not supported in current environment, skip junction creation
    }

    const candidateBackup = {
      format: "hana-paper-reader-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      paperHash: hash,
      paper: makePaper(hash, "Junction Test", cacheId),
      notes: [],
      bookmarks: [],
      progress: null,
      glossary: null,
      translationCache: [],
      tasks: [],
      assets: [
        {
          cacheId,
          path: "figures/outside.png",
          data: Buffer.from("outside content").toString("base64"),
        },
      ],
    };

    if (fs.existsSync(cacheDir) && fs.lstatSync(cacheDir).isSymbolicLink()) {
      let rejected = false;
      try {
        await workspace.restoreBackup(candidateBackup);
      } catch (err) {
        rejected = true;
        assert.match(err.message, /symlink or junction/i);
      }
      assert.equal(rejected, true, "Restore through junction must be rejected");
      assert.equal(fs.existsSync(path.join(outsideDir, "figures", "outside.png")), false);
    }
  } finally {
    await workspace.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("restoreBackup normalizes uppercase cacheId and preserves assets through cleanup", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-cacheid-test-"));
  const workspace = createPaperWorkspace({ filePath: path.join(tempDir, "paper-workspace.json") });

  try {
    const hash = "f".repeat(64);
    const upperCacheId = "A1B2C3D4E5F6A1B2C3D4E5F6";
    const lowerCacheId = upperCacheId.toLowerCase();

    const candidateBackup = {
      format: "hana-paper-reader-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      paperHash: hash,
      paper: makePaper(hash, "Uppercase CacheId Paper", upperCacheId),
      notes: [],
      bookmarks: [],
      progress: null,
      glossary: null,
      translationCache: [],
      tasks: [],
      assets: [
        {
          cacheId: upperCacheId,
          path: "figures/fig1.png",
          data: Buffer.from("test image bytes").toString("base64"),
        },
      ],
    };

    await workspace.restoreBackup(candidateBackup);

    const restoredPaper = workspace.getPaper(hash);
    assert.equal(restoredPaper.blocks[0].assetRef.cacheId, lowerCacheId);

    // Verify cache file exists on disk in lowercase directory
    const assetFile = path.join(tempDir, "mineru-cache", lowerCacheId, "figures", "fig1.png");
    assert.equal(fs.existsSync(assetFile), true, "Asset file must remain on disk after cleanup");
    assert.equal(fs.readFileSync(assetFile, "utf8"), "test image bytes");
  } finally {
    await workspace.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("safeId rejects prototype pollution reserved keys", () => {
  for (const key of ["__proto__", "constructor", "prototype", "toString", "valueOf"]) {
    assert.equal(isReservedKey(key), true);
    assert.throws(() => safeId(key), /reserved JavaScript object key/);
  }
});
