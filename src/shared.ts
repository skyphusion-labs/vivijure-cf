// Small shared helpers the render handlers lean on. Kept tiny and dependency-free.

export {
  BUNDLE_KEY_PREFIX,
  isSafeRelKey,
  isSafeBundleKey,
  sanitizeKeySegment,
} from "@skyphusion-labs/vivijure-core/key-safety";

/** Defense-in-depth check for a key about to be SIGNED. Narrower than isSafeRelKey: it blocks only
 *  the shapes that can steer a signed request off its intended object -- empty/oversized, absolute
 *  ("/..."), a "://" scheme, a ".." traversal segment, or any non-printable / non-ASCII byte -- while
 *  still allowing benign printable specials (space, "#", ...) that SigV4 uriEncode handles. This
 *  keeps legitimate keys signable without re-opening the injection hole. (security #6) */
export function isPresignSafeKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) return false;
  if (key.startsWith("/")) return false;
  if (key.includes("://")) return false;
  if (/[^ -~]/.test(key)) return false; // control chars, DEL, non-ASCII
  return !key.split("/").includes("..");
}

/** JSON response with the content-type set; merges any extra init. */
export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

// --- HTTP byte-range parsing (RFC 7233) ---------------------------------------------------------
// A media element (Safari/iOS especially) will not play a video it cannot range-request, and Chrome
// re-fetches from byte 0 on every seek without 206 support. This parses a single-range `Range` header
// against a known object size so the artifact route can answer 206 / 416 correctly.

export type ByteRange = { offset: number; length: number; start: number; end: number };

/** Parse a `Range` header (RFC 7233) against a known object `size`. Returns:
 *   - a ByteRange {offset,length,start,end} for a satisfiable single range (caller sends 206),
 *   - "unsatisfiable" for a syntactically valid but out-of-bounds range (caller sends 416),
 *   - null to ignore the header and serve the full body (no/blank header, malformed, a non-"bytes"
 *     unit, or a MULTI-range request) (caller sends 200).
 *  Only the "bytes" unit and a SINGLE range are supported; a multi-range request is served in full (a
 *  valid RFC 7233 response) rather than as multipart/byteranges. `offset`/`length` map straight onto
 *  the R2 get() range option; `start`/`end` are the inclusive positions for the Content-Range header. */
export function parseByteRange(header: string | null | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(.*)$/.exec(header.trim());
  if (!m) return null;
  const specs = m[1].split(",");
  if (specs.length !== 1) return null; // multi-range -> serve the full body
  const spec = specs[0].trim();
  const dash = spec.indexOf("-");
  if (dash === -1) return null;
  const startStr = spec.slice(0, dash).trim();
  const endStr = spec.slice(dash + 1).trim();
  // Each side must be empty or digits only; anything else is malformed -> ignore.
  const digits = /^[0-9]*$/;
  if (!digits.test(startStr) || !digits.test(endStr)) return null;

  if (size <= 0) return "unsatisfiable"; // an empty object has no satisfiable range

  // suffix form: bytes=-N (the last N bytes)
  if (startStr === "") {
    if (endStr === "") return null; // "bytes=-" is malformed
    const n = Number(endStr);
    if (n === 0) return "unsatisfiable"; // last 0 bytes is unsatisfiable
    const start = n >= size ? 0 : size - n; // clamp: -N past the start = whole file
    const end = size - 1;
    return { offset: start, length: end - start + 1, start, end };
  }

  const start = Number(startStr);
  if (start >= size) return "unsatisfiable"; // first-byte-pos at/after the end
  // open-ended form: bytes=N-
  if (endStr === "") {
    const end = size - 1;
    return { offset: start, length: end - start + 1, start, end };
  }
  // closed form: bytes=N-M
  let end = Number(endStr);
  if (end < start) return null; // reversed range is invalid -> ignore
  if (end >= size) end = size - 1; // clamp last-byte-pos to the object end
  return { offset: start, length: end - start + 1, start, end };
}
