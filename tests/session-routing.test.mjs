import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import registerApiRoutes from "../routes/api.js";

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
  };
}

function requestContext(body = {}) {
  return {
    req: { json: async () => body, query: () => "" },
    json(value, status = 200) { return { value, status }; },
    get() { return null; },
  };
}

function sessionRecord(overrides = {}) {
  return {
    sessionId: "session-existing-1",
    path: "C:\\hana\\agents\\hakimi\\sessions\\existing.jsonl",
    title: "已有研究对话",
    firstMessage: "讨论论文方法",
    agentId: "hakimi",
    agentName: "哈基米",
    modified: "2026-08-22T12:00:00.000Z",
    messageCount: 4,
    visibility: "public",
    ...overrides,
  };
}

test("paper reader sends only to an explicit selected session and never creates one implicitly", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paper-reader-session-routing-"));
  const app = makeApp();
  const calls = [];
  const sent = [];
  let created = 0;
  const ctx = {
    pluginId: "hana-paper-reader",
    dataDir: tempDir,
    config: { get: () => "", setMany() {} },
    log: { error() {}, warn() {} },
    bus: {
      async request(type, payload) {
        calls.push({ type, payload });
        if (type === "session:list") return { sessions: [sessionRecord()] };
        if (type === "session:get") return { session: sessionRecord() };
        if (type === "session:send") {
          sent.push(payload);
          return { accepted: true };
        }
        if (type === "agent:profile") return { profile: { name: "哈基米", models: { chat: "fixture-model" } } };
        if (type === "session:create") {
          created += 1;
          return {
            sessionId: `session-created-${created}`,
            sessionRef: { sessionId: `session-created-${created}` },
            thinkingLevel: "max",
          };
        }
        throw new Error(`unexpected bus call: ${type}`);
      },
    },
    network: { fetch: async () => { throw new Error("network must not run"); } },
  };

  try {
    registerApiRoutes(app, ctx);
    const listTargets = app.routes.get("GET /api/session-targets");
    const sendToSession = app.routes.get("POST /api/send-to-session");
    const createAndSend = app.routes.get("POST /api/create-session-and-send");
    assert.equal(typeof listTargets, "function");
    assert.equal(typeof sendToSession, "function");
    assert.equal(typeof createAndSend, "function");

    const missingTarget = await sendToSession(requestContext({
      quote: "A quoted sentence",
      paperTitle: "Fixture paper",
    }));
    assert.equal(missingTarget.status, 400);
    assert.equal(missingTarget.value.code, "session_target_required");
    assert.equal(created, 0, "missing target must never create a session");
    assert.equal(sent.length, 0, "missing target must never send a message");

    const listed = await listTargets(requestContext());
    assert.equal(listed.status, 200);
    assert.equal(listed.value.ok, true);
    assert.equal(listed.value.sessions.length, 1);
    const target = listed.value.sessions[0];
    assert.match(target.targetId, /^st_/);
    assert.equal("sessionId" in target, false, "UI receives an opaque target id, not the host session id");
    assert.equal("path" in target, false, "UI never receives a host session path");

    const sentResponse = await sendToSession(requestContext({
      targetId: target.targetId,
      quote: "A quoted sentence",
      paperTitle: "Fixture paper",
      context: "The surrounding paragraph",
    }));
    assert.equal(sentResponse.status, 200);
    assert.equal(sentResponse.value.ok, true);
    assert.equal(sentResponse.value.message, "已发送到所选对话");
    assert.equal(created, 0, "selected existing target must not create a session");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].sessionId, "session-existing-1");
    assert.equal(sent[0].sessionRef.sessionPath, sessionRecord().path);
    assert.match(sent[0].text, /A quoted sentence/);

    const explicitNew = await createAndSend(requestContext({
      agentId: "fixture-agent",
      quote: "A second quoted sentence",
      paperTitle: "Fixture paper",
    }));
    assert.equal(explicitNew.status, 200);
    assert.equal(explicitNew.value.ok, true);
    assert.equal(explicitNew.value.message, "已新建对话并发送");
    assert.equal(created, 1, "only the explicit new-session action may create a session");
    assert.equal(sent.length, 2);
    assert.equal(sent[1].sessionId, "session-created-1");
    assert.match(sent[1].text, /A second quoted sentence/);

    const callTypes = calls.map(({ type }) => type);
    assert.ok(callTypes.includes("session:list"));
    assert.ok(callTypes.includes("session:get"));
    assert.equal(callTypes.filter((type) => type === "session:create").length, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("path-only session projections remain selectable through the compatibility locator", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paper-reader-session-path-"));
  const app = makeApp();
  const sent = [];
  const pathOnly = sessionRecord({ sessionId: undefined });
  const ctx = {
    pluginId: "hana-paper-reader",
    dataDir: tempDir,
    config: { get: () => "", setMany() {} },
    log: { error() {}, warn() {} },
    bus: {
      async request(type, payload) {
        if (type === "session:list") return { sessions: [pathOnly] };
        if (type === "session:get") return { session: sessionRecord() };
        if (type === "session:send") { sent.push(payload); return { accepted: true }; }
        throw new Error(`unexpected bus call: ${type}`);
      },
    },
    network: { fetch: async () => { throw new Error("network must not run"); } },
  };

  try {
    registerApiRoutes(app, ctx);
    const listed = await app.routes.get("GET /api/session-targets")(requestContext());
    assert.equal(listed.value.sessions.length, 1);
    const result = await app.routes.get("POST /api/send-to-session")(requestContext({
      targetId: listed.value.sessions[0].targetId,
      quote: "Path-compatible quote",
    }));
    assert.equal(result.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].sessionId, "session-existing-1");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
