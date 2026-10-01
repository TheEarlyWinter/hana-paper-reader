export class RequestBodyError extends Error {
  constructor(code, message, status = 400) { super(message); Object.assign(this, { code, status }); }
}

const invalid = () => new RequestBodyError("request_body_invalid", "请求正文不是有效 UTF-8 文本");
const tooLarge = () => new RequestBodyError("request_body_too_large", "请求正文超过大小限制", 413);

export async function readBoundedRequestText(request, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new TypeError("body limit is invalid");
  const declared = Number(request.header?.("Content-Length") ?? request.raw?.headers?.get("Content-Length"));
  if (declared > maximumBytes) throw tooLarge();
  const raw = request.raw;
  if (raw?.bodyUsed) throw invalid();
  if (!raw?.body?.getReader) {
    const text = await request.text();
    if (typeof text !== "string") throw invalid();
    if (Buffer.byteLength(text, "utf8") > maximumBytes) throw tooLarge();
    return text;
  }
  const signal = raw.signal;
  if (signal?.aborted) throw invalid();
  const reader = raw.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks = [];
  let bytes = 0;
  let cancellationRequested = false;
  const cancel = () => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Already closed. */ }
  };
  let rejectAbort;
  const aborted = signal ? new Promise((_, reject) => { rejectAbort = reject; }) : null;
  void aborted?.catch(() => {});
  const onAbort = () => { cancel(); rejectAbort(invalid()); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    while (!signal?.aborted) {
      const read = reader.read();
      const { value, done } = await (aborted ? Promise.race([read, aborted]) : read);
      if (signal?.aborted) throw invalid();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw invalid();
      bytes += value.byteLength;
      if (bytes > maximumBytes) throw tooLarge();
      try { chunks.push(decoder.decode(value, { stream: true })); } catch { throw invalid(); }
    }
    if (signal?.aborted) throw invalid();
    try { chunks.push(decoder.decode()); } catch { throw invalid(); }
    return chunks.join("");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    cancel();
    try { reader.releaseLock(); } catch { /* Transport may already have cancelled it. */ }
  }
}
