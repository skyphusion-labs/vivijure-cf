import { describe, it, expect } from "vitest";
import {
  advanceParent,
  buildParentDoc,
  keyframeBackendForStyle,
  MAX_PARTS,
  MAX_PARTS_IN_FLIGHT,
  mergeSrt,
  parentView,
  partInputs,
  planPartRanges,
  retryPart,
  STALE_CLAIM_MS,
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
    ...over,
  };
}

function harness(doc: ParentDoc) {
  const h = {
    saves: 0,
    loseSaveAt: -1,
    bundles: [] as Array<Record<string, unknown>>,
    starts: [] as Array<Record<string, unknown>>,
    children: new Map<string, ChildRead | null>(),
    found: null as string | null,
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
    async bundle(args) {
      h.bundles.push(args);
      return `bundles/${String(args.storyboard.project)}.tar.gz`;
    },
    async start(b) {
      h.starts.push(b);
      return `film-${h.starts.length}`;
    },
    async readChild(id) {
      return h.children.has(id) ? (h.children.get(id) as ChildRead | null) : { phase: "clips", shots_done: 1, output_key: null, sidecar_key: null, error: null };
    },
    async findChild() {
      return h.found;
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
  it("refuses a repeated shot id", () => {
    const b = body(2);
    (b.storyboard as { scenes: unknown[] }).scenes = [{ shot_id: "a" }, { shot_id: "a" }];
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
    expect(bundleArgs.storyboard.projectName).toBe("Long_p01");
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

  it("a stale claim adopts the film it finds, and submits nothing new", async () => {
    const { h, deps, doc } = harness(buildParentDoc("f", body(2, { part_size: 2, dialogue_lines: [] }), 0));
    doc.parts[0].status = "submitting";
    doc.parts[0].claimed_at = 0;
    h.found = "film-found";
    await advanceParent(doc, deps, STALE_CLAIM_MS);
    expect(h.starts).toHaveLength(0);
    expect(doc.parts[0].child_film_id).toBe("film-found");
    expect(doc.parts[0].status).toBe("running");
  });

  it("a fresh claim is left alone", async () => {
    const { h, deps, doc } = harness(buildParentDoc("f", body(2, { part_size: 2, dialogue_lines: [] }), 0));
    doc.parts[0].status = "submitting";
    doc.parts[0].claimed_at = 0;
    await advanceParent(doc, deps, STALE_CLAIM_MS - 1);
    expect(h.starts).toHaveLength(0);
    expect(doc.parts[0].status).toBe("submitting");
  });

  it("a stale claim with no film submits again", async () => {
    const { h, deps, doc } = harness(buildParentDoc("f", body(2, { part_size: 2, dialogue_lines: [] }), 0));
    doc.parts[0].status = "submitting";
    doc.parts[0].claimed_at = 0;
    await advanceParent(doc, deps, STALE_CLAIM_MS);
    expect(h.starts).toHaveLength(1);
  });

  it("a refused submit fails the part and stops the film on the next tick", async () => {
    const { deps, doc } = harness(buildParentDoc("f", body(4), 0));
    deps.start = async () => { throw new Error("submit refused (400): nope"); };
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
    expect(h.starts[2].project).toBe("Long_p01");
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

  it("a lost join submits again, and stops after the limit", async () => {
    const { h, deps, doc } = await allDone([null, null]);
    h.join = { status: "missing" };
    await advanceParent(doc, deps, 4);
    expect(h.joins).toHaveLength(2);
    await advanceParent(doc, deps, 5);
    expect(h.joins).toHaveLength(3);
    await advanceParent(doc, deps, 6);
    expect(h.joins).toHaveLength(3);
    expect(doc.phase).toBe("failed");
    expect(doc.error).toBe("the join job was lost");
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
