import { describe, expect, it } from "vitest";

import {
  DEGRADE_BANDS,
  NO_REASON,
  bandNote,
  clipsFrom,
  degradeBand,
  degradeFrom,
  deliverable,
  deliveredSummary,
  type RenderOutput,
} from "../public/finish-degrade.js";

// cf#118. When the video-finish tier is unavailable (VIDEO_FINISH_VPC unbound, the hosted
// tenant case) the orchestrator degrades honestly: per-shot clips at assemble, the silent
// film at mux, with a reason. The poll payload carried all of that and the panel showed a
// green "completed" and a JSON blob.
//
// The bias here is deliberate and asymmetric, and it is the OPPOSITE of the cf#98 gate:
// there, junk resolved to "no restriction" so a parse failure could not black out a working
// studio. Here, junk resolves to "no degrade" for the same underlying reason -- a parse
// failure must not tell a user their perfectly good film is broken.

const CLIPS_DEGRADE: RenderOutput = {
  project: "p1",
  finish_unavailable: {
    at: "assemble",
    reason: "video-finish tier not installed (VIDEO_FINISH_VPC unbound); delivered per-shot clips",
    delivered: "clips",
  },
  clips: [
    { shot_id: "shot_01", key: "renders/film-1/clips/shot_01.mp4" },
    { shot_id: "shot_02", key: "renders/film-1/clips/shot_02.mp4" },
  ],
};

const MUX_DEGRADE: RenderOutput = {
  project: "p1",
  output_key: "renders/film-1/silent.mp4",
  finish_unavailable: { at: "mux", reason: "mux container unreachable", delivered: "silent_film" },
};

const HEALTHY: RenderOutput = { project: "p1", output_key: "renders/film-1/film.mp4" };

describe("degradeFrom", () => {
  it("reads the degrade the studio reported, reason VERBATIM", () => {
    const d = degradeFrom(CLIPS_DEGRADE);
    expect(d).not.toBeNull();
    expect(d?.at).toBe("assemble");
    expect(d?.delivered).toBe("clips");
    // Verbatim: not re-worded, not softened, not truncated.
    expect(d?.reason).toBe(
      "video-finish tier not installed (VIDEO_FINISH_VPC unbound); delivered per-shot clips",
    );
    expect(d?.clips.map((c) => c.shot_id)).toEqual(["shot_01", "shot_02"]);
  });

  it("CONTROL: a healthy render reports no degrade at all", () => {
    expect(degradeFrom(HEALTHY)).toBeNull();
  });

  it("substitutes NO_REASON only when the studio gave none, keeping the structural facts", () => {
    const d = degradeFrom({ finish_unavailable: { at: "mux", delivered: "silent_film" } });
    expect(d?.reason).toBe(NO_REASON);
    expect(d?.at).toBe("mux");
  });

  it("junk resolves to NO DEGRADE, never to a scary banner on a good render", () => {
    expect(degradeFrom(null)).toBeNull();
    expect(degradeFrom(undefined)).toBeNull();
    expect(degradeFrom({} as RenderOutput)).toBeNull();
    expect(degradeFrom({ finish_unavailable: "broken" } as RenderOutput)).toBeNull();
    expect(degradeFrom({ finish_unavailable: [] } as RenderOutput)).toBeNull();
    expect(degradeFrom({ finish_unavailable: null } as RenderOutput)).toBeNull();
    // Neither structural fact present: indistinguishable from junk, so report nothing
    // rather than a contentless warning.
    expect(degradeFrom({ finish_unavailable: { reason: "x" } } as RenderOutput)).toBeNull();
  });
});

describe("clipsFrom", () => {
  it("keeps well-formed clips and SKIPS junk entries rather than failing the whole list", () => {
    const clips = clipsFrom({
      clips: [
        { shot_id: "shot_01", key: "k1" },
        null,
        { shot_id: "", key: "k2" },
        { shot_id: "shot_03" },
        "nope",
        { shot_id: "shot_04", key: "k4" },
      ],
    } as RenderOutput);
    // One malformed clip must not hide the clips that ARE deliverable.
    expect(clips).toEqual([
      { shot_id: "shot_01", key: "k1" },
      { shot_id: "shot_04", key: "k4" },
    ]);
  });

  it("a non-array clips field yields an empty list, not a throw", () => {
    expect(clipsFrom({ clips: "x" } as RenderOutput)).toEqual([]);
    expect(clipsFrom({} as RenderOutput)).toEqual([]);
  });
});

describe("deliverable (the stale-link fix)", () => {
  it("assembled film -> kind film, with the key", () => {
    const d = deliverable(HEALTHY);
    expect(d.kind).toBe("film");
    expect(d.key).toBe("renders/film-1/film.mp4");
  });

  it("mux degrade still has a film: the silent video IS complete", () => {
    const d = deliverable(MUX_DEGRADE);
    expect(d.kind).toBe("film");
    expect(d.key).toBe("renders/film-1/silent.mp4");
  });

  it("assemble degrade -> kind clips: the per-shot clips ARE the delivered render", () => {
    const d = deliverable(CLIPS_DEGRADE);
    expect(d.kind).toBe("clips");
    expect(d.key).toBeNull();
    expect(d.clips.map((c) => c.key)).toEqual([
      "renders/film-1/clips/shot_01.mp4",
      "renders/film-1/clips/shot_02.mp4",
    ]);
  });

  it("nothing downloadable -> kind none, so the caller CLEARS the links", () => {
    // The bug this exists to kill: output_key undefined on the assemble degrade meant the
    // old code never touched the anchors, leaving them on the PREVIOUS render's film.
    // "none" is a positive instruction to clear, not an absence the caller can skip.
    expect(deliverable({} as RenderOutput).kind).toBe("none");
    expect(deliverable(null).kind).toBe("none");
    expect(deliverable({ finish_unavailable: { at: "assemble", delivered: "clips" } } as RenderOutput).kind).toBe("none");
  });

  it("an empty-string output_key is NOT a film (it would build /api/artifact/)", () => {
    expect(deliverable({ output_key: "   " } as RenderOutput).kind).toBe("none");
  });
});

describe("deliveredSummary", () => {
  it("states what was handed over, structurally, and counts the clips", () => {
    expect(deliveredSummary(degradeFrom(CLIPS_DEGRADE))).toBe(
      "The assemble step did not run, so this render delivered 2 per-shot clips instead of one assembled film.",
    );
  });

  it("singular clip reads as a clip, not 1 clips", () => {
    const one = degradeFrom({
      finish_unavailable: { at: "assemble", delivered: "clips" },
      clips: [{ shot_id: "shot_01", key: "k1" }],
    } as RenderOutput);
    expect(deliveredSummary(one)).toContain("1 per-shot clip instead");
  });

  it("the mux degrade says the video is complete and the audio is missing", () => {
    const s = deliveredSummary(degradeFrom(MUX_DEGRADE));
    expect(s).toContain("audio mux step");
    expect(s).toContain("SILENT film");
  });

  it("never paraphrases the studio reason: the summary and the reason are separate strings", () => {
    const d = degradeFrom(CLIPS_DEGRADE);
    const summary = deliveredSummary(d) as string;
    // The verbatim reason must not be folded into, or replaced by, our sentence.
    expect(summary).not.toContain("VIDEO_FINISH_VPC");
    expect(d?.reason).toContain("VIDEO_FINISH_VPC");
  });

  it("CONTROL: no degrade -> no summary", () => {
    expect(deliveredSummary(null)).toBeNull();
    expect(deliveredSummary(degradeFrom(HEALTHY))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// cf#549: render history was structurally blind to degradation. A film that shipped
// without part of its finish was `done`, `errors: []`, and byte-identical in render
// history to one that shipped complete, so the incidence could not be counted and a load
// test could not fail on this axis at all.
//
// `degradeFrom` above answers "is there a degrade to RENDER" and returns null for three
// different situations on purpose, because on the live view a parse failure must not tell
// a user their good film is broken. `degradeBand` answers "what do we KNOW about this
// row", which is a different question and cannot afford that collapse. These two suites
// exist to keep the four bands apart; every assertion below names the band string it
// expects, never merely that something was truthy, so a guard that has quietly stopped
// discriminating still has to produce a value it can no longer produce.

const NO_PAYLOAD_BANDS = ["unmeasured", "none-reported", "unreadable", "reported"] as const;

describe("degradeBand (cf#549)", () => {
  it("a reported degrade bands as reported, at either step", () => {
    expect(degradeBand(CLIPS_DEGRADE)).toBe("reported");
    expect(degradeBand(MUX_DEGRADE)).toBe("reported");
  });

  it("a readable payload that reports no degrade bands as none-reported, NEVER as clean", () => {
    // The emitter writes `finish_unavailable` only when it degrades, so absent-or-null on
    // a payload we could read is a real report of "no degrade at this step".
    expect(degradeBand(HEALTHY)).toBe("none-reported");
    expect(degradeBand({} as RenderOutput)).toBe("none-reported");
    expect(degradeBand({ finish_unavailable: null } as RenderOutput)).toBe("none-reported");
    // The band is deliberately not called "clean" or "complete": it says nothing about
    // `film_finish.degraded` (vivijure-core#203), which is not on the payload today.
    expect(degradeBand(HEALTHY)).not.toBe("reported");
  });

  it("no readable payload at all bands as unmeasured", () => {
    expect(degradeBand(null)).toBe("unmeasured");
    expect(degradeBand(undefined)).toBe("unmeasured");
    expect(degradeBand("nope" as unknown as RenderOutput)).toBe("unmeasured");
    expect(degradeBand(7 as unknown as RenderOutput)).toBe("unmeasured");
    // An array is typeof "object" and is not a payload we can read.
    expect(degradeBand([] as unknown as RenderOutput)).toBe("unmeasured");
  });

  it("a degrade the studio reported and we cannot read bands as unreadable, not as silence", () => {
    expect(degradeBand({ finish_unavailable: "broken" } as RenderOutput)).toBe("unreadable");
    expect(degradeBand({ finish_unavailable: [] } as RenderOutput)).toBe("unreadable");
    expect(degradeBand({ finish_unavailable: {} } as RenderOutput)).toBe("unreadable");
    // Neither structural fact, which degradeFrom() forgives to null for the live view.
    expect(degradeBand({ finish_unavailable: { reason: "x" } } as RenderOutput)).toBe("unreadable");
  });

  it("THE COLLAPSE TEST: three situations degradeFrom() returns null for land in THREE bands", () => {
    // This is the assertion cf#549 exists for. degradeFrom() maps all three to one null,
    // deliberately. If render history ever maps them to one band again, that is the same
    // defect rebuilt one field over, and this is the test that has to go red for it.
    const unmeasured = null;
    const noneReported: RenderOutput = { project: "p1", output_key: "renders/f/film.mp4" };
    const unreadable = { finish_unavailable: { reason: "x" } } as RenderOutput;

    expect(degradeFrom(unmeasured)).toBeNull();
    expect(degradeFrom(noneReported)).toBeNull();
    expect(degradeFrom(unreadable)).toBeNull();

    const bands = [degradeBand(unmeasured), degradeBand(noneReported), degradeBand(unreadable)];
    expect(bands).toEqual(["unmeasured", "none-reported", "unreadable"]);
    expect(new Set(bands).size).toBe(3);
  });

  it("CONTROL: every band this function can return is one of the four declared names", () => {
    // A positive control on the vocabulary itself: if a band string is ever renamed on one
    // side only, the row's data-finish-degrade contract and its readers drift silently.
    expect(Object.values(DEGRADE_BANDS).sort()).toEqual([...NO_PAYLOAD_BANDS].sort());
    for (const out of [null, HEALTHY, CLIPS_DEGRADE, { finish_unavailable: {} } as RenderOutput]) {
      expect(NO_PAYLOAD_BANDS).toContain(degradeBand(out));
    }
  });
});

describe("bandNote (cf#549)", () => {
  it("the reported band is badged, and says a degrade happened rather than a failure", () => {
    const note = bandNote("reported");
    expect(note?.label).toBe("finished with limits");
    expect(note?.title).toContain("delivered less than a full finish");
  });

  it("the unreadable band is badged, and says the report could not be read", () => {
    const note = bandNote("unreadable");
    expect(note?.label).toBe("degrade unreadable");
    expect(note?.title).toContain("could not be read");
    // It must not claim to know what was delivered, because it does not.
    expect(note?.title).toContain("unknown");
  });

  it("the two ordinary bands render NOTHING, so a badge cannot fire on a healthy list", () => {
    // They are still asserted positively on every row via data-finish-degrade; what is
    // suppressed here is the badge, not the state.
    expect(bandNote("none-reported")).toBeNull();
    expect(bandNote("unmeasured")).toBeNull();
  });

  it("an unrecognised band renders nothing rather than an empty badge", () => {
    expect(bandNote("clean")).toBeNull();
    expect(bandNote(null)).toBeNull();
    expect(bandNote(undefined)).toBeNull();
  });

  it("the two badged notes are DIFFERENT text: one check wearing two names would not be", () => {
    const reported = bandNote("reported");
    const unreadable = bandNote("unreadable");
    // Both non-null FIRST. Written without this the inequality passes vacuously when one
    // side goes missing (undefined !== a string), which the mutation pass caught: deleting
    // the unreadable badge left this assertion green while the badge test alone went red.
    expect(reported).not.toBeNull();
    expect(unreadable).not.toBeNull();
    expect(reported?.label).not.toBe(unreadable?.label);
    expect(reported?.title).not.toBe(unreadable?.title);
  });
});
