import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPaperWorkspace } from "../server/domain/paper-workspace.js";
import registerApiRoutes from "../server/http/api-routes.js";

function makeApp() {
  const routes = new Map();
  const add = (method) => (route, handler) => routes.set(`${method} ${route}`, handler);
  return { routes, get: add("GET"), post: add("POST"), delete: add("DELETE") };
}

function requestContext({ authorized = true, query = {}, params = {}, body = {}, signal } = {}) {
  return {
    get(key) {
      if (key !== "appRequestContext") return undefined;
      return authorized ? { principal: { id: "phase2-model-test" } } : undefined;
    },
    req: {
      query(name) { return query[name]; },
      param(name) { return params[name] || ""; },
      async json() { return body; },
      raw: { signal },
    },
    json(value, status = 200) { return { value, status }; },
    body(value, status = 200, headers = {}) { return { value, status, headers }; },
  };
}

function modelEvents(requestId, text) {
  return [
    { type: "start", requestId },
    { type: "text-delta", requestId, delta: text },
    {
      type: "done",
      requestId,
      stopReason: "stop",
      assistant: { role: "assistant", content: [{ type: "text", text }] },
    },
  ];
}

function makeRuntime(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-v2-model-agent-"));
  const calls = { listModels: 0, listAgents: [], profiles: [], utility: [], stream: [], cancel: [] };
  const models = {
    async list() {
      calls.listModels += 1;
      return {
        models: [
          { provider: "synthetic", id: "reader", name: "Synthetic Reader", apiKey: "secret", baseUrl: "https://secret.invalid" },
          { ref: "synthetic/reader", name: "Duplicate" },
          { provider: "synthetic", id: "translator", name: "Synthetic Translator", contextWindow: 4096 },
          { provider: "bad value", id: "ignored" },
        ],
      };
    },
    async utility(input) {
      calls.utility.push(input);
      return { requestId: input.requestId, text: "[\"译文\"]" };
    },
    async stream(input) {
      calls.stream.push(input);
      const prompt = input.messages?.[0]?.content || "";
      return modelEvents(input.requestId, prompt.includes("JSON") ? "[\"模型回答\"]" : "模型回答");
    },
    async cancel(requestId) {
      calls.cancel.push(requestId);
    },
    ...overrides.models,
  };
  const agents = {
    async list(input) {
      calls.listAgents.push(input);
      return { agents: [{ id: "agent-a", name: "合成助手", ownerPluginId: "other" }] };
    },
    async profile(input) {
      calls.profiles.push(input);
      return {
        profile: {
          id: input.agentId,
          name: "合成助手",
          identity: "只使用核验后的论文证据。",
          model: { provider: "synthetic", id: "reader" },
          config: { apiKey: "must-not-leak", baseUrl: "https://secret.invalid" },
        },
      };
    },
    ...overrides.agents,
  };
  return { runtime: { dataDir, models, agents, modelTimeoutMs: overrides.modelTimeoutMs }, calls, dataDir };
}

function cleanup(runtime) {
  assert.equal(path.dirname(path.resolve(runtime.dataDir)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(runtime.dataDir).startsWith("hpr-v2-model-agent-"));
  fs.rmSync(runtime.dataDir, { recursive: true, force: true });
}

for (const scenario of [
  { name: "accepts exactly 8 segments and 50000 characters", texts: Array(8).fill("字".repeat(6250)), status: 200 },
  { name: "accepts exactly 12000 characters in one segment", texts: ["x".repeat(12000)], status: 200 },
  { name: "rejects 9 segments before any model call", texts: Array(9).fill("x"), status: 400, code: "translation_input_invalid" },
  { name: "rejects 50001 aggregate characters before any model call", texts: ["字".repeat(6251), ...Array(7).fill("字".repeat(6250))], status: 413, code: "translation_input_too_large" },
  { name: "rejects a 12001-character segment before any model call", texts: ["x".repeat(12001)], status: 413, code: "translation_input_too_large" },
  { name: "rejects an empty batch before any model call", texts: [], status: 400, code: "translation_input_invalid" },
]) {
  test(`the actual translation route ${scenario.name}`, async () => {
    let invoked = 0;
    const expected = scenario.texts.map((_, index) => `Translated segment ${index + 1}`);
    const fixture = makeRuntime({ models: { async utility(input) {
      invoked++;
      return { requestId: input.requestId, text: JSON.stringify(expected) };
    } } });
    try {
      const app = makeApp();
      registerApiRoutes(app, fixture.runtime);
      const response = await app.routes.get("POST /api/translate")(requestContext({ body: { texts: scenario.texts } }));
      assert.equal(response.status, scenario.status);
      assert.equal(invoked, scenario.status === 200 ? 1 : 0);
      assert.equal(fixture.calls.stream.length, 0);
      if (scenario.status === 200) assert.deepEqual(response.value.translations, expected);
      else {
        assert.equal(response.value.ok, false);
        assert.equal(response.value.code, scenario.code);
        assert.equal("translations" in response.value, false);
      }
    } finally { cleanup(fixture); }
  });
}

test("model and Agent catalogs use v2 public projections and never expose config secrets", async () => {
  const fixture = makeRuntime();
  try {
    const app = makeApp();
    registerApiRoutes(app, fixture.runtime);
    const denied = await app.routes.get("GET /api/models")(requestContext({ authorized: false }));
    assert.equal(denied.status, 403);

    const models = await app.routes.get("GET /api/models")(requestContext());
    assert.equal(models.status, 200);
    assert.equal(models.value.models.length, 2);
    assert.deepEqual(models.value.models[0], {
      ref: "synthetic/reader",
      provider: "synthetic",
      id: "reader",
      name: "Synthetic Reader",
    });
    assert.equal(JSON.stringify(models.value).includes("secret"), false);

    const agents = await app.routes.get("GET /api/agents")(requestContext());
    assert.equal(agents.status, 200);
    assert.equal(agents.value.agents.length, 1);
    assert.equal(agents.value.agents[0].model, "synthetic/reader");
    assert.equal(agents.value.agentScope, "all");
    assert.equal(agents.value.agentReadDowngraded, false);
    assert.equal(JSON.stringify(agents.value).includes("must-not-leak"), false);
    assert.deepEqual(fixture.calls.listAgents[0], { scope: "all", lifecycle: "active" });
    assert.deepEqual(fixture.calls.profiles[0], { agentId: "agent-a", scope: "all" });

    const profile = await app.routes.get("GET /api/agents/:agentId")(requestContext({ params: { agentId: "agent-a" } }));
    assert.equal(profile.status, 200);
    assert.equal(profile.value.agent.identity, "只使用核验后的论文证据。");
    assert.equal(profile.value.agentScope, "all");
  } finally {
    cleanup(fixture);
  }
});

test("Agent catalog downgrades from all to own on missing app/agents.read and refuses if own access is also denied", async () => {
  const downgraded = makeRuntime();
  const denied = makeRuntime();
  try {
    downgraded.runtime.agents.list = async (input) => {
      downgraded.calls.listAgents.push(input);
      if (input.scope === "all") throw Object.assign(new Error("grant required"), { code: "APP_CAPABILITY_DENIED" });
      return { agents: [{ id: "agent-a", name: "本 App 助手" }] };
    };
    downgraded.runtime.agents.profile = async (input) => {
      downgraded.calls.profiles.push(input);
      if (input.scope === "all") throw Object.assign(new Error("grant required"), { code: "APP_CAPABILITY_DENIED" });
      return { profile: { id: input.agentId, name: "本 App 助手", model: { provider: "synthetic", id: "reader" } } };
    };
    const fallbackApp = makeApp();
    registerApiRoutes(fallbackApp, downgraded.runtime);
    const fallbackResponse = await fallbackApp.routes.get("GET /api/agents")(requestContext());
    assert.equal(fallbackResponse.status, 200);
    assert.equal(fallbackResponse.value.agentScope, "own");
    assert.equal(fallbackResponse.value.agentReadDowngraded, true);
    assert.equal(fallbackResponse.value.agentReadWarning, "app/agents.read_not_granted");
    assert.deepEqual(downgraded.calls.listAgents.map((item) => item.scope), ["all", "own"]);

    denied.runtime.agents.list = async () => {
      throw Object.assign(new Error("grant required"), { code: "APP_CAPABILITY_DENIED" });
    };
    denied.runtime.agents.profile = async () => {
      throw Object.assign(new Error("grant required"), { code: "APP_CAPABILITY_DENIED" });
    };
    const deniedApp = makeApp();
    registerApiRoutes(deniedApp, denied.runtime);
    const deniedResponse = await deniedApp.routes.get("GET /api/agents")(requestContext());
    assert.equal(deniedResponse.status, 403);
    assert.equal(deniedResponse.value.code, "agent_read_denied");
  } finally {
    cleanup(downgraded);
    cleanup(denied);
  }
});

test("utility translation uses ctx.models.utility with app scope and no provider selection", async () => {
  const fixture = makeRuntime();
  try {
    const app = makeApp();
    registerApiRoutes(app, fixture.runtime);
    const response = await app.routes.get("POST /api/translate")(requestContext({ body: {
      texts: ["A synthetic sentence."],
      glossaryTerms: { synthetic: "合成" },
    } }));
    assert.equal(response.status, 200);
    assert.deepEqual(response.value.translations, ["译文"]);
    assert.equal(response.value.model, "utility");
    assert.equal(fixture.calls.utility.length, 1);
    assert.equal(fixture.calls.utility[0].scope, "app");
    assert.equal("provider" in fixture.calls.utility[0], false);
    assert.equal("apiKey" in fixture.calls.utility[0], false);
  } finally {
    cleanup(fixture);
  }
});

test("Agent translation and ask routes validate the public model catalog before stream", async () => {
  const fixture = makeRuntime();
  try {
    const app = makeApp();
    registerApiRoutes(app, fixture.runtime);
    const explicitWithoutAgent = await app.routes.get("POST /api/translate")(requestContext({ body: {
      text: "text", modelRef: "synthetic/reader",
    } }));
    assert.equal(explicitWithoutAgent.status, 400);
    assert.equal(explicitWithoutAgent.value.code, "model_agent_required");

    const translated = await app.routes.get("POST /api/translate")(requestContext({ body: {
      text: "text", agentId: "agent-a", modelRef: "synthetic/translator", thinkingLevel: "low",
    } }));
    assert.equal(translated.status, 200);
    assert.deepEqual(translated.value.translations, ["模型回答"]);
    assert.equal(translated.value.modelSelection.ref, "synthetic/translator");
    assert.equal(fixture.calls.stream.at(-1).provider, "synthetic");
    assert.equal(fixture.calls.stream.at(-1).model, "translator");
    assert.equal(fixture.calls.stream.at(-1).reasoningEffort, "low");
    assert.equal("apiKey" in fixture.calls.stream.at(-1), false);

    const answer = await app.routes.get("POST /api/ask-agent")(requestContext({ body: {
      agentId: "agent-a", quote: "A verified quote", context: "synthetic context",
    } }));
    assert.equal(answer.status, 200);
    assert.equal(answer.value.answer, "模型回答");
    assert.equal(answer.value.modelSelection.mode, "agent-default");
    assert.equal(answer.value.model, "synthetic/reader");
  } finally {
    cleanup(fixture);
  }
});

test("ask-agent derives citation from v2 workspace evidence and strips forged or missing sources", async () => {
  let streamCalls = 0;
  const fixture = makeRuntime({ models: {
    async stream(input) {
      streamCalls += 1;
      return modelEvents(input.requestId, "Page 999 / block forged-block\\n模型回答");
    },
  } });
  const paperHash = "a".repeat(64);
  try {
    const workspace = createPaperWorkspace({ dataDir: fixture.dataDir });
    await workspace.upsertPaper({
      paperHash,
      metadata: { title: "Evidence fixture" },
      blocks: [{ id: "b1", page: 3, type: "paragraph", text: "Verified quote" }],
    });
    await workspace.close();

    const app = makeApp();
    registerApiRoutes(app, fixture.runtime);
    const legal = await app.routes.get("POST /api/ask-agent")(requestContext({ body: {
      agentId: "agent-a",
      quote: "Verified quote",
      paperHash,
      blockId: "b1",
      page: 999,
    } }));
    assert.equal(legal.status, 200);
    assert.equal(legal.value.citation, "Page 3 / block b1");
    assert.equal(legal.value.evidence.page, 3);
    assert.equal(legal.value.answer.includes("Page 3 / block b1"), false);
    assert.equal(legal.value.answer.includes("[未核验来源已移除]"), true);
    assert.equal(legal.value.answer.includes("Page 999 / block forged-block"), false);

    const forged = await app.routes.get("POST /api/ask-agent")(requestContext({ body: {
      agentId: "agent-a",
      quote: "Verified quote",
      paperHash,
      blockId: "forged-block",
      evidenceId: "forged-evidence-id",
      context: "客户端自报来源：Page 999 / block forged-block",
    } }));
    assert.equal(forged.status, 404);
    assert.equal(forged.value.code, "evidence_not_found");
    assert.equal(streamCalls, 1);

    const missing = await app.routes.get("POST /api/ask-agent")(requestContext({ body: {
      agentId: "agent-a",
      quote: "Verified quote",
    } }));
    assert.equal(missing.status, 200);
    assert.equal(missing.value.citation, null);
    assert.equal(missing.value.evidence, null);
    assert.equal(missing.value.answer.includes("[未核验来源已移除]"), true);
  } finally {
    cleanup(fixture);
  }
});

test("research evidence assistant uses only server-resolved evidence", async () => {
  let evidencePrompt = "";
  let evidenceAnswer = "Page 999 / block forged\n结论\nPage 2 / block b1";
  const fixture = makeRuntime({ models: {
    async stream(input) {
      evidencePrompt = input.messages?.[0]?.content || "";
      return modelEvents(input.requestId, evidenceAnswer);
    },
  } });
  const paperHash = "b".repeat(64);
  try {
    const workspace = createPaperWorkspace({ dataDir: fixture.dataDir });
    await workspace.upsertPaper({
      paperHash,
      metadata: { title: "Evidence assistant fixture" },
      blocks: [{ id: "b1", page: 2, type: "paragraph", text: "Verified evidence" }],
    });
    await workspace.close();

    const app = makeApp();
    registerApiRoutes(app, fixture.runtime);
    const response = await app.routes.get("POST /api/research/evidence")(requestContext({ body: {
      paperHash,
      blockId: "b1",
      question: "What does the evidence say?",
      agentId: "agent-a",
      modelRef: "agent-default",
    } }));
    assert.equal(response.status, 200);
    assert.equal(response.value.evidence.length, 1);
    assert.equal(response.value.evidence[0].page, 2);
    assert.equal(response.value.answer.includes("Page 2 / block b1"), true);
    assert.equal(response.value.answer.includes("Page 999 / block forged"), false);
    assert.equal(evidencePrompt.includes("Verified evidence"), true);

    evidenceAnswer = "证据不足，无法给出带来源的结论";
    const uncited = await app.routes.get("POST /api/research/evidence")(requestContext({ body: {
      paperHash,
      blockId: "b1",
      question: "Can the evidence support this?",
      agentId: "agent-a",
      modelRef: "agent-default",
    } }));
    assert.equal(uncited.status, 200);
    assert.equal(uncited.value.answer, evidenceAnswer);
    assert.equal(uncited.value.answer.includes("Page 2 / block b1"), false);
  } finally {
    cleanup(fixture);
  }
});

test("model denial and malformed output are mapped without leaking host diagnostics", async () => {
  const denied = makeRuntime({ models: {
    async stream() { throw Object.assign(new Error("permission detail"), { code: "APP_PERMISSION_DENIED", secret: "token" }); },
  } });
  const malformed = makeRuntime({ models: {
    async stream(input) { return [{ type: "start", requestId: input.requestId }]; },
  } });
  try {
    const deniedApp = makeApp();
    registerApiRoutes(deniedApp, denied.runtime);
    const deniedResponse = await deniedApp.routes.get("POST /api/ask-agent")(requestContext({ body: { agentId: "agent-a", quote: "quote" } }));
    assert.equal(deniedResponse.status, 403);
    assert.equal(deniedResponse.value.code, "model_inference_denied");
    assert.equal(JSON.stringify(deniedResponse.value).includes("permission detail"), false);

    const malformedApp = makeApp();
    registerApiRoutes(malformedApp, malformed.runtime);
    const malformedResponse = await malformedApp.routes.get("POST /api/ask-agent")(requestContext({ body: { agentId: "agent-a", quote: "quote" } }));
    assert.equal(malformedResponse.status, 502);
    assert.equal(malformedResponse.value.code, "model_output_invalid");
  } finally {
    cleanup(denied);
    cleanup(malformed);
  }
});

test("model timeout cancels the request and client cancellation maps explicitly", async () => {
  const timeoutFixture = makeRuntime({
    modelTimeoutMs: 5,
    models: { async stream() { return new Promise(() => {}); } },
  });
  const cancelledFixture = makeRuntime({
    models: { async stream() { return new Promise(() => {}); } },
  });
  try {
    const timeoutApp = makeApp();
    registerApiRoutes(timeoutApp, timeoutFixture.runtime);
    const timeoutResponse = await timeoutApp.routes.get("POST /api/ask-agent")(requestContext({ body: { agentId: "agent-a", quote: "quote" } }));
    assert.equal(timeoutResponse.status, 504);
    assert.equal(timeoutResponse.value.code, "model_timeout");
    assert.equal(timeoutFixture.calls.cancel.length, 1);

    const stalledStreamFixture = makeRuntime({
      modelTimeoutMs: 5,
      models: {
        async stream() {
          return {
            [Symbol.asyncIterator]() {
              return {
                next() { return new Promise(() => {}); },
                return() { return Promise.resolve({ done: true }); },
              };
            },
          };
        },
      },
    });
    const stalledApp = makeApp();
    registerApiRoutes(stalledApp, stalledStreamFixture.runtime);
    const stalledResponse = await stalledApp.routes.get("POST /api/ask-agent")(requestContext({ body: { agentId: "agent-a", quote: "quote" } }));
    assert.equal(stalledResponse.status, 504);
    assert.equal(stalledResponse.value.code, "model_timeout");
    assert.equal(stalledStreamFixture.calls.cancel.length, 1);
    cleanup(stalledStreamFixture);

    const cancelStallFixture = makeRuntime({
      modelTimeoutMs: 5,
      models: {
        async stream() {
          return {
            [Symbol.asyncIterator]() {
              return { next() { return new Promise(() => {}); } };
            },
          };
        },
        async cancel() { return new Promise(() => {}); },
      },
    });
    const cancelStallApp = makeApp();
    registerApiRoutes(cancelStallApp, cancelStallFixture.runtime);
    const cancelStartedAt = Date.now();
    const cancelStallResponse = await cancelStallApp.routes.get("POST /api/ask-agent")(requestContext({ body: { agentId: "agent-a", quote: "quote" } }));
    assert.equal(cancelStallResponse.status, 504);
    assert.ok(Date.now() - cancelStartedAt < 1000);
    cleanup(cancelStallFixture);

    const controller = new AbortController();
    controller.abort();
    const cancelledApp = makeApp();
    registerApiRoutes(cancelledApp, cancelledFixture.runtime);
    const cancelledResponse = await cancelledApp.routes.get("POST /api/ask-agent")(requestContext({ signal: controller.signal, body: { agentId: "agent-a", quote: "quote" } }));
    assert.equal(cancelledResponse.status, 499);
    assert.equal(cancelledResponse.value.code, "model_cancelled");
  } finally {
    cleanup(timeoutFixture);
    cleanup(cancelledFixture);
  }
});
