import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { sha256Hex, sha256HexFallback } from "../assets/sha256.js";

function expected(value) {
  return createHash("sha256").update(value).digest("hex");
}

const vectors = [
  "",
  "abc",
  "汉字与 academic text",
  "a".repeat(55),
  "a".repeat(56),
  "a".repeat(64),
  "a".repeat(65),
];

test("browser SHA-256 fallback matches standard boundary vectors", () => {
  for (const value of vectors) assert.equal(sha256HexFallback(value), expected(value), `vector length ${value.length}`);
});

test("browser SHA-256 accepts binary views and native/fallback paths agree", async () => {
  const bytes = new Uint8Array(Array.from({ length: 1025 }, (_, index) => index % 251));
  assert.equal(sha256HexFallback(bytes), expected(bytes));
  assert.equal(sha256HexFallback(bytes.subarray(7, 777)), expected(bytes.subarray(7, 777)));
  assert.equal(await sha256Hex(bytes), expected(bytes));
});
