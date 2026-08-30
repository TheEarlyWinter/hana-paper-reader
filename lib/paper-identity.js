const RESERVED_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
]);

export function normalizePaperHash(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function assertPaperHash(value) {
  const normalized = normalizePaperHash(value);
  if (!normalized || !/^[a-f0-9]{12,128}$/.test(normalized)) {
    throw new Error(`invalid paper hash: "${String(value).slice(0, 40)}"`);
  }
  return normalized;
}

export function isSafePaperHash(value) {
  const normalized = normalizePaperHash(value);
  return Boolean(normalized && /^[a-f0-9]{12,128}$/.test(normalized));
}

export function normalizeCacheId(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function assertCacheId(value) {
  const normalized = normalizeCacheId(value);
  if (!normalized || !/^[a-f0-9]{24}$/.test(normalized)) {
    throw new Error(`invalid cache id: "${String(value).slice(0, 40)}"`);
  }
  return normalized;
}

export function isSafeCacheId(value) {
  const normalized = normalizeCacheId(value);
  return Boolean(normalized && /^[a-f0-9]{24}$/.test(normalized));
}

export function isReservedKey(value) {
  return typeof value === "string" && RESERVED_KEYS.has(value);
}

export function safeId(value) {
  const id = typeof value === "string" ? value.trim().slice(0, 128) : "";
  if (!id || !/^[A-Za-z0-9._:-]+$/.test(id)) {
    throw new Error("id is invalid");
  }
  if (isReservedKey(id)) {
    throw new Error(`id cannot be a reserved JavaScript object key: "${id}"`);
  }
  return id;
}
