import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { INVOKE_FAILURE_REASONS } from "@skyphusion-labs/vivijure-core/modules/types";

// cf#846 step 3: `reason?: InvokeFailureReason` on each module's VENDORED InvokeResponse.
//
// WHY THIS TEST IS THE MECHANISM, AND WHY THERE IS NO GENERATOR SCRIPT.
//
// All 34 module contracts are VENDORED and IMPORT-FREE by deliberate design -- measured: `grep -l
// "^import " modules/*/src/contract.ts` returns 0, and four of them state the rationale, e.g.
// "Dependency-free, which is the point: a module must be buildable and deployable without the core
// package." So the union cannot be imported into them; it has to be copied, 34 times.
//
// 34 copies of one closed vocabulary is a drift surface, and this repo has already lost that bet:
// GHSA-qgx2-5crw-9m4j was two copies of one safety rule that diverged, with the narrower copy's
// docstring asserting the two were the same. A generator would help only if someone ran it, and a
// generator nobody runs is a rule with no mechanism. So the EXPECTED TEXT IS DERIVED HERE, from
// core's own `INVOKE_FAILURE_REASONS` at test time, and compared byte-for-byte against all 34 files.
//
// Consequences, which are the whole point:
//   * core adding, removing or reordering a member FAILS this test until every copy is regenerated
//   * a hand-edited copy FAILS, including a near-miss spelling like `not_configured`
//   * the failure message PRINTS the exact expected block, so the fix is a paste and not a puzzle
//
// WHY ONLY 33 OF THE 63 IDENTICAL `| { ok: false; error: string };` ARMS CARRY `reason`.
//
// That string appears 63 times across the 33 contracts and serves THREE different types:
// `InvokeResponse` 33, `PollResponse` 28, `CancelResponse` 2. (Was 65/34/29 until cf#921
// retired modules/kling, which took one InvokeResponse arm and one PollResponse arm with it.) The string cannot tell you which; only
// the enclosing declaration can, so a global replace would widen the contract in 31 places.
//
// `PollResponse` is EXCLUDED ON PURPOSE, and this is a decision rather than an unfinished migration.
// core#306 states it: the poll site keeps `classifyTransientFailure` because `PollResponse` already
// carries its own closed `outcome` set. Adding `reason` beside `outcome` would put TWO closed unions
// on one object sharing two spellings -- `backend-error` and `cancelled` are members of both, meaning
// "RunPod reported a backend error" in one and "our module classified this as a backend error" in the
// other -- which would render identically to a human reading the row. A shared spelling is not a
// shared meaning. `CancelResponse` is excluded for the same reason: it is not an invoke result.
//
// The counts are asserted below so that exclusion stays visible. Anyone reading 33-of-63 as a partial
// migration should read this block and the `PollResponse` assertion instead.

const MODULES_DIR = join(__dirname, "..", "modules");

function contractPaths(): string[] {
  return readdirSync(MODULES_DIR)
    .filter((d) => d !== "_shared")
    .map((d) => join(MODULES_DIR, d, "src", "contract.ts"))
    .filter((p) => {
      try {
        readFileSync(p, "utf8");
        return true;
      } catch {
        return false;
      }
    });
}

/** The canonical vendored block, derived from core. The ONLY definition of what the copies must say. */
function canonicalBlock(): string {
  const members = INVOKE_FAILURE_REASONS.map((r) => `  | ${JSON.stringify(r)}`).join("\n");
  return [
    "/** VENDORED from core's `InvokeFailureReason` (vivijure-module/2, core#291). CLOSED set.",
    " *",
    " *  DO NOT HAND-EDIT. `tests/invoke-failure-reason-vendored.test.ts` derives this block from core's",
    " *  `INVOKE_FAILURE_REASONS` and fails if any of the 34 vendored copies drifts from it. Copied rather",
    " *  than imported because this file is deliberately import-free (a module must build without the core",
    " *  package); the test is what makes 34 copies safe.",
    " *",
    " *  ABSENT means the module has not adopted the field. It is never defaulted to a class. */",
    "export type InvokeFailureReason =",
    members + ";",
  ].join("\n");
}

/** The InvokeResponse failure arm, which is the only arm that gains `reason`. */
const CANONICAL_ARM = "  | { ok: false; error: string; reason?: InvokeFailureReason };";

/** What PollResponse and CancelResponse must still say: bare, no `reason`. */
const BARE_ARM = "  | { ok: false; error: string };";

describe("cf#846: the vendored InvokeFailureReason block is byte-identical in all 33 contracts", () => {
  it("there are 33 module contracts (denominator, so a shrinking sweep cannot pass)", () => {
    expect(contractPaths().length).toBe(33);
  });

  it("every contract carries the canonical block EXACTLY, derived from core", () => {
    const want = canonicalBlock();
    const missing: string[] = [];
    for (const p of contractPaths()) {
      if (!readFileSync(p, "utf8").includes(want)) missing.push(p.replace(MODULES_DIR, "modules"));
    }
    expect(
      missing,
      "These contracts do not carry the canonical vendored block. Paste EXACTLY this, " +
        "immediately above `export type InvokeResponse`:\n\n" + want + "\n",
    ).toEqual([]);
  });

  it("every contract's InvokeResponse failure arm carries reason", () => {
    const missing: string[] = [];
    for (const p of contractPaths()) {
      if (!readFileSync(p, "utf8").includes(CANONICAL_ARM)) missing.push(p.replace(MODULES_DIR, "modules"));
    }
    expect(missing, "Expected this arm:\n\n" + CANONICAL_ARM + "\n").toEqual([]);
  });

  it("the member list matches core's set and count, so a core change cannot pass silently", () => {
    // The assertion that gives this test its single-source property: if core adds `job-gone` or
    // `policy-refusal`, the derived block changes and the 34 copies go red until regenerated.
    expect(INVOKE_FAILURE_REASONS.length).toBe(11);
    const block = canonicalBlock();
    for (const r of INVOKE_FAILURE_REASONS) expect(block).toContain(`  | "${r}"`);
  });
});

describe("cf#846: a near-miss spelling cannot pass as a member", () => {
  // The two ways a closed union quietly becomes a free string.
  it.each(["not_configured", "quota", "rate_limited", "backendError"])(
    "%s is NOT a member of core's set and is NOT in the canonical block",
    (bad) => {
      expect(INVOKE_FAILURE_REASONS as readonly string[]).not.toContain(bad);
      expect(canonicalBlock()).not.toContain(`  | "${bad}"`);
    },
  );

  it("a hand-edited copy with a near-miss FAILS the byte-exact comparison", () => {
    // Negative control on the comparison itself: proves the check discriminates, rather than only
    // proving the good text matches. A tampered block must not satisfy `includes`.
    const tampered = canonicalBlock().replace('  | "not-configured"', '  | "not_configured"');
    expect(tampered).not.toBe(canonicalBlock());
    const fileWithTampered = "prefix\n" + tampered + "\nsuffix";
    expect(fileWithTampered.includes(canonicalBlock())).toBe(false);
  });
});

describe("cf#846: PollResponse and CancelResponse are EXCLUDED, and that is asserted not assumed", () => {
  // Without these rows, 33-of-63 reads as an incomplete migration. See the header for core#306's
  // reason: PollResponse already carries its own closed `outcome` set, and two closed unions on one
  // object sharing `backend-error` and `cancelled` would render identically while meaning different
  // things.
  it("no contract puts reason on a PollResponse or CancelResponse arm", () => {
    const offenders: string[] = [];
    for (const p of contractPaths()) {
      const lines = readFileSync(p, "utf8").split("\n");
      let cur: string | null = null;
      lines.forEach((l, i) => {
        const m = /^export (?:type|interface) (\w+)/.exec(l);
        if (m) cur = m[1];
        if ((cur === "PollResponse" || cur === "CancelResponse") && l.includes("reason?")) {
          offenders.push(`${p.replace(MODULES_DIR, "modules")}:${i + 1} (${cur})`);
        }
      });
    }
    expect(
      offenders,
      "PollResponse keeps its own closed `outcome` vocabulary (core#306). Adding `reason` beside it " +
        "puts two closed unions on one object sharing two spellings with different meanings.",
    ).toEqual([]);
  });

  it("the bare arm still appears, so the exclusion is real rather than a rename", () => {
    // If a global replace had been done, zero bare arms would remain and this row would fail.
    //
    // TWO COUNTS, ON PURPOSE, because they differ and the difference is a trap I walked into while
    // writing this test. 30 arms are OWNED by PollResponse (28) and CancelResponse (2), but only 29
    // of them are a standalone `  | { ok: false; error: string };` LINE: one CancelResponse is
    // declared inline as `export type CancelResponse = { ok: true } | { ok: false; error: string };`.
    // Asserting 30 against a line-matcher fails, and the number that is "wrong" depends entirely on
    // which instrument you used. So both are pinned and named.
    let standalone = 0;
    let inlineCancel = 0;
    for (const p of contractPaths()) {
      const lines = readFileSync(p, "utf8").split("\n");
      standalone += lines.filter((l) => l === BARE_ARM).length;
      inlineCancel += lines.filter(
        (l) => l.startsWith("export type CancelResponse") && l.includes("ok: false; error: string"),
      ).length;
    }
    expect(standalone).toBe(29);
    expect(inlineCancel).toBe(1);
    expect(standalone + inlineCancel).toBe(30); // == PollResponse 28 + CancelResponse 2
  });
});
