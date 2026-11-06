// The bearer check for a media door Worker. Vendored byte-for-byte into each
// containers/<name>/cf-container/src/, like bearer.py in the containers; tests/door-worker-gate.test.ts
// asserts the copies are identical and drives this one.
//
// The token is compared in constant time, matching the container's hmac.compare_digest: both
// sides are hashed to SHA-256 first, so the compare always runs over two 32-byte digests and its
// time depends on neither the length nor the content of the presented value.

const encoder = new TextEncoder();

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/** Equal-length compare with no early exit. Uses the Workers runtime's timingSafeEqual when it is
 *  there, and an accumulate-XOR over the whole buffer otherwise (Node, for the tests). */
export function equalDigests(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (x: ArrayBufferView, y: ArrayBufferView) => boolean };
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** The value after `Bearer ` (any case), or "" when the header is absent or another scheme. */
export function presentedBearer(header: string | null): string {
  const h = header || "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7) : "";
}

/** True only when a token is configured and the request presents exactly that token. */
export async function bearerOk(header: string | null, expected: string | undefined): Promise<boolean> {
  const want = expected || "";
  const got = presentedBearer(header);
  if (!want || !got) return false;
  return equalDigests(await digest(got), await digest(want));
}

/** GET /ready: readiness as booleans only, never anything derived from the token's value. */
export function readyBody(expected: string | undefined): { ok: true; token_configured: boolean } {
  return { ok: true, token_configured: Boolean(expected) };
}
