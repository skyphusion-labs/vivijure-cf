import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  JITTER_MIN_FACTOR,
  JITTER_SPAN,
  POLL_BASE_MS,
  createLoop,
  registeredLoopCount,
} from "../public/poll-schedule.js";
import type { DocumentLike, PollLoop } from "../public/poll-schedule.js";

// cf#581 (+ cf#573). PR #563 gave the RENDER poll jitter, backoff and a real
// visibility pause. PR #575 gave jitter and backoff to the remaining loops and
// DELIBERATELY stopped short of the pause, because a pause needs a matching
// RESUME per loop and a pause with no resume is a WORSE defect than the one it
// fixes: the user backgrounds the tab, the poll never re-arms, and the panel
// sits on "pending" forever for a LoRA run, a music bed or a shot regen that
// actually completed.
//
// cf#581 says in as many words which assertion carries this suite: "Assert that
// no poll fires while document.hidden is true AND that an in-flight job resumes
// polling on visibility return. The SECOND assertion is the one that matters and
// it must be driven red first: a test suite that only asserts the pause will go
// green on exactly the defect this issue exists to avoid."
//
// That is not hypothetical. Measured against the pre-change suite: every one of
// the existing assertions passes on a loop that is paused and NEVER resumed.
// tests/poll-schedule-515.test.ts asserts armPoll calls the injected timer ZERO
// times while hidden, which is the pause half with no counterpart, and the only
// resume coverage anywhere was three toContain substring checks on
// planner-init.js. Emptying the body of resumeRenderPoll leaves all of them
// green. An absence check passes when the thing was killed outright.
//
// So every lifecycle test below asserts a DELTA (the run function was invoked,
// the loop reports it resumed) rather than an absence.

// A document with exactly the surface the policy touches, so the resume path is
// reachable from plain node with no DOM. The listener is captured rather than
// dispatched through a real event target, because what is under test is that the
// policy registers ONE listener and drives the right loops from it.
function fakeDoc(): DocumentLike & {
  fire: () => void;
  listenerCount: number;
} {
  const listeners: Array<() => void> = [];
  return {
    hidden: false,
    listenerCount: 0,
    addEventListener(type: string, fn: () => void) {
      if (type !== "visibilitychange") return;
      listeners.push(fn);
      this.listenerCount = listeners.length;
    },
    fire() {
      for (const fn of listeners.slice()) fn();
    },
  } as DocumentLike & { fire: () => void; listenerCount: number };
}

interface Harness {
  doc: ReturnType<typeof fakeDoc>;
  loop: PollLoop;
  runs: () => number;
  armedDelays: () => number[];
}

function harness(opts: {
  baseMs?: number;
  active?: () => boolean;
  random?: () => number;
  maxErrorStreak?: number;
  onGiveUp?: (n: number) => void;
} = {}): Harness {
  const doc = fakeDoc();
  const armedDelays: number[] = [];
  let runs = 0;
  const loop = createLoop({
    baseMs: opts.baseMs,
    random: opts.random,
    maxErrorStreak: opts.maxErrorStreak,
    onGiveUp: opts.onGiveUp,
    doc,
    run: () => {
      runs += 1;
    },
    isActive: opts.active || (() => true),
    setTimer: (_fn: () => void, ms: number) => {
      armedDelays.push(ms);
      return armedDelays.length;
    },
    clearTimer: () => undefined,
  });
  return { doc, loop, runs: () => runs, armedDelays: () => armedDelays };
}

describe("cf#581: the poll lifecycle pauses AND resumes", () => {
  it("PROBE WITH A NON-DEFAULT VALUE: the loop honours baseMs rather than substituting the default", () => {
    // On the DEFAULT base, honoured and substituted are byte-identical, so a
    // test written against POLL_BASE_MS cannot tell the two apart. Every base in
    // the tree is non-default (4000 regen, 5000 LoRA and music, 8000 demo), so
    // this probes with the regen base and asserts the produced band could not
    // have come from the default.
    const NON_DEFAULT = 4000;
    expect(NON_DEFAULT).not.toBe(POLL_BASE_MS);

    const h = harness({ baseMs: NON_DEFAULT, random: () => 0.5 });
    h.loop.arm();

    const expected = Math.round(NON_DEFAULT * (JITTER_MIN_FACTOR + JITTER_SPAN * 0.5));
    expect(h.armedDelays()).toEqual([expected]);

    // The discriminating half: the default would have produced a value outside
    // the non-default band entirely.
    const defaultBand = Math.round(POLL_BASE_MS * JITTER_MIN_FACTOR);
    expect(expected).toBeLessThan(defaultBand);
  });

  it("arms nothing while hidden, and records PAUSED rather than stopped", () => {
    const h = harness({ baseMs: 4000 });
    h.doc.hidden = true;
    h.loop.arm();

    expect(h.armedDelays()).toEqual([]);
    expect(h.loop.state().armed).toBe(false);
    // The delta that distinguishes paused from dead. An absence check cannot.
    expect(h.loop.state().paused).toBe(true);
  });

  it("RESUMES on visibility return, with an immediate poll -- the assertion cf#581 names", () => {
    const h = harness({ baseMs: 5000 });
    h.doc.hidden = true;
    h.loop.arm();
    expect(h.runs()).toBe(0);

    h.doc.hidden = false;
    h.doc.fire();

    // Not "a timer was armed": the poll RAN, at once, so a tab hidden for ten
    // minutes is current immediately rather than after another full interval.
    expect(h.runs()).toBe(1);
    expect(h.loop.state().paused).toBe(false);
  });

  it("pauses on the way out and resumes on the way back, driven by the same listener", () => {
    const h = harness({ baseMs: 5000 });
    h.loop.arm();
    expect(h.armedDelays().length).toBe(1);

    h.doc.hidden = true;
    h.doc.fire();
    expect(h.loop.state().paused).toBe(true);
    expect(h.loop.state().armed).toBe(false);
    expect(h.runs()).toBe(0);

    h.doc.hidden = false;
    h.doc.fire();
    expect(h.runs()).toBe(1);
  });

  it("does NOT resume a job that finished while the tab was hidden", () => {
    let active = true;
    const h = harness({ baseMs: 5000, active: () => active });
    h.doc.hidden = true;
    h.loop.arm();
    expect(h.loop.state().paused).toBe(true);

    // The job completed server-side while the tab was in the background.
    active = false;
    h.doc.hidden = false;
    h.doc.fire();

    expect(h.runs()).toBe(0);
    expect(h.loop.resume()).toBe(false);
  });

  it("does not mark an already-finished loop as paused", () => {
    const h = harness({ baseMs: 5000, active: () => false });
    h.doc.hidden = true;
    h.doc.fire();
    expect(h.loop.state().paused).toBe(false);
  });

  it("stop() leaves the loop inert but re-armable; destroy() unregisters it", () => {
    const doc = fakeDoc();
    let active = true;
    let runs = 0;
    const loop = createLoop({
      baseMs: 4000,
      doc,
      run: () => {
        runs += 1;
      },
      isActive: () => active,
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
    expect(registeredLoopCount(doc)).toBe(1);

    doc.hidden = true;
    loop.arm();
    expect(loop.state().paused).toBe(true);
    active = false;
    loop.stop();
    expect(loop.state().paused).toBe(false);
    // Still registered: the same loop object serves the next job of its kind.
    expect(registeredLoopCount(doc)).toBe(1);

    loop.destroy();
    expect(registeredLoopCount(doc)).toBe(0);
    active = true;
    doc.hidden = false;
    doc.fire();
    expect(runs).toBe(0);
  });

  it("attaches exactly ONE visibilitychange listener per document, however many loops", () => {
    const doc = fakeDoc();
    const mk = () =>
      createLoop({
        doc,
        run: () => undefined,
        isActive: () => true,
        setTimer: () => 1,
        clearTimer: () => undefined,
      });
    mk();
    mk();
    mk();
    // Two listeners would call resume twice, and resume runs the poll body, so
    // this is a correctness assertion and not a tidiness one.
    expect(doc.listenerCount).toBe(1);
    expect(registeredLoopCount(doc)).toBe(3);
  });

  it("refuses to build a loop with no isActive predicate", () => {
    // A default of "always active" is the silent-fallback shape: resume would
    // restart a finished job and the failure would read as working.
    expect(() =>
      // @ts-expect-error deliberately omitting the required predicate
      createLoop({ run: () => undefined, doc: fakeDoc() }),
    ).toThrow(/isActive/);
  });
});

describe("cf#573: the attempt cap bounds the TOTAL, not just the rate", () => {
  it("gives up at the cap, once, and arms nothing afterwards", () => {
    let gaveUpWith = -1;
    let calls = 0;
    const h = harness({
      baseMs: 4000,
      maxErrorStreak: 3,
      onGiveUp: (n) => {
        calls += 1;
        gaveUpWith = n;
      },
    });

    h.loop.armAfterError();
    h.loop.armAfterError();
    expect(h.loop.state().gaveUp).toBe(false);
    expect(h.armedDelays().length).toBe(2);

    h.loop.armAfterError();
    expect(h.loop.state().gaveUp).toBe(true);
    expect(calls).toBe(1);
    expect(gaveUpWith).toBe(3);
    // The delta: no further timer was armed by the failing arm.
    expect(h.armedDelays().length).toBe(2);

    // And it stays given up.
    h.loop.arm();
    expect(h.armedDelays().length).toBe(2);
    h.doc.hidden = false;
    h.doc.fire();
    expect(h.runs()).toBe(0);
  });

  it("no cap by default, so a legitimately long job is not cut off", () => {
    const h = harness({ baseMs: 4000 });
    for (let i = 0; i < 40; i++) h.loop.armAfterError();
    expect(h.loop.state().gaveUp).toBe(false);
    expect(h.armedDelays().length).toBe(40);
  });

  it("a good poll clears the backoff, so a recovered studio is watched at full cadence", () => {
    const h = harness({ baseMs: 4000, random: () => 0 });
    h.loop.armAfterError();
    h.loop.armAfterError();
    const backedOff = h.armedDelays()[1];
    h.loop.armAfterSuccess();
    const recovered = h.armedDelays()[2];
    expect(backedOff).toBeGreaterThan(recovered);
    expect(recovered).toBe(Math.round(4000 * JITTER_MIN_FACTOR));
    expect(h.loop.state().errorStreak).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Structural half. The population is derived from the FILESYSTEM by UNION, not
// from a hardcoded list, because a hardcoded list asserts a constant about
// itself: the pre-change suite asserted expect(plannerOwn.length).toBe(2) over
// its own literal array, which is why two poll loops and two fetch sites stayed
// uncounted for two PRs.

const PUBLIC_DIR = join(__dirname, "..", "public");

function publicJsFiles(): string[] {
  return readdirSync(PUBLIC_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort();
}

function read(f: string): string {
  return readFileSync(join(PUBLIC_DIR, f), "utf8");
}

// Strip line comments so a tombstone ("this used to be a bare setTimeout") is
// not counted as live code. Measured: 8 of 20 setTimeout hits in this tree are
// comment prose.
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((ln) => !/^\s*(\/\/|\*|\/\*)/.test(ln))
    .join("\n");
}

describe("cf#581: every self-rescheduling poll loop has a visibility pause with a resume", () => {
  it("the four loops that had NO hidden guard now own one through the shared primitive", () => {
    const MIGRATED = [
      "cast.js",
      "demo-steer.js",
      "planner-audio.js",
      "planner-history-row.js",
    ];
    const files = publicJsFiles();
    // Denominator, printed rather than assumed.
    expect(files.length).toBeGreaterThan(MIGRATED.length);

    const withCreateLoop = files.filter((f) => /createLoop\(/.test(codeOnly(read(f))));
    // Positive control: the matcher finds createLoop where it certainly exists.
    expect(withCreateLoop).toContain("poll-schedule.js");

    const consumers = withCreateLoop.filter((f) => f !== "poll-schedule.js").sort();
    expect(consumers).toEqual(MIGRATED);
  });

  it("none of the migrated loops re-arms itself with a bare timer any more", () => {
    for (const f of ["cast.js", "demo-steer.js", "planner-audio.js", "planner-history-row.js"]) {
      const code = codeOnly(read(f));
      // The shapes each of these four used before the change.
      expect(code).not.toMatch(/setTimeout\(\s*\(\)\s*=>\s*poll/);
      expect(code).not.toMatch(/setTimeout\(\s*poll[A-Za-z]*\s*,/);
      expect(code).not.toMatch(/=\s*setTimeout\(function/);
    }
    // Positive control: the matcher DOES fire on the shape it is looking for.
    expect(/setTimeout\(\s*\(\)\s*=>\s*poll/.test("x = setTimeout(() => pollThing(1), 5);")).toBe(
      true,
    );
  });

  it("the two loops that already had a pause keep their own wiring, and are NOT double-driven", () => {
    // planner-render.js and planner-history-list.js were guarded before this
    // change, by the single visibilitychange handler in planner-init.js. They
    // deliberately do NOT register with the shared listener: a loop driven by
    // both would be resumed twice, and resume runs the poll body, so this is a
    // correctness assertion. The render poll is also the instrument the cf#512
    // load run measures with, and moving it onto a new primitive in the same
    // change that introduces the primitive is a risk taken for no gain.
    for (const f of ["planner-render.js", "planner-history-list.js"]) {
      expect(codeOnly(read(f))).not.toMatch(/createLoop\(/);
    }
    const init = codeOnly(read("planner-init.js"));
    expect(init).toContain("visibilitychange");
    expect(init).toContain("pauseRenderPoll()");
    expect(init).toContain("resumeRenderPoll()");
  });

  it("the LoRA and demo loops are on pages with no visibilitychange handler of their own", () => {
    // This is why the listener had to live in the primitive. cast.html and
    // modules.html do not load planner-init.js, which was the ONLY file in the
    // tree carrying a visibilitychange listener, so a pause wired the planner
    // way could never have fired on those pages.
    for (const page of ["cast.html", "modules.html"]) {
      const html = readFileSync(join(PUBLIC_DIR, page), "utf8");
      expect(html).not.toMatch(/planner-init\.js/);
      // ...and they DO load the shared policy, which is what carries the pause.
      expect(html).toMatch(/poll-schedule\.js/);
    }
    // Positive control: planner.html is the page that does load the handler.
    expect(readFileSync(join(PUBLIC_DIR, "planner.html"), "utf8")).toMatch(/planner-init\.js/);
  });
});
