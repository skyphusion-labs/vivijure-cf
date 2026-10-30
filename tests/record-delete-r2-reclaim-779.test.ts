import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  buildLiveKeyIndex,
  clipJobIdOf,
  isForeignRef,
  ownsVoiceRefKey,
  parseJobDocKeys,
  parseOutputJsonKeys,
  planReclaim,
  renderLogKeyFor,
  type RenderKeyRow,
} from "../src/record-reclaim";

// cf#779 (LG-2/LG-3). `docs/legal/PRIVACY.md` Section 7 is a PUBLISHED promise that the studio's
// delete actions "remove the corresponding records and free their stored files". Project delete and
// render delete removed the D1 row and freed NOTHING, and because `r2-orphan-reconcile.ts` treats
// every non-cast key as out-of-scope, the row was the last thing that named those objects.
//
// WHAT MAKES THESE TESTS ABLE TO GO RED, stated because a reclaim suite that only asserts "the right
// keys were deleted" is equally consistent with a handler that deletes EVERYTHING, which is the worse
// defect. Every case below is paired:
//
//   the LEAK direction   -- an object the record owned is still in the bucket after the delete
//   the OVER-DELETE      -- an object a SURVIVING record still names is gone after the delete
//
// The R2 fake is a real store, so both directions are observable as store contents rather than as
// call counts. It paginates at two objects per page, so an implementation that reads only the first
// `list` page fails the pagination case rather than passing it by luck of fixture size.

const PAGE = 2;

function makeR2(seed: string[] = []) {
  const store = new Set<string>(seed);
  const ops: string[] = [];
  const failDelete = new Set<string>();
  const bodies = new Map<string, string>();
  const binding = {
    list: async ({ prefix = "", cursor }: { prefix?: string; cursor?: string } = {}) => {
      ops.push(`list:${prefix}${cursor ? `@${cursor}` : ""}`);
      const all = [...store].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + PAGE);
      const next = start + PAGE;
      return next < all.length
        ? { objects: page.map((key) => ({ key, size: 1 })), truncated: true, cursor: String(next) }
        : { objects: page.map((key) => ({ key, size: 1 })), truncated: false };
    },
    get: async (key: string) => {
      ops.push(`get:${key}`);
      if (!store.has(key)) return null;
      const body = bodies.get(key);
      return body === undefined ? null : { text: async () => body };
    },
    head: async (key: string) => (store.has(key) ? { size: 1 } : null),
    delete: async (key: string) => {
      if (failDelete.has(key)) {
        ops.push(`delete-threw:${key}`);
        throw new Error("simulated R2 delete failure");
      }
      ops.push(`delete:${key}`);
      store.delete(key);
    },
    put: async (key: string, body?: unknown) => {
      store.add(key);
      if (typeof body === "string") bodies.set(key, body);
    },
  };
  const putDoc = (key: string, doc: unknown) => {
    store.add(key);
    bodies.set(key, JSON.stringify(doc));
  };
  return { store, ops, failDelete, binding, putDoc };
}

interface RenderFixture extends RenderKeyRow {
  project_id: number | null;
  public_id: string;
}

interface ShotFixture {
  film_id: string;
  still_key: string | null;
  wav_key: string | null;
  clip_key: string | null;
}

/** A D1 stand-in covering only the statements this change issues. It routes on SQL SHAPE, and
 *  throws on anything it does not recognise rather than returning an empty result: a fake that
 *  answers an unexpected query with `[]` makes a missing read look like an empty table, which is
 *  precisely the reassuring reading these tests exist to rule out. */
function makeDB(state: { renders: RenderFixture[]; shots: ShotFixture[] }) {
  const seen: string[] = [];
  const prepare = (sql: string) => {
    const flat = sql.replace(/\s+/g, " ").trim();
    let args: unknown[] = [];
    const stmt = {
      bind(...a: unknown[]) { args = a; return stmt; },
      async all<T>() {
        seen.push(flat);
        if (/FROM renders WHERE id IN/.test(flat)) {
          const ids = args as number[];
          return { results: state.renders.filter((r) => ids.includes(r.id)) as unknown as T[] };
        }
        if (/FROM renders WHERE id NOT IN/.test(flat)) {
          const ids = args as number[];
          return { results: state.renders.filter((r) => !ids.includes(r.id)) as unknown as T[] };
        }
        if (/FROM renders WHERE project_id =/.test(flat)) {
          return { results: state.renders.filter((r) => r.project_id === args[0]) as unknown as T[] };
        }
        if (/FROM renders$/.test(flat)) {
          return { results: state.renders as unknown as T[] };
        }
        if (/FROM shot_records WHERE film_id IN/.test(flat)) {
          const ids = args as string[];
          return { results: state.shots.filter((s) => ids.includes(s.film_id)) as unknown as T[] };
        }
        if (/FROM shot_records WHERE film_id =/.test(flat)) {
          return { results: state.shots.filter((s) => s.film_id === args[0]) as unknown as T[] };
        }
        throw new Error(`unstubbed D1 all(): ${flat}`);
      },
      async run() {
        seen.push(flat);
        if (/DELETE FROM shot_records WHERE film_id IN/.test(flat)) {
          const ids = args as string[];
          state.shots = state.shots.filter((s) => !ids.includes(s.film_id));
          return { meta: { changes: 1 } };
        }
        if (/DELETE FROM renders WHERE id IN/.test(flat)) {
          const ids = args as number[];
          state.renders = state.renders.filter((r) => !ids.includes(r.id));
          return { meta: { changes: 1 } };
        }
        throw new Error(`unstubbed D1 run(): ${flat}`);
      },
      async first<T>() {
        seen.push(flat);
        // countOtherRowsWithOutputKey (core/renders-db.js:679), the gate the #779 ruling names.
        if (/COUNT\(\*\) AS n FROM renders WHERE output_key = \? AND id != \?/.test(flat)) {
          const [key, id] = args as [string, number];
          const n = state.renders.filter((r) => r.output_key === key && r.id !== id).length;
          return { n } as unknown as T;
        }
        throw new Error(`unstubbed D1 first(): ${flat}`);
      },
    };
    return stmt;
  };
  return { db: { prepare } as unknown as never, seen, state };
}

const renderFixture = (over: Partial<RenderFixture> = {}): RenderFixture => ({
  id: 1,
  public_id: "11111111-1111-4111-8111-111111111111",
  job_id: "film-aaa",
  project: "heist",
  bundle_key: "bundles/heist-abc123def456.tar.gz",
  output_key: "renders/film-aaa/film.mp4",
  keyframes_json: JSON.stringify([{ shot_id: "s1", key: "renders/heist/keyframes/s1.png" }]),
  output_json: JSON.stringify({ output_key: "renders/film-aaa/film.mp4", sidecar_key: "renders/film-aaa/film.srt" }),
  project_id: 7,
  ...over,
});

// ---------------------------------------------------------------------------
// The pure core. These pin the ALLOWLIST, which is the part that decides whether a render delete
// reaches into another record's property.
// ---------------------------------------------------------------------------
describe("record-reclaim pure core", () => {
  it("harvests a job doc's own artifacts INCLUDING takes recorded nowhere else", () => {
    const keys = parseJobDocKeys({
      film_key: "renders/film-aaa/film.mp4",
      silent_film_key: "renders/film-aaa/film-silent.mp4",
      film_finish: { sidecar_key: "renders/film-aaa/film.srt" },
      shots: [
        {
          shot_id: "s1",
          clip_key: "renders/heist/clips/s1_wan.mp4",
          still_key: "renders/heist/keyframes/s1.png",
          wav_key: "renders/heist/dialogue/s1.wav",
          takes: [{ key: "renders/heist/clips/s1_wan_take1760000000000.mp4", at: 1 }],
        },
      ],
    });
    // The take is the one that matters: `archiveExistingClipTakes` records it ONLY in this doc, so a
    // delete that does not read the doc strands it forever. Drop `takes` from the parser and this is
    // the assertion that reddens.
    expect(keys).toContain("renders/heist/clips/s1_wan_take1760000000000.mp4");
    expect(keys).toContain("renders/film-aaa/film.mp4");
    expect(keys).toContain("renders/heist/dialogue/s1.wav");
  });

  it("REFUSES to harvest the fields another record owns, even though they sit in the same doc", () => {
    const keys = parseJobDocKeys({
      shots: [
        {
          shot_id: "s1",
          clip_key: "renders/heist/clips/s1_wan.mp4",
          // Cast-owned: cast_members.voice_ref_key. A render delete that swept every *_key field
          // would destroy a cast member's kept voice clip.
          voice_ref_key: "cast/9/voice-ref.mp4",
          // Upload-owned, reused by any render that selects it.
          audio_key: "audio/9f3c.wav",
          // Already named by renders.keyframes_json, and sometimes a cast PORTRAIT passed through.
          keyframe_key: "cast/9/portrait.png",
          last_keyframe_key: "cast/9/portrait.png",
        },
      ],
    });
    expect(keys).toEqual(["renders/heist/clips/s1_wan.mp4"]);
  });

  it("reads output_json only for the three fields that are keys", () => {
    const keys = parseOutputJsonKeys(JSON.stringify({
      output_key: "renders/film-aaa/film.mp4",
      sidecar_key: "renders/film-aaa/film.srt",
      clips: [{ shot_id: "s1", key: "renders/heist/clips/s1_wan.mp4" }],
      // None of these are keys, and all of them are strings.
      mode: "full",
      project: "heist",
      model: "wan-2.2",
      error: "renders/heist/clips/s1_wan.mp4 was unreadable",
    }));
    expect(keys).toEqual([
      "renders/film-aaa/film.mp4",
      "renders/film-aaa/film.srt",
      "renders/heist/clips/s1_wan.mp4",
    ]);
  });

  it("a malformed column yields no keys rather than throwing", () => {
    expect(parseOutputJsonKeys("{not json")).toEqual([]);
    expect(parseJobDocKeys("nope")).toEqual([]);
    expect(clipJobIdOf(null)).toBeNull();
  });

  it("the gate retains a key a survivor names, and the reason is recorded", () => {
    const survivor = renderFixture({ id: 2, job_id: "film-bbb" });
    const live = buildLiveKeyIndex({ renderRows: [survivor] });
    const plan = planReclaim(
      ["renders/heist/keyframes/s1.png", "renders/film-aaa/film-job.json"],
      live,
    );
    expect(plan.deletable).toEqual(["renders/film-aaa/film-job.json"]);
    expect(plan.retained.map((r) => r.key)).toEqual(["renders/heist/keyframes/s1.png"]);
    expect(plan.retained[0].reason).toMatch(/live record/);
  });

  it("treats a stored absolute URL as foreign, never as a key to delete", () => {
    // An absolute value in these columns is a live shape, not a dead one: the panel's artifactUrl
    // returns an absolute http(s):// value verbatim rather than routing it through /api/artifact/.
    // The demo seed that first produced them is gone (pr1019); the guard and this case are not.
    expect(isForeignRef("https://assets.skyphusion.net/vivijure/showcase/a.mp4")).toBe(true);
    expect(isForeignRef("renders/film-aaa/film.mp4")).toBe(false);
  });

  it("owns a voice ref only under the member's own tree, never the shared generated key", () => {
    expect(ownsVoiceRefKey(9, "cast/9/voice-ref.mp4")).toBe(true);
    // ONE key for every cast member (context.project="cast", shot_id="voice-sample").
    expect(ownsVoiceRefKey(9, "renders/cast/clips/voice-sample_cf-seedance.mp4")).toBe(false);
    expect(ownsVoiceRefKey(9, "cast/10/voice-ref.mp4")).toBe(false);
    expect(ownsVoiceRefKey(9, null)).toBe(false);
  });

  it("the render log is keyed off job_id but outside the render's own tree", () => {
    // render-log.js:3 says the UI re-derives this key rather than storing it, which is exactly why
    // nothing in D1 names it and why a `renders/<job_id>/` prefix sweep alone misses it.
    expect(renderLogKeyFor("film-aaa")).toBe("renders/logs/film-aaa.txt");
    expect(renderLogKeyFor("film-aaa").startsWith("renders/film-aaa/")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The live reclaim. A real (fake) bucket, so the assertions are STORE CONTENTS: what survived the
// delete and what did not. Every case names both failure directions.
// ---------------------------------------------------------------------------
describe("reclaimRenderRows: the leak direction and the over-delete direction", () => {
  let reclaim: typeof import("../src/record-reclaim-io").reclaimRenderRows;

  beforeEach(async () => {
    reclaim = (await import("../src/record-reclaim-io")).reclaimRenderRows;
  });

  /** The render tree, the project-shared families, the log, the bundle, and a take that exists only
   *  in the clips-job doc. Shaped from the real key builders, not invented. */
  function scene() {
    const r2 = makeR2([
      "renders/film-aaa/film.mp4",
      "renders/film-aaa/film.srt",
      "renders/film-aaa/partials/partial-001.mp4",
      "renders/film-aaa/partials/partial-002.mp4",
      "renders/logs/film-aaa.txt",
      "bundles/heist-abc123def456.tar.gz",
      "renders/heist/keyframes/s1.png",
      "renders/heist/keyframes/s1.png.prov",
      "renders/heist/clips/s1_wan.mp4",
      "renders/heist/clips/s1_wan.mp4.prov",
      "renders/heist/clips/s1_wan_take1760000000000.mp4",
      "renders/heist/dialogue/s1.wav",
    ]);
    r2.putDoc("renders/film-aaa/film-job.json", {
      film_id: "film-aaa",
      project: "heist",
      clip_job_id: "clips-aaa",
      film_key: "renders/film-aaa/film.mp4",
      film_finish: { sidecar_key: "renders/film-aaa/film.srt" },
      shots: [{ shot_id: "s1", clip_key: "renders/heist/clips/s1_wan.mp4" }],
    });
    r2.putDoc("renders/clips-aaa/clips-job.json", {
      job_id: "clips-aaa",
      project: "heist",
      shots: [{
        shot_id: "s1",
        clip_key: "renders/heist/clips/s1_wan.mp4",
        voice_ref_key: "cast/9/voice-ref.mp4",
        takes: [{ key: "renders/heist/clips/s1_wan_take1760000000000.mp4", at: 1760000000000 }],
      }],
    });
    r2.store.add("cast/9/voice-ref.mp4");
    return r2;
  }

  const shots = (): ShotFixture[] => [{
    film_id: "film-aaa",
    still_key: "renders/heist/keyframes/s1.png",
    wav_key: "renders/heist/dialogue/s1.wav",
    clip_key: "renders/heist/clips/s1_wan.mp4",
  }];

  it("CONTROL: a SOLE render's artifacts are all freed, including the four nothing in D1 names", async () => {
    const r2 = scene();
    const row = renderFixture();
    const { db } = makeDB({ renders: [row], shots: shots() });
    const env = { DB: db, R2_RENDERS: r2.binding } as unknown as never;

    const report = await reclaim(env, [row]);
    const left = [...r2.store].sort();
    expect(report.complete, `ops=${r2.ops.join(" ")}`).toBe(true);

    // THE LEAK DIRECTION. Pre-fix every one of these survived the delete. The four that no D1
    // column names are the interesting ones, because a reclaim built from the row alone misses them:
    for (const key of [
      "renders/logs/film-aaa.txt",                             // derived, never stored
      "renders/film-aaa/partials/partial-002.mp4",             // page 2 of the tree listing
      "renders/clips-aaa/clips-job.json",                      // id lives inside the film doc
      "renders/heist/clips/s1_wan_take1760000000000.mp4",      // named only in the clips doc
      "renders/heist/clips/s1_wan.mp4.prov",                   // suffix sidecar, named nowhere
    ]) {
      expect(left, `${key} LEAKED: still in the bucket after the only record naming it was deleted`)
        .not.toContain(key);
    }

    // THE OVER-DELETE DIRECTION, in the same assertion set so neither can be satisfied alone.
    expect(left, "a cast member's voice ref is not a render's property").toContain("cast/9/voice-ref.mp4");
    expect(left).toEqual(["cast/9/voice-ref.mp4"]);
  });

  it("CONTROL: a key a SURVIVING sibling still names is RETAINED, not freed", async () => {
    // Two renders of ONE project. `assertProjectKey` forces every module artifact to be
    // project-keyed, so this sharing is the rule, not an edge case: both rows name the same
    // keyframe, the same clip and the same content-addressed bundle.
    const r2 = scene();
    const doomed = renderFixture({ id: 1, job_id: "film-aaa" });
    const survivor = renderFixture({
      id: 2,
      public_id: "22222222-2222-4222-8222-222222222222",
      job_id: "film-bbb",
      output_key: "renders/film-bbb/film.mp4",
      output_json: JSON.stringify({ output_key: "renders/film-bbb/film.mp4" }),
    });
    const { db } = makeDB({
      renders: [doomed, survivor],
      shots: [...shots(), { film_id: "film-bbb", still_key: "renders/heist/keyframes/s1.png", wav_key: null, clip_key: "renders/heist/clips/s1_wan.mp4" }],
    });
    const env = { DB: db, R2_RENDERS: r2.binding } as unknown as never;

    const report = await reclaim(env, [doomed]);
    const left = [...r2.store].sort();
    const evidence = `retained=${report.retained.map((r) => r.key).join(",")} left=${left.join(",")}`;

    // Delete the gate and these three go: a sibling render loses its only copy of its clips,
    // its keyframes and its bundle, which is worse than the leak this change closes.
    expect(left, `keyframe destroyed under a live sibling. ${evidence}`).toContain("renders/heist/keyframes/s1.png");
    expect(left, `clip destroyed under a live sibling. ${evidence}`).toContain("renders/heist/clips/s1_wan.mp4");
    expect(left, `shared content-addressed bundle destroyed. ${evidence}`).toContain("bundles/heist-abc123def456.tar.gz");
    // The sidecar of a RETAINED artifact is never even looked at, so it survives with it.
    expect(left, `the provenance sidecar of a retained clip went with it. ${evidence}`).toContain("renders/heist/clips/s1_wan.mp4.prov");
    // ...while the doomed render's own exclusive tree still goes. Without this the test would also
    // pass against a handler that deletes nothing at all.
    expect(left, `the doomed render's own film doc survived. ${evidence}`).not.toContain("renders/film-aaa/film-job.json");
    expect(left, `the doomed render's own log survived. ${evidence}`).not.toContain("renders/logs/film-aaa.txt");
    expect(report.retained.length, evidence).toBeGreaterThan(0);
  });

  it("CONTROL: a shared output_key is retained, which is countOtherRowsWithOutputKey doing its job", async () => {
    // The one guard core wrote for this and nothing called. Two rows, one output_key, as happens
    // when a re-render of a project lands on the same filename.
    const r2 = makeR2(["renders/heist/final.mp4", "renders/logs/film-aaa.txt"]);
    const doomed = renderFixture({ id: 1, job_id: "film-aaa", output_key: "renders/heist/final.mp4", output_json: null, keyframes_json: null, bundle_key: null });
    const twin = renderFixture({ id: 2, public_id: "22222222-2222-4222-8222-222222222222", job_id: "film-bbb", output_key: "renders/heist/final.mp4", output_json: null, keyframes_json: null, bundle_key: null });
    const { db, seen } = makeDB({ renders: [doomed, twin], shots: [] });
    const env = { DB: db, R2_RENDERS: r2.binding } as unknown as never;

    const report = await reclaim(env, [doomed]);
    const evidence = `seen=${seen.join(" | ")} left=${[...r2.store].join(",")}`;
    expect(seen.some((q) => /COUNT\(\*\) AS n FROM renders WHERE output_key/.test(q)), `the named gate was never consulted. ${evidence}`).toBe(true);
    expect([...r2.store], `the twin row's output was destroyed. ${evidence}`).toContain("renders/heist/final.mp4");
    expect(report.retained.map((r) => r.key)).toContain("renders/heist/final.mp4");
  });

  it("CONTROL: a project cascade frees a key its two renders SHARE, which the named gate alone would retain", async () => {
    // The bound on countOtherRowsWithOutputKey. It counts rows with `id != ?`, so for render 1 it
    // sees render 2 and says "still referenced" -- while render 2 is being deleted in the SAME
    // operation. Trusting it here would leak the key forever. Passing both rows to one reclaim is
    // what makes the cascade correct.
    const r2 = makeR2(["renders/heist/final.mp4", "renders/logs/film-aaa.txt", "renders/logs/film-bbb.txt"]);
    const a = renderFixture({ id: 1, job_id: "film-aaa", output_key: "renders/heist/final.mp4", output_json: null, keyframes_json: null, bundle_key: null });
    const b = renderFixture({ id: 2, public_id: "22222222-2222-4222-8222-222222222222", job_id: "film-bbb", output_key: "renders/heist/final.mp4", output_json: null, keyframes_json: null, bundle_key: null });
    const { db } = makeDB({ renders: [a, b], shots: [] });
    const env = { DB: db, R2_RENDERS: r2.binding } as unknown as never;

    const report = await reclaim(env, [a, b]);
    const left = [...r2.store].sort();
    expect(report.complete, `left=${left.join(",")}`).toBe(true);
    expect(left, "a key whose every owner was deleted in one operation LEAKED").toEqual([]);
  });

  it("CONTROL: the whole tree is freed across list pages, not just the first", async () => {
    // Six objects under one prefix at a page size of two. An implementation that reads one page
    // leaves four behind and reports success, which is the exact shape of a sweep that looks healthy.
    const tree = [1, 2, 3, 4, 5, 6].map((n) => `renders/film-aaa/partials/partial-00${n}.mp4`);
    const r2 = makeR2([...tree, "renders/logs/film-aaa.txt"]);
    const row = renderFixture({ output_key: null, output_json: null, keyframes_json: null, bundle_key: null });
    const { db } = makeDB({ renders: [row], shots: [] });
    const env = { DB: db, R2_RENDERS: r2.binding } as unknown as never;

    const report = await reclaim(env, [row]);
    expect(report.complete).toBe(true);
    expect([...r2.store], `pagination not followed; ops=${r2.ops.join(" ")}`).toEqual([]);
    // The cursor was actually used, so this case is testing pagination and not fixture size.
    expect(r2.ops.filter((o) => o.startsWith("list:renders/film-aaa/@")).length).toBeGreaterThan(0);
  });

  it("CONTROL: an R2 delete failure refuses the delete rather than reporting success", async () => {
    const r2 = scene();
    r2.failDelete.add("renders/heist/dialogue/s1.wav");
    const row = renderFixture();
    const { db } = makeDB({ renders: [row], shots: shots() });
    const env = { DB: db, R2_RENDERS: r2.binding } as unknown as never;

    const report = await reclaim(env, [row]);
    // The caller keys the D1 delete off `complete`. If this ever reads true on a failed delete, the
    // row is dropped and that object is unreachable for good.
    expect(report.complete, `failed=${JSON.stringify(report.failed)}`).toBe(false);
    expect(report.failed.map((f) => f.key)).toEqual(["renders/heist/dialogue/s1.wav"]);
  });

  it("CONTROL: a truncated read deletes NOTHING, because an under-read live set over-deletes", async () => {
    // A budget too small to finish the reads. The dangerous direction is not the leak, it is
    // planning against a live set we know is incomplete, so the refusal is total.
    const r2 = scene();
    const row = renderFixture();
    const { db } = makeDB({ renders: [row], shots: shots() });
    const env = { DB: db, R2_RENDERS: r2.binding } as unknown as never;
    const before = [...r2.store].sort();

    const report = await reclaim(env, [row], { budget: 3 });
    expect(report.complete).toBe(false);
    expect(report.deleted, "deleted against a listing known to be partial").toEqual([]);
    expect([...r2.store].sort(), "the bucket was mutated on a refused reclaim").toEqual(before);
  });
});

describe("reclaimRenderRows: a listing that says there is more", () => {
  it("CONTROL: truncated with NO cursor deletes nothing, even with budget to spare", async () => {
    // R2 can answer `truncated: true` without handing back a usable cursor. The loop cannot
    // continue, so the read is PARTIAL -- and a partial read must never be planned against, because
    // an under-read live set over-deletes a sibling's only copy. This case has budget left over, so
    // it isolates the truncation guard from the subrequest budget (which is what left the earlier
    // version of this claim untestable: an exhausted budget also starves the delete loop, so the
    // bucket was untouched either way and the assertion could not fail).
    const { reclaimRenderRows } = await import("../src/record-reclaim-io");
    const store = new Set(["renders/film-aaa/film-job.json", "renders/film-aaa/a.mp4", "renders/logs/film-aaa.txt"]);
    const binding = {
      list: async ({ prefix = "" }: { prefix?: string } = {}) => ({
        objects: [...store].filter((k) => k.startsWith(prefix)).slice(0, 1).map((key) => ({ key, size: 1 })),
        truncated: true, // and deliberately no cursor
      }),
      get: async () => null,
      head: async (key: string) => (store.has(key) ? { size: 1 } : null),
      delete: async (key: string) => { store.delete(key); },
      put: async () => {},
    };
    const row = renderFixture({ output_key: null, output_json: null, keyframes_json: null, bundle_key: null });
    const { db } = makeDB({ renders: [row], shots: [] });
    const env = { DB: db, R2_RENDERS: binding } as unknown as never;
    const before = [...store].sort();

    const report = await reclaimRenderRows(env, [row], { budget: 500 });
    expect(report.complete, "a partial listing was reported as a complete reclaim").toBe(false);
    expect(report.spent, "this case must NOT be a budget-exhaustion case in disguise").toBeLessThan(500);
    expect(report.deleted, "deleted against a listing that said there was more").toEqual([]);
    expect([...store].sort()).toEqual(before);
  });
});

describe("parseJobDocKeys and job-scoped stills (cf#1059)", () => {
  const own = "renders/p/keyframes/kf-1/shot_01.png";
  const flat = "renders/p/keyframes/shot_01.png";

  it("names a full film's job-scoped still, because no row names it", () => {
    expect(parseJobDocKeys({ keyframes: [{ shot_id: "shot_01", keyframe_key: own }] })).toContain(own);
  });

  it("does not name a flat shared still", () => {
    expect(parseJobDocKeys({ keyframes: [{ shot_id: "shot_01", keyframe_key: flat }] })).toEqual([]);
  });

  it("a from-keyframes child names none of its parent's stills", () => {
    expect(parseJobDocKeys({ derive_mode: "finalized", keyframes: [{ shot_id: "shot_01", keyframe_key: own }] })).toEqual([]);
  });
});
