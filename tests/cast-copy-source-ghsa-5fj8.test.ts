import { describe, it, expect, vi, beforeEach } from "vitest";

// Ref GHSA-5fj8-6pc2-x9p5. A path that COPIES an object into served artifact space must not accept a
// source from outside that space. Held objects live outside it, so a takedown must not be undoable by
// a second API call that re-publishes the same bytes under a fresh, unmarked key.
//
// HOW THESE ARE WRITTEN, AND WHY. Every assertion in the two groups below drives a real exported door
// and asserts on HTTP status plus BUCKET STATE, using only APIs that predate the change. That is
// deliberate, and it follows the convention set by tests/abuse-report-ghsa-wmjq.test.ts: a regression
// test that imports a NEW symbol fails on the missing import when run against the tree without the
// change, which looks red while proving nothing. The isServedArtifactKey table at the bottom does
// import a new export; it is added COVERAGE and is marked as such so the two are never confused.
//
// THE DISCRIMINATOR. The held fixture's key is `quarantine/<stamp>/<hold>/cast/7/portrait.png`: its
// TAIL is an ordinary, perfectly legitimate artifact key. Each refusal case is paired with the SAME
// bytes stored at that un-prefixed tail, which must still be accepted. So these tests show the hold
// prefix is what refuses the copy, not some incidental property of the fixture, and a fix that simply
// broke the copy paths would fail the control half.

const STAMP = "2026-09-26T00-00-00-000Z";
const HOLD = "11111111-1111-1111-1111-111111111111";
const HELD_IMAGE = `quarantine/${STAMP}/${HOLD}/cast/7/portrait.png`;
const LEGIT_IMAGE = "cast/7/portrait.png";      // the held key's own tail, un-prefixed
const CHAT_IMAGE = "out/from-chat.png";          // where chat artifacts are actually written
const HELD_CLIP = `quarantine/${STAMP}/${HOLD}/out/take.wav`;
const LEGIT_CLIP = "out/take.wav";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
// RIFF....WAVE, the shape sniffVoiceRefMime recognizes as audio/wav.
const WAV = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0, 0, 0, 0,
]);

const updateCast = vi.fn(async () => ({ id: 7 }));

vi.mock("@skyphusion-labs/vivijure-core/cast-db", () => ({
  getCastById: async () => ({
    id: 7,
    public_id: "x",
    name: "Ada",
    portrait_key: null,
    ref_keys: [],
    source_keys: [],
  }),
  setPortrait: async () => ({ id: 7 }),
  clearPortrait: async () => ({ id: 7 }),
  addRef: async () => ({ id: 7 }),
  removeRef: async () => ({ row: { id: 7 }, removedKey: "k" }),
  addSource: async () => ({ id: 7 }),
  removeSource: async () => ({ row: { id: 7 }, removedKey: "k" }),
  updateCast,
  toPublicCast: (r: unknown) => r,
}));

function makeR2(seed: Record<string, { bytes: Uint8Array; mime: string }>) {
  const store = new Map(Object.entries(seed));
  const puts: string[] = [];
  const binding = {
    put: async (key: string, bytes: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) => {
      puts.push(key);
      store.set(key, {
        bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
        mime: opts?.httpMetadata?.contentType ?? "application/octet-stream",
      });
    },
    get: async (key: string) => {
      const hit = store.get(key);
      if (!hit) return null;
      return {
        arrayBuffer: async () =>
          hit.bytes.buffer.slice(hit.bytes.byteOffset, hit.bytes.byteOffset + hit.bytes.byteLength),
        httpMetadata: { contentType: hit.mime },
      };
    },
    head: async (key: string) => (store.has(key) ? { size: store.get(key)!.bytes.length } : null),
    delete: async (key: string) => { store.delete(key); },
  };
  return { store, puts, binding };
}

const SEED = () => ({
  [HELD_IMAGE]: { bytes: PNG, mime: "image/png" },
  [CHAT_IMAGE]: { bytes: PNG, mime: "image/png" },
  [LEGIT_IMAGE]: { bytes: PNG, mime: "image/png" },
  [HELD_CLIP]: { bytes: WAV, mime: "audio/wav" },
  [LEGIT_CLIP]: { bytes: WAV, mime: "audio/wav" },
});

let r2: ReturnType<typeof makeR2>;
let env: { R2_RENDERS: ReturnType<typeof makeR2>["binding"]; DB: object };

beforeEach(() => {
  vi.clearAllMocks();
  r2 = makeR2(SEED());
  env = { R2_RENDERS: r2.binding, DB: {} };
});

function copyReq(srcKey: string, path: string): Request {
  return new Request(`https://cf/api/cast/7/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from_chat_artifact: srcKey }),
  });
}

/** Keys the bucket gained during the call, which is the evidence a copy did or did not happen. */
function written(): string[] {
  return r2.puts.slice();
}

describe("a copy into served space REFUSES a source outside served space", () => {
  it("the portrait door does not re-publish a held object, and writes nothing", async () => {
    const { handleCastPortraitUpload } = await import("../src/cast-media.js");
    const res = await handleCastPortraitUpload(copyReq(HELD_IMAGE, "portrait"), env as never, 7);
    expect(res.status).toBe(404);
    expect(written()).toEqual([]);                      // no bytes left the hold
    expect(r2.store.get(HELD_IMAGE)).toBeDefined();     // and the hold itself is untouched
  });

  it("the refs door does not re-publish a held object, and writes nothing", async () => {
    const { handleCastRefAdd } = await import("../src/cast-media.js");
    const res = await handleCastRefAdd(copyReq(HELD_IMAGE, "refs"), env as never, 7);
    expect(res.status).toBe(404);
    expect(written().filter((k) => k.startsWith("cast/7/refs/"))).toEqual([]);
  });

  it("the sources door does not re-publish a held object, and writes nothing", async () => {
    const { handleCastSourceAdd } = await import("../src/cast-media.js");
    const res = await handleCastSourceAdd(copyReq(HELD_IMAGE, "sources"), env as never, 7);
    expect(res.status).toBe(404);
    expect(written().filter((k) => k.startsWith("cast/7/sources/"))).toEqual([]);
  });

  it("the voice-sample door does not re-publish a held clip, and writes no voice ref", async () => {
    const { attachCastVoiceSampleFromKey } = await import("../src/cast-voice-sample.js");
    await expect(attachCastVoiceSampleFromKey(env as never, 7, HELD_CLIP))
      .rejects.toMatchObject({ sampleStatus: 404 });
    expect(written().filter((k) => k.startsWith("cast/7/voice-ref."))).toEqual([]);
    expect(updateCast).not.toHaveBeenCalled();          // and no row points at one
  });

  it("refuses a source outside the artifact namespaces entirely, not only a held one", async () => {
    const { handleCastPortraitUpload } = await import("../src/cast-media.js");
    r2.store.set("secrets/private.png", { bytes: PNG, mime: "image/png" });
    const res = await handleCastPortraitUpload(copyReq("secrets/private.png", "portrait"), env as never, 7);
    expect(res.status).toBe(404);
    expect(written()).toEqual([]);
  });
});

describe("CONTROL: a legitimate copy still works, so the doors are not merely broken", () => {
  it("the portrait door copies a chat artifact, which is where chat images are written", async () => {
    const { handleCastPortraitUpload } = await import("../src/cast-media.js");
    const res = await handleCastPortraitUpload(copyReq(CHAT_IMAGE, "portrait"), env as never, 7);
    expect(res.status).toBe(200);
    expect(written()).toEqual(["cast/7/portrait.png"]);
    expect(r2.store.get("cast/7/portrait.png")?.mime).toBe("image/png");
  });

  it("THE DISCRIMINATOR: the held key's own un-prefixed tail is accepted", async () => {
    // Same bytes, same trailing path, no hold prefix. This is what makes the refusal above a
    // statement about the hold and not about the fixture.
    const { handleCastPortraitUpload } = await import("../src/cast-media.js");
    const res = await handleCastPortraitUpload(copyReq(LEGIT_IMAGE, "portrait"), env as never, 7);
    expect(res.status).toBe(200);
    expect(written()).toEqual(["cast/7/portrait.png"]);
  });

  it("the refs door still copies a legitimate source", async () => {
    const { handleCastRefAdd } = await import("../src/cast-media.js");
    const res = await handleCastRefAdd(copyReq(CHAT_IMAGE, "refs"), env as never, 7);
    expect(res.status).toBe(200);
    expect(written().filter((k) => k.startsWith("cast/7/refs/"))).toHaveLength(1);
  });

  it("the sources door still copies a legitimate source", async () => {
    const { handleCastSourceAdd } = await import("../src/cast-media.js");
    const res = await handleCastSourceAdd(copyReq(CHAT_IMAGE, "sources"), env as never, 7);
    expect(res.status).toBe(200);
    expect(written().filter((k) => k.startsWith("cast/7/sources/"))).toHaveLength(1);
  });

  it("the voice-sample door still attaches a legitimate clip", async () => {
    const { attachCastVoiceSampleFromKey } = await import("../src/cast-voice-sample.js");
    const out = await attachCastVoiceSampleFromKey(env as never, 7, LEGIT_CLIP);
    expect(out.voice_ref_key).toBe("cast/7/voice-ref.wav");
    expect(out.mime).toBe("audio/wav");
    expect(updateCast).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------------------------------------------
// ADDED COVERAGE, NOT THE PROOF. This group imports a symbol that does not exist without the change,
// so running it against the unfixed tree fails on the import rather than on the behaviour. The proof
// is the two groups above, which use only pre-existing doors.
describe("isServedArtifactKey (unit table, added coverage)", () => {
  it("admits the artifact namespaces and refuses everything else", async () => {
    const { isServedArtifactKey } = await import("../src/shared.js");
    expect(isServedArtifactKey(CHAT_IMAGE)).toBe(true);
    expect(isServedArtifactKey(LEGIT_IMAGE)).toBe(true);
    expect(isServedArtifactKey("renders/film/clips/s1.mp4")).toBe(true);
    expect(isServedArtifactKey(HELD_IMAGE)).toBe(false);   // a hold, whose tail is otherwise legitimate
    expect(isServedArtifactKey("quarantine/x/HOLD.json")).toBe(false);
    expect(isServedArtifactKey("secrets/private.png")).toBe(false);
    expect(isServedArtifactKey("cast/../secrets/p.png")).toBe(false);
    expect(isServedArtifactKey("/cast/7/portrait.png")).toBe(false);
    expect(isServedArtifactKey("")).toBe(false);
    expect(isServedArtifactKey(undefined)).toBe(false);
    expect(isServedArtifactKey(42)).toBe(false);
  });
});
