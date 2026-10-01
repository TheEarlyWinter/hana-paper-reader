// Prepared for the deferred regression phase. No live host or external service.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { createPaperWorkspace } from "../server/domain/paper-workspace.js";
import { createSessionDelivery } from "../server/domain/session-delivery.js";

const HASH = "a".repeat(64);
const OWNER = "synthetic-owner";
const PERMISSIONS = ["app/sessions.read", "app/sessions.manage", "app/session.start-turn"];
const digest = value => createHash("sha256").update(value).digest("hex");
const rejectsWith = (code, status) => error => error.code === code && error.status === status;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-session-regression-"));
  const sent = [];
  const runtime = {
    dataDir,
    capabilities: { async get() { return { capabilities: PERMISSIONS.map(capability => ({ capability, status: "always" })) }; } },
    sessions: {
      async list() { return { sessions: [{ sessionId: "session-fixture", lifecycle: "active", title: "Fixture", modified: 1700000000000 }] }; },
      async send(input) { sent.push(input); return { accepted: true, sessionId: input.sessionId }; },
    },
  };
  const workspace = createPaperWorkspace({ dataDir });
  await workspace.upsertPaper({ paperHash: HASH, metadata: { title: "Synthetic evidence" },
    blocks: [{ id: "b1", page: 2, type: "paragraph", text: "Backend source evidence" }] });
  const service = createSessionDelivery(runtime);
  const rows = await service.list(OWNER);
  const body = { requestId: randomUUID(), targetId: rows[0].targetId, paperHash: HASH, blockId: "b1", quote: "Selected evidence" };
  const receiptPath = path.join(dataDir, "session-delivery", `${digest(OWNER)}-${body.requestId}.json`);
  return { runtime, service, body, receiptPath, sent, dataDir,
    close() {
      const resolved = path.resolve(dataDir);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith("hpr-session-regression-"));
      fs.rmSync(resolved, { recursive: true, force: true });
    },
  };
}

test("concurrent identical requests send once; different content cannot reuse an in-flight ID", async () => {
  const f = await fixture();
  const gate = deferred();
  const originalGet = f.runtime.capabilities.get;
  f.runtime.capabilities.get = async () => { await gate.promise; return originalGet(); };
  const first = f.service.deliver(OWNER, f.body);
  const duplicate = f.service.deliver(OWNER, { ...f.body });
  try {
    await assert.rejects(f.service.deliver(OWNER, { ...f.body, quote: "Different evidence" }), rejectsWith("session_request_conflict", 409));
    assert.equal((await f.service.status(OWNER, f.body.requestId)).state, "pending");
    assert.equal(f.sent.length, 0);
    gate.resolve();
    const results = await Promise.all([first, duplicate]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].scope, "all");
    assert.match(f.sent[0].text, /Page 2 \/ block b1/);
    assert.match(f.sent[0].text, /Backend source evidence/);
    assert.equal(f.sent[0].deliverAs, "followUp");
  } finally {
    gate.resolve();
    await Promise.allSettled([first, duplicate]);
    f.close();
  }
});

test("accepted receipts survive a service restart without another host send", async () => {
  const f = await fixture();
  try {
    const result = await f.service.deliver(OWNER, f.body);
    const restarted = createSessionDelivery(f.runtime);
    assert.deepEqual(await restarted.deliver(OWNER, f.body), result);
    assert.equal(f.sent.length, 1);
    assert.equal((await restarted.status(OWNER, f.body.requestId)).state, "accepted");
    const persisted = fs.readFileSync(f.receiptPath, "utf8");
    assert.doesNotMatch(persisted, /Selected evidence|Backend source evidence/);
  } finally { f.close(); }
});

test("an ambiguous host send stays uncertain after restart and never automatically retries", async () => {
  const f = await fixture();
  try {
    f.runtime.sessions.send = async input => { f.sent.push(input); throw new Error("synthetic transport timeout"); };
    await assert.rejects(f.service.deliver(OWNER, f.body), rejectsWith("session_delivery_uncertain", 409));
    const restarted = createSessionDelivery(f.runtime);
    assert.equal((await restarted.status(OWNER, f.body.requestId)).state, "uncertain");
    await assert.rejects(restarted.deliver(OWNER, f.body), rejectsWith("session_delivery_uncertain", 409));
    assert.equal(f.sent.length, 1);
  } finally { f.close(); }
});

for (const [label, record] of [
  ["null", null], ["array", []],
  ["malformed accepted", { state: "accepted", fingerprint: "0".repeat(64), result: { accepted: false } }],
]) {
  test(`a present ${label} receipt blocks delivery instead of being treated as absent`, async () => {
    const f = await fixture();
    try {
      fs.mkdirSync(path.dirname(f.receiptPath), { recursive: true });
      fs.writeFileSync(f.receiptPath, JSON.stringify(record));
      await assert.rejects(f.service.deliver(OWNER, f.body), rejectsWith("session_receipt_unavailable", 503));
      await assert.rejects(f.service.status(OWNER, f.body.requestId), rejectsWith("session_receipt_unavailable", 503));
      assert.equal(f.sent.length, 0);
    } finally { f.close(); }
  });
}

test("failure to persist the initial intent prevents any host mutation", async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.dataDir, "session-delivery"), "synthetic file blocking directory creation");
    await assert.rejects(f.service.deliver(OWNER, f.body), rejectsWith("session_delivery_not_started", 503));
    assert.equal(f.sent.length, 0);
  } finally { f.close(); }
});

test("a chooser ticket cannot be used by another principal", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.deliver("another-owner", f.body), rejectsWith("session_target_expired", 409));
    assert.equal(f.sent.length, 0);
    assert.equal(fs.existsSync(path.join(f.dataDir, "session-delivery")), false);
  } finally { f.close(); }
});

test("numeric modification times order the chooser; duplicate and inactive sessions are excluded", async () => {
  const f = await fixture();
  try {
    f.runtime.sessions.list = async () => ({ sessions: [
      { sessionId: "older", title: "Older", lifecycle: "active", modified: 1700000000000, path: "private/session/path" },
      { sessionId: "newer", title: "Newer", lifecycle: "active", modified: 1700000001000 },
      { sessionId: "newer", title: "Duplicate", lifecycle: "active", modified: 1700000002000 },
      { sessionId: "archived", title: "Archived", lifecycle: "archived", modified: 1700000003000 },
      { sessionId: null, title: "Missing identity", lifecycle: "active", modified: 1700000004000 },
    ] });
    const rows = await f.service.list(OWNER);
    assert.deepEqual(rows.map(row => row.title), ["Newer", "Older"]);
    assert.equal(rows[0].modified, new Date(1700000001000).toISOString());
    assert.doesNotMatch(JSON.stringify(rows), /private\/session\/path|sessionId/);
  } finally { f.close(); }
});
