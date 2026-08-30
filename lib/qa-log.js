import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_ENTRY_CHARS = 4000;
const SECRET_KEY = /(token|authorization|api[-_]?key|password|secret|credential)/i;
const SECRET_VALUE = /(bearer\s+)[^\s]+/ig;

function redact(value, depth = 0) {
  if (depth > 5) return "[Truncated]";
  if (typeof value === "string") {
    return value.replace(SECRET_VALUE, "$1<REDACTED>").slice(0, MAX_ENTRY_CHARS);
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? "<REDACTED>" : redact(item, depth + 1),
    ]));
  }
  return value;
}

function normalizeLevel(value) {
  return ["debug", "info", "warn", "error"].includes(String(value)) ? String(value) : "info";
}

export function createQaLogger({ dataDir, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const root = String(dataDir || process.cwd());
  const filePath = path.join(root, "qa-runtime.log.jsonl");
  const limit = Math.max(256, Number(maxBytes) || DEFAULT_MAX_BYTES);

  function write(level, event, details = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: normalizeLevel(level),
      event: String(event || "unknown").slice(0, 160),
      details: redact(details),
    };
    let line = `${JSON.stringify(entry)}\n`;
    // A single oversized detail payload must not leave an invalid JSONL tail.
    // Keep the entry valid first, then enforce the byte (not UTF-16 character)
    // limit so Chinese text and emoji cannot exceed the configured bound.
    if (Buffer.byteLength(line, "utf8") > limit) {
      entry.details = { truncated: true };
      line = `${JSON.stringify(entry)}\n`;
    }
    if (Buffer.byteLength(line, "utf8") > limit) {
      entry.event = "truncated";
      entry.details = {};
      line = `${JSON.stringify(entry)}\n`;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    let previous = "";
    try { previous = fs.readFileSync(filePath, "utf8"); } catch {}
    const content = Buffer.from(`${previous}${line}`, "utf8");
    fs.writeFileSync(filePath, content.length > limit ? content.subarray(-limit) : content);
    return entry;
  }

  function read({ limit: count = 200 } = {}) {
    let content = "";
    try { content = fs.readFileSync(filePath, "utf8"); } catch { return []; }
    return content.split(/\r?\n/).filter(Boolean).slice(-Math.max(1, Math.min(1000, Number(count) || 200))).flatMap((line) => {
      try { return [redact(JSON.parse(line))]; } catch { return []; }
    });
  }

  return { filePath, write, read };
}
