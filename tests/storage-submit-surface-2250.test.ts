import { describe, it, expect } from "vitest";
import { isStorageSubmitRoute, storageSubmitPatterns } from "@skyphusion-labs/vivijure-core/storage-quota";
import { isPanelStorageSubmitRoute, PANEL_STORAGE_SUBMIT_PATTERNS } from "../src/storage-submit-routes";
import { API_ROUTES } from "../src/index";

// fc#2250 item 5 -- THE STORAGE CEILING MISSED FOUR BYTE-WRITING ROUTES.
//
// An over-quota studio was refused 507 on /api/storyboard/render and could then re-render an entire
// film through /api/storyboard/renders/:id/retry, which core's STORAGE_SUBMIT_PATTERNS does not
// cover. The ceiling denied the front door and left the side door open.
//
// Scope is the three families where byte-writing routes actually live and where this defect
// occurred: /api/cast/*, /api/render/* and /api/storyboard/renders/*. Deliberately NOT every POST
// route in the studio, for the reason cf#423 states about its own scope: a guard that refuses on the
// ~60 routes nobody has classified is a guard people switch off.
//
// Properties, the same set cf#423 established, because a list-versus-list check is otherwise
// trivially vacuous:
//
//   1. DERIVED, NOT TRANSCRIBED. The population comes from API_ROUTES, so a byte-writing route added
//      to one of these families later lands in neither bucket and fails here.
//   2. PRINTED DENOMINATORS on every assertion, so a matcher that extracts zero rows is a HARNESS
//      failure rather than a clean pass.
//   3. DECLARED NON-WRITERS, each with its reason, so an omission and a deliberate exclusion never
//      look the same.
//   4. A DISCRIMINATION CONTROL: the declared non-writers must NOT be metered, so a predicate that
//      answered true for everything would fail instead of passing everything.
//   5. THE SUPPLEMENT IS SELF-RETIRING. No panel pattern may match a route core already covers, so
//      the day core absorbs one of these four, this file FAILS and the supplement must shrink. That
//      is what keeps a second route list from becoming permanent drift (cf#789).

const FAMILIES = ["/api/cast/", "/api/render/", "/api/storyboard/renders/"];

// POST routes in these families that write NO new artifact bytes. Reasons, not just names.
const NOT_WRITERS: Record<string, string> = {
  "/api/cast": "creates a D1 cast row from JSON; stores no artifact",
  "/api/cast/export/:id":
    "reads the cast row and its artifacts and streams a bundle back; exportCastBundle performs no put (the puts in src/cast-bundle.ts belong to importCastBundle, and /api/cast/import is already covered by core)",
  "/api/cast/:id/voice-sample/keep":
    "re-points the cast row at the clip the already-metered sample run produced; writes no new artifact bytes",
  "/api/storyboard/renders/adopt":
    "adopts an EXISTING artifact into a render row (core render-adopt performs no R2 write)",
};

/** Concrete path for a pattern, so the predicates see what the router would have matched. */
function concrete(pattern: string): string {
  return pattern.replace(":id", "7");
}

const population = API_ROUTES.filter(
  (r) => r.method === "POST" && FAMILIES.some((f) => r.pattern === f.slice(0, -1) || r.pattern.startsWith(f)),
).map((r) => r.pattern);

describe("fc#2250 item 5 -- every byte-writing POST route passes the storage ceiling", () => {
  it("HARNESS FLOOR: the derived population and core's own list both parsed", () => {
    console.log(
      `[fc2250-storage] derived ${population.length} POST routes from ${API_ROUTES.length} API_ROUTES ` +
        `in families ${FAMILIES.join(" ")}`,
    );
    console.log(
      `[fc2250-storage] core patterns: ${storageSubmitPatterns().length}, ` +
        `panel supplement: ${PANEL_STORAGE_SUBMIT_PATTERNS.length}`,
    );
    // A zero in either number means the extraction broke, not that nothing writes bytes.
    expect(population.length).toBeGreaterThanOrEqual(20);
    expect(storageSubmitPatterns().length).toBeGreaterThan(0);
  });

  it("classifies every route in these families as metered or declared non-writing", () => {
    const metered = population.filter((p) => isPanelStorageSubmitRoute("POST", concrete(p)));
    const declared = population.filter((p) => p in NOT_WRITERS);
    const unclassified = population.filter(
      (p) => !isPanelStorageSubmitRoute("POST", concrete(p)) && !(p in NOT_WRITERS),
    );
    console.log(
      `[fc2250-storage] classified ${metered.length + declared.length} of ${population.length} ` +
        `(metered=${metered.length} declared-non-writing=${declared.length} unclassified=${unclassified.length})`,
    );
    expect(
      unclassified,
      `POST route(s) in these families reach the router but neither pass the storage ceiling nor are ` +
        `declared non-writing with a reason. If the route stores bytes, add it to core's ` +
        `STORAGE_SUBMIT_PATTERNS or to PANEL_STORAGE_SUBMIT_PATTERNS in src/storage-submit-routes.ts. ` +
        `If it stores nothing, add it to NOT_WRITERS here with the reason: ${unclassified.join(", ")}`,
    ).toEqual([]);
    expect(metered.length + declared.length).toBe(population.length);
  });

  it("the four fc#2250 routes are metered (the regression rows)", () => {
    // Named individually, because a count can move for the wrong reason.
    expect(isPanelStorageSubmitRoute("POST", "/api/storyboard/renders/abc-123/retry")).toBe(true);
    expect(isPanelStorageSubmitRoute("POST", "/api/cast/7/voice-sample")).toBe(true);
    expect(isPanelStorageSubmitRoute("POST", "/api/cast/7/voice-sample/attach")).toBe(true);
    expect(isPanelStorageSubmitRoute("POST", "/api/render/frames")).toBe(true);
  });

  it("does NOT meter the declared non-writers (the discrimination control)", () => {
    // If the predicate answered true for everything, every other assertion here would still pass.
    // This is the row that can only be green if it discriminates.
    const wrong = Object.keys(NOT_WRITERS).filter((p) => isPanelStorageSubmitRoute("POST", concrete(p)));
    console.log(
      `[fc2250-storage] declared non-writing: ${Object.keys(NOT_WRITERS).length}, wrongly metered: ${wrong.length}`,
    );
    expect(Object.keys(NOT_WRITERS).length).toBeGreaterThan(0);
    expect(wrong, `declared non-writing route(s) are being metered: ${wrong.join(", ")}`).toEqual([]);
  });

  it("every declared non-writer is actually registered (no dead declarations)", () => {
    const orphaned = Object.keys(NOT_WRITERS).filter((p) => !population.includes(p));
    expect(
      orphaned,
      `NOT_WRITERS names route(s) the router does not register: ${orphaned.join(", ")}`,
    ).toEqual([]);
  });

  it("THE SUPPLEMENT IS SELF-RETIRING: no panel pattern duplicates one core already covers", () => {
    // The property that keeps a second route list from becoming permanent drift. When core absorbs
    // one of these four, this row fails and PANEL_STORAGE_SUBMIT_PATTERNS must shrink by one.
    const samples = [
      "/api/storyboard/renders/abc-123/retry",
      "/api/cast/7/voice-sample",
      "/api/cast/7/voice-sample/attach",
      "/api/render/frames",
    ];
    const nowInCore = samples.filter((s) => isStorageSubmitRoute("POST", s));
    console.log(`[fc2250-storage] panel patterns already covered by core: ${nowInCore.length} of ${samples.length}`);
    expect(
      nowInCore,
      `core's STORAGE_SUBMIT_PATTERNS now covers these, so remove them from ` +
        `PANEL_STORAGE_SUBMIT_PATTERNS in src/storage-submit-routes.ts rather than carrying a ` +
        `duplicate that can drift: ${nowInCore.join(", ")}`,
    ).toEqual([]);
    // And every sample must be one the supplement genuinely matches, or a pattern has gone dead.
    for (const s of samples) {
      expect(PANEL_STORAGE_SUBMIT_PATTERNS.some((re) => re.test(s)), `no panel pattern matches ${s}`).toBe(true);
    }
  });

  it("anchoring: the supplement does not widen past the routes it names", () => {
    // /keep is declared non-writing above, so an unanchored voice-sample pattern would contradict
    // this file's own partition.
    expect(PANEL_STORAGE_SUBMIT_PATTERNS.some((re) => re.test("/api/cast/7/voice-sample/keep"))).toBe(false);
    expect(isPanelStorageSubmitRoute("POST", "/api/render/framesx")).toBe(false);
    expect(isPanelStorageSubmitRoute("POST", "/api/storyboard/renders/abc/retry/again")).toBe(false);
    // Non-POST never meters, whatever the path.
    expect(isPanelStorageSubmitRoute("GET", "/api/cast/7/voice-sample")).toBe(false);
    expect(isPanelStorageSubmitRoute("DELETE", "/api/cast/7/voice-sample")).toBe(false);
  });

  it("core's own coverage is preserved, not replaced (union, never override)", () => {
    // A supplement that accidentally SHADOWED core would pass everything above while quietly
    // dropping core's 25 patterns. Sample across core's families to prove the union holds.
    for (const p of ["/api/upload", "/api/cast/import", "/api/cast/7/portrait", "/api/render/film", "/api/storyboard/score-bed"]) {
      expect(isStorageSubmitRoute("POST", p), `core should cover ${p}`).toBe(true);
      expect(isPanelStorageSubmitRoute("POST", p), `panel predicate must preserve ${p}`).toBe(true);
    }
  });
});
