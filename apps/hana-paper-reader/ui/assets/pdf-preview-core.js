// Pure input boundaries shared by the host-bound PDF view. No resource paths,
// host credentials or document-access handles are accepted or retained here.
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
export const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
export const MAX_CANVAS_SIDE = 8192;
export const MAX_PAGE_COUNT = 10000;
export const MAX_SEARCH_RESULTS = 100;
export const MAX_SEARCH_PAGE_CHARS = 200000;

export function previewError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function documentIdentity(context) {
  if (!context || context.appId !== "hana-paper-reader" ||
      !Array.isArray(context.capabilities) || !context.capabilities.includes("read") ||
      !Number.isSafeInteger(context.generation) || context.generation < 0 ||
      ![context.documentId, context.viewId, context.providerId].every(value => typeof value === "string" && value.length > 0)) {
    throw previewError("DOCUMENT_UNAVAILABLE", "此页面没有可读取的 PDF 文档，请从 Hana 文件预览中打开。");
  }
  return JSON.stringify([context.documentId, context.viewId, context.providerId, context.generation]);
}

export function checkDeclaredSize(context) {
  const size = context?.version?.size;
  if (typeof size === "number" && (!Number.isSafeInteger(size) || size < 0 || size > MAX_PDF_BYTES)) {
    throw previewError("PDF_TOO_LARGE", "PDF 超过 50 MiB 预览上限，请拆分后再打开。");
  }
}

export function unwrapHostResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw previewError("DOCUMENT_RESPONSE_INVALID", "宿主返回的文档格式无法识别。");
  }
  if (result.error || result.ok === false) {
    const code = typeof result.code === "string" ? result.code : result.error?.code;
    throw previewError(code || "DOCUMENT_READ_FAILED", "宿主无法读取当前文档。");
  }
  return result;
}

export function decodePdfBytes(result) {
  // Host 0.1050.9 preview-documents/read serializes ResourceIO bytes as this
  // exact envelope (CVr in bundle/index.js), regardless of the provider.
  const source = unwrapHostResult(result);
  if (source.encoding !== "base64" || typeof source.content !== "string") {
    throw previewError("DOCUMENT_RESPONSE_INVALID", "宿主未返回可识别的 PDF 字节。");
  }
  const encoded = source.content;
  if (!encoded.length || encoded.length % 4 || encoded.length > Math.ceil(MAX_PDF_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw previewError(encoded.length > Math.ceil(MAX_PDF_BYTES / 3) * 4 ? "PDF_TOO_LARGE" : "PDF_BYTES_INVALID", "PDF 内容为空、损坏或超过 50 MiB 上限。");
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const byteLength = encoded.length / 4 * 3 - padding;
  if (byteLength > MAX_PDF_BYTES) throw previewError("PDF_TOO_LARGE", "PDF 超过 50 MiB 预览上限。");
  const bytes = new Uint8Array(byteLength);
  // Decode in 48 KiB aligned chunks to avoid an additional whole-file binary
  // string. The SDK transport itself still receives the complete base64 DTO.
  const chunkSize = 65536;
  let offset = 0;
  try {
    for (let index = 0; index < encoded.length; index += chunkSize) {
      const chunk = atob(encoded.slice(index, index + chunkSize));
      for (let cursor = 0; cursor < chunk.length; cursor++) bytes[offset++] = chunk.charCodeAt(cursor);
    }
  } catch {
    throw previewError("PDF_BYTES_INVALID", "PDF 字节编码损坏。");
  }
  // PDF readers may accept a short binary preamble before the header.
  const header = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
  if (!header.includes("%PDF-")) throw previewError("PDF_HEADER_INVALID", "当前文档不是可识别的 PDF。");
  return bytes;
}

export function canvasScale(width, height, pixelRatio = 1) {
  if (![width, height].every(value => Number.isFinite(value) && value > 0 && value <= 100000)) {
    throw previewError("PDF_PAGE_SIZE_INVALID", "PDF 页面尺寸异常，无法安全绘制。");
  }
  return Math.min(Math.max(1, Math.min(Number(pixelRatio) || 1, 2)),
    Math.sqrt(MAX_CANVAS_PIXELS / (width * height)), MAX_CANVAS_SIDE / width, MAX_CANVAS_SIDE / height);
}

export async function readSearchPageText(page, { signal } = {}) {
  const cancelled = () => previewError("PDF_SEARCH_CANCELLED", "已停止 PDF 查找。");
  if (signal?.aborted) throw cancelled();
  const reader = page.streamTextContent({ disableNormalization: false }).getReader();
  let cancellationRequested = false;
  const cancelReader = () => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    // Worker cancellation is best effort. A delayed acknowledgement must not
    // prevent the view from retiring this search or starting another one.
    try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Already released. */ }
  };
  let rejectAbort;
  const aborted = signal ? new Promise((_, reject) => { rejectAbort = reject; }) : null;
  void aborted?.catch(() => {});
  const onAbort = () => { cancelReader(); rejectAbort(cancelled()); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const chunks = [];
  let chars = 0;
  let truncated = false;
  try {
    while (!signal?.aborted) {
      const read = reader.read();
      const { value, done } = await (aborted ? Promise.race([read, aborted]) : read);
      if (signal?.aborted) throw cancelled();
      if (done) break;
      for (const item of value.items || []) {
        if (typeof item.str !== "string") continue;
        const text = item.str.slice(0, Math.max(0, MAX_SEARCH_PAGE_CHARS - chars));
        chunks.push(text);
        chars += text.length;
        if (chars >= MAX_SEARCH_PAGE_CHARS) { truncated = true; break; }
        chunks.push(" "); chars++;
        if (chars >= MAX_SEARCH_PAGE_CHARS) { truncated = true; break; }
      }
      if (truncated) break;
    }
    if (signal?.aborted) throw cancelled();
    return { text: chunks.join("").replace(/\s+/g, " ").toLowerCase(), truncated };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    cancelReader();
    try { reader.releaseLock(); } catch { /* Worker may already have closed it. */ }
  }
}

export function displayName(context) {
  const resource = context?.resource;
  const value = resource?.name || resource?.title || resource?.filename;
  return typeof value === "string" && value.trim()
    ? value.split(/[\\/]/).pop().replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 160) || "论文 PDF"
    : "论文 PDF";
}

export function publicError(error) {
  const code = String(error?.code || error?.name || "PDF_PREVIEW_FAILED");
  if (/denied|permission|forbidden|revoked|expired|binding|stale|access/i.test(code)) {
    return { code: "DOCUMENT_ACCESS_UNAVAILABLE", message: "文档授权已失效或页面已被替换，请关闭后重新打开 PDF。" };
  }
  if (/too_large/i.test(code)) return { code: "PDF_TOO_LARGE", message: "PDF 超过当前预览大小上限，请拆分后再打开。" };
  if (/timeout/i.test(code)) return { code: "DOCUMENT_TIMEOUT", message: "读取文档超时，请稍后重新加载。" };
  if (/missing|not_found|invalid.*resource|resource.*invalid|enoent/i.test(code)) return { code: "DOCUMENT_MISSING", message: "文档已不存在或无法读取，请从文件列表重新打开。" };
  if (code === "PasswordException") return { code, message: "PDF 未解锁，请重新加载并输入打开密码。" };
  if (code === "InvalidPDFException") return { code, message: "PDF 结构损坏或格式不受支持。" };
  if (code === "PASSWORD_CANCELLED") return { code, message: "已取消解锁 PDF，可重新加载后再次输入密码。" };
  // Deliberately never expose arbitrary SDK/PDF.js messages: they may contain
  // private resource paths, URLs or document identifiers.
  const localCodes = new Set(["DOCUMENT_UNAVAILABLE", "PDF_TOO_LARGE", "PDF_BYTES_INVALID", "PDF_HEADER_INVALID", "PDF_PAGE_SIZE_INVALID", "DOCUMENT_RESPONSE_INVALID", "PDF_PAGE_COUNT_INVALID"]);
  return { code: localCodes.has(code) ? code : "PDF_PREVIEW_FAILED", message: localCodes.has(code) ? error.message : "PDF 预览失败，请重新加载或使用 Hana 内置预览。" };
}
