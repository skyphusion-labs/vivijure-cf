import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// cf#317 -- every route the router serves must be written down in docs/CONTRACT.md.
//
// The escape hatch an agent is told to use for an uncurated route (`studio_request`) takes a method
// and a path. It is only usable if the route is documented somewhere the caller can read, so an
// undocumented route is not "uncurated", it is UNREACHABLE IN PRACTICE. Fourteen route entries were
// in that state when cf#317 measured it, and nothing would ever have reported it: the parity numbers
// counted route REACH, and a route with no documentation reaches exactly as well as one with it.
//
// The population is derived from the API_ROUTES table at test time, not from a list maintained here.

const SRC = readFileSync(`${process.cwd()}/src/index.ts`, "utf8");
const DOC = readFileSync(`${process.cwd()}/docs/CONTRACT.md`, "utf8");
// The document is hard-wrapped, so a phrase can straddle a newline. Flatten before matching.
const FLAT = DOC.replace(/\s+/g, " ");

interface Route {
  method: string;
  pattern: string;
}

function studioRoutes(): Route[] {
  const start = SRC.indexOf("export const API_ROUTES: Route[] = [");
  expect(start, "API_ROUTES table not found in src/index.ts").toBeGreaterThan(-1);
  const end = SRC.indexOf("\n];", start);
  expect(end, "API_ROUTES terminator not found").toBeGreaterThan(start);
  const out: Route[] = [];
  for (const m of SRC.slice(start, end).matchAll(/\{\s*method:\s*"([A-Z]+)",\s*pattern:\s*"([^"]+)"/g)) {
    out.push({ method: m[1], pattern: m[2] });
  }
  // cf#520 REMOVED the compensation that used to sit here: GET /api/modules was dispatched inline
  // in routeRequest, so the table undercounted by one and this file pushed it back by hand. It is a
  // table route now, so the push would DOUBLE-COUNT it. tests/no-inline-api-routes.test.ts is what
  // keeps this honest going forward -- it fails if any route goes back to being dispatched inline,
  // which is the condition that made a hand-maintained compensation necessary in the first place.
  return out;
}

const documented = (pattern: string) => FLAT.includes(pattern);

describe("cf#317 the matcher, before any claim built on it", () => {
  it("POSITIVE control: a route known to be documented is found", () => {
    expect(documented("/api/storyboard/preflight")).toBe(true);
    expect(documented("/api/cast/:id/train-lora")).toBe(true);
    expect(documented("/api/cast/:id/voice-sample")).toBe(true);
    expect(documented("/api/cast/:id/voice-sample/keep")).toBe(true);
    expect(documented("/api/cast/:id/voice-sample/attach")).toBe(true);
  });

  it("NEGATIVE control: a route that cannot exist is not found", () => {
    // Without this, a matcher that returned true for everything would satisfy the coverage
    // assertion below and report a fully documented contract forever.
    expect(documented("/api/definitely-not-a-real-route")).toBe(false);
    expect(documented("/api/storyboard/renders/:id/no-such-action")).toBe(false);
  });

  it("the route parse returns a plausible table, not an empty one", () => {
    // An empty parse makes the coverage assertion 0-of-0 and reads as "everything is documented".
    expect(studioRoutes().length).toBeGreaterThan(50);
  });
});

describe("cf#317 every route the router serves is in CONTRACT.md", () => {
  it("no route pattern is missing from the document", () => {
    const missing = [...new Set(studioRoutes().filter((r) => !documented(r.pattern)).map((r) => r.pattern))];
    expect(
      missing,
      `route patterns served by src/index.ts but absent from docs/CONTRACT.md:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the counts CONTRACT.md 2.1 publishes are the counts the table produces", () => {
    // 2.1 states both numbers in prose. A number in prose is the one nobody re-derives, so it is
    // asserted here rather than trusted, the same discipline docs/mcp-parity.md is held to.
    const routes = studioRoutes();
    const patterns = new Set(routes.map((r) => r.pattern));
    expect(FLAT).toContain(`**${routes.length} route entries**`);
    expect(FLAT).toContain(`**${patterns.size} distinct path patterns**`);
  });
});
