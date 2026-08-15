import { describe, it, expect, beforeEach } from "vitest";
import { discoverModules, _resetModuleDiscoveryCache } from "@skyphusion-labs/vivijure-core/modules/registry";
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";

// Issue #17 follow-up: /api/modules caches discovery for 60s per isolate (opt-in via cacheTtlMs) so a
// refresh storm stops re-fetching every module manifest each request. nowMs is injected for determinism.

const MANIFEST = { name: "finish-rife", version: "0.1.0", api: MODULE_API, hooks: ["finish"] };
const TTL = 60_000;

// One MODULE_* binding whose manifest fetch is counted, so cache hits are observable.
function countingEnv() {
  const counts = { fetches: 0 };
  const env: Record<string, unknown> = {
    MODULE_X: {
      fetch: async () => {
        counts.fetches++;
        return new Response(JSON.stringify(MANIFEST), { status: 200, headers: { "content-type": "application/json" } });
      },
    },
  };
  return { env, counts };
}

describe("discoverModules per-isolate cache (issue #17 follow-up)", () => {
  beforeEach(() => _resetModuleDiscoveryCache());

  it("re-uses the cached registry within the TTL (one fetch, not N)", async () => {
    const { env, counts } = countingEnv();
    const a = await discoverModules(env, { cacheTtlMs: TTL, nowMs: 1000 });
    const b = await discoverModules(env, { cacheTtlMs: TTL, nowMs: 1000 + TTL - 1 }); // still inside TTL
    expect(counts.fetches).toBe(1); // second call served from cache
    expect(b).toEqual(a);
    expect(a.map((m) => m.name)).toEqual(["finish-rife"]);
  });

  it("re-discovers once the TTL has elapsed", async () => {
    const { env, counts } = countingEnv();
    await discoverModules(env, { cacheTtlMs: TTL, nowMs: 1000 });
    await discoverModules(env, { cacheTtlMs: TTL, nowMs: 1000 + TTL }); // at expiry (now < expiresAt is false)
    expect(counts.fetches).toBe(2);
  });

  // core#216 INVERTED this contract. The scan cache used to be OPT-IN (default TTL 0, so a caller
  // passing nothing never cached); it is now OPT-OUT (default SERVICE_SCAN_TTL_MS, 30s). The test
  // that stood here asserted the OLD default and is not repairable by adjusting its number, because
  // the property it named no longer exists.
  it("the DEFAULT caches the service scan -- opt-out now, not opt-in (core#216)", async () => {
    const { env, counts } = countingEnv();
    await discoverModules(env, { nowMs: 1000 });
    await discoverModules(env, { nowMs: 1001 });
    expect(counts.fetches).toBe(1);
  });

  it("cacheTtlMs 0 still forces a cold scan, so the opt-out survives the new default", async () => {
    const { env, counts } = countingEnv();
    await discoverModules(env, { cacheTtlMs: 0, nowMs: 1000 });
    await discoverModules(env, { cacheTtlMs: 0, nowMs: 1001 });
    expect(counts.fetches).toBe(2);
  });

  // WAS: "an uncached caller never reads the route cache". That test passed here for a reason
  // unrelated to what it claimed. It populated at nowMs 1000 and then called with NO nowMs, so the
  // second call used the REAL clock, against which an entry expiring at 61000 is ancient. It missed
  // and re-fetched. Give it a CONSISTENT clock and it takes 1 fetch, not 2 -- measured. Under the
  // new default there is no such thing as an uncached caller, so the property is gone and only the
  // clock artifact was keeping it green. The real remaining property is that an EXPLICIT cold caller
  // ignores a populated cache, asserted below on one clock so it cannot pass by accident.
  it("an EXPLICIT cold caller (cacheTtlMs 0) ignores a live populated cache", async () => {
    const { env, counts } = countingEnv();
    await discoverModules(env, { cacheTtlMs: TTL, nowMs: 1000 });
    await discoverModules(env, { cacheTtlMs: 0, nowMs: 1001 });
    expect(counts.fetches).toBe(2);
  });
});
