import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CastRefsJob } from "../src/cast-image-orchestrator";

// cf#386 -- the WIRING, which review 4940729370 measured as uncovered on a 2841-green suite.
//
// The PR shipped a pure helper (`freshCastRefImages`) with a good unit test, but the feature lives in
// `advanceCastRefsJob`: fold a pending poll's progressive images onto the cast member so `registered`
// moves while the job runs. Two separate mutations each reduced cf#386 to a no-op with the whole
// suite still green -- deleting the pending-branch fold, and making the module emit `images: []`.
// A test that covers the pure function and not the caller cannot see either.
//
// Three things are pinned here, one per blocking review item:
//   1. a pending poll carrying images registers them BEFORE the terminal batch, with the legacy bare
//      `{ pending: true }` shape as the paired case proving it stays 0;
//   2. a terminal `addRefs` failure is LOUD (phase "failed", "k of n"), never `phase: "done"` with a
//      self-consistent `registered` -- driven live here, not read from source;
//   3. a non-conformant mid-run image is refused by the same predicate the terminal branch applies,
//      instead of being appended verbatim onto the member.
//
// Every payload is NON-DEFAULT on purpose: on an empty `images` array, folded and not-folded are
// byte-identical, so an empty-array probe would pass with the feature removed.

const addRefs = vi.fn();
const CAST_ID = 7;
const PUB = "a7000000-0000-4000-8000-000000000007";

vi.mock("@skyphusion-labs/vivijure-core/cast-db", () => ({
  addRefs: (...a: unknown[]) => addRefs(...a),
  getCastById: async () => ({ id: CAST_ID, public_id: PUB, name: "Ada", portrait_key: "p.png", source_keys: [], ref_keys: [] }),
}));

const pollModule = vi.fn();

vi.mock("@skyphusion-labs/vivijure-core/modules/registry", () => ({
  pollModule: (...a: unknown[]) => pollModule(...a),
  resolveFetcher: () => ({ fetch: async () => new Response("{}") }),
  discoverModules: async () => [],
  resolvePickOne: () => null,
  invokeModule: async () => ({ ok: false, error: "not used in this file" }),
  validateConfig: (_s: unknown, c: unknown) => c ?? {},
}));

// `hookOutputViolation` is deliberately NOT mocked. The terminal branch's contract check is the thing
// item 3 compares the pending branch against, so it stays the real implementation -- a stub would
// encode this test's own idea of the contract instead of the contract.

/** A real-enough R2 for the job doc: what `putJob` writes is what the next advance reads. */
function makeR2() {
  const store = new Map<string, string>();
  return {
    store,
    binding: {
      put: async (key: string, value: string) => { store.set(key, value); },
      get: async (key: string) => {
        const hit = store.get(key);
        return hit === undefined ? null : { text: async () => hit };
      },
    },
  };
}

const JOB_ID = "refs-cf386";
const JOB_KEY = `cast-gen/${CAST_ID}/${JOB_ID}.refs-job.json`;

function seedJob(r2: ReturnType<typeof makeR2>, over: Partial<CastRefsJob> = {}): CastRefsJob {
  const job: CastRefsJob = {
    job_id: JOB_ID,
    cast_id: CAST_ID,
    cast_public_id: PUB,
    module_name: "cast-image",
    binding: "MODULE_CAST_IMAGE",
    phase: "generating",
    module_poll: "poll-token-1",
    images: [],
    applied: [],
    registered: 0,
    created_at: 0,
    ...over,
  };
  r2.store.set(JOB_KEY, JSON.stringify(job));
  return job;
}

/** The two images the module renders first. Distinct mimes so a mime that survives verbatim is
 *  visible, and real `cast-gen/<id>/ref_NN` keys so the assertion is on the module's own naming. */
const IMG1 = { key: `cast-gen/${CAST_ID}/ref_01.png`, mime: "image/png" };
const IMG2 = { key: `cast-gen/${CAST_ID}/ref_02.jpg`, mime: "image/jpeg" };
const IMG3 = { key: `cast-gen/${CAST_ID}/ref_03.webp`, mime: "image/webp" };

/** The row `addRefs` returns on success. Only its truthiness is read by the orchestrator. */
const OK_ROW = { id: CAST_ID, public_id: PUB };

async function advance(env: unknown) {
  const { advanceCastRefsJob } = await import("../src/cast-image-orchestrator");
  return advanceCastRefsJob(env as never, CAST_ID, JOB_ID);
}

/** What actually landed in R2, which is what the NEXT poll of the job will read. Asserting only on
 *  the returned object would pass even if the job doc were never persisted. */
function persisted(r2: ReturnType<typeof makeR2>): CastRefsJob {
  return JSON.parse(r2.store.get(JOB_KEY) as string) as CastRefsJob;
}

describe("cast-refs progressive registration, the wiring (cf#386)", () => {
  beforeEach(() => {
    addRefs.mockReset();
    pollModule.mockReset();
    addRefs.mockResolvedValue(OK_ROW);
  });

  it("a pending poll carrying images registers them onto the member mid-run", async () => {
    const r2 = makeR2();
    seedJob(r2);
    pollModule.mockResolvedValue({
      ok: true,
      pending: true,
      progress: { done: 2, total: 5 },
      images: [IMG1, IMG2],
    });

    const job = await advance({ R2_RENDERS: r2.binding });

    expect(addRefs).toHaveBeenCalledTimes(1);
    expect(addRefs.mock.calls[0][1]).toBe(CAST_ID);
    expect(addRefs.mock.calls[0][2]).toEqual([IMG1, IMG2]);
    // The point of cf#386: registered moved BEFORE the terminal batch, while still generating.
    expect(job?.phase).toBe("generating");
    expect(job?.registered).toBe(2);
    expect(job?.images).toEqual([IMG1, IMG2]);
    expect(persisted(r2).registered).toBe(2);
    expect(persisted(r2).images).toEqual([IMG1, IMG2]);
  });

  it("a legacy bare { pending: true } module registers nothing until the terminal batch", async () => {
    const r2 = makeR2();
    seedJob(r2);
    pollModule.mockResolvedValue({ ok: true, pending: true });

    const job = await advance({ R2_RENDERS: r2.binding });

    expect(addRefs).not.toHaveBeenCalled();
    expect(job?.registered).toBe(0);
    expect(job?.images).toEqual([]);
    expect(job?.phase).toBe("generating");
    expect(job?.error).toBeUndefined();
  });

  it("a second pending poll folds only the NEW key (addRefs is append-only)", async () => {
    const r2 = makeR2();
    seedJob(r2, { images: [IMG1, IMG2], registered: 2 });
    pollModule.mockResolvedValue({ ok: true, pending: true, images: [IMG1, IMG2, IMG3] });

    const job = await advance({ R2_RENDERS: r2.binding });

    expect(addRefs).toHaveBeenCalledTimes(1);
    expect(addRefs.mock.calls[0][2]).toEqual([IMG3]); // not the two already written
    expect(job?.registered).toBe(3);
    expect(job?.images).toEqual([IMG1, IMG2, IMG3]);
  });

  it("the terminal batch after progressive folds registers the residual and completes", async () => {
    const r2 = makeR2();
    seedJob(r2, { images: [IMG1, IMG2], registered: 2 });
    pollModule.mockResolvedValue({
      ok: true,
      output: { cast_id: CAST_ID, images: [IMG1, IMG2, IMG3], applied: ["model:flux-2-klein-9b", "generated:3"] },
    });

    const job = await advance({ R2_RENDERS: r2.binding });

    expect(addRefs).toHaveBeenCalledTimes(1);
    expect(addRefs.mock.calls[0][2]).toEqual([IMG3]);
    expect(job?.phase).toBe("done");
    expect(job?.registered).toBe(3);
    expect(job?.applied).toEqual(["model:flux-2-klein-9b", "generated:3"]);
  });

  // ---- blocking item 2: a registration failure must not read as success ----

  it("a terminal addRefs failure fails the job LOUDLY instead of reporting done", async () => {
    const r2 = makeR2();
    seedJob(r2);
    addRefs.mockResolvedValue(null); // the cast row is gone: nothing was written
    pollModule.mockResolvedValue({
      ok: true,
      output: { cast_id: CAST_ID, images: [IMG1, IMG2], applied: ["generated:2"] },
    });

    const job = await advance({ R2_RENDERS: r2.binding });

    expect(job?.phase).toBe("failed");
    expect(job?.phase).not.toBe("done");
    expect(job?.error).toContain("registered 0 of 2");
    expect(job?.error).toContain("cast row unavailable");
    expect(persisted(r2).phase).toBe("failed");
  });

  it("a partial registration reports k of n, not a self-consistent silence", async () => {
    const r2 = makeR2();
    seedJob(r2, { images: [IMG1], registered: 1 }); // one landed mid-run
    addRefs.mockResolvedValue(null);
    pollModule.mockResolvedValue({
      ok: true,
      output: { cast_id: CAST_ID, images: [IMG1, IMG2, IMG3], applied: ["generated:3"] },
    });

    const job = await advance({ R2_RENDERS: r2.binding });

    expect(job?.phase).toBe("failed");
    expect(job?.error).toContain("registered 1 of 3");
    // The refs that DID land stay on the member and stay reported.
    expect(job?.registered).toBe(1);
    expect(job?.images).toEqual([IMG1]);
  });

  it("a mid-run drop that the terminal batch recovers still completes (not a sticky counter)", async () => {
    const r2 = makeR2();
    seedJob(r2);
    addRefs.mockResolvedValueOnce(null); // mid-run fold fails...
    pollModule.mockResolvedValue({ ok: true, pending: true, images: [IMG1, IMG2] });
    const midrun = await advance({ R2_RENDERS: r2.binding });
    expect(midrun?.registered).toBe(0);
    expect(midrun?.phase).toBe("generating");

    addRefs.mockResolvedValue(OK_ROW); // ...and the terminal write succeeds
    pollModule.mockResolvedValue({
      ok: true,
      output: { cast_id: CAST_ID, images: [IMG1, IMG2], applied: ["generated:2"] },
    });
    const job = await advance({ R2_RENDERS: r2.binding });

    expect(job?.phase).toBe("done");
    expect(job?.error).toBeUndefined();
    expect(job?.registered).toBe(2);
    expect(job?.images).toEqual([IMG1, IMG2]);
  });

  // ---- blocking item 3: mid-run images are held to the hook-output contract ----

  it("a non-conformant mid-run image is refused, not appended verbatim onto the member", async () => {
    const r2 = makeR2();
    seedJob(r2);
    pollModule.mockResolvedValue({
      ok: true,
      pending: true,
      // `addRefs` writes into ref_keys_json with no validation of its own, and the identical payload
      // on the TERMINAL poll is refused by hookOutputViolation ("each cast.image needs key + mime").
      images: [IMG1, { key: 123, mime: {} }],
    });

    const job = await advance({ R2_RENDERS: r2.binding });

    expect(addRefs).not.toHaveBeenCalled();
    expect(job?.phase).toBe("failed");
    expect(job?.error).toContain("each cast.image needs key + mime");
    expect(job?.images).toEqual([]);
    expect(job?.registered).toBe(0);
  });

  it("the same payload on the TERMINAL poll is refused too (the contract both branches share)", async () => {
    const r2 = makeR2();
    seedJob(r2);
    pollModule.mockResolvedValue({
      ok: true,
      output: { cast_id: CAST_ID, images: [IMG1, { key: 123, mime: {} }], applied: ["generated:2"] },
    });

    const job = await advance({ R2_RENDERS: r2.binding });

    expect(addRefs).not.toHaveBeenCalled();
    expect(job?.phase).toBe("failed");
    expect(job?.error).toContain("each cast.image needs key + mime");
  });
});
