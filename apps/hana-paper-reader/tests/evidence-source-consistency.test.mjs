import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createPaperWorkspace } from "../server/domain/paper-workspace.js";
import { readResearchEvidenceSnapshot } from "../server/domain/research-read.js";
import { evidenceRequestBasis } from "../ui/assets/evidence-source.js";
import registerApiRoutes from "../server/http/api-routes.js";

const HASH = "a".repeat(64);
const blocks = [{ id: "b1", page: 1, type: "paragraph", text: "Owned original source" },
  { id: "b2", page: 2, type: "paragraph", text: "Owned second source" }];
async function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hpr-evidence-source-23-"));
  const workspace = createPaperWorkspace({ dataDir });
  const paper = await workspace.upsertPaper({ paperHash: HASH, metadata: { title: "Owned source paper" }, blocks });
  const routes = new Map(), app = {};
  for (const method of ["get", "post", "delete"]) app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  const f = { dataDir, workspace, paper, routes, calls: [], profileCalls: 0, onModel: null, onProfile: null };
  registerApiRoutes(app, { dataDir,
    agents: { list: async () => ({ agents: [{ id: "owned-agent", name: "Owned synthetic assistant" }] }),
      profile: async () => { f.profileCalls++; await f.onProfile?.(); return { profile: { id: "owned-agent", name: "Owned synthetic assistant", model: { provider: "owned", id: "reader" } } }; } },
    models: { list: async () => ({ models: [{ provider: "owned", id: "reader" }] }),
      stream: async input => { f.calls.push(input); await f.onModel?.(); const text = "Owned answer\nPage 1 / block b1";
        return [{ type: "start", requestId: input.requestId }, { type: "text-delta", requestId: input.requestId, delta: text },
          { type: "done", requestId: input.requestId, stopReason: "stop", assistant: { role: "assistant", content: [{ type: "text", text }] } }]; } },
  });
  f.request = (body = {}) => routes.get("POST /api/research/evidence")({ get: () => ({ principal: { id: "owned-source-test" } }),
    req: { json: async () => ({ paperHash: HASH, blockId: "b1", question: "Owned source question", agentId: "owned-agent", modelRef: "agent-default", ...body }) },
    json: (value, status = 200) => ({ value, status }) });
  f.close = async () => {
    await workspace.close();
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("hpr-evidence-source-23-"));
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return f;
}

for (const change of ["updated source", "deleted paper", "same-content recreation"]) {
  test(`a research question rejects its result after an ${change} during model execution`, async () => {
    const f = await fixture();
    try {
      f.onModel = async () => {
        if (change === "updated source") await f.workspace.upsertPaper({ paperHash: HASH, blocks: blocks.map(block => block.id === "b1" ? { ...block, text: "New committed source" } : block) });
        else { await f.workspace.removePaper(HASH); if (change === "same-content recreation") await f.workspace.upsertPaper({ paperHash: HASH, metadata: f.paper.metadata, blocks }); }
      };
      const response = await f.request();
      assert.equal(response.status, 409); assert.equal(response.value.code, "evidence_source_changed");
      assert.equal(response.value.ok, false); assert.equal(response.value.answer, undefined);
      assert.equal(f.calls.length, 1);
    } finally { await f.close(); }
  });
}

test("a research question rejects a stale client generation before calling the model", async () => {
  const f = await fixture();
  try {
    const previous = f.paper.generation;
    await f.workspace.removePaper(HASH); await f.workspace.upsertPaper({ paperHash: HASH, metadata: f.paper.metadata, blocks });
    const response = await f.request({ expectedGeneration: previous });
    assert.equal(response.status, 409); assert.equal(response.value.code, "evidence_source_changed");
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("a conditional question returns its committed basis and derives the paper title from storage", async () => {
  const f = await fixture();
  try {
    const snapshot = readResearchEvidenceSnapshot(f.dataDir, HASH, { blockId: "b1" });
    assert.equal(snapshot.sourceBasis, evidenceRequestBasis(f.paper, "b1"));
    const response = await f.request({ expectedGeneration: f.paper.generation, expectedSource: snapshot.sourceBasis, paperTitle: "Forged client title" });
    assert.equal(response.status, 200); assert.equal(response.value.sourceBasis, snapshot.sourceBasis);
    assert.equal(response.value.sourceGeneration, f.paper.generation);
    assert.ok(f.calls[0].messages[0].content.includes("Owned source paper"));
    assert.ok(!f.calls[0].messages[0].content.includes("Forged client title"));
  } finally { await f.close(); }
});

test("a stale client source condition rejects changed content before model or Agent reads", async () => {
  const f = await fixture();
  try {
    const expectedSource = evidenceRequestBasis(f.paper, "b1");
    await f.workspace.upsertPaper({ paperHash: HASH, blocks: blocks.map(block => block.id === "b1" ? { ...block, text: "New source before question" } : block) });
    assert.equal(f.workspace.getPaper(HASH).generation, f.paper.generation);
    const response = await f.request({ expectedGeneration: f.paper.generation, expectedSource });
    assert.equal(response.status, 409); assert.equal(response.value.code, "evidence_source_changed");
    assert.equal(f.profileCalls, 0); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("a source update during Agent lookup is rejected before inference starts", async () => {
  const f = await fixture();
  try {
    f.onProfile = () => f.workspace.upsertPaper({ paperHash: HASH, blocks: blocks.map(block => block.id === "b1" ? { ...block, page: 8 } : block) });
    const response = await f.request();
    assert.equal(response.status, 409); assert.equal(response.value.code, "evidence_source_changed");
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("a separate owned writer can commit while inference waits and makes its result conflict", async () => {
  const f = await fixture();
  try {
    f.onModel = () => {
      const moduleUrl = new URL("../server/domain/paper-workspace.js", import.meta.url).href;
      const program = `import { createPaperWorkspace } from ${JSON.stringify(moduleUrl)};\nconst dataDir = process.argv[1];\nconst workspace = createPaperWorkspace({ dataDir });\nawait workspace.upsertPaper({ paperHash: ${JSON.stringify(HASH)}, blocks: [{ id: "b1", page: 1, text: "Owned external writer source" }] });\nawait workspace.close();`;
      execFileSync(process.execPath, ["--input-type=module", "--eval", program, f.dataDir], { windowsHide: true, timeout: 15000, stdio: "pipe" });
    };
    const response = await f.request();
    assert.equal(response.status, 409); assert.equal(response.value.answer, undefined);
    assert.equal(f.workspace.getPaper(HASH).blocks[0].text, "Owned external writer source");
  } finally { await f.close(); }
});

test("unrelated research changes and a same-source revision update do not invalidate inference", async () => {
  const f = await fixture();
  try {
    f.onModel = async () => {
      await f.workspace.putNote({ paperHash: HASH, blockId: "b1", note: "Owned unrelated note" });
      await f.workspace.setProgress({ paperHash: HASH, percent: 80 });
      await f.workspace.putGlossary({ paperHash: HASH, terms: { evidence: "Owned term" } });
      await f.workspace.upsertPaper({ paperHash: HASH, metadata: f.paper.metadata, blocks });
    };
    const response = await f.request({ expectedSource: evidenceRequestBasis(f.paper, "b1"), expectedGeneration: f.paper.generation });
    assert.equal(response.status, 200); assert.ok(response.value.answer.includes("Owned answer"));
    assert.ok(f.workspace.getPaper(HASH).revision > f.paper.revision);
  } finally { await f.close(); }
});

test("a same-content backup restore invalidates an in-flight question", async () => {
  const f = await fixture();
  try {
    const backup = f.workspace.exportBackup(HASH);
    f.onModel = () => f.workspace.restoreBackup({ ...backup, expectedRevision: f.workspace.getPaper(HASH).revision });
    const response = await f.request();
    assert.equal(response.status, 409); assert.equal(response.value.code, "evidence_source_changed");
  } finally { await f.close(); }
});

test("a whole-paper question observes updates to any evidence in its supplied set", async () => {
  const f = await fixture();
  try {
    const expectedSource = evidenceRequestBasis(f.paper);
    f.onModel = () => f.workspace.upsertPaper({ paperHash: HASH, blocks: blocks.map(block => block.id === "b2" ? { ...block, text: "New second source" } : block) });
    const response = await f.request({ blockId: null, expectedSource });
    assert.equal(response.status, 409); assert.equal(response.value.code, "evidence_source_changed");
  } finally { await f.close(); }
});

test("a selected-block question is not invalidated by an unrelated block update", async () => {
  const f = await fixture();
  try {
    f.onModel = () => f.workspace.upsertPaper({ paperHash: HASH, blocks: blocks.map(block => block.id === "b2" ? { ...block, text: "Unrelated new text" } : block) });
    const response = await f.request({ expectedSource: evidenceRequestBasis(f.paper, "b1") });
    assert.equal(response.status, 200); assert.equal(response.value.evidence.length, 1);
    assert.equal(response.value.evidence[0].blockId, "b1");
  } finally { await f.close(); }
});

test("mismatched evidence and block identifiers cannot select an unintended source", async () => {
  const f = await fixture();
  try {
    const evidenceId = f.workspace.getEvidence(HASH, { blockId: "b2" }).evidenceId;
    const response = await f.request({ blockId: "b1", evidenceId });
    assert.equal(response.status, 404); assert.equal(response.value.code, "evidence_not_found"); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

for (const [field, values, code] of [
  ["expectedGeneration", [null, "", -1, 1.1, false, {}, "01"], "paper_generation_invalid"],
  ["expectedSource", [null, "", 0, false, {}, [], "x".repeat(1024 * 1024 + 1)], "evidence_source_condition_invalid"],
]) {
  test(`invalid ${field} conditions fail before invoking the model and preserve workspace bytes`, async () => {
    const f = await fixture();
    try {
      const file = path.join(f.dataDir, "papers", HASH, "paper.json"), before = fs.readFileSync(file);
      for (const value of values) {
        const response = await f.request({ [field]: value });
        assert.equal(response.status, 400); assert.equal(response.value.code, code);
        assert.deepEqual(fs.readFileSync(file), before);
      }
      assert.equal(f.calls.length, 0); assert.equal(f.profileCalls, 0);
    } finally { await f.close(); }
  });
}

test("an unreadable source shard stops inference without resetting its data", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.dataDir, "papers", HASH, "paper.json"); fs.writeFileSync(file, "Owned invalid JSON");
    const before = fs.readFileSync(file), response = await f.request();
    assert.equal(response.status, 503); assert.equal(response.value.code, "workspace_integrity_error");
    assert.equal(f.calls.length, 0); assert.deepEqual(fs.readFileSync(file), before);
  } finally { await f.close(); }
});

test("a translation-only evidence fallback is revalidated during inference", async () => {
  const f = await fixture();
  try {
    const fallbackBlocks = [{ id: "b1", page: 1, type: "paragraph", text: "", translatedText: "Owned translation fallback" }];
    const paper = await f.workspace.upsertPaper({ paperHash: HASH, blocks: fallbackBlocks, replaceTranslations: true });
    f.onModel = async () => {
      await f.workspace.upsertPaper({ paperHash: HASH, blocks: [{ ...fallbackBlocks[0], translatedText: "New translated source" }],
        translations: { b1: "New translated source" }, replaceTranslations: true });
      assert.equal(f.workspace.getPaper(HASH).blocks[0].translatedText, "New translated source");
    };
    const response = await f.request({ expectedSource: evidenceRequestBasis(paper, "b1") });
    assert.equal(response.status, 409); assert.ok(f.calls[0].messages[0].content.includes("Owned translation fallback"));
  } finally { await f.close(); }
});
