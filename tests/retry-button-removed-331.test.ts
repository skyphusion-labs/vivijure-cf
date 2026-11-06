/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { API_ROUTES } from "../src/index";

// cf#331 removed a dead panel control that POSTed a route that did not exist.
// cf#353 landed the REAL route and restored the button. These tests lock that the
// control and the route now match -- a fetch to /retry exists, and so does the route.

const ROW_JS = readFileSync(`${process.cwd()}/public/planner-history-row.js`, "utf8");

describe("cf#353 the retry control is real (supersedes dead cf#331)", () => {
  it("the panel calls POST .../retry via retryFailedRender", () => {
    expect(ROW_JS).toContain("async function retryFailedRender");
    expect(ROW_JS).toMatch(/\/api\/storyboard\/renders\/.*\/retry/);
  });

  it("the route is registered on the studio", () => {
    const retryRoutes = API_ROUTES.filter((r) => r.pattern.includes("/retry"));
    expect(retryRoutes.map((r) => `${r.method} ${r.pattern}`)).toEqual([
      "POST /api/film/:id/parts/:n/retry",
      "POST /api/storyboard/renders/:id/retry",
    ]);
  });

  it("a failed row still has re-render as a recovery path", () => {
    const start = ROW_JS.indexOf('// v0.35.1: "re-render" with the same bundle');
    expect(start, "the re-render section anchor is gone; re-anchor this test").toBeGreaterThan(-1);
    const block = ROW_JS.slice(start, ROW_JS.indexOf("actions.appendChild(rerun)", start));
    expect(block).toContain('rerun.textContent = "re-render"');
    // cf#1309: the one gate allowed is the clip-job row, which has no bundle to re-render. Any other
    // condition (a status gate above all) would leave a failed film row with no recovery path.
    const gates = block.match(/if\s*\(([^)]*)\)/g) ?? [];
    expect(gates, "re-render became gated on something other than the clip-job row").toEqual(["if (!clipJob)"]);
  });

  it("POSITIVE CONTROL: the matchers can see the files they are reading", () => {
    expect(ROW_JS.length).toBeGreaterThan(1000);
    expect(ROW_JS).toContain('rerun.textContent = "re-render"');
    expect(API_ROUTES.length).toBeGreaterThan(50);
  });
});
