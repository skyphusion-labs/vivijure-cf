import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import worker from "../src/index";
import { API_ROUTES } from "../src/index";
import { sha256Hex } from "../src/auth-gate";
import { authorizeRoute, isScope, SCOPES, AUTHZ_DENY_REASON, type Scope } from "../src/authz";
import { PINNED_ROUTE_COUNT } from "./route-scope-pins";
import type { Env } from "../src/env";

// cf#520 -- per-route authorization.
//
// THE LOAD-BEARING TEST IN THIS FILE IS "a CONSUMER token CANNOT call an operator route". It was
// driven RED against the pre-enforcement tree before the wiring existed: the gate admitted the
// token and the operator handler served 200. A green run here on unwired code would have meant the
// test was not reaching the behaviour, not that the behaviour was safe.
//
// The three supporting legs exist because the first one can be satisfied by breaking the route for
// EVERYONE: an operator credential must still reach it, a consumer credential must still reach a
// consumer route, and the operator secret path must be untouched.

const SECRET = "a".repeat(32) + "b".repeat(32); // the deploy.sh mint shape
const CONSUMER_TOKEN = "c".repeat(64);
const OPERATOR_TOKEN = "e".repeat(64);

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

// An operator route and a consumer route, both GET, both taken from the shipped table rather than
// typed in here -- a pattern transcribed into a test is a second copy that can drift from the
// table it claims to describe.
const OPERATOR_ROUTE = "/api/modules/installed";
const CONSUMER_ROUTE = "/api/cast";

/** Emulates the api_tokens lookup INCLUDING the scope column (migration 0020). A fixture is a claim
 *  about the shape of real data: this one returns exactly the columns the shipped SELECT asks for,
 *  so a row missing `scope` is representable and testable rather than impossible. */
function fakeDb(rows: Array<{ hash: string; name: string; scope?: unknown; revoked?: boolean }>) {
  const lookup = (hash: string) => {
    const r = rows.find((x) => x.hash === hash && !x.revoked);
    if (!r) return null;
    return "scope" in r ? { name: r.name, scope: r.scope } : { name: r.name };
  };
  return {
    prepare: (_sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => lookup(String(args[0])),
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
      }),
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ success: true }),
    }),
  } as any;
}

function tokenEnv(db: any): Env {
  return {
    AUTH_MODE: "token",
    STUDIO_API_TOKEN: SECRET,
    DB: db,
    ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
  } as unknown as Env;
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request("https://studio.example" + path, { headers });

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function errorOf(res: Response): Promise<string | null> {
  const text = await res.text();
  try {
    return (JSON.parse(text) as { error?: string }).error ?? null;
  } catch {
    return null; // an asset/HTML body: not an error envelope, so not an authz refusal
  }
}

// ---- the comparison itself, before anything built on it (N318: control first) -----------------

describe("cf#520 authorizeRoute -- the whole comparison, all four cells plus the null", () => {
  it("a consumer route admits BOTH credential classes", () => {
    expect(authorizeRoute("consumer", "consumer")).toBe(true);
    expect(authorizeRoute("consumer", "operator")).toBe(true);
  });

  it("an operator route admits ONLY an operator credential", () => {
    expect(authorizeRoute("operator", "operator")).toBe(true);
    expect(authorizeRoute("operator", "consumer")).toBe(false);
  });

  it("no gate decision at all FAILS CLOSED on an operator route", () => {
    // Unreachable today (every table pattern is under /api/, asserted below) and kept so a route
    // added outside the gated prefix cannot reach an operator handler unauthenticated.
    expect(authorizeRoute("operator", null)).toBe(false);
    expect(authorizeRoute("consumer", null)).toBe(true);
  });

  it("the matrix above is EXHAUSTIVE over the declared domain (no third scope went untested)", () => {
    // Derived from SCOPES rather than counted by hand, so adding a value to the union makes this
    // fail instead of silently leaving the new cell untested.
    expect([...SCOPES].sort()).toEqual(["consumer", "operator"]);
    expect(SCOPES.length * (SCOPES.length + 1)).toBe(6); // 4 cells + 2 null cases = 6 asserted
  });

  it("isScope narrows the union and rejects everything else", () => {
    for (const s of SCOPES) expect(isScope(s)).toBe(true);
    for (const bad of [null, undefined, "", "Operator", "admin", 1, {}]) expect(isScope(bad)).toBe(false);
  });
});

// ---- the refusal must not trip the frontend's re-authenticate prompt --------------------------

describe("cf#520 the authz refusal is not mistaken for an AUTHENTICATION failure", () => {
  // The shim's trigger is read OUT OF THE SHIM, not transcribed here. A copy of another file's
  // regex is a second definition that drifts; consuming the real one cannot.
  const SHIM = readFileSync(`${process.cwd()}/public/auth-token.js`, "utf8");
  const m = SHIM.match(/if \(\/([^/]+)\/i\.test\(reason\)\)/);

  it("the shim's prompt trigger is still extractable (POSITIVE control on the extraction)", () => {
    expect(m, "public/auth-token.js no longer matches the expected prompt-trigger shape").not.toBeNull();
    // POSITIVE control on the regex itself: it must fire on the real AUTHENTICATION reason, or a
    // regex that matches nothing would satisfy the assertion below forever.
    expect(new RegExp(m![1], "i").test("missing API token: send Authorization: Bearer <your studio API token>")).toBe(true);
  });

  it("AUTHZ_DENY_REASON does NOT trip it (the caller's token is fine; do not ask them to re-paste it)", () => {
    expect(new RegExp(m![1], "i").test(AUTHZ_DENY_REASON)).toBe(false);
  });
});

// ---- the structural precondition the null-credential branch rests on --------------------------

describe("cf#520 every table route is under the gated prefix", () => {
  it("all API_ROUTES patterns start with /api/ (so a table hit always has a gate decision)", () => {
    const outside = API_ROUTES.filter((r) => !r.pattern.startsWith("/api/"));
    // Exact count, not `> 80`: a lower bound on a monotonically-growing list cannot fail on the
    // input it is meant to police (cf#569). The value lives next to the per-route pin table.
    expect(API_ROUTES.length, "route table parsed empty or drifted").toBe(PINNED_ROUTE_COUNT);
    expect(outside.map((r) => `${r.method} ${r.pattern}`)).toEqual([]);
  });

  it("the table carries BOTH scopes (a table classified all-consumer would pass every test here)", () => {
    const operator = API_ROUTES.filter((r) => r.scope === "operator");
    const consumer = API_ROUTES.filter((r) => r.scope === "consumer");
    expect(operator.length).toBeGreaterThan(0);
    expect(consumer.length).toBeGreaterThan(0);
    expect(operator.length + consumer.length).toBe(API_ROUTES.length);
  });

  it("the two routes this file drives are classified as it assumes", () => {
    // Without this, a reclassification would silently turn the load-bearing test into a test of a
    // consumer route calling a consumer route, which passes and proves nothing.
    const op = API_ROUTES.find((r) => r.method === "GET" && r.pattern === OPERATOR_ROUTE);
    const co = API_ROUTES.find((r) => r.method === "GET" && r.pattern === CONSUMER_ROUTE);
    expect(op?.scope).toBe("operator");
    expect(co?.scope).toBe("consumer");
  });
});

// ---- THE LOAD-BEARING TEST + its three supporting legs ----------------------------------------

describe("cf#520 token mode -- a consumer token cannot reach an operator route", () => {
  async function db() {
    return fakeDb([
      { hash: await sha256Hex(CONSUMER_TOKEN), name: "slate-bot", scope: "consumer" },
      { hash: await sha256Hex(OPERATOR_TOKEN), name: "conrad", scope: "operator" },
    ]);
  }

  it("LOAD-BEARING: consumer token + operator route -> 403, refused BY AUTHORIZATION", async () => {
    const res = await worker.fetch(get(OPERATOR_ROUTE, auth(CONSUMER_TOKEN)), tokenEnv(await db()), ctx);
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe(AUTHZ_DENY_REASON);
  });

  it("operator-scoped NAMED token + operator route -> authorization passes", async () => {
    const res = await worker.fetch(get(OPERATOR_ROUTE, auth(OPERATOR_TOKEN)), tokenEnv(await db()), ctx);
    expect(await errorOf(res)).not.toBe(AUTHZ_DENY_REASON);
  });

  it("the operator SECRET path is unchanged and still reaches the operator route", async () => {
    const res = await worker.fetch(get(OPERATOR_ROUTE, auth(SECRET)), tokenEnv(await db()), ctx);
    expect(await errorOf(res)).not.toBe(AUTHZ_DENY_REASON);
  });

  it("FALSE-POSITIVE GUARD: consumer token + consumer route still works", async () => {
    // A gate that refuses correct work is the gate people switch off. Without this leg the
    // load-bearing test above is satisfied by breaking the route for everyone.
    const res = await worker.fetch(get(CONSUMER_ROUTE, auth(CONSUMER_TOKEN)), tokenEnv(await db()), ctx);
    expect(await errorOf(res)).not.toBe(AUTHZ_DENY_REASON);
  });
});

// ---- a row whose scope is not in the union is a configuration defect, and fails CLOSED ---------

describe("cf#520 an api_tokens row with an unusable scope denies, with no oracle", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["column absent (migration 0020 not applied)", {}],
    ["NULL", { scope: null }],
    ["a typo", { scope: "Operator" }],
    ["an invented scope", { scope: "admin" }],
  ];

  for (const [label, extra] of cases) {
    it(`${label} -> denied even on a CONSUMER route`, async () => {
      const db = fakeDb([{ hash: await sha256Hex(CONSUMER_TOKEN), name: "slate-bot", ...extra }]);
      const res = await worker.fetch(get(CONSUMER_ROUTE, auth(CONSUMER_TOKEN)), tokenEnv(db), ctx);
      expect(res.status).toBe(403);
      // IDENTICAL to any other bad token: a distinct message here would tell a prober that the
      // token they presented is real, which the gate deliberately never reveals.
      expect(await errorOf(res)).toBe("bad API token");
    });
  }

  it("CONTROL: the same fixture WITH a valid scope admits (so the denials above are about scope)", async () => {
    const db = fakeDb([{ hash: await sha256Hex(CONSUMER_TOKEN), name: "slate-bot", scope: "consumer" }]);
    const res = await worker.fetch(get(CONSUMER_ROUTE, auth(CONSUMER_TOKEN)), tokenEnv(db), ctx);
    expect(await errorOf(res)).not.toBe("bad API token");
  });
});

// ---- what this does to the OTHER auth modes, asserted rather than asserted-in-prose -----------

describe("cf#520 the other auth modes", () => {
  it("ALLOW_UNAUTHENTICATED (legacy dev opt-out) grants OPERATOR -- unchanged behaviour", async () => {
    const env = {
      ALLOW_UNAUTHENTICATED: "true",
      ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    } as unknown as Env;
    const res = await worker.fetch(get(OPERATOR_ROUTE), env, ctx);
    expect(await errorOf(res)).not.toBe(AUTHZ_DENY_REASON);
  });

  it("DEMO grants CONSUMER: an operator route that was anonymously readable is now refused", async () => {
    // MEASURED DELTA, not a prediction. On 2026-08-14 `GET /api/modules/installed` returned 200 to
    // an anonymous caller on demo.vivijure.com (control: /api/voices 200, a nonexistent route 404,
    // so the probe discriminated). No file under public/ calls that route -- measured, 0 hits -- so
    // nothing in the demo panel depends on it. This closes it.
    const env = {
      AUTH_MODE: "demo",
      ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    } as unknown as Env;
    const res = await worker.fetch(get(OPERATOR_ROUTE), env, ctx);
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe(AUTHZ_DENY_REASON);
  });

  it("DEMO still serves its own consumer routes (the read surface is untouched)", async () => {
    const env = {
      AUTH_MODE: "demo",
      ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    } as unknown as Env;
    const res = await worker.fetch(get("/api/voices"), env, ctx);
    expect(await errorOf(res)).not.toBe(AUTHZ_DENY_REASON);
  });

  it("DEMO mutation refusal still comes from the DEMO gate, not from authorization", async () => {
    const env = {
      AUTH_MODE: "demo",
      ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    } as unknown as Env;
    const res = await worker.fetch(
      new Request("https://demo.example/api/cast", { method: "POST" }),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatch(/read-only/i);
  });
});

// ---- the 86th route, moved into the table (cf#520 part 1) -------------------------------------

describe("cf#520 GET /api/modules is a table route now, and behaves identically", () => {
  it("it is IN the table, classified consumer", () => {
    const r = API_ROUTES.find((x) => x.method === "GET" && x.pattern === "/api/modules");
    expect(r, "GET /api/modules is not in API_ROUTES").toBeDefined();
    expect(r!.scope).toBe("consumer");
  });

  it("it still serves the modules projection to a consumer token", async () => {
    const db = fakeDb([{ hash: await sha256Hex(CONSUMER_TOKEN), name: "slate-bot", scope: "consumer" }]);
    const res = await worker.fetch(get("/api/modules", auth(CONSUMER_TOKEN)), tokenEnv(db), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modules?: unknown[] };
    expect(Array.isArray(body.modules)).toBe(true);
  });

  it("it still serves anonymously in demo mode (the panel's module list)", async () => {
    const env = {
      AUTH_MODE: "demo",
      ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    } as unknown as Env;
    const res = await worker.fetch(get("/api/modules"), env, ctx);
    expect(res.status).toBe(200);
    // `readonly` is projected under `host`, not at the top level (src/auth-gate.ts says so in
    // terms: "the /api/modules route can project host.readonly"). The first draft of this line
    // asserted `body.readonly` and failed IDENTICALLY before and after the move, so it was never
    // discriminating -- it is here to prove the demo projection survived the move, and it can only
    // do that if it reads the field the projection actually writes.
    const body = (await res.json()) as { modules?: unknown[]; host?: { readonly?: boolean } };
    expect(Array.isArray(body.modules)).toBe(true);
    expect(body.host?.readonly).toBe(true);
  });
});

// Type-level: the two exports this file leans on are the same vocabulary, not two that agree today.
const _scopeIsRouteScope: Scope = API_ROUTES[0].scope;
void _scopeIsRouteScope;
