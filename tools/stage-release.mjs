#!/usr/bin/env node
// Prepare a release tree only. This deliberately does not invoke a validator,
// tests, Electron, the installed App runtime, or the installation API.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const pilot = !args.includes("--reader-only");
const outputIndex = args.indexOf("--out");
if (outputIndex < 0 || !args[outputIndex + 1] || args.some((value, index) =>
  value !== "--reader-only" && value !== "--previewer-pilot" && value !== "--out" && index !== outputIndex + 1)) {
  throw new Error("Usage: node tools/stage-release.mjs --out <staging-parent> [--reader-only]");
}
const source = path.join(repository, "apps", "hana-paper-reader");
const outputParent = path.resolve(args[outputIndex + 1]);
if (outputParent === source || outputParent.startsWith(`${source}${path.sep}`)) throw new Error("Staging must be outside the source App.");
const manifest = JSON.parse(await fs.readFile(path.join(source, "manifest.json"), "utf8"));
const releaseName = `hana-paper-reader-${manifest.version}-${pilot ? "full-feature" : "reader-only"}-${randomUUID().slice(0, 8)}`;
await fs.mkdir(outputParent, { recursive: true });
const output = path.join(outputParent, releaseName);
await fs.mkdir(output); // Never overwrite an existing staging tree.
for (const name of ["manifest.json", "index.js", "README.md", "assets", "sdk", "server", "ui"]) {
  await fs.cp(path.join(source, name), path.join(output, name), { recursive: true, errorOnExist: true, force: false });
}
if (pilot) {
  manifest.contributes.previewers = [{
    id: "pdf", title: "论文 PDF（试点）", route: "/pdf-preview.html", mode: "read",
    selectors: [{ extensions: ["pdf"] }, { mimeTypes: ["application/pdf"] }],
  }];
  manifest.contributes.cards = manifest.contributes.cards.filter(card => card.id !== "pdf-preview");
  manifest.contributes.cards.push({
    id: "pdf-preview", title: "PDF 预览（试点）", description: "在独立只读预览卡中打开 PDF。",
    realization: "card", face: { image: "assets/cover.png" }, route: "/pdf-preview.html",
    detached: { route: "/pdf-preview.html" }, detachedDefaultSize: { width: 1100, height: 850 },
    cardForm: "flush", titlebar: "solid",
  });
} else {
  delete manifest.contributes.previewers;
  manifest.contributes.cards = manifest.contributes.cards.filter(card => card.id !== "pdf-preview");
}
await fs.writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const buildInfoPath = path.join(output, "ui", "assets", "build-info.js");
const buildInfo = await fs.readFile(buildInfoPath, "utf8");
await fs.writeFile(buildInfoPath, buildInfo.replace(/PDF_PREVIEWER_ENABLED = (?:true|false)/, `PDF_PREVIEWER_ENABLED = ${pilot}`));
await fs.writeFile(path.join(output, "RELEASE-CANDIDATE.json"), `${JSON.stringify({
  app: manifest.id, version: manifest.version, variant: pilot ? "full-feature" : "reader-only",
  createdAt: new Date().toISOString(), verification: "pending-release-acceptance", installed: false,
  previewer: pilot ? "read-only-opt-in-pilot" : "not-declared",
}, null, 2)}\n`);
console.log(JSON.stringify({ staging: output, version: manifest.version, variant: pilot ? "full-feature" : "reader-only", verification: "pending-release-acceptance" }));
