import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

// cf#336 -- the two-step cast upload flow, end to end, which NOTHING in this suite covered.
//
// The panel stages bytes with POST /api/upload, then registers the returned key on a cast member.
// f239532 bound the JSON `{ key, mime }` register form to keys already under `cast/<id>/`, which is
// correct, but the panel was sending the `uploads/<uuid>` key that /api/upload actually returns. So
// every portrait / ref / source FILE upload on the hosted door answered 400 for ten days and no test
// noticed, because each STEP was covered and the FLOW was not.
//
// This drives both steps through the real API_ROUTES table against one shared R2, so the key that
// step 2 receives is the key step 1 really produced rather than one a fixture asserted.

const setPortrait = vi.fn(async (_e: unknown, _id: number, key: string, mime: string) => ({
  id: 7, name: "Ada", portrait_key: key, portrait_mime: mime,
}));

// The :id route param is an opaque public id and `isPublicId` requires a real UUID shape, so the
// fixture uses one. A short stand-in 404s at the shape gate before any handler logic runs, which
// looks exactly like "the flow is broken" and is not.
const PUB = "3f2a91d4-5c6b-4e10-9a77-2b8c4d1e6f03";

vi.mock("@skyphusion-labs/vivijure-core/cast-db", () => ({
  getCastIdByPublicId: async (_e: unknown, pub: string) => (pub === PUB ? 7 : null),
  getCastById: async () => ({ id: 7, public_id: PUB, name: "Ada", portrait_key: null, ref_keys: [], source_keys: [] }),
  clearPortrait: async () => ({ id: 7, public_id: PUB }),
  setPortrait,
  addRef: async () => ({ id: 7 }),
  removeRef: async () => ({ row: { id: 7 }, removedKey: "k" }),
  addSource: async () => ({ id: 7 }),
  removeSource: async () => ({ row: { id: 7 }, removedKey: "k" }),
  toPublicCast: (r: unknown) => r,
}));

/** A real-enough R2: what step 1 writes is what step 2 reads. */
function makeR2() {
  const store = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    store,
    binding: {
      put: async (key: string, bytes: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) => {
        store.set(key, {
          bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
          contentType: opts?.httpMetadata?.contentType ?? "application/octet-stream",
        });
      },
      get: async (key: string) => {
        const hit = store.get(key);
        if (!hit) return null;
        return {
          arrayBuffer: async () =>
            hit.bytes.buffer.slice(hit.bytes.byteOffset, hit.bytes.byteOffset + hit.bytes.byteLength),
          httpMetadata: { contentType: hit.contentType },
        };
      },
      delete: async (key: string) => { store.delete(key); },
    },
  };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const HTML = new TextEncoder().encode("<script>alert(1)</script>");

async function routes() {
  const { API_ROUTES } = await import("../src/index");
  return API_ROUTES;
}
async function handlerFor(method: string, pattern: string) {
  const r = (await routes()).find((x) => x.method === method && x.pattern === pattern);
  if (!r) throw new Error(`route ${method} ${pattern} is not in API_ROUTES`);
  return r.handler;
}

/** Mirror of the router's documented error mapping (CONTRACT 2.0): a handler throwing an
 *  HttpError becomes `{ error: message }` at that status. Named as a mirror because it is one. */
async function asResponse(fn: () => Promise<Response>): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const res = await fn();
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } catch (e) {
    const err = e as { status?: number; message?: string };
    if (typeof err.status !== "number") throw e;
    return { status: err.status, body: { error: err.message } };
  }
}

/** STEP 1, the real upload handler: raw bytes in, staged key out. */
async function upload(env: unknown, bytes: Uint8Array, mime: string) {
  const h = await handlerFor("POST", "/api/upload");
  return asResponse(() =>
    h(
      new Request("https://s/api/upload", { method: "POST", headers: { "content-type": mime }, body: bytes }),
      env as never, {} as never, {},
    ),
  ) as Promise<{ status: number; body: { key?: string; error?: string } }>;
}

/** STEP 2, the real cast-media handler, with whatever body shape is under test. */
async function register(env: unknown, body: unknown) {
  const h = await handlerFor("POST", "/api/cast/:id/portrait");
  return asResponse(() =>
    h(
      new Request(`https://s/api/cast/${PUB}/portrait`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }),
      env as never, {} as never, { id: PUB },
    ),
  );
}

describe("cf#336 upload-then-register, as ONE flow", () => {
  let r2: ReturnType<typeof makeR2>;
  let env: unknown;
  beforeEach(() => {
    setPortrait.mockClear();
    r2 = makeR2();
    env = { R2_RENDERS: r2.binding, DB: {} };
  });

  it("the flow the panel now performs: upload, then register by COPY", async () => {
    const up = await upload(env, PNG, "image/png");
    expect(up.status).toBe(201);
    expect(up.body.key, "upload no longer returns an uploads/ key").toMatch(/^uploads\//);

    const reg = await register(env, { from_chat_artifact: up.body.key });
    expect(reg.status, `register failed: ${JSON.stringify(reg.body)}`).toBe(200);
    // The copy path stages the object itself, under the member's own prefix.
    expect(setPortrait.mock.calls[0][2]).toMatch(/^cast\/7\/portrait\./);
  });

  it("REGRESSION: the body the panel used to send is still refused", async () => {
    // This is the assertion that would have caught cf#336 on the day f239532 landed. It asserts the
    // studio's CURRENT, CORRECT behaviour: an uploads/ key is not a cast-staged key. If this ever
    // starts passing, the prefix bind has been widened and the magic-byte hole is back.
    const up = await upload(env, PNG, "image/png");
    const reg = await register(env, { key: up.body.key, mime: "image/png" });
    expect(reg.status).toBe(400);
    expect(String(reg.body.error)).toMatch(/safe staged path/);
    expect(setPortrait).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: the staged-key form still works for a genuinely cast-staged key", async () => {
    // Without this, the regression row above would pass identically if the register handler simply
    // refused every JSON body, and the flow test would be the only thing keeping it honest.
    const reg = await register(env, { key: "cast/7/portrait.png", mime: "image/png" });
    expect(reg.status).toBe(200);
    expect(setPortrait).toHaveBeenCalledTimes(1);
  });

  it("the COPY path validates BYTES, which is why it is the safer half of the ruling", async () => {
    // The whole reason cf#336 was fixed by switching the panel rather than widening the guard: this
    // path sniffs the object and refuses content that does not match its claimed type. Uploading
    // HTML under an image content-type is refused at /api/upload's own allowlist, so drive the
    // sharper case: bytes that ARE stored as image/png but are not an image.
    await r2.binding.put("uploads/liar.png", HTML, { httpMetadata: { contentType: "image/png" } });
    const reg = await register(env, { from_chat_artifact: "uploads/liar.png" });
    expect(reg.status).toBe(400);
    expect(String(reg.body.error)).toMatch(/recognizable|does not match/);
    expect(setPortrait).not.toHaveBeenCalled();
  });

  it("NEGATIVE CONTROL: /api/upload refuses a non-image content-type outright", async () => {
    const up = await upload(env, HTML, "text/html");
    expect(up.status).toBe(400);
    expect(String(up.body.error)).toMatch(/unsupported content-type/);
  });
});

// The suite above proves what the STUDIO does. It cannot see what the PANEL sends, and the panel is
// the half that was broken: every assertion above passed on the day cf#336 was live. So the shipped
// cast.js is asserted directly, the same way cf#344's field name is.
describe("cf#336 the panel sends the copy form", () => {
  const CAST_JS = readFileSync(`${process.cwd()}/public/cast.js`, "utf8");

  it("all three file-upload call sites register by copy", () => {
    const copies = CAST_JS.match(/body: JSON\.stringify\(\{ from_chat_artifact: key \}\)/g) ?? [];
    // portrait, source, ref -- plus the pre-existing accept-portrait flow, which already used it.
    expect(copies.length, "a cast register call site stopped using the copy form").toBeGreaterThanOrEqual(3);
  });

  it("REGRESSION: no cast register call site sends the { key, mime } body again", () => {
    // The exact shape the studio refuses. If this string comes back, the upload path is dead again
    // and the only symptom a user sees is a 400 on a button that used to work.
    expect(CAST_JS).not.toContain("JSON.stringify({ key, mime })");
  });

  it("uploadBytes returns the key ALONE, so the refused body cannot be rebuilt", () => {
    // Structural rather than assertional: with no mime in hand at the call site, reconstructing
    // { key, mime } takes a deliberate new fetch of the mime rather than a one-word edit.
    expect(CAST_JS).toContain("return up.key;");
    expect(CAST_JS).not.toContain("return { key: up.key, mime: up.mime || file.type };");
  });

  it("POSITIVE CONTROL: the matcher can see the file it is reading", () => {
    // Without this, every assertion above passes against an empty or unreadable file.
    expect(CAST_JS.length).toBeGreaterThan(1000);
    expect(CAST_JS).toContain("async function uploadBytes(file)");
  });
});
