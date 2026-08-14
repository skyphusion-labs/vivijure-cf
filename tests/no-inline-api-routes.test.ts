import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// cf#520 -- THE CLASS, not the instance.
//
// `Route.scope` is required, so forgetting to classify a route does not compile. That guarantee is
// exactly as complete as the route TABLE: a handler dispatched inline inside `routeRequest` never
// touches the `Route` type, carries no scope, and NO COMPILE ERROR WILL EVER SAY SO.
//
// `GET /api/modules` was in that state -- inline since the host bootstrap (`d03b57f`), before the
// table pattern existed. Moving it fixes one instance. The class is "someone adds an inline handler
// because it was faster than a table entry", which is how that one got there and will recur under
// deadline. The compiler cannot see it, so this test must.
//
// DRIVEN RED before the move: at `304c01f` (whose `routeRequest` is byte-identical to
// `origin/main`'s -- the classification commit touched only the `Route` interface and the table,
// both outside this function) both assertions below failed, naming the inline `/api/modules`
// comparison. A green run against that tree would have meant the test was not reaching the thing.

const SRC = readFileSync(`${process.cwd()}/src/index.ts`, "utf8");

/** The body of `routeRequest`, from its signature to the closing brace in column 0. Returned with
 *  its first and last line so a caller can prove the slice did not overrun its terminator and
 *  swallow the rest of the file -- an over-long slice reads exactly like a correct one. */
function routeRequestBody(): { text: string; first: string; last: string; lines: number } {
  const all = SRC.split("\n");
  const start = all.findIndex((l) => l.startsWith("async function routeRequest("));
  if (start === -1) throw new Error("routeRequest not found in src/index.ts");
  let end = -1;
  for (let i = start + 1; i < all.length; i++) {
    if (all[i] === "}") { end = i; break; }
  }
  if (end === -1) throw new Error("routeRequest terminator not found");
  const slice = all.slice(start, end + 1);
  return { text: slice.join("\n"), first: slice[0], last: slice[slice.length - 1], lines: slice.length };
}

/** Any `<something>.pathname === "/api/..."` comparison, in either operand order. This is the exact
 *  shape the design forbids: a route decided by hand inside the dispatcher instead of by a table
 *  entry the compiler can see. */
const INLINE_EQ = [
  /\.pathname\s*===?\s*["'`]\/api\//g,
  /["'`]\/api\/[^"'`]*["'`]\s*===?\s*\w+\.pathname/g,
];

/** Every double-quoted `/api/...` literal. Stricter than the equality check and not evadable by
 *  choosing a different operator (`startsWith`, `includes`, a regex): after the move there is
 *  exactly ONE, the auth gate's own prefix test, and any second literal is a route being decided
 *  here rather than in the table. */
const API_LITERAL = /"\/api\//g;

const countAll = (text: string, res: RegExp[]) =>
  res.reduce((n, re) => n + [...text.matchAll(re)].length, 0);

describe("cf#520 the matcher, before any claim built on it", () => {
  it("POSITIVE control: it matches an inline comparison in both operand orders", () => {
    expect(countAll('if (url.pathname === "/api/modules" && x) {', INLINE_EQ)).toBe(1);
    expect(countAll('if ("/api/modules" === url.pathname) {', INLINE_EQ)).toBe(1);
    expect(countAll('if (new URL(r.url).pathname == "/api/thing") {', INLINE_EQ)).toBe(1);
  });

  it("NEGATIVE control: it does not match the things that are allowed to be here", () => {
    // Without this the assertion below could be satisfied by a matcher that fires on everything,
    // or could fire on the gate and the /health check and read as a permanent, ignorable red.
    expect(countAll('if (url.pathname === "/health") return json({ ok: true });', INLINE_EQ)).toBe(0);
    expect(countAll('if (url.pathname.startsWith("/api/")) {', INLINE_EQ)).toBe(0);
    expect(countAll("if (WELCOME_REDIRECT_PATHS.has(url.pathname)) {", INLINE_EQ)).toBe(0);
  });

  it("POSITIVE control: the literal counter sees an /api/ literal, and ignores others", () => {
    expect([...'x.startsWith("/api/")'.matchAll(API_LITERAL)].length).toBe(1);
    expect([...'x === "/api/modules"'.matchAll(API_LITERAL)].length).toBe(1);
    expect([...'x === "/health"'.matchAll(API_LITERAL)].length).toBe(0);
  });

  it("the extracted slice is routeRequest and stops at its own terminator", () => {
    const b = routeRequestBody();
    // First and last line printed into the assertion, so an overrun cannot pass as a clean read.
    expect(b.first).toBe("async function routeRequest(request: Request, env: StudioEnv, ctx: ExecutionContext): Promise<Response> {");
    expect(b.last).toBe("}");
    expect(b.lines).toBeGreaterThan(20);
    // Denominator: the slice really is the dispatcher, not some other function that happens to
    // contain no /api/ literals and would satisfy every assertion below vacuously.
    expect(b.text).toContain("gateApi(");
    expect(b.text).toContain("match(API_ROUTES,");
    expect(b.text).toContain("env.ASSETS.fetch(request)");
  });
});

describe("cf#520 routeRequest decides no route by hand", () => {
  it("carries ZERO inline `pathname === \"/api/...\"` comparisons", () => {
    const b = routeRequestBody();
    const hits = INLINE_EQ.flatMap((re) => [...b.text.matchAll(re)].map((m) => m[0]));
    // The hits themselves, not a count: a bare number tells the next reader nothing about which
    // route escaped the table.
    expect(hits).toEqual([]);
  });

  it("carries EXACTLY ONE `\"/api/` literal, and it is the auth gate's prefix test", () => {
    const b = routeRequestBody();
    const lines = b.text.split("\n").filter((l) => l.includes('"/api/'));
    expect(lines.map((l) => l.trim())).toEqual(['if (url.pathname.startsWith("/api/")) {']);
  });
});

// RESIDUALS, stated rather than left implicit. These two assertions do not cover: a route decided
// from a CONSTANT or variable holding an /api path (no literal appears here), a pathname compared
// after being reassigned, or dispatch inside a helper `routeRequest` calls. The literal count is
// the wider of the two and catches every in-function form; the equality check exists so the failure
// message names the specific class when it is that one.
