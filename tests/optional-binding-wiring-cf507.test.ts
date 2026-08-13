/// <reference types="node" />
// cf#507. THE DEFECT CLASS THIS CLOSES, IN ITS OWN WORDS -- .github/workflows/ci.yml says of the
// cf#489 binding: "This one was MISSED when the binding was added, and the deploy stayed GREEN while
// silently stripping the door blocks. The log line ... is the ONLY tell, and nothing asserts this
// list against the module tomls that declare the markers."
//
// That is exactly right, and cf#507 makes it worse rather than better: adding a second door per
// module took the hand-maintained population from 3 ids to 5, in TWO separate hand-maintained lists
// (the optional-var loop in fill-module-placeholders.sh, and the env block in ci.yml). A membership
// list whose right-hand side is another hand-written copy can only fail when an entry is REMOVED;
// it cannot fail in the direction that actually happens, which is the population GROWING.
//
// So the authority here is DERIVED: the `cf482-optional:<VAR>` markers that the module tomls
// themselves carry. Every consumer of that population is asserted against the derived set, and the
// derivation prints its own denominator so a zero-match reads as a harness failure rather than as
// agreement (N120/N227). ci.yml's half is irreducibly hand-maintained -- GitHub Actions cannot
// enumerate `secrets.*` dynamically -- which is precisely why it needs an assertion rather than a
// convention.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const MODULES = join(ROOT, "modules");

/** Every `cf482-optional:<VAR>` marker declared by any module toml. THE AUTHORITY. */
function declaredOptionalVars(): { vars: Set<string>; tomlsScanned: number; markerLines: number } {
  const vars = new Set<string>();
  let tomlsScanned = 0;
  let markerLines = 0;
  for (const dir of readdirSync(MODULES)) {
    const toml = join(MODULES, dir, "wrangler.toml");
    if (!existsSync(toml)) continue;
    tomlsScanned++;
    for (const line of readFileSync(toml, "utf8").split("\n")) {
      // The stripper requires the marker to be a WHOLE comment line (cf#484). Match the same shape
      // it does, so this test and strip-vpc-block.awk cannot disagree about what a marker is.
      const m = /^[ \t]*#[ \t]*cf482-optional:([A-Z0-9_]+)[ \t]*$/.exec(line);
      if (m) { vars.add(m[1]); markerLines++; }
    }
  }
  return { vars, tomlsScanned, markerLines };
}

describe("cf507: every optional VPC binding is wired end to end", () => {
  it("DENOMINATOR + POSITIVE CONTROL: the derivation actually finds markers", () => {
    const { vars, tomlsScanned, markerLines } = declaredOptionalVars();
    // Printed as assertions rather than console noise: a zero here is a broken matcher, not a
    // clean repo, and this must fail before any assertion below can mean anything.
    expect(tomlsScanned).toBeGreaterThan(0);
    expect(markerLines).toBeGreaterThan(0);
    expect(vars.size).toBeGreaterThan(0);
    // Known-answer control: cf#480's original door must be in the derived set. If this fails the
    // regex has drifted from the stripper's, and every other assertion here is vacuous.
    expect([...vars]).toContain("VPC_FINISH_UPSCALE_ID");
    // NEGATIVE control: a REQUIRED binding carries no marker and must never be derived as optional.
    expect([...vars]).not.toContain("VPC_VIDEO_FINISH_ID");
  });

  it("each marker's blocks carry a matching REPLACE_WITH_ placeholder", () => {
    const { vars } = declaredOptionalVars();
    const missing: string[] = [];
    for (const dir of readdirSync(MODULES)) {
      const toml = join(MODULES, dir, "wrangler.toml");
      if (!existsSync(toml)) continue;
      const text = readFileSync(toml, "utf8");
      for (const v of vars) {
        if (!text.includes("cf482-optional:" + v)) continue;
        if (!text.includes("REPLACE_WITH_" + v)) missing.push(`${dir}:${v}`);
      }
    }
    // A marker with no placeholder strips fine and BINDS to a literal placeholder when set --
    // the half-configured state the survivor check exists to catch.
    expect(missing).toEqual([]);
  });

  it("the stripper's optional-var loop covers every declared marker", () => {
    const { vars } = declaredOptionalVars();
    const sh = readFileSync(join(ROOT, "scripts", "fill-module-placeholders.sh"), "utf8");
    const loop = /for v in ([A-Z0-9_ ]+); do\n\s*marker="cf482-optional/.exec(sh);
    expect(loop, "could not locate the optional-var loop -- this test is stale, fix it").not.toBeNull();
    const covered = new Set(loop![1].trim().split(/\s+/));
    expect(covered.size).toBeGreaterThan(0);           // denominator
    const uncovered = [...vars].filter((v) => !covered.has(v)).sort();
    // An uncovered marker means the stripper never touches those blocks: the placeholder survives,
    // and the survivor check refuses the deploy. Loud, but only at tag time.
    expect(uncovered, "declared in a module toml but absent from fill-module-placeholders.sh").toEqual([]);
  });

  it("CI passes every declared marker through to the deploy step -- the cf#489 failure", () => {
    const { vars } = declaredOptionalVars();
    const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    const absent = [...vars].filter((v) => !new RegExp(`^\\s*${v}:\\s*\\$\\{\\{\\s*secrets\\.${v}\\s*\\}\\}`, "m").test(ci)).sort();
    // THIS is the one that would have caught cf#489. An id missing here is "" at deploy time, which
    // IS the unset state, so the door is stripped and the deploy stays GREEN. There is no other
    // tell: the strip is a log line nobody reads, and the module silently keeps its RunPod path.
    expect(absent, "declared in a module toml but never passed to the deploy step in ci.yml -- the deploy will go GREEN while silently stripping this door").toEqual([]);
  });
});
