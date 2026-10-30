import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canRetryFinish, completedStatus, incompleteFrom, incompleteSummary, waitingLabel } from "../public/finish-degrade.js";
import {
  FAILURE_NOT_CONFIGURED,
  FAILURE_REFUSED,
  FAILURE_UNREACHABLE,
  failureFromStatus,
  withFailure,
} from "../modules/_shared/finish-failure";

// A film with a missing step must never read as a clean finish in the panel (core#377).

const ENTRY = { stage: "film.finish", step: "subtitle", code: "unreachable", kept: "the film without this step", at: 1 };
const render = readFileSync(join(__dirname, "../public/planner-render.js"), "utf8");

describe("a film with finish_incomplete", () => {
  it("is never painted clean, whatever else the payload says", () => {
    for (const limited of [false, true]) {
      const v = completedStatus({ output_key: "k", finish_incomplete: [ENTRY] }, limited);
      expect(v.tone).toBe("warn");
      expect(v.text).toBe("completed, steps missing");
      expect(v.retry).toBe(true);
    }
  });

  it("an unreadable entry still reads as missing, never as clean", () => {
    expect(completedStatus({ finish_incomplete: [null, 7] as unknown[] }, false).tone).toBe("warn");
    expect(incompleteFrom({ finish_incomplete: [null] as unknown[] })).toHaveLength(1);
  });

  it("a clean film stays green, so the warning means something", () => {
    expect(completedStatus({ output_key: "k" }, false)).toMatchObject({ tone: "success", text: "completed", retry: false });
    expect(completedStatus({ output_key: "k", finish_incomplete: [] }, false).tone).toBe("success");
    expect(incompleteFrom({ output_key: "k" })).toBeNull();
  });

  it("the summary names the step and what is kept", () => {
    const s = incompleteSummary(incompleteFrom({ finish_incomplete: [ENTRY] }));
    expect(s).toContain("subtitle did not run");
    expect(s).toContain("the film without this step");
    expect(s).toContain("Retry");
  });

  it("the panel's status line goes through that one decision, and it offers the retry", () => {
    expect(render).toContain("window.finishDegrade.completedStatus(out, limited)");
    expect(render).toContain("setRenderStatus(verdict.text + elapsed, verdict.tone)");
    expect(render).toContain("/finish-retry");
    expect(render).not.toContain('(limited ? "completed with limits" : "completed") + elapsed');
  });
});

describe("the retry button", () => {
  it("is offered only for a job the route accepts", () => {
    expect(canRetryFinish("film-abc")).toBe(true);
    for (const id of ["scatter-abc", "", null, undefined]) expect(canRetryFinish(id)).toBe(false);
    expect(render).toContain("fd.canRetryFinish(jobId)");
  });
  it("no route in this studio starts a scatter film, so a new film can always retry", () => {
    const index = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
    expect(index).not.toContain("startScatterRender");
    expect(index).toContain("startFilmJob(env");
  });
});

describe("waitingLabel", () => {
  it("says the position when a queue gave one", () => {
    expect(waitingLabel({ finish_waiting: { position: 3, depth: 5 } })).toBe("waiting for a finish slot, position 3 of 5");
  });
  it("says what is waiting when there is no queue", () => {
    expect(waitingLabel({ finish_waiting: { step: "subtitle" } })).toBe("waiting on subtitle, will retry");
    expect(waitingLabel({ finish_waiting: {} })).toBe("waiting for the finish tier, will retry");
  });
  it("is null when not waiting", () => {
    expect(waitingLabel({})).toBeNull();
    expect(waitingLabel(null)).toBeNull();
  });
});

describe("failureFromStatus", () => {
  it("only 429 is capacity, the one code held for hours", () => {
    expect(failureFromStatus(429)).toMatchObject({ kind: "transient", code: "capacity" });
    for (const s of [500, 502, 503, 504]) expect(failureFromStatus(s)).toMatchObject({ kind: "transient", code: "server_error" });
  });
  it("a 4xx is permanent, including a bad token, because no wait cures it", () => {
    for (const s of [400, 401, 403, 404]) expect(failureFromStatus(s).kind).toBe("permanent");
  });
  it("an unreachable door is transient but is not capacity, so it gets the short bound", () => {
    expect(FAILURE_UNREACHABLE).toMatchObject({ kind: "transient", code: "unreachable" });
    expect(FAILURE_NOT_CONFIGURED.kind).toBe("permanent");
    expect(FAILURE_REFUSED.kind).toBe("permanent");
  });
  it("withFailure only touches an output", () => {
    const failed = { ok: false, error: "x" };
    expect(withFailure(failed, FAILURE_REFUSED)).toEqual(failed);
    expect((withFailure({ ok: true, output: { film_key: "k" } }, FAILURE_REFUSED).output as { failure?: unknown }).failure).toEqual(FAILURE_REFUSED);
  });
});
