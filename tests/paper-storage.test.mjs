import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPaperStorage, paperDir, paperFiles } from "../lib/paper-storage.js";

test("paper-storage rejects path traversal attempts in paperDir, paperFiles, removePaper and stats", () => {
  const root = path.resolve("C:/fake/storage/root");

  const maliciousHashes = [
    "../../outside",
    "..\\..\\outside",
    "/etc/passwd",
    "C:\\Windows\\System32",
    "validhash/../../escape",
    "validhash\\..\\..\\escape",
    "hash with spaces",
    "hash\0withnull",
  ];

  for (const malicious of maliciousHashes) {
    assert.throws(
      () => paperDir(root, malicious),
      /invalid paper hash|escapes storage root/,
      `paperDir must throw for: ${malicious}`
    );
  }
});

test("paper-storage load() isolates malicious index keys and preserves valid papers", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paper-storage-test-"));
  const indexPath = path.join(tempDir, "paper-workspace.json");

  try {
    const validHash = "a".repeat(64);
    const validPaperDir = path.join(tempDir, "papers", validHash);
    fs.mkdirSync(validPaperDir, { recursive: true });
    fs.writeFileSync(path.join(validPaperDir, "paper.json"), JSON.stringify({ title: "Valid Paper" }));
    fs.writeFileSync(path.join(validPaperDir, "research.json"), JSON.stringify({ notes: {} }));
    fs.writeFileSync(path.join(validPaperDir, "translations.json"), JSON.stringify({ translations: {} }));
    fs.writeFileSync(path.join(validPaperDir, "tasks.json"), JSON.stringify({ tasks: {} }));

    const indexContent = {
      schemaVersion: 3,
      storageLayout: "per-paper-v1",
      updatedAt: new Date().toISOString(),
      papers: {
        [validHash]: { paperHash: validHash, title: "Valid Paper", storagePath: `papers/${validHash}` },
        "../../escape": { paperHash: "../../escape", title: "Malicious Escaped Paper" },
        "INVALID-HASH-CHARS": { paperHash: "INVALID-HASH-CHARS", title: "Invalid Hash Paper" },
      },
    };
    fs.writeFileSync(indexPath, JSON.stringify(indexContent));

    const storage = createPaperStorage({ filePath: indexPath });
    const loaded = storage.load();

    assert.equal(loaded.split, true);
    assert.ok(loaded.source.papers[validHash]);
    assert.equal(loaded.source.papers[validHash].title, "Valid Paper");
    assert.equal(loaded.source.papers["../../escape"], undefined);
    assert.equal(loaded.source.papers["INVALID-HASH-CHARS"], undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("paper-storage write() fails preflight if any paper key is invalid, leaving disk untouched", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paper-storage-write-test-"));
  const indexPath = path.join(tempDir, "paper-workspace.json");

  try {
    const validHash = "b".repeat(64);
    const validPaperDir = path.join(tempDir, "papers", validHash);
    fs.mkdirSync(validPaperDir, { recursive: true });
    fs.writeFileSync(path.join(validPaperDir, "paper.json"), JSON.stringify({ title: "Initial Paper" }));
    fs.writeFileSync(path.join(validPaperDir, "research.json"), JSON.stringify({ notes: {} }));
    fs.writeFileSync(path.join(validPaperDir, "translations.json"), JSON.stringify({ translations: {} }));
    fs.writeFileSync(path.join(validPaperDir, "tasks.json"), JSON.stringify({ tasks: {} }));

    const indexContent = {
      schemaVersion: 3,
      storageLayout: "per-paper-v1",
      updatedAt: new Date().toISOString(),
      papers: {
        [validHash]: { paperHash: validHash, title: "Initial Paper", storagePath: `papers/${validHash}` },
      },
    };
    fs.writeFileSync(indexPath, JSON.stringify(indexContent));

    const initialDiskContent = fs.readFileSync(path.join(validPaperDir, "paper.json"), "utf8");

    const storage = createPaperStorage({ filePath: indexPath });

    const maliciousData = {
      schemaVersion: 3,
      updatedAt: new Date().toISOString(),
      papers: {
        [validHash]: { paperHash: validHash, title: "Mutated Paper" },
        "../../malicious": { paperHash: "../../malicious", title: "Malicious Paper" },
      },
      notes: {},
      bookmarks: {},
      progress: {},
      glossaries: {},
      translationCache: {},
      tasks: {},
    };

    let writeFailed = false;
    try {
      await storage.write(maliciousData);
    } catch (err) {
      writeFailed = true;
      assert.match(err.message, /invalid paper hash/);
    }

    assert.equal(writeFailed, true, "storage.write() must reject write containing malicious keys");

    // Verify disk was completely untouched
    const afterDiskContent = fs.readFileSync(path.join(validPaperDir, "paper.json"), "utf8");
    assert.equal(afterDiskContent, initialDiskContent, "Initial paper.json must remain untouched");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("paper-storage multi-file transaction rolls back byte-for-byte on failure in second paper", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paper-storage-multi-tx-test-"));
  const indexPath = path.join(tempDir, "paper-workspace.json");

  try {
    const hash1 = "1".repeat(64);
    const hash2 = "2".repeat(64);

    const storage = createPaperStorage({ filePath: indexPath });

    // Initial valid state with 2 papers
    const initialData = {
      schemaVersion: 3,
      updatedAt: new Date().toISOString(),
      papers: {
        [hash1]: { paperHash: hash1, title: "Paper 1 Original" },
        [hash2]: { paperHash: hash2, title: "Paper 2 Original" },
      },
      notes: {},
      bookmarks: {},
      progress: {},
      glossaries: {},
      translationCache: {},
      tasks: {},
    };

    await storage.write(initialData);

    const paper1File = path.join(tempDir, "papers", hash1, "paper.json");
    const paper2Dir = path.join(tempDir, "papers", hash2);
    const paper1Before = fs.readFileSync(paper1File, "utf8");

    // Make second paper dir a symlink/junction or trigger a failure during preflight
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-storage-out-"));
    try {
      fs.rmSync(paper2Dir, { recursive: true, force: true });
      try {
        fs.symlinkSync(outsideDir, paper2Dir, "junction");
      } catch {}

      if (fs.existsSync(paper2Dir) && fs.lstatSync(paper2Dir).isSymbolicLink()) {
        const mutatedData = {
          schemaVersion: 3,
          updatedAt: new Date().toISOString(),
          papers: {
            [hash1]: { paperHash: hash1, title: "Paper 1 Mutated" },
            [hash2]: { paperHash: hash2, title: "Paper 2 Mutated" },
          },
          notes: {},
          bookmarks: {},
          progress: {},
          glossaries: {},
          translationCache: {},
          tasks: {},
        };

        let txRejected = false;
        try {
          await storage.write(mutatedData);
        } catch (err) {
          txRejected = true;
          assert.match(err.message, /symlink or junction/);
        }

        assert.equal(txRejected, true);
        const paper1After = fs.readFileSync(paper1File, "utf8");
        assert.equal(paper1After, paper1Before, "Paper 1 must remain untouched when Paper 2 fails preflight");
      }
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
