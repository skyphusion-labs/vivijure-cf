/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { API_ROUTES } from "../src/index";

// cf#331: the panel rendered a "retry" button on every FAILED / CANCELLED / TIMED_OUT render row
// and POSTed /api/storyboard/renders/<id>/retry, a route that has never existed. A user clicking the
// one control they reach for at the one moment a render has just failed got a bare 404.
//
// The button is removed rather than reimplemented, because there is no honest panel-side version:
// it promised a SERVER-side re-POST of the row's stored args with the GPU resuming off its network
// volume. A panel cannot resume a volume, and re-submitting from current panel state would render
// from different inputs than the original -- worse than a dead button, which at least failed loudly.
//
// These lock the three things that make the removal safe rather than merely done.

const ROW_JS = readFileSync(`${process.cwd()}/public/planner-history-row.js`, "utf8");
const PANEL_JS = ["planner-history-row.js", "planner-history-list.js", "app.js"]
  .map((f) => readFileSync(`${process.cwd()}/public/${f}`, "utf8"))
  .join("\n");

describe("cf#331 the dead retry control is gone", () => {
  it("no panel file calls the route that never existed", () => {
    // Matches the REQUEST, not the word: the explanatory comment left in place mentions the path
    // deliberately, and a matcher that could not tell those apart would either fail on the comment
    // or pass on a real call that happened to be worded differently.
    expect(PANEL_JS).not.toMatch(/fetch\([^)]*\/retry/);
    expect(PANEL_JS).not.toContain("retryFailedRender");
  });

  it("the route really is absent from the studio, so this is not a rename", () => {
    // If a /retry route ever lands, this fails and whoever added it is pointed straight at the
    // control that should come back with it.
    const retryRoutes = API_ROUTES.filter((r) => r.pattern.includes("/retry"));
    expect(retryRoutes.map((r) => `${r.method} ${r.pattern}`)).toEqual([]);
  });

  it("a failed row is NOT left without a recovery path", () => {
    // The removal is only safe because "re-render" is ungated by status. If someone later wraps it
    // in a status check, a failed render becomes a dead end.
    //
    // The slice starts at the SECTION COMMENT, not at the element creation. The first version of
    // this assertion anchored on `rerun.textContent` and I watched it NOT fail when I gated the
    // control for real: the guard goes in ABOVE `const rerun = ...`, so the window I was searching
    // began after the only place the defect can appear. It could not have produced the
    // disconfirming result, which is the whole reason to try to make a new assertion fail before
    // trusting it.
    const start = ROW_JS.indexOf('// v0.35.1: "re-render" with the same bundle');
    expect(start, "the re-render section anchor is gone; re-anchor this test").toBeGreaterThan(-1);
    const block = ROW_JS.slice(start, ROW_JS.indexOf("actions.appendChild(rerun)", start));
    expect(block).toContain('rerun.textContent = "re-render"');
    expect(block, "re-render became status-gated; a failed row now has no recovery path")
      .not.toMatch(/if\s*\(/);
  });

  it("POSITIVE CONTROL: the matchers can see the files they are reading", () => {
    // Every assertion above is a NEGATIVE. All four pass against an empty file.
    expect(ROW_JS.length).toBeGreaterThan(1000);
    expect(ROW_JS).toContain('rerun.textContent = "re-render"');
    expect(API_ROUTES.length).toBeGreaterThan(50);
    // And the matcher that must reject a real call is shown rejecting one.
    expect('fetch("/api/storyboard/renders/x/retry"').toMatch(/fetch\([^)]*\/retry/);
  });
});
