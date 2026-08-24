import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(import.meta.dirname, "fixtures", "regression");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

test("fixed PDF regression fixture manifest is complete and immutable", () => {
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.samples.map((sample) => sample.kind).sort(), [
    "chinese", "english-two-column", "figure-table-dense", "formula-dense", "scanned-image-only",
  ]);
  assert.equal(manifest.samples.filter((sample) => sample.requiresOcr).length, 1);
  for (const sample of manifest.samples) {
    const filePath = path.join(root, sample.file);
    assert.ok(fs.existsSync(filePath), `missing ${sample.file}`);
    const bytes = fs.readFileSync(filePath);
    assert.equal(bytes.subarray(0, 5).toString("ascii"), "%PDF-", `${sample.file} is not a PDF`);
    assert.ok(bytes.length > 10_000 && bytes.length < 2_000_000, `${sample.file} fixture size is unreasonable`);
    assert.equal(sha256(bytes), sample.sha256, `${sample.file} fixture hash changed unexpectedly`);
    assert.ok(sample.expectedText.length >= 4);
  }
  assert.equal(manifest.ocrFallbackProtocolTest, "tests/mineru-protocol.test.mjs");
});

test("fixture directory contains no user paper or obvious credential material", () => {
  const names = fs.readdirSync(root).map((name) => name.toLowerCase());
  assert.equal(names.some((name) => name.includes("main(2)") || name.includes("main-2")), false);
  const manifestText = JSON.stringify(manifest);
  for (const pattern of [/bearer\s+[a-z0-9._-]{16,}/i, /sk-[a-z0-9]{16,}/i, /mineruapitoken/i]) {
    assert.doesNotMatch(manifestText, pattern);
  }
});
