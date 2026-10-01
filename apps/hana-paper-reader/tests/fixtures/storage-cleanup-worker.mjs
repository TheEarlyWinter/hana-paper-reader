// Operates only on an owned synthetic cleanup fixture, never on the installed App.
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createPaperWorkspace } from "../../server/domain/paper-workspace.js";
const [directory, mode] = process.argv.slice(2);
const root = path.resolve(directory || "");
if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("hpr-cleanup-isolation-")) {
  throw new Error("Cleanup worker requires its owned temporary root");
}
if (!["recreate", "share", "replace-owner"].includes(mode)) throw new Error("Unknown cleanup fixture mode");
try {
  const workspace = createPaperWorkspace({ dataDir: root });
  const paperHash = (mode === "share" ? "b" : "a").repeat(64);
  if (mode === "replace-owner") await workspace.removePaper(paperHash);
  const before = workspace.getPaper(paperHash);
  await workspace.upsertPaper({ paperHash, ...(before ? { expectedRevision: before.revision } : {}),
    metadata: { title: mode === "recreate" ? "Recreated synthetic paper" : "New synthetic cache reference" },
    blocks: [{ id: "b1", page: 1, type: "image", text: "Synthetic resource", assetRef: { cacheId: "c".repeat(24), path: "one.png" } }] });
  if (mode === "replace-owner") {
    const directory = path.join(root, "mineru-cache", "c".repeat(24));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "one.png"), "replacement synthetic asset");
    await workspace.updatePaperMetadata(paperHash, { title: "Replacement owner at revision two" });
  }
  console.log(JSON.stringify({ busy: false, saved: true }));
} catch (error) {
  if (error.code !== "workspace_storage_busy") throw error;
  console.log(JSON.stringify({ busy: true, saved: false }));
}
