import { describe, expect, it } from "vitest";

import {
  BACKOFF_FACTOR,
  BACKOFF_MAX_MS,
  JITTER_MIN_FACTOR,
  JITTER_SPAN,
  POLL_BASE_MS,
  armPoll,
  nextPollDelayMs,
} from "../public/poll-schedule.js";

// cf#515. Two independent defects compounded on the render poll: it was
// unjittered (so clients that start in one window converge onto the same 8s
// boundary and stay there, arriving as a spike) and it never paused, so a
// backgrounded tab polled forever and a run could not shed load.
//
// This route is not a read. GET /api/storyboard/render/<id> is one of the two
// drivers of advanceFilmJob, so it is also what closes a film's DB row --
// which makes it the thing that sets cf#512's metric 2, observation lag. The
// arming policy therefore has to be testable on its own, in node, without a
// DOM: hence a pure module with random / setTimeout / hidden all injected.

const fixedRandom = (v: number) => () => v;

describe("nextPollDelayMs -- jitter (cf#515 defect 1)", () => {
  it("spans exactly the declared window at the extremes of random()", () => {
    // random() is [0,1), so these are the true bounds of the produced band.
    expect(nextPollDelayMs({ random: fixedRandom(0) })).toBe(
      Math.round(POLL_BASE_MS * JITTER_MIN_FACTOR),
    );
    // Not reachable in practice (random() < 1), but it pins the top of the band.
    expect(nextPollDelayMs({ random: fixedRandom(0.999999) })).toBeLessThanOrEqual(
      Math.round(POLL_BASE_MS * (JITTER_MIN_FACTOR + JITTER_SPAN)),
    );
  });

  it("N independent clients do not land on one boundary, and they cover the window", () => {
    // The acceptance in cf#515 says a green run with ONE client proves nothing,
    // so this drives 200 and asserts on the DISTRIBUTION, not on one draw.
    const N = 200;
    const delays: number[] = [];
    for (let i = 0; i < N; i++) delays.push(nextPollDelayMs({ random: Math.random }));

    const unique = new Set(delays);
    // The failing (pre-fix) behaviour is every client on the identical delay,
    // which is exactly unique.size === 1. Demand real spread, not merely >1.
    expect(unique.size).toBeGreaterThan(N / 4);

    const lo = Math.round(POLL_BASE_MS * JITTER_MIN_FACTOR);
    const hi = Math.round(POLL_BASE_MS * (JITTER_MIN_FACTOR + JITTER_SPAN));
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(lo);
    expect(Math.max(...delays)).toBeLessThanOrEqual(hi);

    // Cover the window rather than clustering: both halves must be populated.
    const mid = (lo + hi) / 2;
    expect(delays.some((d) => d < mid)).toBe(true);
    expect(delays.some((d) => d > mid)).toBe(true);
  });

  // NOTE, kept because the first version of this assertion was WRONG and flaky.
  // It read "never returns the bare base interval", which is false: random()
  // near 0.5 legitimately rounds to exactly POLL_BASE_MS, and MEASURED that
  // band is random() in [0.499792, 0.500208), giving an 8% chance of at least
  // one hit per 200 draws. It would have failed roughly one run in twelve, and
  // seeding random() to silence it would have made the suite green about a
  // property the code does not have.
  //
  // A single client drawing 8000ms is NOT the defect. The defect was every
  // client drawing 8000ms EVERY time. So the property to assert is that the
  // function is not a constant -- which is what distinguishes jittered from
  // fixed-interval, and which cannot pass against the pre-fix behaviour.
  it("is not a constant function, which is what fixed-interval polling was", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(nextPollDelayMs({ random: Math.random }));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("nextPollDelayMs -- backoff (cf#515 defect 1, error paths)", () => {
  it("grows with consecutive errors instead of re-arming flat", () => {
    const r = fixedRandom(0); // pin jitter so only the backoff term moves
    const d0 = nextPollDelayMs({ errorStreak: 0, random: r });
    const d1 = nextPollDelayMs({ errorStreak: 1, random: r });
    const d2 = nextPollDelayMs({ errorStreak: 2, random: r });
    expect(d1).toBeGreaterThan(d0);
    expect(d2).toBeGreaterThan(d1);
    expect(d1 / d0).toBeCloseTo(BACKOFF_FACTOR, 5);
  });

  it("caps, so a long outage cannot push the next poll past the ceiling", () => {
    const capped = nextPollDelayMs({ errorStreak: 50, random: fixedRandom(0.999999) });
    expect(capped).toBeLessThanOrEqual(
      Math.round(BACKOFF_MAX_MS * (JITTER_MIN_FACTOR + JITTER_SPAN)),
    );
  });

  it("still jitters while backing off, so error recovery does not re-synchronise", () => {
    const delays = new Set<number>();
    for (let i = 0; i < 100; i++) delays.add(nextPollDelayMs({ errorStreak: 3, random: Math.random }));
    expect(delays.size).toBeGreaterThan(10);
  });
});

describe("armPoll -- visibility (cf#515 defect 1, backgrounded tabs)", () => {
  it("does not arm a timer at all while the document is hidden", () => {
    let calls = 0;
    const fakeSetTimeout = () => {
      calls++;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    };
    const id = armPoll({
      hidden: true,
      run: () => undefined,
      setTimer: fakeSetTimeout,
      random: Math.random,
    });
    // The load-bearing assertion is the injected timer was NEVER CALLED --
    // not merely that the return was null, which a broken impl could also give.
    expect(calls).toBe(0);
    expect(id).toBe(null);
  });

  it("arms when visible, and hands the scheduler its own jittered delay", () => {
    const seen: number[] = [];
    const fakeSetTimer = (_fn: () => void, ms: number) => {
      seen.push(ms);
      return 7 as unknown as ReturnType<typeof setTimeout>;
    };
    const id = armPoll({
      hidden: false,
      run: () => undefined,
      setTimer: fakeSetTimer,
      random: fixedRandom(0),
    });
    expect(id).toBe(7);
    expect(seen).toEqual([Math.round(POLL_BASE_MS * JITTER_MIN_FACTOR)]);
  });

  it("passes the error streak through to the delay it arms", () => {
    const seen: number[] = [];
    const fakeSetTimer = (_fn: () => void, ms: number) => {
      seen.push(ms);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    };
    armPoll({ hidden: false, errorStreak: 2, run: () => undefined, setTimer: fakeSetTimer, random: fixedRandom(0) });
    expect(seen[0]).toBe(Math.round(POLL_BASE_MS * BACKOFF_FACTOR * BACKOFF_FACTOR * JITTER_MIN_FACTOR));
  });
});

// ---------------------------------------------------------------------------
// Structural guards. The pure tests above prove the POLICY is right; these
// prove the shipped panel actually goes through it. A correct policy that
// nothing calls is decorative, and that is the failure mode this whole issue
// is about, so it gets its own assertions rather than being assumed.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";

// process.cwd() rather than import.meta.url, matching the convention already
// used by tests/panel-no-hardcoded-modules.test.ts. The URL form typechecks
// differently under the tsc gate (node:url URL vs lib URL) and the CI gate
// caught it; there is no reason for this file to invent a second pattern.
const readPublic = (name: string) =>
  readFileSync(process.cwd() + "/public/" + name, "utf8");

// Strip whole-line comments before matching. Without this the guard counts its
// own tombstones: the explanatory comment in planner-render.js quotes the old
// `setTimeout(pollRender, POLL_INTERVAL_MS)` pattern verbatim, so a naive
// matcher reports 2 survivors against a file that has none. Measured during
// this change -- the raw grep really did return 2, both of them prose.
const codeLines = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

describe("cf#515 structural: the panel arms the poll only through the policy", () => {
  it("planner-render.js has NO raw setTimeout(pollRender, ...) left", () => {
    const code = codeLines(readPublic("planner-render.js"));
    // POSITIVE CONTROL FIRST: the matcher must be able to find the pattern at
    // all, or a zero below means nothing. Plant one and confirm it is seen.
    expect((code + "\nrenderState.pollTimer = setTimeout(pollRender, 8000);").match(/setTimeout\(pollRender/g)?.length).toBe(1);
    // The claim.
    expect(code.match(/setTimeout\(pollRender/g)).toBe(null);
  });

  it("planner-render.js routes every arm through schedulePollRender", () => {
    const code = codeLines(readPublic("planner-render.js"));
    expect(code).toContain("pollSchedule.armPoll(");
    // More than one call site, so this is the shared path rather than a helper
    // that happens to exist beside four inline re-arms.
    expect((code.match(/schedulePollRender\(\)/g) || []).length).toBeGreaterThan(2);
  });

  it("the visibility handler pauses AND resumes the render poll", () => {
    const code = codeLines(readPublic("planner-init.js"));
    expect(code).toContain("pauseRenderPoll()");
    expect(code).toContain("resumeRenderPoll()");
    // Control: the handler this rides on is still the history one, so a future
    // refactor that deletes the listener entirely fails here rather than
    // silently passing on two orphaned function names.
    expect(code).toContain("visibilitychange");
  });

  it("poll-schedule.js is loaded by planner.html, or none of the above ships", () => {
    expect(readPublic("planner.html")).toContain('<script src="poll-schedule.js">');
  });
});
