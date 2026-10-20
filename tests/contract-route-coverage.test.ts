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

// Table rows are `| 24a | GET/POST | \`/api/...\` (or \`/suffix\`) (alias \`/name\`) |`.
// The row id may carry a letter. One cell may name more than one method. The path is the first
// backtick span. A later `(or \`...\`)` or `alias \`...\`` is another path on the same method.
function documentedRoutes(doc: string): Route[] {
  const out: Route[] = [];
  for (const line of doc.split("\n")) {
    const m = line.match(/^\|\s*\d+[a-z]?\s*\|\s*([^|]+?)\s*\|\s*`([^`]+)`/);
    if (!m) continue;
    const methods = m[1].split("/").map((s) => s.trim()).filter((s) => /^[A-Z]+$/.test(s));
    const primary = m[2].trim();
    const extras: string[] = [];
    const alt = line.match(/\(or\s+`([^`]+)`\)/);
    if (alt) extras.push(joinDocPath(primary, alt[1].trim()));
    const alias = line.match(/alias\s+`([^`]+)`/);
    if (alias) extras.push(joinDocPath(primary, alias[1].trim()));
    for (const method of methods) {
      out.push({ method, pattern: primary });
      for (const pattern of extras) out.push({ method, pattern });
    }
  }
  return out;
}

// `/refs/*refKey` beside `/api/cast/:id/ref` is `/api/cast/:id/refs/*refKey`.
function joinDocPath(primary: string, extra: string): string {
  if (extra.startsWith("/api/")) return extra;
  const parent = primary.slice(0, primary.lastIndexOf("/"));
  return parent + (extra.startsWith("/") ? extra : `/${extra}`);
}

function sameRoute(a: Route, b: Route): boolean {
  return a.method === b.method && a.pattern === b.pattern;
}

// Exact method + path. A path substring, or the same path with a different method, is not a match.
function covers(documented: Route[], implemented: Route): boolean {
  return documented.some((d) => sameRoute(d, implemented));
}

const DOC_ROUTES = documentedRoutes(DOC);

// /health is served beside the table, not inside it. Count it so the reverse check can see it.
function implementedRoutes(): Route[] {
  const out = studioRoutes();
  if (SRC.includes('pathname === "/health"') && !out.some((r) => r.pattern === "/health")) {
    out.push({ method: "GET", pattern: "/health" });
  }
  return out;
}

describe("cf#317 the matcher, before any claim built on it", () => {
  it("POSITIVE control: a route known to be documented is found", () => {
    expect(DOC_ROUTES.some((r) => r.pattern === "/api/storyboard/preflight")).toBe(true);
    expect(DOC_ROUTES.some((r) => r.pattern === "/api/cast/:id/train-lora")).toBe(true);
    expect(DOC_ROUTES.some((r) => r.pattern === "/api/cast/:id/voice-sample")).toBe(true);
    expect(DOC_ROUTES.some((r) => r.pattern === "/api/cast/:id/voice-sample/keep")).toBe(true);
    expect(DOC_ROUTES.some((r) => r.pattern === "/api/cast/:id/voice-sample/attach")).toBe(true);
  });

  it("NEGATIVE control: a route that cannot exist is not found", () => {
    // Without this, a matcher that returned true for everything would satisfy the coverage
    // assertion below and report a fully documented contract forever.
    expect(DOC_ROUTES.some((r) => r.pattern === "/api/definitely-not-a-real-route")).toBe(false);
    expect(DOC_ROUTES.some((r) => r.pattern === "/api/storyboard/renders/:id/no-such-action")).toBe(false);
  });

  it("a documented GET does not cover an implemented HEAD (cf#882)", () => {
    const doc = [{ method: "GET", pattern: "/api/foo" }];
    const head = { method: "HEAD", pattern: "/api/foo" };
    expect(covers(doc, head)).toBe(false);
    // The old matcher was a substring check of the flattened document. /api/storage is not itself
    // a documented route but sits inside two that are, so that check would still have passed.
    expect(DOC.replace(/\s+/g, " ").includes("/api/storage")).toBe(true);
    expect(DOC_ROUTES.some((r) => r.pattern === "/api/storage")).toBe(false);
  });

  it("a documented path does not cover an implemented path that merely contains it (cf#882)", () => {
    const doc = [{ method: "POST", pattern: "/api/render" }];
    const impl = { method: "POST", pattern: "/api/render/film/:id" };
    expect(covers(doc, impl)).toBe(false);
    // Same measured old-matcher fact as the HEAD case above.
    expect(DOC.replace(/\s+/g, " ").includes("/api/storage")).toBe(true);
    expect(DOC_ROUTES.some((r) => r.pattern === "/api/storage")).toBe(false);
  });

  it("the route parse returns a plausible table, not an empty one", () => {
    // An empty parse makes the coverage assertion 0-of-0 and reads as "everything is documented".
    expect(studioRoutes().length).toBeGreaterThan(50);
  });
});

describe("cf#317 every route the router serves is in CONTRACT.md", () => {
  it("no implemented method+path is missing from the document, and no documented route is missing from the code", () => {
    const impl = implementedRoutes();
    const missingFromDoc = impl.filter((r) => !covers(DOC_ROUTES, r)).map((r) => `${r.method} ${r.pattern}`);
    const missingFromCode = DOC_ROUTES.filter((r) => !impl.some((i) => sameRoute(i, r))).map(
      (r) => `${r.method} ${r.pattern}`,
    );
    expect(
      missingFromDoc,
      `routes served by src/index.ts but absent from the CONTRACT.md table:\n  ${missingFromDoc.join("\n  ")}`,
    ).toEqual([]);
    expect(
      missingFromCode,
      `routes in the CONTRACT.md table but not served:\n  ${missingFromCode.join("\n  ")}`,
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
