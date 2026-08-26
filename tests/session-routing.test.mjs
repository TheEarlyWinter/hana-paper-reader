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
  const previousHanaHome = process.env.HANA_HOME;
  process.env.HANA_HOME = tempDir;
  fs.mkdirSync(path.join(tempDir, "agents", "local-agent"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "agents", "local-agent", "config.yaml"), "agent:\n  name: 本地 Agent\nmodels:\n  chat:\n    id: selected-model\n    provider: fixture\n", "utf8");
  fs.mkdirSync(path.join(tempDir, "agents", "deleted-agent"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "agents", "deleted-agent", "config.yaml"), "agent:\n  name: 已删除 Agent\n", "utf8");
  fs.writeFileSync(path.join(tempDir, "agents", "deleted-agent", ".deleted-agent.json"), JSON.stringify({
    version: 1,
    agentId: "deleted-agent",
    agentName: "已删除 Agent",
    deletedAt: "2026-08-22T12:00:00.000Z",
  }), "utf8");
  const createdPayloads = [];
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
        if (type === "agent:list") return { agents: [
          { id: "dynamic-agent", name: "动态 Agent" },
          { id: "deleted-agent", name: "已删除 Agent" },
        ] };
        if (type === "agent:profile") {
          const agentId = payload?.agentId;
          return { profile: { id: agentId, name: agentId === "dynamic-agent" ? "动态 Agent" : agentId === "deleted-agent" ? "已删除 Agent" : "哈基米", models: { chat: { id: "selected-model", provider: "fixture" } } } };
        }
        if (type === "provider:models-by-type") return {
          models: [
            { provider: "fixture", id: "selected-model", name: "Fixture Selected" },
            { provider: "other", id: "other-model", name: "Other Model" },
          ],
        };
        if (type === "session:create") {
          created += 1;
          createdPayloads.push(payload);
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
    const listAgents = app.routes.get("GET /api/agents");
    const listTargets = app.routes.get("GET /api/session-targets");
    const listModels = app.routes.get("GET /api/models");
    const sendToSession = app.routes.get("POST /api/send-to-session");
    assert.equal(typeof listAgents, "function");
    const createAndSend = app.routes.get("POST /api/create-session-and-send");
    assert.equal(typeof listTargets, "function");
    assert.equal(typeof listModels, "function");
    assert.equal(typeof sendToSession, "function");
    assert.equal(typeof createAndSend, "function");

    const agents = await listAgents(requestContext());
    assert.equal(agents.status, 200);
    assert.deepEqual(agents.value.agents.map((agent) => agent.id).sort(), ["dynamic-agent", "local-agent"]);
    assert.equal(agents.value.agents.some((agent) => agent.id === "deleted-agent"), false, "deleted Agent tombstones must never appear in the picker");
    assert.ok(calls.some(({ type, payload }) => type === "agent:list" && payload.includePluginPrivate === true));

    const models = await listModels(requestContext());
    assert.equal(models.status, 200);
    assert.deepEqual(models.value.models.map((model) => model.ref), ["fixture/selected-model", "other/other-model"]);
    const modelsAgain = await listModels(requestContext());
    assert.equal(modelsAgain.status, 200);
    assert.equal(calls.filter(({ type }) => type === "provider:models-by-type").length, 1, "model catalog endpoint should use its short cache");

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
      modelRef: "fixture/selected-model",
    }));
    assert.equal(sentResponse.status, 200);
    assert.equal(sentResponse.value.ok, true);
    assert.equal(sentResponse.value.message, "已发送到所选对话");
    assert.equal(created, 0, "selected existing target must not create a session");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].sessionId, "session-existing-1");
    assert.equal(sent[0].sessionRef.sessionPath, sessionRecord().path);
    assert.match(sent[0].text, /A quoted sentence/);
    assert.equal("model" in sent[0], false, "existing-session sends must not carry a model override");

    const explicitNew = await createAndSend(requestContext({
      agentId: "fixture-agent",
      modelRef: "fixture/selected-model",
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
    assert.deepEqual(createdPayloads[0].model, { provider: "fixture", id: "selected-model" });
    assert.equal(explicitNew.value.modelSelection.ref, "fixture/selected-model");

    const followAgent = await createAndSend(requestContext({
      agentId: "fixture-agent",
      modelRef: "agent-default",
      quote: "A follow-agent quoted sentence",
    }));
    assert.equal(followAgent.status, 200);
    assert.equal(created, 2);
    assert.equal("model" in createdPayloads[1], false, "跟随 Agent must omit an explicit model override");

    const invalidModel = await createAndSend(requestContext({
      agentId: "fixture-agent",
      modelRef: "fixture/not-configured",
      quote: "This must not create a session",
    }));
    assert.equal(invalidModel.status, 409);
    assert.equal(invalidModel.value.code, "model_unavailable");
    assert.equal(created, 2, "an unavailable model must not create a session");

    const callTypes = calls.map(({ type }) => type);
    assert.ok(callTypes.includes("session:list"));
    assert.ok(callTypes.includes("session:get"));
    assert.equal(callTypes.filter((type) => type === "session:create").length, 2);
    assert.equal(callTypes.filter((type) => type === "provider:models-by-type").length, 3, "explicit model requests must revalidate against the current catalog");
  } finally {
    if (previousHanaHome === undefined) delete process.env.HANA_HOME;
    else process.env.HANA_HOME = previousHanaHome;
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
