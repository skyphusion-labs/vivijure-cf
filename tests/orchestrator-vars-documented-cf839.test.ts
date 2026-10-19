/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { ORCHESTRATOR_VAR_KEYS } from "../src/platform/orchestrator-vars";

// cf#839: A LIVE VAR MISSING FROM THE FILE AN OPERATOR EDITS.
//
// `ALLOW_UNAUTHENTICATED` is read by live code, is in the canonical var contract
// (src/platform/orchestrator-vars.ts, which flows to the release manifest as `required_vars`), and
// appeared in NONE of the five committed wrangler examples. So the hosted control plane knew about
// it and the self-hoster could not see it. That asymmetry is the finding: a var that is live and
// undocumented is worse than a documented dead one -- the dead one wastes a reader's time, the
// undocumented live one means a deploy silently lacks a capability with nothing saying so.
//
// Fixing the file once does not stop it recurring, so the denominator is asserted here instead. The
// list is DERIVED from ORCHESTRATOR_VAR_KEYS rather than typed, so a var added there is covered
// automatically and this test does not become a second copy of the contract it is checking.
//
// THE BLIND SPOT, NAMED: the denominator is the ORCHESTRATOR list. A var the host reads that is NOT
// in that list is outside this guard entirely -- `VIDEO_FINISH_TIER_STATE` is exactly that (read by
// src/video-finish-availability.ts, written by the control plane, never an orchestrator var). It is
// documented in wrangler.toml.example by cf#839 and is asserted separately below, by name, because a
// derived sweep cannot find what its source list does not contain.

const ROOT = join(import.meta.dirname, "..");

/** Every committed wrangler example. A listing that misses one is not a denominator: an earlier
 *  pass reasoned about "the wrangler example" as if there were one, and there are five. */
const EXAMPLES = [
  "wrangler.toml.example",
  "wrangler.demo.toml.example",
  "wrangler.mcp.toml.example",
  "tail/wrangler.toml.example",
  "modules/local-gpu/wrangler.demo.toml.example",
];

/**
 * Vars deliberately absent from every example, each with a reason. "Declared" does not mean "fine";
 * it means VISIBLE. Anything not listed here must appear in at least one example.
 */
const DECLARED_ABSENT: Record<string, string> = {
  PLANNER_AI_MOCK:
    "dev-only mock gate (#411, src/env.ts). Shipping it in an operator example invites someone to set it in production.",
  ABUSE_REPORT_URL:
    "control-plane owned: the hosted plane injects it onto a tenant studio. A self-hoster has nothing to put here.",
};

/** VISIBLE: the var appears anywhere in an example, including in a comment. That is the bar for the
 *  derived sweep -- an exotic var explained in prose is genuinely discoverable by a reader. */
function mentionedIn(v: string, files = EXAMPLES): string[] {
  const out: string[] = [];
  for (const f of files) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    if (readFileSync(p, "utf8").includes(v)) out.push(f);
  }
  return out;
}

/**
 * SETTABLE: the var appears as an actual assignment, `VAR = ...`, on a non-comment line.
 *
 * WHY BOTH EXIST, and it is not pedantry. The first version of this file had only the loose check,
 * and two planted defects stayed GREEN because of it: deleting `ALLOW_UNAUTHENTICATED = ""` left the
 * explanatory comment above it, which still matched, so the test could not tell "an operator can set
 * this" from "an operator can read about it". A positive control cannot catch a matcher that is too
 * LOOSE -- it passes either way -- which is why the plant is what found it.
 *
 * For a var whose whole point is that a self-hoster sets it, settable is the real claim.
 */
function settableIn(v: string, files = EXAMPLES): string[] {
  const out: string[] = [];
  const assign = new RegExp("^\\s*" + v + "\\s*=");
  for (const f of files) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    const hit = readFileSync(p, "utf8")
      .split("\n")
      .some((l) => !l.trimStart().startsWith("#") && assign.test(l));
    if (hit) out.push(f);
  }
  return out;
}

describe("every orchestrator var is visible to an operator (cf#839)", () => {
  it("the instrument reads the examples at all (POSITIVE control)", () => {
    // Without this, "everything is documented" and "no file was read" are the same observation.
    for (const f of EXAMPLES) {
      expect(existsSync(join(ROOT, f)), `example missing from the repo: ${f}`).toBe(true);
    }
    expect(mentionedIn("AUTH_MODE")).toContain("wrangler.toml.example");
    // Both matchers must be able to fire, or one of them is decoration.
    expect(settableIn("AUTH_MODE")).toContain("wrangler.toml.example");
    expect(ORCHESTRATOR_VAR_KEYS.length).toBeGreaterThan(20);
  });

  it("the instrument can REPORT A MISS (NEGATIVE control)", () => {
    // The other half of the control. A checker that cannot produce a failure is decoration, and a
    // too-loose matcher is the shape a positive control alone cannot catch.
    expect(mentionedIn("CF839_VAR_THAT_CANNOT_EXIST")).toEqual([]);
    expect(settableIn("CF839_VAR_THAT_CANNOT_EXIST")).toEqual([]);
    // And the tighter matcher must reject a COMMENT-ONLY mention, which is the exact hole that let
    // two plants pass. `XAI_API_KEY` now exists only as a tombstone comment, so it is the live
    // fixture for this: mentioned, and correctly NOT settable.
    expect(mentionedIn("XAI_API_KEY").length).toBeGreaterThan(0);
    expect(settableIn("XAI_API_KEY")).toEqual([]);
  });

  it("no orchestrator var is missing from every example unless declared", () => {
    const undocumented = ORCHESTRATOR_VAR_KEYS.filter(
      (v) => mentionedIn(v).length === 0 && !(v in DECLARED_ABSENT),
    );
    expect(undocumented, "orchestrator var(s) an operator cannot see in any wrangler example").toEqual([]);
  });

  it("ALLOW_UNAUTHENTICATED is in the file an operator edits, not only in prose", () => {
    // The specific regression cf#839 found. docs/SECURITY.md and docs/CONTRACT.md described it all
    // along; the config surface did not, which is the surface that decides a deploy.
    // SETTABLE, not merely mentioned: a self-hoster has to be able to set this without inventing
    // the key name or its syntax.
    expect(settableIn("ALLOW_UNAUTHENTICATED")).toContain("wrangler.toml.example");
  });

  it("VIDEO_FINISH_TIER_STATE is documented, though it is outside the derived sweep", () => {
    // Asserted BY NAME on purpose: it is not an orchestrator var, so the loop above cannot see it.
    // Read by src/video-finish-availability.ts, written by the control plane.
    expect(settableIn("VIDEO_FINISH_TIER_STATE")).toContain("wrangler.toml.example");
  });

  it("every declared exemption is still a REAL orchestrator var, so the list cannot rot", () => {
    // A graveyard entry for a var that no longer exists would silently excuse a future var that
    // happens to reuse the name. Same ratchet the panel guard uses on its exemptions.
    for (const v of Object.keys(DECLARED_ABSENT)) {
      expect(ORCHESTRATOR_VAR_KEYS as readonly string[], `stale exemption: ${v}`).toContain(v);
      expect(DECLARED_ABSENT[v].length, `exemption ${v} has no reason`).toBeGreaterThan(20);
    }
  });
});

describe("cf#839 the retired shim and the unimplemented key stay gone", () => {
  const tree = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

  it("src/shard-count.ts is gone and nothing declares RENDER_SHARD_MAX", () => {
    // Retired after enumerating EVERY invocation path, not on one zero-reference count: static and
    // dynamic import, all four exported symbols by name, the route table, the cron/scheduled
    // handler, the one Durable Object class, and the fact that this worker declares no queue, email
    // or tail handler at all. Core 1.24.0 exports resolveShardCount, which is the sunset condition
    // the shim's own header named (it said 1.19.0), and scatter is retired behind a 410.
    expect(existsSync(join(ROOT, "src/shard-count.ts")), "the shim came back").toBe(false);
    expect(existsSync(join(ROOT, "tests/shard-count.test.ts"))).toBe(false);
    expect(tree("src/env.ts")).not.toContain("RENDER_SHARD_MAX");
  });

  it("XAI_API_KEY is not declared, and not promised in any example", () => {
    // It was declared in Env and documented in three operator-facing places with a
    // `wrangler secret put` recipe, and read by no code. A tombstone comment explaining the removal
    // is fine and expected; a declaration or an unqualified instruction is not.
    expect(tree("src/env.ts")).not.toContain("XAI_API_KEY");
    for (const f of EXAMPLES) {
      const p = join(ROOT, f);
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, "utf8").split("\n")) {
        if (!line.includes("XAI_API_KEY")) continue;
        // Only a comment that says it is gone may mention it.
        expect(line.trimStart().startsWith("#"), `${f}: XAI_API_KEY in a non-comment line`).toBe(true);
        expect(line, `${f}: XAI_API_KEY mentioned without saying it is gone`).toMatch(/GONE|removed|REMOVED/);
      }
    }
  });
});
