import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// GHSA-qgx2-5crw-9m4j: THE DRIFT SURFACE, not just the drift.
//
// The defect was two copies of one CSAM matcher that had diverged: `_shared/finish-soft-degrade.ts`
// tested `includes("csam")` while `cloud-keyframe/src/image-gen.ts` tested four wordings, and the
// first one's docstring claimed they were the same. Widening the narrow copy fixes today. It does
// nothing about tomorrow, because the thing that produced the defect was the SECOND COPY being
// possible at all, and the population was two the last time anyone counted.
//
// So this asserts the count, not the contents: exactly ONE file in the tree may match text against
// a CSAM needle. Everything else must import it.
//
// Message CONSTRUCTION is explicitly allowed. `finish-blender`, `finish-rife` and `finish-upscale`
// each build `"csam refusal: " + csam` after calling the shared discriminator; they hold no needle
// and are not what this guards against. The distinction is applying a string TEST to a needle.

const ROOT = join(__dirname, "..");

/** The one file permitted to hold the needle. */
const SINGLE_SOURCE = "modules/_shared/finish-soft-degrade.ts";

/** Trees that ship code. `tests/` is excluded: a suite naturally names the wordings it asserts on. */
const SCANNED = ["modules", "src", "public", "tail", "scripts"];

const NEEDLE = /csam|child sexual|child pornography|sexual content involving a minor/i;
/** A string TEST being applied, rather than a message being built. */
const TESTING = /\.(includes|test|match|search|startsWith|endsWith|indexOf)\s*\(|=~|\/[^/\n]*(?:csam|child sexual)[^/\n]*\/[gimsuy]*\s*\.test/i;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".git" || e === "dist") continue;
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|js|mjs|cjs)$/.test(e) && !/\.test\.(ts|js)$/.test(e)) out.push(full);
  }
  return out;
}

/** Files holding a line that applies a string test to a CSAM needle. */
function needleHolders(): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = [];
  for (const top of SCANNED) {
    for (const file of walk(join(ROOT, top))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((raw, i) => {
        const line = raw.trim();
        // Skip comment lines: a comment can name the rule without implementing it, and several
        // deliberately do (see public/planner-error-recipe.js on CSAM staying `unknown`).
        if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) return;
        if (NEEDLE.test(raw) && TESTING.test(raw)) {
          hits.push({ file: relative(ROOT, file), line: i + 1, text: line });
        }
      });
    }
  }
  return hits;
}

describe("GHSA-qgx2-5crw-9m4j: exactly ONE CSAM needle exists in the tree", () => {
  it("the scanner can see the real needle (positive control -- without this the count is vacuous)", () => {
    // If the needle is ever renamed or restructured out of this detector's reach, this row goes red
    // rather than the count silently becoming zero and the guard passing on an empty population.
    const hits = needleHolders();
    const inSource = hits.filter((h) => h.file === SINGLE_SOURCE);
    expect(inSource.length).toBeGreaterThan(0);
  });

  it("the detector CAN fire on a second copy (negative control on synthetic input)", () => {
    // Proves there is a reachable world in which this guard fails. A tree-scanning assertion that
    // has never been shown to reject anything is decoration.
    const synthetic = 'return s.includes("child pornography");';
    expect(NEEDLE.test(synthetic) && TESTING.test(synthetic)).toBe(true);
    // And that it does NOT fire on the allowed shape: building a message, not testing one.
    const construction = 'return { ok: false, error: "csam refusal: " + csam };';
    expect(NEEDLE.test(construction) && TESTING.test(construction)).toBe(false);
  });

  it("no file other than the single source holds a needle", () => {
    const strays = needleHolders().filter((h) => h.file !== SINGLE_SOURCE);
    // Printed, not just counted: a bare count tells the next reader nothing about what to fix.
    expect(
      strays.map((s) => `${s.file}:${s.line}  ${s.text}`),
      "a second CSAM matcher appeared. Import isCsamRefusalReason from " +
        SINGLE_SOURCE +
        " instead of reimplementing it; two copies of this rule have already drifted once " +
        "(GHSA-qgx2-5crw-9m4j).",
    ).toEqual([]);
  });

  it("the consumers that BUILD a csam message are not flagged (they hold no needle)", () => {
    // finish-blender / finish-rife / finish-upscale call the shared discriminator and then format
    // its result. Guarding against them would be a false positive that gets the guard disabled.
    const flagged = needleHolders().map((h) => h.file);
    for (const consumer of [
      "modules/finish-blender/src/index.ts",
      "modules/finish-rife/src/index.ts",
      "modules/finish-upscale/src/index.ts",
    ]) {
      expect(flagged).not.toContain(consumer);
    }
  });
});
