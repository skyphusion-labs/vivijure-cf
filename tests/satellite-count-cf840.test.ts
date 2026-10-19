/// <reference types="node" />
// cf#840 -- the SATELLITE count the operator READS must be derived from the count the script
// DEPLOYS, or it drifts on the next excision. It already did: cf#785 (excise MuseTalk) and cf#787
// (remove speech-upscale) took SATELLITE_MODULES from three modules to one, landed correctly in
// the code, and left "the 3 opt-in GPU finish modules" plus three copies of "with the 3 extra
// RunPod endpoint ids" in the text deploy.sh prints on a SUCCESSFUL run. An operator following
// that instruction went hunting for three RunPod endpoint ids when deploy.sh requires exactly one
// (VIDEO_UPSCALE_RUNPOD_ENDPOINT_ID, the satellites branch), and the other two had no module
// behind them any more.
//
// WHY THIS IS A TEST AND NOT A SENTENCE IN A DOC. "Document that it is 1 endpoint" is a rule, and
// a rule with no mechanism is a defect: nothing would have gone red when the count changed, which
// is exactly how it stayed wrong through two excisions. This guard DERIVES N from the
// SATELLITE_MODULES assignment in deploy.sh and fails when any operator-facing phrase disagrees,
// so the next addition or excision cannot silently desynchronise them.
//
// IT DELIBERATELY DOES NOT HARDCODE 1. A guard pinned to today's number is the same defect one
// commit later: it would go red on a CORRECT change (adding a second satellite) and green on the
// drift it exists to catch. N comes from the script; only the AGREEMENT is asserted.
//
// The scanned-file list is itself part of the contract. If a file below legitimately stops
// carrying the count, this guard goes red and the list must be edited deliberately -- that cost
// is the point. CHANGELOG.md is NOT scanned: its entries are history, and at the old shas the 3
// was correct.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const DEPLOY = "deploy.sh";

// Operator-facing files that state the satellite count in prose. Each must carry at least one
// countable phrase (the denominator below), so a deleted or moved phrase is a RED, never a
// vacuous green.
const SCANNED = [DEPLOY, "docs/DEPLOYMENT.md", "docs/opt-in-tiers.md", "docs/SECURITY.md"];

const WORDS = ["zero", "one", "two", "three", "four", "five", "six"];

function src(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/**
 * How many modules the satellites profile actually deploys, read from the shipped assignment.
 * Returns null when the assignment cannot be found, so the caller can fail LOUDLY instead of
 * silently treating "no match" as a count.
 */
function satelliteCount(shell: string): number | null {
  const m = /^SATELLITE_MODULES="([^"]*)"/m.exec(shell);
  if (!m) return null;
  const mods = m[1].split(/\s+/).filter((s) => s.length > 0 && s !== "\\");
  return mods.length;
}

/**
 * Operator prose wraps across lines, sits behind `#` in the shell and behind `>` in a markdown
 * blockquote, and carries markdown emphasis. Normalise all of that away so a phrase is matched by
 * its WORDS rather than by its line breaks -- the three success-message copies in deploy.sh each
 * split "the N extra / RunPod endpoint id" across two lines.
 */
function normalise(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/^[\s>#]+/, ""))
    .join(" ")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ");
}

/** Every satellite-count phrase, as {token, noun}. Word spellings are captured too, so writing */
/** the count as "three" cannot dodge a digit-only check. */
function countPhrases(text: string): { token: string; noun: string; phrase: string }[] {
  const N = "(\\d+|zero|one|two|three|four|five|six)";
  const families = [
    new RegExp(`the ${N} opt-in GPU finish (modules?)\\b`, "gi"),
    new RegExp(`the ${N} extra RunPod endpoint (ids?)\\b`, "gi"),
    new RegExp(`(?:the )?${N} GPU finish (endpoints?|satellites?|modules?)\\b`, "gi"),
  ];
  const out: { token: string; noun: string; phrase: string }[] = [];
  const flat = normalise(text);
  for (const re of families) {
    for (const m of flat.matchAll(re)) {
      out.push({ token: m[1].toLowerCase(), noun: m[2].toLowerCase(), phrase: m[0] });
    }
  }
  return out;
}

describe("cf#840: the operator-facing satellite count is derived, not remembered", () => {
  it("DENOMINATOR: SATELLITE_MODULES is parseable and non-empty", () => {
    const n = satelliteCount(src(DEPLOY));
    expect(n, "SATELLITE_MODULES=\"...\" not found in deploy.sh -- this guard cannot derive N").not.toBeNull();
    expect(n).toBeGreaterThan(0);
  });

  it("CONTROL: the parser reports a DIFFERENT count for a different assignment", () => {
    // Without this, a parser that always answered 1 would pass every assertion below while the
    // real count was three. Proves the instrument can produce the reading that fails the suite.
    expect(satelliteCount('SATELLITE_MODULES="a b c"\n')).toBe(3);
    expect(satelliteCount('SATELLITE_MODULES="only-one"\n')).toBe(1);
    expect(satelliteCount('MODULES="a b"\n')).toBeNull();
  });

  it("CONTROL: the phrase checker accepts the right count and rejects the wrong one", () => {
    const ok = countPhrases("with the 1 extra RunPod endpoint id) and re-run");
    expect(ok.length).toBe(1);
    expect(ok[0].token).toBe("1");
    const stale = countPhrases("with the 3 extra RunPod endpoint ids) and re-run");
    expect(stale.length).toBe(1);
    expect(stale[0].token).toBe("3"); // the exact pre-fix text: it MUST be seen, not skipped
    // The word spelling is caught as well, so "three" is not an escape hatch from a digit check.
    expect(countPhrases("deploys the three GPU finish endpoints below")[0].token).toBe("three");
  });

  it("DENOMINATOR: every scanned file yields at least one countable phrase", () => {
    for (const f of SCANNED) {
      expect(countPhrases(src(f)).length, `${f} carries no satellite-count phrase -- either the text moved (update SCANNED deliberately) or this guard has stopped looking`).toBeGreaterThan(0);
    }
  });

  it("every operator-facing satellite count equals the count deploy.sh deploys", () => {
    const n = satelliteCount(src(DEPLOY))!;
    const expected = new Set([String(n), WORDS[n]].filter(Boolean));
    const wrong: string[] = [];
    for (const f of SCANNED) {
      for (const p of countPhrases(src(f))) {
        if (!expected.has(p.token)) wrong.push(`${f}: "${p.phrase}" says ${p.token}, SATELLITE_MODULES has ${n}`);
      }
    }
    expect(wrong, `stale satellite count(s); SATELLITE_MODULES deploys ${n}`).toEqual([]);
  });

  it("the count's grammatical number agrees with it (a half-landed edit goes red)", () => {
    // cf#840 changed a count in one place and left "ids" plural in another; the number and the
    // noun have to move together or the text still misinforms.
    const n = satelliteCount(src(DEPLOY))!;
    const bad: string[] = [];
    for (const f of SCANNED) {
      for (const p of countPhrases(src(f))) {
        const plural = p.noun.endsWith("s");
        if (n === 1 && plural) bad.push(`${f}: "${p.phrase}" is plural but the count is 1`);
        if (n !== 1 && !plural) bad.push(`${f}: "${p.phrase}" is singular but the count is ${n}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
