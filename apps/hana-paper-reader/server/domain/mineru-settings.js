import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SETTINGS_FILE = "mineru-settings.json";
const DPAPI_PREFIX = "dpapi:";
const SETTINGS_KEYS = Object.freeze([
  "mineruApiToken",
  "mineruApiBaseUrl",
  "mineruModelVersion",
  "mineruLanguage",
  "mineruEnableFormula",
  "mineruEnableTable",
  "mineruOcr",
  "mineruTimeoutSeconds",
  "mineruPollIntervalSeconds",
]);
const DEFAULTS = Object.freeze({
  mineruApiToken: "",
  mineruApiBaseUrl: "https://mineru.net/api/v4",
  mineruModelVersion: "vlm",
  mineruLanguage: "ch",
  mineruEnableFormula: true,
  mineruEnableTable: true,
  mineruOcr: false,
  mineruTimeoutSeconds: 900,
  mineruPollIntervalSeconds: 5,
});

const PS_PROTECT = `
Add-Type -AssemblyName System.Security
$b = [Text.Encoding]::UTF8.GetBytes($env:HPR_MINERU_TOKEN)
$e = [Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser')
[Convert]::ToBase64String($e)`;
const PS_UNPROTECT = `
Add-Type -AssemblyName System.Security
$b = [Convert]::FromBase64String($env:HPR_MINERU_TOKEN)
$d = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')
[Text.Encoding]::UTF8.GetString($d)`;

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function isProtected(value) {
  return String(value || "").startsWith(DPAPI_PREFIX);
}

function settingsPath(dataDir) {
  if (typeof dataDir !== "string" || !dataDir.trim()) throw new TypeError("MinerU settings dataDir is required");
  return path.join(dataDir, SETTINGS_FILE);
}

function quarantineCorrupt(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = `${file}.corrupt-${stamp}`;
  try {
    fs.renameSync(file, destination);
    return destination;
  } catch (error) {
    throw new Error("MinerU 设置文件损坏且无法留档", { cause: error });
  }
}

function readStored(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : {};
  } catch (error) {
    quarantineCorrupt(file);
    return {};
  }
}

function writeStored(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid.toString(36)}-${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* preserve the previous settings file */ }
    throw error;
  }
}

async function protectToken(value) {
  const plain = String(value || "");
  if (!plain || isProtected(plain)) return plain;
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", PS_PROTECT], {
        env: { ...process.env, HPR_MINERU_TOKEN: plain },
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      const encoded = String(stdout || "").trim();
      if (encoded) return DPAPI_PREFIX + encoded;
    } catch (error) {
      throw new Error("无法使用 Windows DPAPI 保护 MinerU Token，设置未保存", { cause: error });
    }
    throw new Error("Windows DPAPI 未返回受保护的 MinerU Token，设置未保存");
  }
  return plain;
}

async function unprotectToken(value) {
  const stored = String(value || "");
  if (!stored || !isProtected(stored)) return stored;
  if (process.platform !== "win32") return "";
  try {
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", PS_UNPROTECT], {
      env: { ...process.env, HPR_MINERU_TOKEN: stored.slice(DPAPI_PREFIX.length) },
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return String(stdout || "").trim();
  } catch (error) {
    throw new Error("无法解密 MinerU Token，设置未保存", { cause: error });
  }
}

function cleanSettings(value) {
  const source = isObject(value) ? value : {};
  return Object.fromEntries(SETTINGS_KEYS.map((key) => [key, source[key] === undefined ? DEFAULTS[key] : source[key]]));
}

/**
 * App-owned MinerU settings. The UI reaches this through /api/mineru-settings;
 * no contributes.settings declaration or Hanako global settings form is needed.
 */
export function createMineruSettingsStore(dataDir, options = {}) {
  const file = settingsPath(dataDir);
  const protect = typeof options.protect === "function" ? options.protect : protectToken;
  const unprotect = typeof options.unprotect === "function" ? options.unprotect : unprotectToken;
  let writeChain = Promise.resolve();

  const read = async () => {
    const stored = cleanSettings(readStored(file));
    stored.mineruApiToken = await unprotect(stored.mineruApiToken);
    return stored;
  };

  const setMany = (patch) => {
    const input = isObject(patch) ? patch : {};
    const operation = writeChain.then(async () => {
      const current = await read();
      const next = cleanSettings({ ...current, ...input });
      const stored = { ...next, mineruApiToken: await protect(next.mineruApiToken) };
      writeStored(file, stored);
      return next;
    });
    writeChain = operation.then(() => undefined, () => undefined);
    return operation;
  };

  return Object.freeze({
    async get(key) {
      await writeChain;
      return (await read())[key];
    },
    async getAll() {
      await writeChain;
      return await read();
    },
    async set(key, value) {
      return setMany({ [key]: value });
    },
    setMany,
  });
}

export { DEFAULTS as MINERU_SETTINGS_DEFAULTS, SETTINGS_FILE as MINERU_SETTINGS_FILE };
