// Deliberately exits only this owned test process at a filesystem checkpoint.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createPaperWorkspace } from "../../server/domain/paper-workspace.js";
const [directory, hash, checkpoint, pause] = process.argv.slice(2);
const root = path.resolve(directory || "");
if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("hpr-storage-crash-")) {
  throw new Error("Crash fixture must stay in its owned temporary directory");
}
const paper = path.join(root, "papers", hash, "paper.json");
const asset = path.join(root, "mineru-cache", "c".repeat(24), "images", "one.png");
const index = path.join(root, "paper-workspace.json");
function stop() {
  fs.writeSync(1, "owned-checkpoint\n");
  if (pause === "pause") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  process.exit(71);
}
const rename = fs.renameSync;
fs.renameSync = (source, destination) => {
  const result = rename(source, destination);
  const target = path.resolve(String(destination));
  if ((checkpoint === "paper" && target === paper) || (checkpoint === "index" && target === index)
      || (checkpoint === "asset" && target === asset)) stop();
  if (path.basename(target) === "manifest.json" && target.includes(`${path.sep}.storage-transactions${path.sep}`)) {
    const state = JSON.parse(fs.readFileSync(target, "utf8")).state;
    if (state === checkpoint) stop();
  }
  return result;
};
const write = fs.writeFileSync;
fs.writeFileSync = (file, content, ...options) => {
  const result = write(file, content, ...options);
  if (checkpoint === "asset" && path.resolve(String(file)) === asset) stop();
  return result;
};
const workspace = createPaperWorkspace({ dataDir: root });
const backup = workspace.exportBackup(hash);
backup.paper.metadata.title = "Restored after interruption";
backup.paper.blocks[0].assetRef = { cacheId: "c".repeat(24), path: "images/one.png" };
backup.assets = [{ cacheId: "c".repeat(24), path: "images/one.png", data: "eA==", size: 1, sha256: createHash("sha256").update("x").digest("hex") }];
await workspace.restoreBackup(backup);
