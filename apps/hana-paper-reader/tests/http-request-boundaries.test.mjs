import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readBoundedRequestText } from "../server/http/request-body.js";
import registerMigrationRoutes from "../server/http/migration-routes.js";
import registerSessionRoutes from "../server/http/session-routes.js";

function streamRequest(chunks, header) {
  let pulls = 0;
  let cancellations = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulls++;
      if (chunks.length) controller.enqueue(chunks.shift()); else controller.close();
    }, cancel() { cancellations++; },
  }, { highWaterMark: 0 });
  const raw = new Request("https://synthetic.invalid/api", { method: "POST", body, duplex: "half" });
  return { raw, header() { return header; }, async text() { assert.fail("Streaming body must not be buffered through text()"); },
    get pulls() { return pulls; }, get cancellations() { return cancellations; } };
}

test("a chunked body is cancelled at its byte limit even without a correct declared size", async () => {
  for (const header of [undefined, "1"]) {
    const request = streamRequest(Array.from({ length: 100 }, () => Buffer.alloc(16, 120)), header);
    await assert.rejects(readBoundedRequestText(request, 20), error => error.status === 413);
    assert.equal(request.pulls, 2);
    assert.equal(request.cancellations, 1);
  }
});

test("an oversized declared body is rejected before reading its stream", async () => {
  const request = streamRequest([Buffer.alloc(10)], "100");
  await assert.rejects(readBoundedRequestText(request, 20), error => error.status === 413);
  assert.equal(request.pulls, 0);
});

test("UTF-8 characters split between chunks survive without counting characters as bytes", async () => {
  const text = '{"text":"证据"}';
  const bytes = Buffer.from(text);
  const request = streamRequest(Array.from(bytes, byte => Uint8Array.of(byte)));
  assert.equal(await readBoundedRequestText(request, bytes.length), text);
  await assert.rejects(readBoundedRequestText(streamRequest([bytes]), text.length), error => error.status === 413);
});

test("malformed or incomplete UTF-8 is rejected rather than silently substituted", async () => {
  for (const bytes of [Uint8Array.of(0xff), Uint8Array.of(0xe8, 0xaf)]) {
    await assert.rejects(readBoundedRequestText(streamRequest([bytes]), 20), error => error.code === "request_body_invalid");
  }
});

test("an aborted request cancels a pending body read and releases its reader", async () => {
  const controller = new AbortController();
  let cancellations = 0;
  let releases = 0;
  const reader = { read() { return new Promise(() => {}); }, cancel() { cancellations++; return new Promise(() => {}); }, releaseLock() { releases++; } };
  const request = { raw: { signal: controller.signal, body: { getReader() { return reader; } } } };
  const operation = readBoundedRequestText(request, 20);
  controller.abort();
  await assert.rejects(operation, error => error.code === "request_body_invalid");
  assert.equal(cancellations, 1); assert.equal(releases, 1);
});

test("nonstreaming adapters still enforce a UTF-8 byte limit", async () => {
  assert.equal(await readBoundedRequestText({ async text() { return "证据"; } }, 6), "证据");
  await assert.rejects(readBoundedRequestText({ async text() { return "证据"; } }, 5), error => error.status === 413);
});

function routesFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-http-boundaries-"));
  const routes = new Map();
  const app = Object.fromEntries(["get", "post"].map(method => [method, (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler)]));
  registerMigrationRoutes(app, { dataDir: root });
  registerSessionRoutes(app, { dataDir: root });
  return { root, routes, close() {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("hpr-http-boundaries-"));
    fs.rmSync(root, { recursive: true, force: true });
  } };
}

test("malformed migration principals are rejected before any body read or plan write", async () => {
  const f = routesFixture();
  try {
    for (const principal of [undefined, {}, { id: 42 }, { id: {} }, { principalId: [] }, { id: " " }]) {
      let reads = 0;
      const result = await f.routes.get("POST /api/migration/prepare")({
        get() { return { principal }; }, header() {},
        req: { async text() { reads++; return JSON.stringify({ format: "hana-paper-reader-migration", version: 1,
          sensitiveConfigPolicy: "manual-reentry", sourceFingerprint: "a".repeat(64), papers: [] }); } },
        json(value, status = 200) { return { value, status }; },
      });
      assert.equal(result.status, 403); assert.equal(reads, 0);
    }
    assert.equal(fs.existsSync(path.join(f.root, "migration")), false);
  } finally { f.close(); }
});

function context(request, principal = { id: "synthetic-http-owner" }) {
  return { req: request, get() { return { principal }; }, header() {},
    json(value, status = 200) { return { value, status }; } };
}

test("the migration route accepts a valid streamed file and rejects invalid text before preparing", async () => {
  const f = routesFixture();
  try {
    const handler = f.routes.get("POST /api/migration/prepare");
    const invalid = await handler(context(streamRequest([Uint8Array.of(0xff)])));
    assert.equal(invalid.status, 400); assert.equal(invalid.value.error.code, "migration_invalid");
    assert.equal(fs.existsSync(path.join(f.root, "migration")), false);
    const input = { format: "hana-paper-reader-migration", version: 1, sensitiveConfigPolicy: "manual-reentry", sourceFingerprint: "a".repeat(64), papers: [] };
    const prepared = await handler(context(streamRequest([Buffer.from(JSON.stringify(input))])));
    assert.equal(prepared.status, 200); assert.equal(prepared.value.plan.state, "prepared");
  } finally { f.close(); }
});

test("session send routes enforce their actual stream limit before host delivery", async () => {
  const f = routesFixture();
  try {
    for (const route of ["POST /api/send-to-session", "POST /api/create-session-and-send"]) {
      const request = streamRequest(Array.from({ length: 10 }, () => Buffer.alloc(64 * 1024, 120)));
      const result = await f.routes.get(route)(context(request));
      assert.equal(result.status, 413); assert.equal(result.value.error.code, "session_quote_invalid");
      assert.equal(request.pulls, 3); assert.equal(request.cancellations, 1);
      const invalid = await f.routes.get(route)(context(streamRequest([Uint8Array.of(0xff)])));
      assert.equal(invalid.status, 400); assert.equal(invalid.value.error.code, "session_quote_invalid");
    }
    assert.equal(fs.existsSync(path.join(f.root, "session-delivery")), false);
  } finally { f.close(); }
});
