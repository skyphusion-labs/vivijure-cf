// cast-image /poll progressive images (cf#386): the emission that survived a 2841-green suite.
//
// Review 4940729370 on PR #441 mutated modules/cast-image/src/index.ts, changing the pending
// return from  images: state.done  to  images: [], and the ENTIRE suite still passed. The
// progressive-images emission is half of what cf#386 ships (the host increments registered per
// tick off exactly this field), and nothing asserted it.
//
// poll() is not exported, so this drives the REAL handler through default.fetch (POST /poll)
// against a real-enough R2, and asserts on the CONTENT of images: the exact key and mime the
// module just wrote to the bucket this tick. An assertion on [], on images.length >= 0, or on
// the mere presence of the field would all survive the mutation. These do not, and neither
// would a rewrite to state.done.slice(0, 0).
//
// Non-default probe throughout: 4 images rather than the default 10, cast id 42, and a fake
// generator that returns image/jpeg rather than the module png fallback, so a hardcoded or
// substituted value cannot pass by coincidence.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildState, encodePoll, stateKey } from "../modules/cast-image/src/cast-image";
import worker from "../modules/cast-image/src/index";

// vi.mock is hoisted above the imports by vitest; vi.hoisted keeps the spy out of the TDZ.
const generateImage = vi.hoisted(() => vi.fn());
vi.mock("../modules/cast-image/src/image-gen", () => ({ generateImage }));

type Img = { key: string; mime: string };

interface PollBody {
  ok: boolean;
  error?: string;
  pending?: boolean;
  progress?: { done: number; total: number };
  images?: Img[];
  output?: { cast_id: number; images: Img[]; applied: string[] };
}

type ModuleEnv = Parameters<typeof worker.fetch>[1];

const CAST_ID = 42;
const JOB_ID = "job-cf386-progressive";
const TOTAL = 4; // clampNumImages floor is 4; the module default is 10

/** A real-enough R2: what the module writes is what the next poll reads. */
function makeR2() {
  const store = new Map<string, { body: string | Uint8Array; contentType: string }>();
  return {
    store,
    binding: {
      put: async (key: string, value: ArrayBuffer | string, opts?: { httpMetadata?: { contentType?: string } }) => {
        store.set(key, {
          body: typeof value === "string" ? value : new Uint8Array(value),
          contentType: opts?.httpMetadata?.contentType ?? "application/octet-stream",
        });
      },
      get: async (key: string) => {
        const hit = store.get(key);
        if (!hit) return null;
        return {
          text: async () => (typeof hit.body === "string" ? hit.body : new TextDecoder().decode(hit.body)),
        };
      },
    },
  };
}

let r2 = makeR2();
let env: ModuleEnv;
let token = "";

async function pollOnce(): Promise<PollBody> {
  const res = await worker.fetch(
    new Request("https://module.invalid/poll", { method: "POST", body: JSON.stringify({ poll: token }) }),
    env,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as PollBody;
}

beforeEach(async () => {
  r2 = makeR2();
  env = {
    AI: { run: async () => { throw new Error("AI.run must not be reached: generateImage is mocked"); } },
    GATEWAY_ID: "gw", // secretValue() accepts a plain string, so no secrets-store stub is needed
    R2_RENDERS: r2.binding,
  } as unknown as ModuleEnv;

  let n = 0;
  generateImage.mockReset();
  generateImage.mockImplementation(async () => {
    n += 1;
    // Distinct bytes per call, and image/jpeg: NOT the module png fallback.
    return { bytes: new Uint8Array([0xff, 0xd8, 0xff, n]).buffer, mime: "image/jpeg" };
  });

  const state = buildState(
    {
      cast_id: CAST_ID,
      portrait_url: "https://example.invalid/portrait.png",
      bible: "a weathered lighthouse keeper",
      art_style: "ink wash",
    },
    "google/nano-banana-pro",
    TOTAL,
  );
  await r2.binding.put(stateKey(CAST_ID, JOB_ID), JSON.stringify(state), {
    httpMetadata: { contentType: "application/json" },
  });
  token = encodePoll({ cast_id: CAST_ID, job_id: JOB_ID });
});

describe("cast-image /poll emits progressive images (cf#386)", () => {
  it("poll 1 is pending and carries the image it just rendered, asserted by content", async () => {
    const body = await pollOnce();
    expect(body.error).toBeUndefined();
    expect(body.ok).toBe(true);
    expect(body.pending).toBe(true);
    expect(body.progress).toEqual({ done: 1, total: TOTAL });
    // CONTENT, not presence. Both  images: []  and  images: state.done.slice(0, 0)  fail here,
    // because this pins the exact key and mime the module wrote to R2 on this tick.
    expect(body.images).toEqual([{ key: "cast-gen/42/ref_01.jpg", mime: "image/jpeg" }]);
    // and that key is a real object in the bucket, not a fixture string.
    expect(r2.store.has("cast-gen/42/ref_01.jpg")).toBe(true);
    expect(generateImage).toHaveBeenCalledTimes(1); // PER_POLL is 1
  });

  it("pending images accumulate one per poll while the queue drains", async () => {
    const expected: Img[] = [];
    for (let i = 1; i < TOTAL; i += 1) {
      expected.push({ key: "cast-gen/42/ref_0" + i + ".jpg", mime: "image/jpeg" });
      const body = await pollOnce();
      expect(body.pending).toBe(true);
      expect(body.progress).toEqual({ done: i, total: TOTAL });
      expect(body.images).toEqual(expected);
    }
  });

  it("the terminal poll drops pending and returns every image in the output", async () => {
    let body: PollBody = { ok: false };
    for (let i = 0; i < TOTAL; i += 1) body = await pollOnce();
    expect(body.ok).toBe(true);
    expect(body.pending).toBeUndefined();
    expect(body.progress).toBeUndefined();
    expect(body.images).toBeUndefined();
    const out = body.output;
    expect(out?.cast_id).toBe(CAST_ID);
    expect(out?.images).toEqual([
      { key: "cast-gen/42/ref_01.jpg", mime: "image/jpeg" },
      { key: "cast-gen/42/ref_02.jpg", mime: "image/jpeg" },
      { key: "cast-gen/42/ref_03.jpg", mime: "image/jpeg" },
      { key: "cast-gen/42/ref_04.jpg", mime: "image/jpeg" },
    ]);
    expect(out?.applied).toContain("generated:4");
  });
});
