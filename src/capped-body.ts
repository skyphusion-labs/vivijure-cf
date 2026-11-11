// Read a request or response body up to a cap. A declared Content-Length over the cap
// is refused before the body is read. A body with no length is read from the stream
// and refused once the running total passes the cap.

export class CappedReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CappedReadError";
  }
}

export async function readCappedBody(req: Request, maxBytes: number): Promise<Uint8Array> {
  return readCappedBytes(req.headers, req.body, () => req.arrayBuffer(), maxBytes);
}

export async function readCappedBytes(
  headers: Headers,
  body: ReadableStream<Uint8Array> | null,
  fallback: () => Promise<ArrayBuffer>,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new CappedReadError(`body too large (Content-Length ${declared} bytes > ${maxBytes} cap)`);
  }
  if (!body || typeof body.getReader !== "function") {
    const buf = new Uint8Array(await fallback());
    if (buf.byteLength > maxBytes) {
      throw new CappedReadError(`body too large (${buf.byteLength} bytes > ${maxBytes} cap)`);
    }
    return buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    const value = step.value;
    if (!value || value.byteLength === 0) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* the caller already has the error */ }
      throw new CappedReadError(`body too large (> ${maxBytes} cap)`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
