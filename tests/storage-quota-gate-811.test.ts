import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { PANEL_STORAGE_SUBMIT_PATTERNS } from "../src/storage-submit-routes";

// cf#811 -- the R2 storage ceiling can answer 507, and its fail-closed posture can answer 503, and
// until this file NEITHER had a test. `git grep -l "checkStorageQuota\|R2_STORAGE_QUOTA_BYTES" --
// tests/` returned nothing, so the control had never been observed going red in CI and a refactor
// that silenced it would have landed green.
//
// The gate is inert on a default deploy (R2_STORAGE_QUOTA_BYTES is commented out in
// wrangler.toml.example, and core treats an absent knob as absent behaviour), which is the second
// reason nothing ever exercised it. That is why every case here sets the knob explicitly.
//
// These drive `worker.fetch` at the WIRE, not `checkStorageQuota` directly, because the thing worth
// pinning is not core's arithmetic (core tests that) but that THIS panel still routes its
// byte-writing routes through the gate at all. A unit test of core's function would stay green
// through the exact regression this file exists to catch: someone deleting the
// `isPanelStorageSubmitRoute` block from src/index.ts.
//
// TELLING THE TWO 503s APART IS THE WHOLE DIFFICULTY. The spend gate sits immediately ABOVE this
// one and also fails closed to 503 on a broken check, so an unbound SPEND_RATE_LIMITER produces a
// 503 that is byte-identical in status to the storage gate's. Every case below therefore binds a
// PASSING limiter and asserts on the MESSAGE, never on the bare status. A test that asserted only
// `status === 503` would pass with the storage gate deleted entirely.

const QUOTA = "1000";
const USED_OVER = 5000; // >= QUOTA, so `deny` refuses
const USED_UNDER = 10; //  <  QUOTA, so the same env admits

/** Minimal D1-shaped stub covering exactly the two statements checkStorageQuota issues. */
function makeDb(opts: { usedBytes: number; trueSince: number | null; throwOnUsage?: boolean }) {
  return {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM storage_usage_meta")) {
                return opts.trueSince === null ? null : { value: String(opts.trueSince) };
              }
              if (sql.includes("FROM storage_usage")) {
                if (opts.throwOnUsage) throw new Error("D1_ERROR: no such table: storage_usage");
                return { total: opts.usedBytes, objects: 3 };
              }
              return null;
            },
          };
        },
      };
    },
  };
}

function makeEnv(opts: {
  quota?: string | undefined;
  mode?: string;
  usedBytes?: number;
  trueSince?: number | null;
  throwOnUsage?: boolean;
  noDb?: boolean;
}): Env {
  const env: Record<string, unknown> = {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    // A PASSING limiter, deliberately. The spend gate runs first and fails CLOSED to 503 on an
    // unbound limiter, which would mask every storage verdict below it.
    SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
    R2_RENDERS: {
      async head() { return null; },
      async get() { return null; },
      async put() { return undefined; },
      async delete() { return undefined; },
      async list() { return { objects: [], truncated: false }; },
    },
  };
  if (opts.quota !== undefined) env.R2_STORAGE_QUOTA_BYTES = opts.quota;
  if (opts.mode !== undefined) env.R2_STORAGE_QUOTA_MODE = opts.mode;
  if (!opts.noDb) {
    env.DB = makeDb({
      usedBytes: opts.usedBytes ?? USED_OVER,
      trueSince: opts.trueSince === undefined ? 1_700_000_000 : opts.trueSince,
      throwOnUsage: opts.throwOnUsage,
    });
  }
  return env as unknown as Env;
}

const PUB = "3f2a91d4-5c6b-4e10-9a77-2b8c4d1e6f03";

/** Every panel-supplement route, with a concrete pathname for each pattern. */
const PANEL_ROUTES: { name: string; path: string }[] = [
  { name: "POST /api/storyboard/renders/:id/retry", path: `/api/storyboard/renders/${PUB}/retry` },
  { name: "POST /api/cast/:id/voice-sample", path: `/api/cast/${PUB}/voice-sample` },
  { name: "POST /api/cast/:id/voice-sample/attach", path: `/api/cast/${PUB}/voice-sample/attach` },
  { name: "POST /api/render/frames", path: "/api/render/frames" },
];

async function post(env: Env, path: string, body: unknown = {}) {
  const res = await worker.fetch(
    new Request(`https://studio.example.org${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
  let parsed: Record<string, unknown> = {};
  try { parsed = (await res.clone().json()) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: res.status, body: parsed };
}

describe("cf#811 the storage ceiling actually refuses at the wire", () => {
  it("DENOMINATOR: every panel-supplement pattern has a case in this file", () => {
    // A listing that excludes by default is not a denominator. If someone adds a fifth byte-writing
    // route to PANEL_STORAGE_SUBMIT_PATTERNS, this fails rather than leaving it silently uncovered.
    expect(PANEL_ROUTES).toHaveLength(PANEL_STORAGE_SUBMIT_PATTERNS.length);
    for (const { path } of PANEL_ROUTES) {
      expect(PANEL_STORAGE_SUBMIT_PATTERNS.some((re) => re.test(path))).toBe(true);
    }
  });

  for (const { name, path } of PANEL_ROUTES) {
    it(`507s on ${name} when the ledger is over the ceiling`, async () => {
      const { status, body } = await post(makeEnv({ quota: QUOTA }), path);
      expect(status).toBe(507);
      // The message carries the REAL numbers, which is what makes the refusal honest rather than a
      // bare status, and it is also what distinguishes this 507 from any other.
      expect(String(body.error)).toContain(`${USED_OVER} bytes stored`);
      expect(String(body.error)).toContain(`${QUOTA}-byte R2_STORAGE_QUOTA_BYTES ceiling`);
    });

    it(`POSITIVE CONTROL: ${name} is ADMITTED in the same env when usage is under the ceiling`, async () => {
      // Same route, same bindings, same knob -- only the ledger reading changes. Without this, N
      // refusals are equally consistent with N routes that are simply broken in this env, and the
      // 507 cases above would prove nothing about the ceiling.
      const { status, body } = await post(makeEnv({ quota: QUOTA, usedBytes: USED_UNDER }), path);
      expect(status).not.toBe(507);
      expect(status).not.toBe(503);
      expect(String(body.error ?? "")).not.toContain("R2_STORAGE_QUOTA_BYTES");
    });
  }

  it("POSITIVE CONTROL: with the knob UNSET the same over-quota ledger is admitted", async () => {
    // Proves the refusal is caused by the KNOB and not by the fixture DB or the request shape.
    // core returns ok before touching the DB when no ceiling is configured, which is also why the
    // gate is inert on a default deploy.
    const { status } = await post(makeEnv({ quota: undefined }), `/api/render/frames`);
    expect(status).not.toBe(507);
    expect(status).not.toBe(503);
  });

  it("NEGATIVE CONTROL: a route that writes no new artifact bytes is NOT gated", async () => {
    // /voice-sample/keep re-points the cast row at a clip an already-metered run produced. The
    // anchored patterns must not widen onto it even with the ledger far over the ceiling.
    const { status } = await post(makeEnv({ quota: QUOTA }), `/api/cast/${PUB}/voice-sample/keep`);
    expect(status).not.toBe(507);
  });
});

describe("cf#811 the fail-CLOSED posture, which is equally untested", () => {
  it("503s when the quota is SET but DB is unbound, and says so in the message", async () => {
    const { status, body } = await post(makeEnv({ quota: QUOTA, noDb: true }), "/api/render/frames");
    expect(status).toBe(503);
    // Asserting the MESSAGE, not the status. The spend gate above also fails closed to 503, so a
    // status-only assertion would survive this gate being deleted outright.
    expect(String(body.error)).toContain("the studio database is unavailable");
    expect(String(body.error)).toContain("fail-closed posture");
    expect(String(body.error)).toContain(`storage quota is set (${QUOTA} bytes)`);
  });

  it("503s when the usage read THROWS, which is a different broken case from an unbound DB", async () => {
    const { status, body } = await post(
      makeEnv({ quota: QUOTA, throwOnUsage: true }), "/api/render/frames");
    expect(status).toBe(503);
    expect(String(body.error)).toContain("storage quota check failed");
    expect(String(body.error)).toContain("fail-closed posture");
  });

  it("POSITIVE CONTROL: an unbound DB with NO quota set is admitted, so the 503 is the KNOB", async () => {
    const { status } = await post(makeEnv({ quota: undefined, noDb: true }), "/api/render/frames");
    expect(status).not.toBe(503);
  });

  it("meter mode does NOT deny an over-quota studio, and does not 503 on a broken read", async () => {
    // The posture knob is core's R2_STORAGE_QUOTA_MODE, NOT SPEND_LIMIT_FAIL_CLOSED. Pinning both
    // arms here is what stops someone "unifying" the two gates on the strength of the old comment.
    const over = await post(makeEnv({ quota: QUOTA, mode: "meter" }), "/api/render/frames");
    expect(over.status).not.toBe(507);
    const broken = await post(makeEnv({ quota: QUOTA, mode: "meter", noDb: true }), "/api/render/frames");
    expect(broken.status).not.toBe(503);
  });

  it("an UNRECOGNISED mode falls back to deny rather than to meter", async () => {
    // Guessing "meter" on a typo would turn a hard stop into unmetered spend. The safe side is the
    // one that costs nobody money they did not agree to.
    const { status } = await post(makeEnv({ quota: QUOTA, mode: "MeTeRr" }), "/api/render/frames");
    expect(status).toBe(507);
  });

  it("an unstamped ledger still DENIES at the ceiling (a floor denies, just later)", async () => {
    const { status, body } = await post(
      makeEnv({ quota: QUOTA, trueSince: null }), "/api/render/frames");
    expect(status).toBe(507);
    expect(String(body.error)).toContain(`${USED_OVER} bytes stored`);
  });
});

describe("cf#811 the gate is wired into THIS panel, not merely present in core", () => {
  it("SPEND_LIMIT_FAIL_CLOSED does not control this gate", async () => {
    // The knobs are different, which src/index.ts now says explicitly (cf#804). Flipping the spend
    // knob must not soften the storage ceiling; if it ever does, the two gates have been merged.
    const env = makeEnv({ quota: QUOTA });
    (env as unknown as Record<string, unknown>).SPEND_LIMIT_FAIL_CLOSED = "false";
    const { status } = await post(env, "/api/render/frames");
    expect(status).toBe(507);
  });
});
