import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { verifyNoSymlinks } from "../server/domain/paper-path-guard.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleUrl = (name) => JSON.stringify(pathToFileURL(path.join(appRoot, "server/domain", name)).href);
const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), "hpr-host-permissions-"));

function runRestricted(dataDir, script, allowSpawn = false) {
  const result = spawnSync(process.execPath, [
    "--permission", `--allow-fs-read=${appRoot}`, `--allow-fs-read=${dataDir}`,
    `--allow-fs-write=${dataDir}`, ...(allowSpawn ? ["--allow-child-process"] : []),
    "--input-type=module", "-e", script,
  ], { encoding: "utf8", timeout: 30000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test("host file permissions permit workspace reads, paper writes and note recovery without parent access", () => {
  const dataDir = fixture();
  try {
    const result = runRestricted(dataDir, `
      import fs from "node:fs";
      import path from "node:path";
      import { createPaperWorkspace } from ${moduleUrl("paper-workspace.js")};
      const dataDir = ${JSON.stringify(dataDir)};
      let parentDenied = false;
      try { fs.lstatSync(path.dirname(dataDir)); } catch (error) { parentDenied = error.code === "ERR_ACCESS_DENIED"; }
      const workspace = createPaperWorkspace({dataDir});
      const initiallyEmpty = Object.keys(workspace.load().papers).length === 0;
      const paperHash = "a".repeat(64);
      await workspace.upsertPaper({paperHash, metadata:{title:"Sandbox fixture"}, blocks:[{id:"b1",page:1,type:"paragraph",text:"Synthetic evidence"}]});
      await workspace.putNote({paperHash,blockId:"b1",note:"Persisted fixture"});
      const reopened = createPaperWorkspace({dataDir});
      console.log(JSON.stringify({parentDenied,initiallyEmpty,papers:reopened.listLibrary().length,notes:reopened.listItems("notes",paperHash).length}));
    `);
    assert.deepEqual(result, { parentDenied: true, initiallyEmpty: true, papers: 1, notes: 1 });
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("bounded path guard rejects external paths and junctions and accepts missing descendants", () => {
  const dataDir = fixture();
  const externalDir = fixture();
  try {
    assert.throws(() => verifyNoSymlinks(externalDir, dataDir), /escapes root boundary/);
    assert.throws(() => verifyNoSymlinks(path.join(dataDir + "-sibling", "paper.json"), dataDir), /escapes root boundary/);
    verifyNoSymlinks(path.join(dataDir, "papers", "missing", "paper.json"), dataDir);
    const link = path.join(dataDir, "linked");
    fs.symlinkSync(externalDir, link, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => verifyNoSymlinks(link, dataDir), /symlink or junction/);
    assert.throws(() => verifyNoSymlinks(link, link), /symlink or junction/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(externalDir, { recursive: true, force: true });
  }
});

test("Windows DPAPI works with the declared host process grant and rejects ungranted saves", { skip: process.platform !== "win32" }, () => {
  const dataDir = fixture();
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(appRoot, "manifest.json"), "utf8"));
    assert.ok(manifest.capabilities.includes("app/process.spawn"));
    const granted = runRestricted(dataDir, `
      import fs from "node:fs";
      import path from "node:path";
      import { createMineruSettingsStore } from ${moduleUrl("mineru-settings.js")};
      const dataDir = ${JSON.stringify(dataDir)};
      const token = "synthetic-dpapi-fixture-123456";
      await createMineruSettingsStore(dataDir).setMany({mineruApiToken:token,mineruTimeoutSeconds:123});
      const raw = fs.readFileSync(path.join(dataDir,"mineru-settings.json"),"utf8");
      const reopened = await createMineruSettingsStore(dataDir).getAll();
      console.log(JSON.stringify({protected:JSON.parse(raw).mineruApiToken.startsWith("dpapi:"),plaintextAbsent:!raw.includes(token),roundTrip:reopened.mineruApiToken===token,timeout:reopened.mineruTimeoutSeconds}));
    `, true);
    assert.deepEqual(granted, { protected: true, plaintextAbsent: true, roundTrip: true, timeout: 123 });
    const before = fs.readFileSync(path.join(dataDir, "mineru-settings.json"));
    const denied = runRestricted(dataDir, `
      import { createMineruSettingsStore } from ${moduleUrl("mineru-settings.js")};
      try {
        await createMineruSettingsStore(${JSON.stringify(dataDir)}).setMany({mineruApiToken:"synthetic-replacement"});
        console.log(JSON.stringify({denied:false}));
      } catch (error) { console.log(JSON.stringify({denied:error.cause?.code==="ERR_ACCESS_DENIED"})); }
    `);
    assert.deepEqual(denied, { denied: true });
    assert.deepEqual(fs.readFileSync(path.join(dataDir, "mineru-settings.json")), before);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
