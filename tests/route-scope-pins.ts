// cf#569 -- frozen pin of every API_ROUTES scope VALUE.
//
// tests/route-scope-authz.test.ts already proves the comparison and that the field is present.
// This file is the second copy of each value, so a `scope: "consumer"` slip on an operator
// route (or a rename that drops a pin) fails CI instead of compiling and passing.
//
// THIS IS A SNAPSHOT OF THE LIVE TABLE, not a tighter policy. Reclassifying a route is a
// deliberate one-line change here plus the matching change in src/index.ts. Adding a route
// requires a new line AND a bump of PINNED_ROUTE_COUNT. A list that regenerates itself from
// API_ROUTES would absorb a slip silently, which is the defect this pin exists to catch.

import type { Scope } from "../src/authz";

export interface RouteScopePin {
  method: string;
  pattern: string;
  scope: Scope;
}

/** Exact table size. Bump this when adding a route; the bidirectional check still has to agree. */
export const PINNED_ROUTE_COUNT = 88;

/** Exact operator-row count. Bump this when a new operator route is classified on purpose. */
export const PINNED_OPERATOR_COUNT = 8;

export function routeScopeKey(r: { method: string; pattern: string }): string {
  return `${r.method} ${r.pattern}`;
}

export interface RouteScopeDiff {
  missingFromPins: string[];
  missingFromRoutes: string[];
  scopeMismatch: string[];
  duplicatePins: string[];
}

export function diffRouteScopes(
  actual: ReadonlyArray<{ method: string; pattern: string; scope: string }>,
  expected: ReadonlyArray<{ method: string; pattern: string; scope: string }>,
): RouteScopeDiff {
  const actualByKey = new Map<string, string>();
  for (const r of actual) actualByKey.set(routeScopeKey(r), r.scope);

  const expectedByKey = new Map<string, string>();
  const duplicatePins: string[] = [];
  for (const r of expected) {
    const k = routeScopeKey(r);
    if (expectedByKey.has(k)) duplicatePins.push(k);
    expectedByKey.set(k, r.scope);
  }

  const missingFromPins: string[] = [];
  const scopeMismatch: string[] = [];
  for (const [k, scope] of actualByKey) {
    if (!expectedByKey.has(k)) missingFromPins.push(k);
    else if (expectedByKey.get(k) !== scope) scopeMismatch.push(`${k}: live=${scope} pin=${expectedByKey.get(k)}`);
  }

  const missingFromRoutes: string[] = [];
  for (const k of expectedByKey.keys()) {
    if (!actualByKey.has(k)) missingFromRoutes.push(k);
  }

  missingFromPins.sort();
  missingFromRoutes.sort();
  scopeMismatch.sort();
  duplicatePins.sort();
  return { missingFromPins, missingFromRoutes, scopeMismatch, duplicatePins };
}

// Generated once from origin/main's API_ROUTES (88 rows, 8 operator). Frozen on purpose.
export const EXPECTED_ROUTE_SCOPES: readonly RouteScopePin[] = [
  { method: "GET", pattern: "/api/storage/usage", scope: "operator" },
  { method: "POST", pattern: "/api/storage/reconcile", scope: "operator" },
  { method: "GET", pattern: "/api/demo/menu", scope: "consumer" },
  { method: "POST", pattern: "/api/demo/render", scope: "consumer" },
  { method: "GET", pattern: "/api/demo/render/:id", scope: "consumer" },
  { method: "POST", pattern: "/api/demo/chat", scope: "consumer" },
  { method: "GET", pattern: "/api/storyboard/projects", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/projects", scope: "consumer" },
  { method: "GET", pattern: "/api/storyboard/projects/:id", scope: "consumer" },
  { method: "PATCH", pattern: "/api/storyboard/projects/:id", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/projects/:id/storyboard", scope: "consumer" },
  { method: "DELETE", pattern: "/api/storyboard/projects/:id", scope: "consumer" },
  { method: "GET", pattern: "/api/voices", scope: "consumer" },
  { method: "GET", pattern: "/api/cast", scope: "consumer" },
  { method: "POST", pattern: "/api/cast", scope: "consumer" },
  { method: "GET", pattern: "/api/cast/export/:id", scope: "consumer" },
  { method: "POST", pattern: "/api/cast/export/:id", scope: "consumer" },
  { method: "POST", pattern: "/api/cast/import", scope: "consumer" },
  { method: "GET", pattern: "/api/cast/:id", scope: "consumer" },
  { method: "PATCH", pattern: "/api/cast/:id", scope: "consumer" },
  { method: "DELETE", pattern: "/api/cast/:id", scope: "consumer" },
  { method: "POST", pattern: "/api/cast/:id/portrait", scope: "consumer" },
  { method: "DELETE", pattern: "/api/cast/:id/portrait", scope: "consumer" },
  { method: "POST", pattern: "/api/cast/:id/ref", scope: "consumer" },
  { method: "DELETE", pattern: "/api/cast/:id/ref", scope: "consumer" },
  { method: "DELETE", pattern: "/api/cast/:id/refs/*refKey", scope: "consumer" },
  { method: "POST", pattern: "/api/cast/:id/source", scope: "consumer" },
  { method: "DELETE", pattern: "/api/cast/:id/source", scope: "consumer" },
  { method: "DELETE", pattern: "/api/cast/:id/source/*sourceKey", scope: "consumer" },
  { method: "POST", pattern: "/api/cast/:id/generate-refs", scope: "consumer" },
  { method: "GET", pattern: "/api/cast/:id/refs-job/:jobId", scope: "consumer" },
  { method: "POST", pattern: "/api/cast/:id/train-lora", scope: "consumer" },
  { method: "POST", pattern: "/api/cast/:id/train-wan-lora", scope: "consumer" },
  { method: "GET", pattern: "/api/cast/:id/lora-status", scope: "consumer" },
  { method: "POST", pattern: "/api/upload", scope: "consumer" },
  { method: "POST", pattern: "/api/report", scope: "consumer" },
  { method: "GET", pattern: "/api/artifact/*key", scope: "consumer" },
  { method: "HEAD", pattern: "/api/artifact/*key", scope: "consumer" },
  { method: "GET", pattern: "/api/artifact-url/*key", scope: "consumer" },
  { method: "POST", pattern: "/api/render/frames", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/preflight", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/plan", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/refine", scope: "consumer" },
  { method: "POST", pattern: "/api/chat", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/score-bed", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/music-generate", scope: "consumer" },
  { method: "GET", pattern: "/api/job/:id", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/enhance", scope: "consumer" },
  { method: "GET", pattern: "/api/models", scope: "consumer" },
  { method: "GET", pattern: "/api/storyboard/models", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/yaml", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/markers", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/bundle", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/audio-upload", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/character-ref", scope: "consumer" },
  { method: "POST", pattern: "/api/audio/analyze", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/render", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/render-plan", scope: "consumer" },
  { method: "POST", pattern: "/api/render/clips", scope: "consumer" },
  { method: "GET", pattern: "/api/render/clips/:id", scope: "consumer" },
  { method: "POST", pattern: "/api/render/film", scope: "consumer" },
  { method: "GET", pattern: "/api/render/film/:id", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/renders/:id/regen-shot", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/render/scatter", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/render-from-keyframes", scope: "consumer" },
  { method: "GET", pattern: "/api/storyboard/render/:jobId", scope: "consumer" },
  { method: "DELETE", pattern: "/api/storyboard/render/:jobId", scope: "consumer" },
  { method: "GET", pattern: "/api/storyboard/renders", scope: "consumer" },
  { method: "GET", pattern: "/api/storyboard/renders/tags", scope: "consumer" },
  { method: "PATCH", pattern: "/api/storyboard/renders/:id", scope: "consumer" },
  { method: "DELETE", pattern: "/api/storyboard/renders/:id", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/renders/:id/add-audio", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/renders/:id/add-narration", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/renders/:id/finalize", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/renders/:id/animate-cloud", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/renders/:id/animate-hybrid", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/renders/:id/retry", scope: "consumer" },
  { method: "POST", pattern: "/api/storyboard/renders/adopt", scope: "consumer" },
  { method: "GET", pattern: "/api/whoami", scope: "consumer" },
  { method: "GET", pattern: "/api/prefs", scope: "consumer" },
  { method: "PATCH", pattern: "/api/prefs", scope: "consumer" },
  { method: "GET", pattern: "/api/modules", scope: "consumer" },
  { method: "GET", pattern: "/api/modules/installed", scope: "operator" },
  { method: "POST", pattern: "/api/modules/install", scope: "operator" },
  { method: "DELETE", pattern: "/api/modules/install/:name", scope: "operator" },
  { method: "PATCH", pattern: "/api/modules/install/:name", scope: "operator" },
  { method: "GET", pattern: "/api/modules/:name/config", scope: "operator" },
  { method: "PATCH", pattern: "/api/modules/:name/config", scope: "operator" },
];
