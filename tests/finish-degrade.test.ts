import { describe, expect, it } from "vitest";

import {
  DEGRADE_BANDS,
  NO_REASON,
  bandNote,
  clipsFrom,
  clipFinishBand,
  clipFinishFrom,
  clipFinishSummary,
  combineBands,
  degradeBand,
  degradeFrom,
  deliverable,
  deliveredSummary,
  parseFilmFinish,
  STAGE_KEYS,
  stageBand,
  stageFrom,
  stageSummary,
  stagesNote,
  type RenderOutput,
} from "../public/finish-degrade.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// cf#118. When the video-finish tier is unavailable (VIDEO_FINISH_URL unset, the hosted
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
    reason: "video-finish tier not installed (VIDEO_FINISH_URL unset); delivered per-shot clips",
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
      "video-finish tier not installed (VIDEO_FINISH_URL unset); delivered per-shot clips",
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
    expect(summary).not.toContain("VIDEO_FINISH_URL");
    expect(d?.reason).toContain("VIDEO_FINISH_URL");
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

// cf#595 / core#226: clip-level polish reasons. A second signal, not a rewrite of
// finish_unavailable -- an unpolished-but-assembled film still has a film.
const FACE = "backend-soft-degrade: no detectable face in clip";
const TIMEOUT = "backend-soft-degrade: wall-clock guard expired after 900s";
const CLIP_DIRTY: RenderOutput = {
  project: "p1",
  output_key: "renders/f/film.mp4",
  finish: { degraded: 2, reasons: [FACE, TIMEOUT] },
};
const CLIP_CLEAN: RenderOutput = {
  project: "p1",
  output_key: "renders/f/film.mp4",
  finish: { degraded: 0, reasons: [] },
};

describe("clipFinishFrom (cf#595)", () => {
  it("projects the two causes VERBATIM, not one passthrough: literal", () => {
    const c = clipFinishFrom(CLIP_DIRTY);
    expect(c).not.toBeNull();
    expect(c?.degraded).toBe(2);
    expect(c?.reasons).toEqual([FACE, TIMEOUT]);
    expect(c?.reasons.join(" ")).not.toMatch(/^passthrough:$/);
  });

  it("CONTROL: a clean finish chain reports nothing to render", () => {
    expect(clipFinishFrom(CLIP_CLEAN)).toBeNull();
    expect(clipFinishFrom(HEALTHY)).toBeNull();
  });

  it("does not steal an assemble/mux degrade's deliverable", () => {
    // The defect this second signal exists to avoid: folding clip-finish into degradeFrom
    // would make a complete film look like "no film".
    expect(degradeFrom(CLIP_DIRTY)).toBeNull();
    expect(deliverable(CLIP_DIRTY).kind).toBe("film");
  });
});

describe("clipFinishBand (cf#595)", () => {
  it("absent finish is unmeasured (row predates the field)", () => {
    expect(clipFinishBand(HEALTHY)).toBe("unmeasured");
    expect(clipFinishBand(null)).toBe("unmeasured");
  });

  it("degraded:0 is none-reported, never a clean verdict about assemble/mux", () => {
    expect(clipFinishBand(CLIP_CLEAN)).toBe("none-reported");
    expect(degradeBand(CLIP_CLEAN)).toBe("none-reported");
  });

  it("two distinct reasons band as reported", () => {
    expect(clipFinishBand(CLIP_DIRTY)).toBe("reported");
  });

  it("junk finish is unreadable, not silence", () => {
    expect(clipFinishBand({ finish: "broken" } as RenderOutput)).toBe("unreadable");
    expect(clipFinishBand({ finish: { reasons: "x" } } as RenderOutput)).toBe("unreadable");
  });
});

describe("clipFinishSummary (cf#595)", () => {
  it("states the count, never paraphrases the reasons", () => {
    const c = clipFinishFrom(CLIP_DIRTY);
    const s = clipFinishSummary(c);
    expect(s).toContain("2 shots");
    expect(s).not.toContain("no detectable face");
    expect(s).not.toContain("passthrough:");
  });
});


// ---------------------------------------------------------------------------------------------
// cf#853 / core#317: the per-stage degrade keys, and THE LADDER.
//
// core#317 emits `speech`, `master` and `dialogue` as top-level payload keys in the same
// `{ degraded, reasons }` vocabulary `output.finish` already uses, and OMITS the key entirely
// when the stage was never reached. So there are three states, not two, and the whole value of
// the field is in keeping them apart:
//
//   key ABSENT       the stage was never reached. NOT MEASURED.
//   degraded: 0      it ran and ran clean. Measured, and NOT a limit.
//   degraded: n > 0  it ran and degraded.
//
// Every test below that asserts a band was checked against a PLANTED COLLAPSE before being
// trusted: making stageBand() treat an absent key as "none-reported" turns the ladder tests red.
// A test that cannot observe the collapse it exists to prevent is decoration.
const ROOT = join(import.meta.dirname, "..");

// DERIVED from STAGE_KEYS with ONE named exception, rather than a hand-typed list: a new
// count-shaped stage is picked up here automatically. `film_finish` is excluded because its RAW
// shape is different (`degraded: string | null`, cf#860) -- the LADDER is identical and is
// asserted for it in its own block below, but a `{ degraded: 0, reasons: [] }` fixture is not a
// payload core ever emits for that key, so feeding it one would assert against a fiction.
const COUNT_SHAPED = STAGE_KEYS.filter((k) => k !== "film_finish");

describe("cf#853 the ladder: absent, clean and degraded are three different states", () => {
  for (const stage of COUNT_SHAPED) {
    describe(stage, () => {
      it("ABSENT key is UNMEASURED, and is not a limit", () => {
        const out = { output_key: "renders/film-x/film.mp4" } as RenderOutput;
        expect(stageBand(out, stage)).toBe(DEGRADE_BANDS.UNMEASURED);
        expect(stageFrom(out, stage)).toBeNull();
      });

      it("degraded 0 is NONE-REPORTED, which is measured and still not a limit", () => {
        const out = { [stage]: { degraded: 0, reasons: [] } } as unknown as RenderOutput;
        expect(stageBand(out, stage)).toBe(DEGRADE_BANDS.NONE_REPORTED);
        // Not a limit: the live view must stay silent on a clean stage.
        expect(stageFrom(out, stage)).toBeNull();
      });

      it("ABSENT and degraded 0 are DIFFERENT -- the distinction the core pays a field to keep", () => {
        const absent = { output_key: "k" } as RenderOutput;
        const clean = { [stage]: { degraded: 0, reasons: [] } } as unknown as RenderOutput;
        expect(stageBand(absent, stage)).not.toBe(stageBand(clean, stage));
      });

      it("degraded n > 0 is REPORTED, and the reasons come back VERBATIM", () => {
        const out = {
          [stage]: { degraded: 1, reasons: ["MODULE_X: invoke failed: 503"] },
        } as unknown as RenderOutput;
        expect(stageBand(out, stage)).toBe(DEGRADE_BANDS.REPORTED);
        const info = stageFrom(out, stage);
        expect(info).not.toBeNull();
        expect(info!.stage).toBe(stage);
        expect(info!.degraded).toBe(1);
        // Never rewritten, never softened.
        expect(info!.reasons).toEqual(["MODULE_X: invoke failed: 503"]);
      });

      it("present but malformed is UNREADABLE, never silently clean", () => {
        const out = { [stage]: { degraded: "lots", reasons: "nope" } } as unknown as RenderOutput;
        expect(stageBand(out, stage)).toBe(DEGRADE_BANDS.UNREADABLE);
        // The live view still stays quiet: a parse failure must not scare a good film.
        expect(stageFrom(out, stage)).toBeNull();
      });
    });
  }

  it("an unknown stage key is UNMEASURED rather than throwing or guessing", () => {
    const out = { speech: { degraded: 3, reasons: ["x"] } } as unknown as RenderOutput;
    expect(stageBand(out, "film_finish")).toBe(DEGRADE_BANDS.UNMEASURED);
    expect(stageFrom(out, "film_finish")).toBeNull();
  });

  it("junk payloads resolve to UNMEASURED on every stage", () => {
    for (const bad of [null, undefined, 42, "x", []] as unknown[]) {
      for (const stage of STAGE_KEYS) {
        expect(stageBand(bad as RenderOutput, stage)).toBe(DEGRADE_BANDS.UNMEASURED);
        expect(stageFrom(bad as RenderOutput, stage)).toBeNull();
      }
    }
  });
});

describe("cf#853 `degraded` is the COUNT and `reasons` is DEDUPED", () => {
  // Measured against core#317's own test: two shots failing for the SAME reason plus one clean
  // shot yields { degraded: 2, reasons: [<one reason>] }. So degraded >= reasons.length, and
  // anything deriving the count from reasons.length under-reports exactly when several shots
  // fail the same way -- which is the common case, not the edge.
  const out = {
    speech: { degraded: 2, reasons: ["speech module MODULE_SPEECH not bound"] },
  } as unknown as RenderOutput;

  it("keeps the count from `degraded`, not from `reasons.length`", () => {
    const info = stageFrom(out, "speech");
    expect(info!.degraded).toBe(2);
    expect(info!.reasons).toHaveLength(1);
  });

  it("the summary counts SHOTS, not distinct reasons", () => {
    expect(stageSummary(stageFrom(out, "speech"))).toContain("2 shots");
  });

  it("falls back to reasons.length only when `degraded` is unusable (a pre-field payload)", () => {
    const legacy = { master: { reasons: ["A", "B"] } } as unknown as RenderOutput;
    expect(stageFrom(legacy, "master")!.degraded).toBe(2);
  });
});

describe("cf#853 stageSummary is OUR sentence, and never paraphrases a reason", () => {
  it("names the stage and pluralises the unit", () => {
    const one = stageFrom({ master: { degraded: 1, reasons: ["a"] } } as unknown as RenderOutput, "master");
    const two = stageFrom({ master: { degraded: 2, reasons: ["a", "b"] } } as unknown as RenderOutput, "master");
    expect(stageSummary(one)).toContain("1 step.");
    expect(stageSummary(two)).toContain("2 steps.");
    expect(stageSummary(one)).toContain("audio master");
  });

  it("dialogue carries NO count, because the leg has exactly one declared degrade", () => {
    const info = stageFrom(
      { dialogue: { degraded: 1, reasons: ["no dialogue module installed"] } } as unknown as RenderOutput,
      "dialogue",
    );
    const summary = stageSummary(info)!;
    expect(summary).toContain("without generated voices");
    // A count here would read as false precision: every other dialogue failure FAILS the
    // render now (core#314 / cf#834) rather than shipping as a limit.
    expect(summary).not.toMatch(/\d/);
  });

  it("returns null rather than a contentless sentence when there is nothing to report", () => {
    expect(stageSummary(null)).toBeNull();
    expect(stageSummary({ stage: "speech", degraded: 0, reasons: [] } as never)).toBeNull();
  });
});

describe("cf#853 the combining rule is NOT worst-of", () => {
  const B = DEGRADE_BANDS;

  it("partially measured is its OWN fact, not folded into either neighbour", () => {
    const partial = combineBands([B.NONE_REPORTED, B.UNMEASURED]);
    const allClean = combineBands([B.NONE_REPORTED, B.NONE_REPORTED]);
    // Neither reports a limit...
    expect(partial.limited).toBe(false);
    expect(allClean.limited).toBe(false);
    // ...and they are still DISTINGUISHABLE, which is the whole point. A worst-of collapse
    // would make these two identical and erase the fact that one stage was never measured.
    expect(partial.fullyMeasured).toBe(false);
    expect(allClean.fullyMeasured).toBe(true);
    expect(partial.unmeasured).toBe(1);
    expect(allClean.unmeasured).toBe(0);
  });

  it("`limited` means a signal REPORTED a limit, and unreadable is not that", () => {
    expect(combineBands([B.REPORTED, B.UNMEASURED]).limited).toBe(true);
    // An unreadable signal must not light the badge as though the studio had named a limit.
    expect(combineBands([B.UNREADABLE, B.NONE_REPORTED]).limited).toBe(false);
    expect(combineBands([B.UNREADABLE, B.NONE_REPORTED]).unreadable).toBe(1);
  });

  it("reports the composition, and an empty set is never fullyMeasured", () => {
    const c = combineBands([B.REPORTED, B.UNREADABLE, B.NONE_REPORTED, B.UNMEASURED]);
    expect(c).toMatchObject({ reported: 1, unreadable: 1, noneReported: 1, unmeasured: 1, total: 4 });
    // Nothing measured is not "everything measured".
    expect(combineBands([]).fullyMeasured).toBe(false);
    expect(combineBands(null).total).toBe(0);
  });
});

describe("cf#853 stagesNote names the right stage", () => {
  it("names a single stage, so the badge does not send the reader to the wrong place", () => {
    const info = stageFrom({ master: { degraded: 1, reasons: ["x"] } } as unknown as RenderOutput, "master");
    const note = stagesNote([info!])!;
    expect(note.label).toContain("audio master");
    expect(note.title).toContain("audio master");
    // bandNote()'s wording says "the finishing step", which is false for these stages.
    expect(note.label).not.toContain("finishing");
  });

  it("returns null when nothing reported", () => {
    expect(stagesNote([])).toBeNull();
    expect(stagesNote(null)).toBeNull();
  });
});

// THE SEAM, STATED PLAINLY. Everything above tests the pure decision logic, which is where all
// of the deciding happens. The DOM wiring is NOT exercised by a rendered-DOM test here, so these
// two assertions check that the wiring EXISTS rather than that it paints correctly -- a weaker
// claim, and it is named as weaker rather than left to look like coverage. `node --check` and
// `npm run guard:resolve` cover the syntax and the script resolution.
describe("cf#853 the panel is actually wired to the new signals", () => {
  const src = (f: string) => readFileSync(join(ROOT, "public", f), "utf8");

  it("planner-render.js folds the stage signals into `limited`", () => {
    const js = src("planner-render.js");
    expect(js).toContain("stageDegradesOf(out)");
    // The flag itself, not just the helper: a helper nothing consumes is the defect shape.
    expect(js).toMatch(/const limited = !!\(degrade \|\| clipFinish \|\| stageDegrades\.length\)/);
  });

  it("planner-history-row.js records a band per stage and renders the reasons", () => {
    const js = src("planner-history-row.js");
    for (const attr of ["speechDegrade", "masterDegrade", "dialogueDegrade"]) {
      expect(js, `history row does not record ${attr}`).toContain(`li.dataset.${attr}`);
    }
    expect(js).toContain("stagesNote(stageInfos)");
    expect(js).toContain("window.finishDegrade.stageSummary(info)");
  });
});


// ---------------------------------------------------------------------------------------------
// cf#860: film_finish, the unfinished half of cf#549.
//
// cf#549 was filed about exactly this case -- "a film that ships without its title card is
// indistinguishable from one that shipped complete" -- and core has been projecting the field that
// answers it while nothing in public/ read it. Same three-state ladder, different raw shape:
//
//   null / absent      the chain was never reached        -> unmeasured
//   degraded: null     it ran and applied cleanly         -> none-reported
//   degraded: "..."    it ran and SHIPPED UNCARDED        -> reported
//
// Unlike the cf#853 keys this is LIVE on the installed core, so these fixtures are the shape a
// real payload carries today rather than one waiting on a core release.
describe("cf#860 film_finish: the same ladder in a different shape", () => {
  const view = (degraded: string | null, extra: Record<string, unknown> = {}) =>
    ({ film_finish: { applied: [], adopted: [], degraded, ...extra } }) as unknown as RenderOutput;

  it("the whole object null is UNMEASURED -- the chain was never reached", () => {
    // Core ALWAYS sets the key and writes null when `job.film_finish` is absent, so this is the
    // common real payload, not an edge case.
    expect(stageBand({ film_finish: null } as unknown as RenderOutput, "film_finish")).toBe(
      DEGRADE_BANDS.UNMEASURED,
    );
    expect(stageFrom({ film_finish: null } as unknown as RenderOutput, "film_finish")).toBeNull();
  });

  it("degraded null is NONE-REPORTED: it ran and applied cleanly, and is not a limit", () => {
    expect(stageBand(view(null), "film_finish")).toBe(DEGRADE_BANDS.NONE_REPORTED);
    expect(stageFrom(view(null), "film_finish")).toBeNull();
  });

  it("null-object and degraded-null are DIFFERENT, which is the whole point of cf#549", () => {
    const never = { film_finish: null } as unknown as RenderOutput;
    expect(stageBand(never, "film_finish")).not.toBe(stageBand(view(null), "film_finish"));
  });

  it("a degraded string is REPORTED, with the reason VERBATIM", () => {
    const out = view("film-titles: MODULE_FILM_TITLES not bound; shipped uncarded");
    expect(stageBand(out, "film_finish")).toBe(DEGRADE_BANDS.REPORTED);
    const info = stageFrom(out, "film_finish")!;
    expect(info.degraded).toBe(1);
    expect(info.reasons).toEqual(["film-titles: MODULE_FILM_TITLES not bound; shipped uncarded"]);
    expect(stageSummary(info)).toContain("title-card and caption pass");
    // One reason always, so a count would be false precision.
    expect(stageSummary(info)).not.toMatch(/\d/);
  });

  it("an object with NO `degraded` key is UNREADABLE, never clean", () => {
    // Core always emits the key, so its absence is a shape we do not recognise. Reading an
    // unrecognised shape as "ran clean" is the one direction this must never fail in.
    const out = { film_finish: { applied: ["titles"], adopted: [] } } as unknown as RenderOutput;
    expect(stageBand(out, "film_finish")).toBe(DEGRADE_BANDS.UNREADABLE);
    expect(stageFrom(out, "film_finish")).toBeNull();
  });

  it("a non-string, non-null `degraded` is UNREADABLE", () => {
    for (const bad of [0, 1, {}, [], true, ""] as unknown[]) {
      expect(stageBand(view(bad as null), "film_finish")).toBe(DEGRADE_BANDS.UNREADABLE);
    }
  });

  it("`adopted` is carried, and CANNOT light a badge on its own (fc#1662)", () => {
    // The wasted-work signal: steps whose artifact was found in R2 rather than run. Real, worth
    // keeping, and NOT a degrade. A film that reused every step but applied its cards cleanly is
    // not a limited film, and if adopted ever starts lighting the badge that is this test's job.
    const reused = view(null, { applied: ["titles", "subtitle"], adopted: ["titles", "subtitle"] });
    expect(stageBand(reused, "film_finish")).toBe(DEGRADE_BANDS.NONE_REPORTED);
    expect(stageFrom(reused, "film_finish")).toBeNull();
    expect(combineBands([stageBand(reused, "film_finish")]).limited).toBe(false);
    // But it is not thrown away either: it rides on the info when there IS a degrade to report.
    const degradedAndReused = view("subtitle: passthrough", { adopted: ["titles"] });
    expect(stageFrom(degradedAndReused, "film_finish")!.adopted).toEqual(["titles"]);
    expect(stageFrom(degradedAndReused, "film_finish")!.applied).toEqual([]);
  });

  it("a malformed LEDGER does not decide the band -- only the degrade does", () => {
    // Deliberately forgiving here and strict on `degraded`: the band is a statement about the
    // degrade, so junk in `applied`/`adopted` must not turn a clean pass into "unreadable".
    const out = view(null, { applied: "not-an-array", adopted: 7 });
    expect(stageBand(out, "film_finish")).toBe(DEGRADE_BANDS.NONE_REPORTED);
    expect(parseFilmFinish({ degraded: null, applied: "x", adopted: 7 })).toEqual({
      degraded: 0,
      reasons: [],
      applied: [],
      adopted: [],
    });
  });

  it("is in STAGE_KEYS, so both panel surfaces pick it up with no new rendering code", () => {
    expect(STAGE_KEYS).toContain("film_finish");
  });
});
