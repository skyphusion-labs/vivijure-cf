import { describe, it, expect } from "vitest";
import { API_ROUTES } from "../src/index";
import { SCOPES, type Scope } from "../src/authz";
import {
  EXPECTED_ROUTE_SCOPES,
  PINNED_OPERATOR_COUNT,
  PINNED_ROUTE_COUNT,
  diffRouteScopes,
  routeScopeKey,
  type RouteScopePin,
} from "./route-scope-pins";

// cf#569 -- every route's scope VALUE, not just the field's presence.
//
// authorizeRoute("consumer", "operator") === true, so an operator route mis-scoped
// `consumer` admits both credential classes. That compiles, the cf#520 suite stays green
// (it only checks that operator routes exist and that one named pair is classified as
// assumed), and nothing reddens. The loud failure is the harmless one (consumer locked
// out). This file pins every value and refuses when the pin table and API_ROUTES disagree
// in either direction.

function isOperatorInstallPattern(pattern: string): boolean {
  return (
    pattern === "/api/modules/installed" ||
    pattern === "/api/modules/install" ||
    pattern.startsWith("/api/modules/install/")
  );
}

function isOperatorConfigPattern(pattern: string): boolean {
  return pattern === "/api/modules/:name/config";
}

function isStoragePattern(pattern: string): boolean {
  return pattern === "/api/storage" || pattern.startsWith("/api/storage/");
}

function isImpliedOperatorPattern(pattern: string): boolean {
  return (
    pattern === "/api/admin" ||
    pattern.startsWith("/api/admin/") ||
    pattern === "/api/tenant" ||
    pattern.startsWith("/api/tenant/") ||
    pattern === "/api/secrets" ||
    pattern.startsWith("/api/secrets/") ||
    pattern === "/api/secret" ||
    pattern.startsWith("/api/secret/")
  );
}

function isFilmmakerConsumerPattern(pattern: string): boolean {
  return (
    pattern === "/api/storyboard" ||
    pattern.startsWith("/api/storyboard/") ||
    pattern === "/api/cast" ||
    pattern.startsWith("/api/cast/") ||
    pattern === "/api/render" ||
    pattern.startsWith("/api/render/")
  );
}

const MUST_BE_OPERATOR: ReadonlyArray<{ method: string; pattern: string }> = [
  { method: "GET", pattern: "/api/storage/usage" },
  { method: "POST", pattern: "/api/storage/reconcile" },
  { method: "GET", pattern: "/api/modules/installed" },
  { method: "POST", pattern: "/api/modules/install" },
  { method: "DELETE", pattern: "/api/modules/install/:name" },
  { method: "PATCH", pattern: "/api/modules/install/:name" },
  { method: "GET", pattern: "/api/modules/:name/config" },
  { method: "PATCH", pattern: "/api/modules/:name/config" },
];

describe("cf#569 the pin comparison can go red (instrument, not the live table)", () => {
  const sample: RouteScopePin[] = [
    { method: "GET", pattern: "/api/modules/installed", scope: "operator" },
    { method: "GET", pattern: "/api/cast", scope: "consumer" },
  ];

  it("POSITIVE: identical tables produce an empty diff", () => {
    expect(diffRouteScopes(sample, sample)).toEqual({
      missingFromPins: [],
      missingFromRoutes: [],
      scopeMismatch: [],
      duplicatePins: [],
    });
  });

  it("NEGATIVE: a consumer slip on an operator route is a scopeMismatch", () => {
    const slipped = sample.map((r) =>
      r.pattern === "/api/modules/installed" ? { ...r, scope: "consumer" as Scope } : r,
    );
    const d = diffRouteScopes(slipped, sample);
    expect(d.scopeMismatch).toEqual([
      "GET /api/modules/installed: live=consumer pin=operator",
    ]);
  });

  it("NEGATIVE: a rename drops the old pin and leaves the new route unpinned", () => {
    const renamed = sample.map((r) =>
      r.pattern === "/api/modules/installed" ? { ...r, pattern: "/api/modules/list" } : r,
    );
    const d = diffRouteScopes(renamed, sample);
    expect(d.missingFromPins).toEqual(["GET /api/modules/list"]);
    expect(d.missingFromRoutes).toEqual(["GET /api/modules/installed"]);
  });

  it("NEGATIVE: a pin the live table does not have is missingFromRoutes", () => {
    const extraPin: RouteScopePin[] = [
      ...sample,
      { method: "POST", pattern: "/api/modules/install", scope: "operator" },
    ];
    expect(diffRouteScopes(sample, extraPin).missingFromRoutes).toEqual([
      "POST /api/modules/install",
    ]);
  });

  it("NEGATIVE: a live route the pin table omitted is missingFromPins", () => {
    const short = sample.slice(0, 1);
    expect(diffRouteScopes(sample, short).missingFromPins).toEqual(["GET /api/cast"]);
  });

  it("NEGATIVE: a duplicated pin is visible (object-key overwrite would hide it)", () => {
    const dup = [...sample, sample[0]];
    expect(diffRouteScopes(sample, dup).duplicatePins).toEqual(["GET /api/modules/installed"]);
  });
});

describe("cf#569 every API_ROUTES scope value is pinned", () => {
  const live = API_ROUTES.map((r) => ({
    method: r.method,
    pattern: r.pattern,
    scope: r.scope,
  }));
  const diff = diffRouteScopes(live, EXPECTED_ROUTE_SCOPES);
  const operator = live.filter((r) => r.scope === "operator");
  const consumer = live.filter((r) => r.scope === "consumer");

  it("the pin table has no duplicate method+pattern keys", () => {
    expect(diff.duplicatePins).toEqual([]);
  });

  it("exact counts, updated deliberately (a > bound on a growing list cannot fail)", () => {
    expect(EXPECTED_ROUTE_SCOPES.length).toBe(PINNED_ROUTE_COUNT);
    expect(
      API_ROUTES.length,
      `asserted ${EXPECTED_ROUTE_SCOPES.length} of ${API_ROUTES.length} routes`,
    ).toBe(PINNED_ROUTE_COUNT);
    expect(operator.length).toBe(PINNED_OPERATOR_COUNT);
    expect(consumer.length).toBe(PINNED_ROUTE_COUNT - PINNED_OPERATOR_COUNT);
    expect(operator.length + consumer.length).toBe(API_ROUTES.length);
  });

  it("pin table and API_ROUTES agree in both directions", () => {
    // Denominator in the message: an empty-vs-empty pass would otherwise read the same
    // as 88-of-88. The counts above already refuse 0-of-0 (PINNED_ROUTE_COUNT is 88).
    expect(
      diff,
      `asserted ${EXPECTED_ROUTE_SCOPES.length} of ${API_ROUTES.length} routes`,
    ).toEqual({
      missingFromPins: [],
      missingFromRoutes: [],
      scopeMismatch: [],
      duplicatePins: [],
    });
    // Printed so CI logs carry the denominator even on green.
    console.log(
      `[cf569] asserted ${EXPECTED_ROUTE_SCOPES.length} of ${API_ROUTES.length} routes ` +
        `(${operator.length} operator, ${consumer.length} consumer)`,
    );
  });

  it("every live scope is still in the declared union", () => {
    const unknown = live.filter((r) => !SCOPES.includes(r.scope as Scope));
    expect(unknown.map(routeScopeKey)).toEqual([]);
  });
});

describe("cf#569 named dangerous routes stay operator even if the snapshot is edited to match a slip", () => {
  // These pins are the POLICY, not the snapshot. Updating EXPECTED_ROUTE_SCOPES to
  // `consumer` for one of these would keep the bidirectional check green; this block
  // would still fail.

  it("every named operator route exists and is classified operator", () => {
    const missing: string[] = [];
    const wrong: string[] = [];
    for (const pin of MUST_BE_OPERATOR) {
      const hit = API_ROUTES.find((r) => r.method === pin.method && r.pattern === pin.pattern);
      if (!hit) missing.push(routeScopeKey(pin));
      else if (hit.scope !== "operator") wrong.push(`${routeScopeKey(pin)} scope=${hit.scope}`);
    }
    expect(missing, "a named operator route was renamed or removed").toEqual([]);
    expect(wrong, "a named operator route slipped to a non-operator scope").toEqual([]);
  });

  it("MUST_BE_OPERATOR is the complete live operator set (a new operator route must be named here)", () => {
    const named = new Set(MUST_BE_OPERATOR.map(routeScopeKey));
    const liveOps = API_ROUTES.filter((r) => r.scope === "operator").map(routeScopeKey).sort();
    const unnamed = liveOps.filter((k) => !named.has(k));
    expect(
      unnamed,
      "an operator route exists that is not in MUST_BE_OPERATOR; name it or it can slip unsigned",
    ).toEqual([]);
    expect(named.size).toBe(PINNED_OPERATOR_COUNT);
  });
});

describe("cf#569 prefix implications (a new route under these prefixes cannot pick the wrong scope)", () => {
  it("storage, module install/uninstall, and module config are operator", () => {
    const slipped = API_ROUTES.filter(
      (r) =>
        (isStoragePattern(r.pattern) ||
          isOperatorInstallPattern(r.pattern) ||
          isOperatorConfigPattern(r.pattern)) &&
        r.scope !== "operator",
    ).map((r) => `${routeScopeKey(r)} scope=${r.scope}`);
    expect(slipped).toEqual([]);
  });

  it("storyboard, cast, render, and film routes are consumer (live contract; not a tighter policy)", () => {
    const slipped = API_ROUTES.filter(
      (r) => isFilmmakerConsumerPattern(r.pattern) && r.scope !== "consumer",
    ).map((r) => `${routeScopeKey(r)} scope=${r.scope}`);
    expect(slipped).toEqual([]);
  });

  it("GET /api/modules stays consumer (catalog projection is not an install route)", () => {
    const r = API_ROUTES.find((x) => x.method === "GET" && x.pattern === "/api/modules");
    expect(r, "GET /api/modules missing").toBeDefined();
    expect(r!.scope).toBe("consumer");
    expect(isOperatorInstallPattern("/api/modules")).toBe(false);
    expect(isOperatorConfigPattern("/api/modules")).toBe(false);
  });

  it("any future /api/admin, /api/tenant, or /api/secret(s) route must be operator", () => {
    const implied = API_ROUTES.filter((r) => isImpliedOperatorPattern(r.pattern));
    const slipped = implied.filter((r) => r.scope !== "operator").map((r) => `${routeScopeKey(r)} scope=${r.scope}`);
    expect(slipped).toEqual([]);
    // Zero today is honest: those prefixes do not exist on the live table. The rule
    // is what goes red if one is added as consumer.
    console.log(`[cf569] implied-operator prefixes matched ${implied.length} live routes`);
  });

  it("NEGATIVE: the prefix predicates fire on the names they claim", () => {
    expect(isOperatorInstallPattern("/api/modules/install")).toBe(true);
    expect(isOperatorInstallPattern("/api/modules/install/:name")).toBe(true);
    expect(isOperatorInstallPattern("/api/modules/installed")).toBe(true);
    expect(isOperatorInstallPattern("/api/modules")).toBe(false);
    expect(isOperatorConfigPattern("/api/modules/:name/config")).toBe(true);
    expect(isStoragePattern("/api/storage/reconcile")).toBe(true);
    expect(isFilmmakerConsumerPattern("/api/render/film")).toBe(true);
    expect(isFilmmakerConsumerPattern("/api/cast/:id")).toBe(true);
    expect(isFilmmakerConsumerPattern("/api/storyboard/render")).toBe(true);
    expect(isImpliedOperatorPattern("/api/admin/tenants")).toBe(true);
    expect(isImpliedOperatorPattern("/api/tenant/foo")).toBe(true);
    expect(isImpliedOperatorPattern("/api/secrets/foo")).toBe(true);
    expect(isImpliedOperatorPattern("/api/cast")).toBe(false);
  });
});
