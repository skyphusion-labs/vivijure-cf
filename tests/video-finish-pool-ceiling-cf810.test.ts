import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { SYNC_POOL_SIZE, RESERVED_JOB_INSTANCES } from "../src/video-finish-binding";

// cf#810: the stateless pool size and the container application's max_instances live in two
// different files, in two different languages, and they MUST relate. Nothing but this test keeps
// them related.
//
// WHY IT MATTERS MORE THAN A USUAL DRIFT CHECK. wrangler.toml.example's own comment records that a
// request exceeding max_instances **ERRORS rather than queueing**. So breaking the inequality does
// not degrade the tier gracefully; it refuses container starts. And the pool is the cheap consumer
// while the per-job instance is the load-bearing one, so the failure lands on the encode -- the one
// thing the tier exists to do -- while the /inspect call that ate the budget succeeds.
//
// THIS IS A REAL DEFECT THAT SHIPPED, not a hypothetical: SYNC_POOL_SIZE was 4 against a ceiling of
// 3, so the pool alone could exceed the cap before a single encode ran. It was invisible because
// the two numbers are never read together anywhere else in the tree.
//
// Parsed from the COMMITTED wrangler.toml.example, deliberately, not from a copy of the number: a
// test asserting against its own transcribed constant would pass while the config said something
// else, which is the entire failure mode being guarded.

function maxInstancesFromConfig(): number {
  // A plain string path, not a URL. This repo pins @cloudflare/workers-types, whose global URL is
  // not assignable to node:fs's or node:url's URL, so every URL-based form fails typecheck here.
  // Resolved from the vitest cwd (the project root), and its EXISTENCE is asserted: a wrong cwd
  // must fail loudly rather than let the regexes below find nothing and report a vacuous pass.
  const path = resolve(process.cwd(), "wrangler.toml.example");
  expect(existsSync(path), `wrangler.toml.example not found at ${path}`).toBe(true);
  const toml = readFileSync(path, "utf8");
  // The [[containers]] block, up to the next section header.
  const block = /\n\[\[containers\]\]\n([\s\S]*?)(?=\n\[|\n*$)/.exec(toml);
  expect(block, "no [[containers]] block in wrangler.toml.example").not.toBeNull();
  const m = /^\s*max_instances\s*=\s*(\d+)\s*$/m.exec(block![1]);
  expect(
    m,
    "no max_instances in the [[containers]] block. It is not optional here: the platform default is " +
      "20 and the pool arithmetic in src/video-finish-binding.ts is written against an explicit cap.",
  ).not.toBeNull();
  return Number(m![1]);
}

describe("cf#810 the stateless pool must fit under the container application ceiling", () => {
  it("parses a real max_instances out of the committed config", () => {
    const max = maxInstancesFromConfig();
    // The instrument must be shown capable of a reading before its verdict means anything.
    expect(Number.isInteger(max)).toBe(true);
    expect(max).toBeGreaterThan(0);
  });

  it("SYNC_POOL_SIZE leaves room for the reserved concurrent finish jobs", () => {
    const max = maxInstancesFromConfig();
    // The invariant, stated once: pool + concurrent jobs <= ceiling.
    expect(SYNC_POOL_SIZE + RESERVED_JOB_INSTANCES).toBeLessThanOrEqual(max);
  });

  it("the pool is at least 1, so stateless routes are reachable at all", () => {
    expect(SYNC_POOL_SIZE).toBeGreaterThanOrEqual(1);
  });

  it("the guard can FAIL: the shipped defect (pool 4, ceiling 3) is rejected by the same inequality", () => {
    // The exact numbers that were on main. A guard that has never produced its negative is not
    // known to work, and this one's whole job is to reject a combination that already shipped.
    const shippedPool = 4;
    const shippedCeiling = 3;
    expect(shippedPool + RESERVED_JOB_INSTANCES).toBeGreaterThan(shippedCeiling);
  });
});
