import { describe, expect, it } from "vitest";

import {
  COLD_START_NOTE,
  PHASE_LABELS,
  PIPELINE_PHASES,
  STATUS_LABELS,
  STALL_NOTE,
  isColdStart,
  isStalled,
  isStartupWindow,
  phaseLabel,
  progressFraction,
  remainingMs,
  statusLabel,
  waitCopy,
  type RenderPollView,
  type RenderProgressOutput,
} from "../public/render-eta.js";

// #115: the render-status poll envelope only carries a `progress` float during
// the i2v phase; keyframe pins scene_index=1 and finish/assemble/mux carry no
// per-unit signal. The old fraction math returned 0 (keyframe) or null
// (assemble/mux), so the UI sat at "?% eta computing..." for the whole render.
// progressFraction maps phases onto cumulative bands so overall completion is
// always defined and monotonic across phases.

const out = (o: Partial<RenderProgressOutput>): RenderProgressOutput => o as RenderProgressOutput;

describe("progressFraction phase bands (#115)", () => {
  it("core film bands are ordered, contiguous, and sum to 1", () => {
    const core = new Set(["keyframe", "i2v", "finish", "assemble", "mux"]);
    let cursor = 0;
    for (const b of PIPELINE_PHASES.filter((p) => core.has(p.key))) {
      expect(b.start).toBeCloseTo(cursor, 6);
      cursor += b.span;
    }
    expect(cursor).toBeCloseTo(1, 6);
  });

  it("scatter shards use shot progress across most of the bar", () => {
    expect(progressFraction(out({ phase: "shards", progress: 0 }))).toBeCloseTo(0, 6);
    expect(progressFraction(out({ phase: "shards", progress: 2 / 7 }))).toBeCloseTo(0.85 * (2 / 7), 5);
    expect(phaseLabel("shards")).toBe("Animating shots");
    expect(phaseLabel("gather")).toBe("Putting the film together");
  });

  it("scatter with no shots done is a startup window", () => {
    expect(isStartupWindow(out({ phase: "shards", progress: 0, scene_index: 1 }))).toBe(true);
    expect(isStartupWindow(out({ phase: "shards", progress: 0.3, scene_index: 3 }))).toBe(false);
  });

  it("keyframe sits at the band floor (no per-keyframe signal)", () => {
    expect(progressFraction(out({ phase: "keyframe", scene_index: 1, scene_total: 6 }))).toBeCloseTo(0, 6);
  });

  it("i2v uses the progress float within its band", () => {
    // i2v band = [0.35, 0.85). progress 0.5 -> 0.35 + 0.5*0.5 = 0.60.
    expect(progressFraction(out({ phase: "i2v", progress: 0.5, scene_index: 3, scene_total: 6 }))).toBeCloseTo(0.6, 6);
  });

  it("i2v falls back to completed-scene count when no progress float", () => {
    // scene_index 4 -> (4-1)/6 = 0.5 -> 0.35 + 0.5*0.5 = 0.60.
    expect(progressFraction(out({ phase: "i2v", scene_index: 4, scene_total: 6 }))).toBeCloseTo(0.6, 6);
  });

  it("finish / assemble / mux are defined (NOT null) at their band floors -- the #115 bug", () => {
    expect(progressFraction(out({ phase: "finish", scene_total: 6 }))).toBeCloseTo(0.85, 6);
    expect(progressFraction(out({ phase: "assemble", scene_total: 6 }))).toBeCloseTo(0.93, 6);
    expect(progressFraction(out({ phase: "mux", scene_total: 6 }))).toBeCloseTo(0.98, 6);
  });

  it("is monotonic across the pipeline phase sequence", () => {
    const seq = [
      progressFraction(out({ phase: "keyframe", scene_index: 1, scene_total: 4 })),
      progressFraction(out({ phase: "i2v", progress: 0.5 })),
      progressFraction(out({ phase: "finish", scene_index: 2, scene_total: 4 })),
      progressFraction(out({ phase: "assemble" })),
      progressFraction(out({ phase: "mux" })),
    ];
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1] as number);
    }
  });

  it("clamps an out-of-range within-phase signal into the band", () => {
    // scene_index past total must not push past the band ceiling.
    const f = progressFraction(out({ phase: "i2v", scene_index: 99, scene_total: 6 }));
    expect(f).toBeLessThanOrEqual(0.85);
    expect(f).toBeGreaterThanOrEqual(0.35);
  });
});

describe("progressFraction legacy / non-film fallback", () => {
  it("uses a bare progress float when no phase is present", () => {
    expect(progressFraction(out({ progress: 0.42 }))).toBeCloseTo(0.42, 6);
  });
  it("uses scene_index/scene_total when no phase or progress", () => {
    expect(progressFraction(out({ scene_index: 3, scene_total: 4 }))).toBeCloseTo(0.5, 6);
  });
  it("parses the latest Scene N/M out of the log", () => {
    expect(progressFraction(out({ log: ["Scene 1/4 ...", "Scene 2/4 ..."] }))).toBeCloseTo(0.25, 6);
  });
  it("falls back to legacy signals when the phase string is unknown", () => {
    expect(progressFraction(out({ phase: "warmup", progress: 0.2 }))).toBeCloseTo(0.2, 6);
  });
  it("returns null when there is no signal at all", () => {
    expect(progressFraction(out({ phase: "assemble-unknown" }))).toBeNull();
    expect(progressFraction(out({}))).toBeNull();
    expect(progressFraction(null)).toBeNull();
  });
});

describe("remainingMs ETA extrapolation (#115)", () => {
  it("extrapolates linearly: total = elapsed/fraction, remaining = total - elapsed", () => {
    // 50% done after 60s -> total ~120s -> ~60s remaining.
    expect(remainingMs(0.5, 60_000)).toBeCloseTo(60_000, 6);
  });
  it("withholds a number below the fraction floor (early model-load skew)", () => {
    expect(remainingMs(0.01, 60_000)).toBeNull();
  });
  it("withholds a number below the elapsed floor", () => {
    expect(remainingMs(0.5, 5_000)).toBeNull();
  });
  it("returns null for a non-positive or missing fraction", () => {
    expect(remainingMs(0, 60_000)).toBeNull();
    expect(remainingMs(null, 60_000)).toBeNull();
  });
  it("never returns negative remaining", () => {
    expect(remainingMs(1, 60_000)).toBe(0);
  });
});

// cf#303: cold start is a permanent accepted characteristic (workersMin is 0 by
// a standing cost ruling), so the panel must EXPLAIN it rather than hide it or
// fake motion through it. These cover the two pure helpers that carry that.
describe("phaseLabel: user-facing names for pipeline tokens (cf#303)", () => {
  it("maps every internal band key to a human-readable label", () => {
    // Guards the real coupling: a band the user can reach with no label would
    // surface raw jargon. Enumerated from PIPELINE_PHASES, not hardcoded, so a
    // NEW band added upstream fails this test instead of silently shipping.
    for (const band of PIPELINE_PHASES) {
      expect(PHASE_LABELS[band.key], `no label for band "${band.key}"`).toBeTruthy();
      expect(phaseLabel(band.key)).toBe(PHASE_LABELS[band.key]);
    }
  });

  it("labels the pre-submit queued window, which carries no envelope phase", () => {
    expect(phaseLabel("queued")).toBe("Waiting to start");
  });

  it("keeps the filmmaker phase words", () => {
    expect(PHASE_LABELS.keyframe).toBe("Drawing keyframes");
    expect(PHASE_LABELS.i2v).toBe("Animating shots");
    expect(PHASE_LABELS.assemble).toBe("Putting the film together");
  });

  it("is case-insensitive on the token", () => {
    expect(phaseLabel("KEYFRAME")).toBe(PHASE_LABELS.keyframe);
  });

  it("passes an UNKNOWN phase through raw rather than hiding it", () => {
    // Degrade to "visible but unpolished", never to "silently missing": a new
    // backend phase must not blank the row.
    expect(phaseLabel("brand_new_phase")).toBe("brand_new_phase");
  });

  it("returns null only when there is genuinely no phase", () => {
    expect(phaseLabel("")).toBeNull();
    expect(phaseLabel(null)).toBeNull();
    expect(phaseLabel(undefined)).toBeNull();
  });

  it("does not leak inherited Object members for prototype-shaped tokens", () => {
    // A bare map lookup would return Object.prototype.constructor here and the
    // panel would render a function body into the DOM.
    expect(phaseLabel("constructor")).toBe("constructor");
    expect(phaseLabel("toString")).toBe("toString");
  });
});

describe("isStartupWindow: prefers the observed queue signal (cf#303)", () => {
  const out = (o: Partial<RenderProgressOutput>): RenderProgressOutput =>
    o as RenderProgressOutput;

  it("is true while the keyframe phase is underway with nothing drawn yet", () => {
    expect(isStartupWindow(out({ phase: "keyframe", scene_index: 1 }))).toBe(true);
  });

  it("is FALSE once the server says the phase has stalled", () => {
    // THE LOAD-BEARING CASE. The startup note is reassuring; if it kept showing
    // through a stall it would explain away the exact failure this work exists
    // to make visible, which is worse than the silence we started with.
    expect(isStartupWindow(out({ phase: "keyframe", scene_index: 1, stalled: true }))).toBe(false);
  });

  it("is false once keyframes start landing", () => {
    expect(isStartupWindow(out({ phase: "keyframe", scene_index: 2 }))).toBe(false);
    expect(isStartupWindow(out({ phase: "keyframe", progress: 0.25 }))).toBe(false);
  });

  it("is false outside the keyframe phase", () => {
    expect(isStartupWindow(out({ phase: "i2v", scene_index: 1 }))).toBe(false);
    expect(isStartupWindow(out({ phase: "mux" }))).toBe(false);
  });

  it("is false for null/undefined envelopes", () => {
    expect(isStartupWindow(null)).toBe(false);
    expect(isStartupWindow(undefined)).toBe(false);
  });
});

describe("isStalled: the server's verdict, now surfaced live (cf#303)", () => {
  const out = (o: Partial<RenderProgressOutput>): RenderProgressOutput =>
    o as RenderProgressOutput;

  it("reads the server-authored flag and nothing else", () => {
    expect(isStalled(out({ stalled: true }))).toBe(true);
    expect(isStalled(out({ phase: "keyframe", scene_index: 1 }))).toBe(false);
    expect(isStalled(null)).toBe(false);
  });

  it("never infers a stall from a merely slow render", () => {
    // A long startup is not a stall. Only the orchestrator, which knows
    // KEYFRAME_STALL_SECONDS and the phase clock, gets to make that call.
    expect(isStalled(out({ phase: "keyframe", scene_index: 1, last_progress_at: 1 }))).toBe(false);
  });
});

describe("the two notes are mutually exclusive (cf#303)", () => {
  const out = (o: Partial<RenderProgressOutput>): RenderProgressOutput =>
    o as RenderProgressOutput;

  it("a stalled keyframe render is never also a startup window", () => {
    const stalledOut = out({ phase: "keyframe", scene_index: 1, stalled: true });
    expect(isStalled(stalledOut)).toBe(true);
    expect(isStartupWindow(stalledOut)).toBe(false);
  });
});

describe("cold-start copy (cf#303)", () => {
  it("names the wait in filmmaker language, not GPU economics", () => {
    expect(COLD_START_NOTE).toMatch(/starting up/i);
    expect(COLD_START_NOTE).toMatch(/model coming online/i);
    expect(COLD_START_NOTE).not.toMatch(/RunPod/i);
    expect(COLD_START_NOTE).not.toMatch(/cost/i);
    expect(COLD_START_NOTE).not.toMatch(/idle/i);
  });

  it("does not dump IN_QUEUE or vendor names into filmmaker copy", () => {
    expect(COLD_START_NOTE).not.toMatch(/queue/i);
    expect(COLD_START_NOTE).not.toMatch(/IN_QUEUE/);
    expect(COLD_START_NOTE).not.toMatch(/RunPod/i);
  });

  it("carries no em-dash or en-dash (house style)", () => {
    expect(COLD_START_NOTE).not.toMatch(/[\u2014\u2013]/);
    expect(STALL_NOTE).not.toMatch(/[\u2014\u2013]/);
  });
});

describe("the startup window still refuses to fabricate motion (cf#303)", () => {
  const out = (o: Partial<RenderProgressOutput>): RenderProgressOutput =>
    o as RenderProgressOutput;

  it("keeps the bar at the keyframe band floor during startup", () => {
    // Adding the note must change the WORDS, never the fraction.
    const o1 = out({ phase: "keyframe", scene_index: 1 });
    expect(isStartupWindow(o1)).toBe(true);
    expect(progressFraction(o1)).toBe(0);
  });

  it("withholds an ETA during the startup window", () => {
    expect(remainingMs(progressFraction(out({ phase: "keyframe", scene_index: 1 })), 120_000)).toBeNull();
  });
});

describe("IN_QUEUE / delayTime is a distinct visible state from a running encode (cf#303)", () => {
  const queued: RenderPollView = {
    status: "IN_QUEUE",
    delayTimeMs: 12_000,
    output: { phase: "keyframe", scene_index: 1 },
  };
  const running: RenderPollView = {
    status: "IN_PROGRESS",
    output: { phase: "i2v", progress: 0.4, scene_index: 3, scene_total: 6 },
  };

  it("a poll with delayTime / IN_QUEUE is a cold start", () => {
    expect(isColdStart(queued)).toBe(true);
    expect(isStartupWindow(queued)).toBe(true);
    expect(waitCopy(queued)).toBe(COLD_START_NOTE);
    expect(statusLabel(queued.status)).toBe("Starting up");
  });

  it("a running encode with no queue delay is not a cold start", () => {
    expect(isColdStart(running)).toBe(false);
    expect(isStartupWindow(running)).toBe(false);
    expect(waitCopy(running)).toBeNull();
    expect(statusLabel(running.status)).toBe("Rendering");
  });

  it("the two polls produce different visible words and a different bar fraction", () => {
    expect(waitCopy(queued)).not.toBe(waitCopy(running));
    expect(statusLabel(queued.status)).not.toBe(statusLabel(running.status));
    expect(progressFraction(queued.output as RenderProgressOutput)).toBe(0);
    expect(progressFraction(running.output as RenderProgressOutput)).toBeGreaterThan(0.3);
  });

  it("delayTime on IN_PROGRESS is historical, not a live cold start", () => {
    const ranAfterQueue: RenderPollView = {
      status: "IN_PROGRESS",
      delayTimeMs: 45_000,
      output: { phase: "i2v", progress: 0.2 },
    };
    expect(isColdStart(ranAfterQueue)).toBe(false);
    expect(waitCopy(ranAfterQueue)).toBeNull();
  });

  it("backend_wait=accepted is the film-path equivalent of IN_QUEUE", () => {
    expect(
      isColdStart({
        status: "IN_PROGRESS",
        output: { phase: "keyframe", backend_wait: "accepted" },
      }),
    ).toBe(true);
    expect(
      isColdStart({
        status: "IN_PROGRESS",
        output: { phase: "keyframe", backend_wait: "running", scene_index: 1 },
      }),
    ).toBe(false);
  });

  it("a running keyframe with no frames yet is not called a cold start", () => {
    // This is the hole the old heuristic could not see: IN_PROGRESS +
    // keyframe + nothing drawn used to share the startup note with IN_QUEUE.
    const sampling: RenderPollView = {
      status: "IN_PROGRESS",
      output: { phase: "keyframe", backend_wait: "running", scene_index: 1 },
    };
    expect(isStartupWindow(sampling)).toBe(false);
    expect(waitCopy(sampling)).toBeNull();
    expect(waitCopy(queued)).toBe(COLD_START_NOTE);
  });
});

describe("statusLabel: filmmaker words, raw token as fallback (cf#303)", () => {
  it("translates IN_QUEUE and IN_PROGRESS to different English", () => {
    expect(statusLabel("IN_QUEUE")).toBe("Starting up");
    expect(statusLabel("IN_PROGRESS")).toBe("Rendering");
    expect(statusLabel("IN_QUEUE")).not.toBe(statusLabel("IN_PROGRESS"));
  });

  it("covers every STATUS_LABELS key without em-dashes", () => {
    for (const [token, label] of Object.entries(STATUS_LABELS)) {
      expect(statusLabel(token)).toBe(label);
      expect(label).not.toMatch(/[\u2014\u2013]/);
      expect(label).not.toBe(token);
    }
  });

  it("passes an unknown status through raw", () => {
    expect(statusLabel("SCATTER_WAIT")).toBe("SCATTER_WAIT");
  });

  it("returns null only when there is no status", () => {
    expect(statusLabel("")).toBeNull();
    expect(statusLabel(null)).toBeNull();
    expect(statusLabel(undefined)).toBeNull();
  });
});
