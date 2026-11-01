import { describe, it, expect } from "vitest";
import {
  advanceParent,
  buildParentDoc,
  keyframeBackendForStyle,
  markRetake,
  MAX_PARTS,
  MAX_PARTS_IN_FLIGHT,
  JoinTransient,
  JOIN_MISSING_STREAK,
  JOIN_TIMEOUT_MS,
  mergeSrt,
  ONE_UPLOAD_BYTES,
  requestFingerprint,
  resumeParent,
  parentView,
  partInputs,
  planPartRanges,
  raiseCeiling,
  retakeScenesAndLines,
  retryPart,
  STALE_CLAIM_MS,
  SubmitNotStarted,
  SubmitRefused,
  type ChildRead,
  type CreateParentBody,
  type JoinRead,
  type ParentDeps,
  type ParentDoc,
} from "../src/film-parent";

function body(shots: number, over: Partial<CreateParentBody> = {}): CreateParentBody {
  return {
    project: "Long",
    storyboard: {
      title: "t",
      scenes: Array.from({ length: shots }, (_, i) => ({ shot_id: `s${i}`, prompt: `p${i}`, seconds: 4 })),
    },
    character_refs: { A: { key: "a" } },
    dialogue_lines: [{ shot_id: "s0", text: "hello", voice_id: "athena" }, { shot_id: "s2", text: "there" }],
    part_size: 2,
    shared: { motion_backend: "infinitetalk", style: "photoreal", delivery_width: 1920, delivery_height: 1080 },
    spend_ceiling_usd: 1000,
    cost_usd_per_shot_est: 1,
    pause_after_first_part: false,
    ...over,
  };
}

function harness(doc: ParentDoc) {
  const h = {
    retakes: [] as Array<[import("../src/film-parent").PartRetake, string]>,
    saves: 0,
    loseSaveAt: -1,
    bundles: [] as Array<Record<string, unknown>>,
    starts: [] as Array<Record<string, unknown>>,
    children: new Map<string, ChildRead | null>(),
    held: null as string | null,
    found: null as string | null,
    foundSince: [] as number[],
    reloads: 0,
    joins: [] as string[][],
    join: { status: "pending" } as JoinRead,
    joinThrows: false,
    texts: new Map<string, string>(),
    written: new Map<string, string>(),
  };
  const deps: ParentDeps = {
    async save() {
      h.saves += 1;
      return h.saves !== h.loseSaveAt;
    },
    async reload() {
      h.reloads += 1;
      return JSON.parse(JSON.stringify(doc));
    },
    async findChild(_project, since) {
      h.foundSince.push(since);
      return h.found;
    },
    async admitSubmit() {
      return h.held;
    },
    async bundle(args) {
      h.bundles.push(args);
      return `bundles/${String(args.storyboard.project)}.tar.gz`;
    },
    async start(b) {
      h.starts.push(b);
      return `film-${h.starts.length}`;
    },
    async startRetake(retake, key) {
      h.retakes.push([JSON.parse(JSON.stringify(retake)), key]);
      return `film-retake-${h.retakes.length}`;
    },
    async readChild(id) {
      return h.children.has(id) ? (h.children.get(id) as ChildRead | null) : { phase: "clips", shots_done: 1, output_key: null, sidecar_key: null, error: null };
    },
    async submitJoin(_d, keys) {
      if (h.joinThrows) throw new Error("door down");
      h.joins.push(keys);
      return "join-job";
    },
    async readJoin() {
      return h.join;
    },
    async readText(key) {
      return h.texts.get(key) ?? null;
    },
    async writeText(key, text) {
      h.written.set(key, text);
    },
  };
  return { h, deps, doc };
}

const done = (key: string, sidecar: string | null = null): ChildRead => ({ phase: "done", shots_done: 2, output_key: key, sidecar_key: sidecar, error: null });

describe("planning parts", () => {
  it("splits by part size and by breaks", () => {
    expect(planPartRanges(5, 2, undefined)).toEqual([[0, 1], [2, 3], [4, 4]]);
    expect(planPartRanges(5, undefined, [1, 3])).toEqual([[0, 0], [1, 2], [3, 4]]);
  });
  it("refuses both, neither, bad breaks, an oversize part and too many parts", () => {
    expect(() => planPartRanges(5, 2, [1])).toThrow(/not both/);
    expect(() => planPartRanges(5, undefined, undefined)).toThrow(/required/);
    expect(() => planPartRanges(5, undefined, [3, 2])).toThrow(/rising/);
    expect(() => planPartRanges(5, undefined, [5])).toThrow(/inside/);
    expect(() => planPartRanges(41, 41, undefined)).toThrow(/limit is 40/);
    expect(() => planPartRanges(MAX_PARTS + 1, 1, undefined)).toThrow(/limit is 64/);
    expect(planPartRanges(MAX_PARTS, 1, undefined)).toHaveLength(MAX_PARTS);
  });
});

describe("creating a parent refuses what would fail or spend blind", () => {
  const cases: Array<[string, Partial<CreateParentBody>, RegExp]> = [
    ["no frame", { shared: { motion_backend: "m", style: "photoreal" } }, /delivery_width/],
    ["a bed", { shared: { motion_backend: "m", style: "photoreal", delivery_width: 1, delivery_height: 1, audio_key: "x" } }, /audio_key/],
    ["no ceiling", { spend_ceiling_usd: undefined }, /spend_ceiling_usd/],
    ["no estimate", { cost_usd_per_shot_est: 0 }, /cost_usd_per_shot_est/],
    ["a line on an unknown shot", { dialogue_lines: [{ shot_id: "nope", text: "x" }] }, /unknown shot/],
    ["an override outside the parts", { part_overrides: [{ index: 99 }] }, /outside/],
    ["a bad style", { shared: { motion_backend: "m", style: "pixel", delivery_width: 1, delivery_height: 1 } }, /style/],
  ];
  for (const [name, over, re] of cases) {
    it(name, () => {
      expect(() => buildParentDoc("f", body(4, over), 0)).toThrow(re);
    });
  }
  it("refuses a scene with no seconds, because size and spend come from them", () => {
    const b = body(2, { dialogue_lines: [] });
    (b.storyboard as { scenes: unknown[] }).scenes = [{ shot_id: "a", seconds: 4 }, { shot_id: "b" }];
    expect(() => buildParentDoc("f", b, 0)).toThrow(/seconds above 0/);
  });

  it("refuses a repeated shot id", () => {
    const b = body(2);
    (b.storyboard as { scenes: unknown[] }).scenes = [{ shot_id: "a", seconds: 4 }, { shot_id: "a", seconds: 4 }];
    expect(() => buildParentDoc("f", { ...b, dialogue_lines: [] }, 0)).toThrow(/own shot_id/);
  });
});

describe("what a part submits", () => {
  const doc = buildParentDoc("f", body(5, {
    part_overrides: [{ index: 1, cast_loras: { A: "other" }, motion_backend: "cf-hailuo" }],
    shared: {
      motion_backend: "infinitetalk", style: "photoreal", delivery_width: 1920, delivery_height: 1080,
      cast_loras: { A: "main" }, film_titles: { title: { text: "T" }, credits: { lines: ["C"] } },
    },
  }), 0);

  it("renames shots and moves each line with its shot", () => {
    const { submit, bundleArgs } = partInputs(doc, doc.parts[1]);
    expect((submit.scenes as Array<{ shot_id: string; prompt: string }>).map((s) => [s.shot_id, s.prompt])).toEqual([["shot_01", "p2"], ["shot_02", "p3"]]);
    expect(submit.dialogue_lines).toEqual([{ shot_id: "shot_01", text: "there" }]);
    expect(bundleArgs.storyboard.projectName).toBe("Long_f_p01");
  });
  it("lets cast and door differ per part", () => {
    expect(partInputs(doc, doc.parts[1]).submit.cast_loras).toEqual({ A: "other" });
    expect(partInputs(doc, doc.parts[1]).submit.motion_backend).toBe("cf-hailuo");
    expect(partInputs(doc, doc.parts[0]).submit.cast_loras).toEqual({ A: "main" });
  });
  it("puts the title on the first part and credits on the last, and neither between", () => {
    expect(partInputs(doc, doc.parts[0]).submit.film_titles).toEqual({ title: { text: "T" } });
    expect(partInputs(doc, doc.parts[1]).submit.film_titles).toBeUndefined();
    expect(partInputs(doc, doc.parts[2]).submit.film_titles).toEqual({ credits: { lines: ["C"] } });
  });
  it("pins the frame, keeps paid work, and derives the keyframe door from style", () => {
    const { submit } = partInputs(doc, doc.parts[0]);
    expect([submit.delivery_width, submit.delivery_height, submit.reuse_finished]).toEqual([1920, 1080, true]);
    expect(submit.keyframe_backend).toBe("keyframe");
    expect(keyframeBackendForStyle("anime")).toBe("cloud-keyframe");
    expect(keyframeBackendForStyle("anime", "keyframe")).toBe("keyframe");
  });
});

describe("the order of work", () => {
  it("runs the first part alone, then at most the limit at once", async () => {
    const { h, deps, doc } = harness(buildParentDoc("f", body(12), 0));
    await advanceParent(doc, deps, 1);
    expect(h.starts).toHaveLength(1);
    await advanceParent(doc, deps, 2);
    expect(h.starts, "the first part must run alone").toHaveLength(1);
    h.children.set("film-1", done("k1"));
    await advanceParent(doc, deps, 3);
    expect(h.starts).toHaveLength(1 + MAX_PARTS_IN_FLIGHT);
    await advanceParent(doc, deps, 4);
    expect(h.starts).toHaveLength(1 + MAX_PARTS_IN_FLIGHT);
  });

  it("a failed part stops new submits and running parts still finish", async () => {
    const { h, deps, doc } = harness(buildParentDoc("f", body(12), 0));
    await advanceParent(doc, deps, 1);
    h.children.set("film-1", done("k1"));
    await advanceParent(doc, deps, 2);
    h.children.set("film-2", { phase: "failed", shots_done: 0, output_key: null, sidecar_key: null, error: "boom" });
    h.children.set("film-3", done("k3"));
    await advanceParent(doc, deps, 3);
    const before = h.starts.length;
    expect(doc.phase).toBe("stopped");
    expect(doc.stop_reason).toBe("part 1 failed");
    expect(doc.parts[1].error).toBe("boom");
    expect(doc.parts[2].status).toBe("done");
    await advanceParent(doc, deps, 4);
    expect(h.starts).toHaveLength(before);
  });

  it("the spend ceiling stops the part that would cross it", async () => {
    const { h, deps, doc } = harness(buildParentDoc("f", body(8, { spend_ceiling_usd: 4 }), 0));
    await advanceParent(doc, deps, 1);
    h.children.set("film-1", done("k1"));
    await advanceParent(doc, deps, 2);
    expect(h.starts, "2 parts at $2 reach $4, and a third would cross").toHaveLength(2);
    expect(doc.stop_reason).toBe("spend ceiling");
    h.children.set("film-2", done("k2"));
    await advanceParent(doc, deps, 3);
    expect(h.starts).toHaveLength(2);
    expect(doc.phase).toBe("stopped");
  });

  it("a tick that loses its claim does not submit", async () => {
    const { h, deps, doc } = harness(buildParentDoc("f", body(4), 0));
    h.loseSaveAt = 1;
    await advanceParent(doc, deps, 1);
    expect(h.starts, "the claim did not land").toHaveLength(0);
    expect(h.bundles).toHaveLength(0);
  });

  it("a finished part stays finished when its job record later goes", async () => {
    const { h, deps, doc } = harness(buildParentDoc("f", body(4), 0));
    await advanceParent(doc, deps, 1);
    h.children.set("film-1", done("k1"));
    await advanceParent(doc, deps, 2);
    h.children.set("film-1", null);
    await advanceParent(doc, deps, 3);
    expect(doc.parts[0].status).toBe("done");
    expect(doc.parts[0].output_key).toBe("k1");
  });

  it("a stale claim adopts a film in its project since the claim, and buys nothing", async () => {
    const { h, deps, doc } = harness(buildParentDoc("f", body(2, { part_size: 2, dialogue_lines: [] }), 0));
    doc.parts[0].status = "submitting";
    doc.parts[0].claimed_at = 1000;
    h.found = "film-found";
    await advanceParent(doc, deps, 1000 + STALE_CLAIM_MS);
    expect(h.foundSince, "bounded by the claim, so an older film cannot match").toEqual([1000]);
    expect(h.starts).toHaveLength(0);
    expect(doc.parts[0].child_film_id).toBe("film-found");
    expect(doc.parts[0].status).toBe("running");
    expect(doc.parts[0].attempts, "the adopted film was already counted at its claim").toBe(0);
  });

  it("a stale claim with no film never submits: it asks a person, naming the project", async () => {
    const { h, deps, doc } = harness(buildParentDoc("f", body(2, { part_size: 2, dialogue_lines: [] }), 0));
    doc.parts[0].status = "submitting";
    doc.parts[0].claimed_at = 0;
    await advanceParent(doc, deps, STALE_CLAIM_MS);
    expect(h.starts).toHaveLength(0);
    expect(doc.parts[0].status).toBe("failed");
    expect(doc.parts[0].error).toMatch(/outcome unknown.*Long_f_p00.*twice/);
    await advanceParent(doc, deps, STALE_CLAIM_MS + 1);
    expect(doc.phase).toBe("stopped");
    expect(h.starts).toHaveLength(0);
  });

  it("a door 5xx started nothing: the part waits, counts nothing, and goes on the next tick", async () => {
    const { h, deps, doc } = harness(buildParentDoc("f", body(4), 0));
    const start = deps.start;
    deps.start = async () => { throw new SubmitNotStarted("submit refused (503): usage read failed"); };
    await advanceParent(doc, deps, 1);
    expect(doc.parts[0].status).toBe("pending");
    expect(doc.parts[0].claimed_at).toBeNull();
    expect(doc.parts[0].attempts).toBe(0);
    expect(doc.parts[0].error).toMatch(/503/);
    expect(doc.phase).toBe("running");
    deps.start = start;
    await advanceParent(doc, deps, 2);
    expect(h.starts).toHaveLength(1);
    expect(h.starts[0].idempotency_key, "the same request, so the same key").toBe("f-p00-g0");
    expect(doc.parts[0].status).toBe("running");
    expect(doc.parts[0].error).toBeNull();
    expect(doc.parts[0].attempts).toBe(1);
  });

  it("a throw from the film start keeps the claim, warns, and buys nothing more", async () => {
    const { h, deps, doc } = harness(buildParentDoc("f", body(4), 0));
    deps.start = async () => { throw new Error("R2 500 after the invoke"); };
    await advanceParent(doc, deps, 1);
    expect(doc.parts[0].status).toBe("submitting");
    expect(doc.parts[0].claimed_at).toBe(1);
    expect(doc.parts[0].error).toMatch(/outcome unknown so far.*R2 500/);
    await advanceParent(doc, deps, 2);
    h.found = "film-late";
    await advanceParent(doc, deps, 1 + STALE_CLAIM_MS);
    expect(doc.parts[0].status).toBe("running");
    expect(doc.parts[0].child_film_id).toBe("film-late");
  });

  it("a thrown bundle is a plain failure, because nothing was spent", async () => {
    const { deps, doc } = harness(buildParentDoc("f", body(4), 0));
    deps.bundle = async () => { throw new Error("bundle refused"); };
    await advanceParent(doc, deps, 1);
    expect(doc.parts[0].status).toBe("failed");
    expect(doc.parts[0].error).toBe("bundle refused");
  });

  /** Etags like R2, so a write based on an old read loses. Only this can see a stale object being saved. */
  function etagHarness(start: ParentDoc) {
    const t = harness(start);
    const store = { body: JSON.stringify(start), version: 0 };
    let held = 0;
    const seen: Array<{ part: number; status: string; attempts: number }> = [];
    let writeDuringFirst = true;
    t.deps.save = async (d) => {
      if (held !== store.version) return false;
      store.body = JSON.stringify(d);
      store.version += 1;
      held = store.version;
      return true;
    };
    t.deps.reload = async () => {
      held = store.version;
      return JSON.parse(store.body) as ParentDoc;
    };
    t.deps.start = async (b) => {
      const part = Number(/_p(\d+)$/.exec(String(b.project))?.[1]);
      const stored = (JSON.parse(store.body) as ParentDoc).parts[part];
      seen.push({ part, status: stored.status, attempts: stored.attempts });
      if (writeDuringFirst) {
        writeDuringFirst = false;
        store.version += 1; // A poll wrote.
      }
      t.h.starts.push(b);
      return `film-${t.h.starts.length}`;
    };
    return { ...t, store, seen };
  }

  it("B1: every part in a tick has its claim stored before its start, past a lost save", async () => {
    const { h, deps, doc, store, seen } = etagHarness(buildParentDoc("f", body(8), 0));
    doc.parts[0].status = "done";
    doc.parts[0].output_key = "k0";
    doc.parts[0].attempts = 1;
    await advanceParent(doc, deps, 1);
    expect(seen.map((s) => s.part)).toEqual([1, 2, 3]);
    expect(seen.map((s) => s.status), "a claim must be on record at each start").toEqual(["submitting", "submitting", "submitting"]);
    expect(seen.map((s) => s.attempts)).toEqual([1, 1, 1]);
    const stored = JSON.parse(store.body) as ParentDoc;
    expect(stored.parts.slice(1).map((p) => [p.status, p.child_film_id, p.attempts])).toEqual([["running", "film-1", 1], ["running", "film-2", 1], ["running", "film-3", 1]]);
    expect(parentView(stored, 2).spend_committed_est, "the ceiling counts what was bought").toBe(8);
    expect(h.starts).toHaveLength(3);
  });

  it("a part another tick took during a reload is not submitted again", async () => {
    const { h, deps, doc, store } = etagHarness(buildParentDoc("f", body(6), 0));
    doc.parts[0].status = "done";
    doc.parts[0].output_key = "k0";
    doc.parts[0].attempts = 1;
    const start = deps.start;
    let first = true;
    deps.start = async (b) => {
      const id = await start(b);
      if (first) {
        first = false;
        const other = JSON.parse(store.body) as ParentDoc;
        Object.assign(other.parts[2], { status: "running", child_film_id: "film-other", attempts: 1 });
        store.body = JSON.stringify(other);
      }
      return id;
    };
    await advanceParent(doc, deps, 1);
    expect(h.starts.map((b) => String(b.project))).toEqual(["Long_f_p01"]);
    expect(doc.parts[2].child_film_id).toBe("film-other");
  });

  it("B3: a thrown save after a good start keeps the film id", async () => {
    const { deps, doc, store } = etagHarness(buildParentDoc("f", body(2, { part_size: 2, dialogue_lines: [] }), 0));
    const save = deps.save;
    let calls = 0;
    deps.save = async (d) => {
      calls += 1;
      if (calls === 2) throw new Error("R2 500");
      return save(d);
    };
    await advanceParent(doc, deps, 1);
    expect((JSON.parse(store.body) as ParentDoc).parts[0].child_film_id).toBe("film-1");
  });

  it("a fresh claim is left alone", async () => {
    const { h, deps, doc } = harness(buildParentDoc("f", body(2, { part_size: 2, dialogue_lines: [] }), 0));
    doc.parts[0].status = "submitting";
    doc.parts[0].claimed_at = 0;
    await advanceParent(doc, deps, STALE_CLAIM_MS - 1);
    expect(h.starts).toHaveLength(0);
    expect(doc.parts[0].status).toBe("submitting");
  });

  it("a poll that writes during a submit does not lose the film id", async () => {
    const { h, deps, doc } = harness(buildParentDoc("f", body(4), 0));
    h.loseSaveAt = 2; // The claim lands, then the write after the submit loses to another tick.
    await advanceParent(doc, deps, 1);
    expect(h.reloads).toBe(1);
    expect(h.starts).toHaveLength(1);
    expect(doc.parts[0].child_film_id).toBe("film-1");
    expect(doc.parts[0].status).toBe("running");
  });

  it("the key moves only on a deliberate retry", async () => {
    const { h, deps, doc } = harness(buildParentDoc("f", body(2, { part_size: 2, dialogue_lines: [] }), 0));
    await advanceParent(doc, deps, 1);
    expect(h.starts[0].idempotency_key).toBe("f-p00-g0");
    h.children.set("film-1", { phase: "failed", shots_done: 0, output_key: null, sidecar_key: null, error: "x" });
    await advanceParent(doc, deps, 2);
    retryPart(doc, 0);
    await advanceParent(doc, deps, 3);
    expect(h.starts[1].idempotency_key).toBe("f-p00-g1");
  });

  it("holds a part when the router's checks refuse, and asks again without failing it", async () => {
    const { h, deps, doc } = harness(buildParentDoc("f", body(4), 0));
    h.held = "daily spend ceiling reached";
    await advanceParent(doc, deps, 1);
    expect(h.starts).toHaveLength(0);
    expect(h.bundles).toHaveLength(0);
    expect(doc.parts[0].status).toBe("pending");
    expect(doc.parts[0].attempts).toBe(0);
    expect(doc.stop_reason).toBe("daily spend ceiling reached");
    expect(doc.phase).toBe("running");
    h.held = null;
    await advanceParent(doc, deps, 2);
    expect(h.starts).toHaveLength(1);
    expect(doc.stop_reason).toBeNull();
  });

  it("two films of one project never share a part project", () => {
    const a = buildParentDoc("feature-aaaaaaaa11", body(2, { dialogue_lines: [] }), 0);
    const b = buildParentDoc("feature-bbbbbbbb22", body(2, { dialogue_lines: [] }), 0);
    expect(a.parts[0].project).toBe("Long_aaaaaaaa_p00");
    expect(b.parts[0].project).toBe("Long_bbbbbbbb_p00");
  });

  it("holds after the first part by default, and resume releases it", async () => {
    const { h, deps, doc } = harness(buildParentDoc("f", body(4, { pause_after_first_part: undefined }), 0));
    await advanceParent(doc, deps, 1);
    h.children.set("film-1", done("k1"));
    await advanceParent(doc, deps, 2);
    expect(h.starts).toHaveLength(1);
    expect(doc.phase).toBe("stopped");
    expect(doc.stop_reason).toMatch(/watch it/);
    await advanceParent(doc, deps, 3);
    expect(h.starts).toHaveLength(1);
    resumeParent(doc);
    await advanceParent(doc, deps, 4);
    expect(h.starts).toHaveLength(2);
  });

  it("a one-part film has no hold", async () => {
    const { h, deps, doc } = harness(buildParentDoc("f", body(2, { part_size: 2, dialogue_lines: [], pause_after_first_part: undefined }), 0));
    await advanceParent(doc, deps, 1);
    h.children.set("film-1", done("k1"));
    await advanceParent(doc, deps, 2);
    expect(doc.phase).toBe("join");
  });

  it("refuses a board one upload cannot carry, before any spend", () => {
    expect(() => buildParentDoc("f", body(2, { dialogue_lines: [] }), 0, () => ONE_UPLOAD_BYTES + 1)).toThrow(/one upload carries/);
    expect(buildParentDoc("f", body(2, { dialogue_lines: [] }), 0, () => ONE_UPLOAD_BYTES).parts).toHaveLength(1);
  });

  it("the fingerprint ignores the key and sees the rest", () => {
    expect(requestFingerprint(body(2, { idempotency_key: "a" }))).toBe(requestFingerprint(body(2, { idempotency_key: "b" })));
    expect(requestFingerprint(body(2, { spend_ceiling_usd: 1 }))).not.toBe(requestFingerprint(body(2)));
  });

  it("a refused submit fails the part and stops the film on the next tick", async () => {
    const { deps, doc } = harness(buildParentDoc("f", body(4), 0));
    deps.start = async () => { throw new SubmitRefused("submit refused (400): nope"); };
    await advanceParent(doc, deps, 1);
    expect(doc.parts[0].status).toBe("failed");
    await advanceParent(doc, deps, 2);
    expect(doc.phase).toBe("stopped");
  });
});

describe("retrying a part", () => {
  it("resubmits only that part, with a new key, and leaves done parts alone", async () => {
    const { h, deps, doc } = harness(buildParentDoc("f", body(4), 0));
    await advanceParent(doc, deps, 1);
    h.children.set("film-1", done("k1"));
    await advanceParent(doc, deps, 2);
    h.children.set("film-2", { phase: "failed", shots_done: 0, output_key: null, sidecar_key: null, error: "boom" });
    await advanceParent(doc, deps, 3);
    expect(doc.phase).toBe("stopped");
    const firstKey = h.starts[1].idempotency_key;
    retryPart(doc, 1);
    await advanceParent(doc, deps, 4);
    expect(h.starts).toHaveLength(3);
    expect(h.starts[2].project).toBe("Long_f_p01");
    expect(h.starts[2].reuse_finished).toBe(true);
    expect(h.starts[2].idempotency_key).not.toBe(firstKey);
    expect(doc.parts[0].output_key).toBe("k1");
  });
  it("refuses a part that has not failed", () => {
    const doc = buildParentDoc("f", body(4), 0);
    expect(() => retryPart(doc, 0)).toThrow(/not failed/);
    expect(() => retryPart(doc, 9)).toThrow(/no such part/);
  });
});

async function allDone(sidecars: Array<string | null>) {
  const t = harness(buildParentDoc("f", body(4), 0));
  await advanceParent(t.doc, t.deps, 1);
  t.h.children.set("film-1", done("k1", sidecars[0]));
  await advanceParent(t.doc, t.deps, 2);
  t.h.children.set("film-2", done("k2", sidecars[1]));
  await advanceParent(t.doc, t.deps, 3);
  return t;
}

describe("the join", () => {
  it("joins in part order, once, then reports the film", async () => {
    const { h, deps, doc } = await allDone([null, null]);
    expect(doc.phase).toBe("join");
    expect(h.joins).toEqual([["k1", "k2"]]);
    await advanceParent(doc, deps, 4);
    expect(h.joins, "pending must not re-submit").toHaveLength(1);
    expect(parentView(doc, 5).output_key, "no film key before the join is done").toBeNull();
    h.join = { status: "completed", bytes: 9, durationSeconds: 8, filmOffsetsSeconds: [0, 4] };
    await advanceParent(doc, deps, 6);
    expect(doc.phase).toBe("done");
    expect(parentView(doc, 7).output_key).toBe("renders/f/film.mp4");
    expect(doc.degraded).toBe("no caption file: no part produced one");
  });

  it("one missing read is not a lost join: only a streak counts", async () => {
    const { h, deps, doc } = await allDone([null, null]);
    h.join = { status: "missing" };
    for (let i = 1; i < JOIN_MISSING_STREAK; i++) await advanceParent(doc, deps, 3 + i);
    expect(h.joins).toHaveLength(1);
    h.join = { status: "pending" };
    await advanceParent(doc, deps, 10);
    h.join = { status: "missing" };
    await advanceParent(doc, deps, 11);
    expect(h.joins, "the streak still counts: pending does not reset it, and this read completes it").toHaveLength(2);
  });

  it("a full door does not use up a join attempt", async () => {
    const t = harness(buildParentDoc("f", body(2, { part_size: 2, dialogue_lines: [] }), 0));
    await advanceParent(t.doc, t.deps, 1);
    t.h.children.set("film-1", done("k1"));
    t.deps.submitJoin = async () => { throw new JoinTransient("join refused (429): full"); };
    for (let i = 0; i < 10; i++) await advanceParent(t.doc, t.deps, 2 + i);
    expect(t.doc.phase).toBe("join");
    expect(t.doc.join_attempts).toBe(0);
    expect(t.doc.error).toMatch(/429/);
  });

  it("a real refusal stops after the limit, and resume joins again", async () => {
    const { h, deps, doc } = await allDone([null, null]);
    h.join = { status: "failed", error: "films[1] differs" };
    await advanceParent(doc, deps, 4);
    await advanceParent(doc, deps, 5);
    await advanceParent(doc, deps, 6);
    expect(doc.phase).toBe("failed");
    expect(doc.error).toBe("films[1] differs");
    const joined = h.joins.length;
    await advanceParent(doc, deps, 7);
    expect(h.joins).toHaveLength(joined);
    resumeParent(doc);
    h.join = { status: "pending" };
    await advanceParent(doc, deps, 8);
    expect(h.joins).toHaveLength(joined + 1);
    expect(doc.phase).toBe("join");
    expect(doc.parts.map((p) => p.output_key), "paid parts are kept").toEqual(["k1", "k2"]);
  });

  it("a join that never answers times out instead of waiting forever", async () => {
    const { h, deps, doc } = await allDone([null, null]);
    h.join = { status: "pending" };
    await advanceParent(doc, deps, 3 + JOIN_TIMEOUT_MS);
    expect(doc.join_started_at).toBe(3);
    await advanceParent(doc, deps, 4 + JOIN_TIMEOUT_MS);
    expect(h.joins).toHaveLength(2);
  });

  it("a token refusal on status is not read as pending", async () => {
    const { h, deps, doc } = await allDone([null, null]);
    h.join = { status: "error", error: "join status refused (401)" };
    await advanceParent(doc, deps, 4);
    expect(doc.join_job_id, "it moves on, and does not wait").toBe("join-job");
    expect(h.joins).toHaveLength(2);
  });

  it("nothing to resume is refused", () => {
    expect(() => resumeParent(buildParentDoc("f", body(4), 0))).toThrow(/nothing to resume/);
  });

  it("merges captions at the join's offsets, and names a part whose captions are missing", async () => {
    const { h, deps, doc } = await allDone(["a.srt", null]);
    h.texts.set("a.srt", "1\n00:00:01,000 --> 00:00:02,500\nhello\n");
    h.join = { status: "completed", bytes: 9, durationSeconds: 8, filmOffsetsSeconds: [0, 4] };
    await advanceParent(doc, deps, 4);
    expect(doc.sidecar_key).toBe("renders/f/film.srt");
    expect(h.written.get("renders/f/film.srt")).toContain("00:00:01,000 --> 00:00:02,500");
    expect(doc.degraded).toBe("captions are missing for parts 1");
  });
});

describe("mergeSrt", () => {
  it("shifts by the offset and renumbers across parts, past an hour", () => {
    const out = mergeSrt([
      { text: "1\r\n00:00:01,000 --> 00:00:02,000\r\nfirst\r\n\r\n2\n00:00:03,000 --> 00:00:04,000\nsecond\nline\n", offsetSeconds: 0 },
      { text: "1\n00:00:00,500 --> 00:00:01,000\nthird\n", offsetSeconds: 3600.25 },
    ]);
    expect(out).toBe(
      "1\n00:00:01,000 --> 00:00:02,000\nfirst\n\n2\n00:00:03,000 --> 00:00:04,000\nsecond\nline\n\n3\n01:00:00,750 --> 01:00:01,250\nthird\n",
    );
  });
});

describe("a retake of one shot", () => {
  async function finished() {
    const t = await allDone([null, null]);
    t.h.join = { status: "completed", bytes: 9, durationSeconds: 8, filmOffsetsSeconds: [0, 4] };
    await advanceParent(t.doc, t.deps, 4);
    expect(t.doc.phase).toBe("done");
    t.h.starts.length = 0;
    t.h.bundles.length = 0;
    t.h.joins.length = 0;
    return t;
  }

  it("re-runs that part from its stills, not from a new bundle, and leaves the other part alone", async () => {
    const { h, deps, doc } = await finished();
    markRetake(doc, "s2", { prompt: "new" });
    await advanceParent(doc, deps, 5);
    expect(h.starts, "a retake must not run the keyframe stage").toEqual([]);
    expect(h.bundles).toEqual([]);
    expect(h.retakes).toHaveLength(1);
    expect(h.retakes[0][0]).toEqual({ from_film_id: "film-2", shots: ["shot_01"], prompts: { shot_01: "new" }, lines: {} });
    expect(doc.parts[0].output_key).toBe("k1");
    expect(doc.parts[0].status).toBe("done");
  });

  it("keeps the delivered film until the new join is done, then moves to a new key and joins the new part", async () => {
    const { h, deps, doc } = await finished();
    markRetake(doc, "s3", {});
    expect(parentView(doc, 5).output_key).toBe("renders/f/film.mp4");
    expect(doc.phase).toBe("running");
    h.join = { status: "pending" };
    await advanceParent(doc, deps, 5);
    h.children.set("film-retake-1", done("k2b"));
    await advanceParent(doc, deps, 6);
    expect(h.joins).toEqual([["k1", "k2b"]]);
    expect(parentView(doc, 7).output_key).toBe("renders/f/film.mp4");
    h.join = { status: "completed", bytes: 9, durationSeconds: 8, filmOffsetsSeconds: [0, 4] };
    await advanceParent(doc, deps, 8);
    expect(doc.phase).toBe("done");
    expect(parentView(doc, 9).output_key).toBe("renders/f/film-v2.mp4");
  });

  it("adds shots of one waiting part into one retake, under one key", async () => {
    const { h, deps, doc } = await finished();
    markRetake(doc, "s2", {});
    markRetake(doc, "s3", { line: "new line", voice_id: "orion" });
    expect(doc.parts[1].retake?.shots).toEqual(["shot_01", "shot_02"]);
    expect(doc.parts[1].retake?.lines).toEqual({ shot_02: { text: "new line", voice_id: "orion" } });
    expect(doc.dialogue_lines.find((l) => l.shot_id === "s3")).toEqual({ shot_id: "s3", text: "new line", voice_id: "orion" });
    await advanceParent(doc, deps, 5);
    expect(h.retakes.map((r) => r[1])).toEqual(["f-p01-r1"]);
  });

  it("a retake that fails retries as a retake, from the same film, and buys no stills", async () => {
    const { h, deps, doc } = await finished();
    markRetake(doc, "s2", {});
    await advanceParent(doc, deps, 5);
    h.children.set("film-retake-1", { phase: "failed", shots_done: 0, output_key: null, sidecar_key: null, error: "boom" });
    await advanceParent(doc, deps, 6);
    expect(doc.phase).toBe("stopped");
    retryPart(doc, 1);
    await advanceParent(doc, deps, 7);
    expect(h.starts).toEqual([]);
    expect(h.bundles).toEqual([]);
    expect(h.retakes.map((r) => [r[0].from_film_id, r[1]])).toEqual([["film-2", "f-p01-r1"], ["film-2", "f-p01-r2"]]);
  });

  it("a retake the door could not start waits, counting nothing", async () => {
    const { deps, doc } = await finished();
    markRetake(doc, "s2", {});
    deps.startRetake = async () => { throw new SubmitNotStarted("busy"); };
    await advanceParent(doc, deps, 5);
    expect([doc.parts[1].status, doc.parts[1].retakes, doc.parts[1].retake_est]).toEqual(["pending", 0, 0]);
    expect(doc.parts[1].retake, "the retake is still waiting").not.toBeNull();
  });

  it("a retake whose start throws keeps its claim and warns, and a refusal fails plainly", async () => {
    const a = await finished();
    markRetake(a.doc, "s2", {});
    a.deps.startRetake = async () => { throw new Error("R2 down"); };
    await advanceParent(a.doc, a.deps, 5);
    expect(a.doc.parts[1].status).toBe("submitting");
    expect(a.doc.parts[1].error).toMatch(/outcome unknown so far/);
    const b = await finished();
    markRetake(b.doc, "s2", {});
    b.deps.startRetake = async () => { throw new SubmitRefused("no stills"); };
    await advanceParent(b.doc, b.deps, 5);
    expect(b.doc.parts[1].status).toBe("failed");
    expect(b.doc.parts[1].error).toBe("no stills");
  });

  it("a finished retake is cleared, so a later retake starts clean", async () => {
    const { h, deps, doc } = await finished();
    markRetake(doc, "s2", { prompt: "new" });
    await advanceParent(doc, deps, 5);
    h.children.set("film-retake-1", done("k2b"));
    await advanceParent(doc, deps, 6);
    expect(doc.parts[1].retake).toBeNull();
    h.join = { status: "completed", bytes: 9, durationSeconds: 8, filmOffsetsSeconds: [0, 4] };
    await advanceParent(doc, deps, 7);
    markRetake(doc, "s3", {});
    expect(doc.parts[1].retake).toEqual({ from_film_id: "film-retake-1", shots: ["shot_02"], prompts: {}, lines: {} });
  });

  it("counts one shot against the ceiling, and refuses to cross it", async () => {
    const { h, deps, doc } = await finished();
    expect(parentView(doc, 5).spend_committed_est).toBe(4);
    doc.spend_ceiling_usd = 4;
    markRetake(doc, "s3", {});
    await advanceParent(doc, deps, 5);
    expect(h.retakes, "$1 more would cross $4").toEqual([]);
    expect(doc.stop_reason).toBe("spend ceiling");
    raiseCeiling(doc, 5);
    await advanceParent(doc, deps, 6);
    expect(h.retakes).toHaveLength(1);
    expect(parentView(doc, 7).spend_committed_est).toBe(5);
  });

  it("refuses an unknown shot, an unfinished part, and empty edits", async () => {
    const fresh = buildParentDoc("f", body(4), 0);
    expect(() => markRetake(fresh, "s0", {})).toThrow(/needs a finished part/);
    const { doc } = await finished();
    expect(() => markRetake(doc, "nope", {})).toThrow(/no shot/);
    expect(() => markRetake(doc, "s1", { prompt: " " })).toThrow(/prompt must be text/);
    expect(() => markRetake(doc, "s1", { voice_id: "a" })).toThrow(/no line/);
    expect(doc.parts[0].status, "a refusal changes nothing").toBe("done");
    expect(doc.phase).toBe("done");
  });

  it("repeats the old job's scenes and lines, changing only what was named", () => {
    const job = {
      scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 3 }, { shot_id: "shot_02", prompt: "b", seconds: 3 }],
      dialogue_lines: [{ shot_id: "shot_01", text: "x", voice_id: "v1" }, { shot_id: "shot_02", text: "y", voice_id: "v2" }],
    };
    const out = retakeScenesAndLines(job, { from_film_id: "f", shots: ["shot_02"], prompts: { shot_02: "B" }, lines: { shot_02: { text: "Y" } } });
    expect(out.scenes[0]).toBe(job.scenes[0]);
    expect(out.scenes[1]).toEqual({ shot_id: "shot_02", prompt: "B", seconds: 3 });
    expect(out.dialogue_lines?.[0]).toBe(job.dialogue_lines[0]);
    expect(out.dialogue_lines?.[1]).toEqual({ shot_id: "shot_02", text: "Y", voice_id: "v2" });
  });
});

describe("the spend ceiling counts retries and can be raised", () => {
  async function failedSecond(ceiling: number) {
    const t = harness(buildParentDoc("f", body(4, { spend_ceiling_usd: ceiling }), 0));
    await advanceParent(t.doc, t.deps, 1);
    t.h.children.set("film-1", done("k1"));
    await advanceParent(t.doc, t.deps, 2);
    t.h.children.set("film-2", { phase: "failed", shots_done: 0, output_key: null, sidecar_key: null, error: "boom" });
    await advanceParent(t.doc, t.deps, 3);
    return t;
  }

  it("a retry that would cross the ceiling does not submit", async () => {
    const { h, deps, doc } = await failedSecond(4);
    expect(parentView(doc, 4).spend_committed_est).toBe(4);
    retryPart(doc, 1);
    await advanceParent(doc, deps, 4);
    expect(h.starts).toHaveLength(2);
    expect(doc.stop_reason).toBe("spend ceiling");
    expect(doc.phase).toBe("stopped");
    expect(doc.parts[1].status).toBe("pending");
  });

  it("raising the ceiling lets that retry run, and it then counts", async () => {
    const { h, deps, doc } = await failedSecond(4);
    retryPart(doc, 1);
    await advanceParent(doc, deps, 4);
    raiseCeiling(doc, 6);
    expect([doc.phase, doc.stop_reason]).toEqual(["running", null]);
    await advanceParent(doc, deps, 5);
    expect(h.starts).toHaveLength(3);
    expect(parentView(doc, 6).spend_committed_est).toBe(6);
  });

  it("raising does not clear a stop from a failed part", async () => {
    const { h, deps, doc } = await failedSecond(10);
    raiseCeiling(doc, 20);
    expect(doc.stop_reason).toBe("part 1 failed");
    await advanceParent(doc, deps, 4);
    expect(doc.phase).toBe("stopped");
    expect(h.starts).toHaveLength(2);
  });

  it("refuses a lower or equal value, a non-number, and a finished film", () => {
    const doc = buildParentDoc("f", body(4), 0);
    expect(() => raiseCeiling(doc, 1000)).toThrow(/above the current/);
    expect(() => raiseCeiling(doc, 5)).toThrow(/above the current/);
    expect(() => raiseCeiling(doc, "2000")).toThrow(/above the current/);
    doc.phase = "done";
    expect(() => raiseCeiling(doc, 2000)).toThrow(/the film is done/);
  });

  it("the view says the ceiling is an estimate that counts retries", () => {
    const view = parentView(buildParentDoc("f", body(4), 0), 0);
    expect(view.spend_ceiling_basis).toMatch(/estimate/);
    expect(view.spend_ceiling_basis).toMatch(/retries/);
  });
});

describe("the status view", () => {
  it("is constant size per part, says actual cost is unknown, and carries no board", async () => {
    const { deps, doc } = harness(buildParentDoc("f", body(4), 0));
    await advanceParent(doc, deps, 1);
    const view = parentView(doc, 11);
    expect(view.elapsed_ms).toBe(10);
    expect(view.cost_est).toBe(4);
    expect(view.cost_actual).toBeNull();
    expect(view.parts[0].cost_actual).toBeNull();
    expect(JSON.stringify(view)).not.toContain("prompt");
    expect(Object.keys(view.parts[0]).sort()).toEqual(["cost_actual", "cost_est", "error", "index", "output_key", "part_id", "phase", "shot_from", "shot_to", "shots_done", "shots_total", "status"]);
  });
});
