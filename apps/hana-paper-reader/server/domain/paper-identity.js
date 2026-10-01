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

// Encoded model/Agent/prompt variants can legitimately exceed 600 characters.
// Keep the entire cache identity, with a bound above the generator's maximum.
export const MAX_TRANSLATION_CACHE_KEY_LENGTH = 16384;

export function assertTranslationCacheKey(value, paperHash) {
  const hash = assertPaperHash(paperHash);
  if (typeof value !== "string" || value !== value.trim() || value.length > MAX_TRANSLATION_CACHE_KEY_LENGTH
      || !value.startsWith(`${hash}:`) || value.includes("\0")) {
    throw new Error("translation cache key is invalid");
  }
  return value;
}

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
