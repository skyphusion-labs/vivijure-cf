/// <reference types="node" />
// cf#560: the hosted studio must never bind local-gpu, on EVERY path that can render a hosted
// studio config -- not on the paths someone remembered.
//
// WHY THIS FILE EXISTS, and it is not "the strip needs a test". The strip already had one gate,
// inline in ci.yml, correct and passing, and cf#560 recurred anyway: studio-release.yml rendered
// the same wrangler.toml.example with a bare envsubst, zero occurrences of local-gpu in the whole
// file, and published the artifact every hosted tenant is provisioned from. A green refusing gate
// on one path read as coverage of the invariant. A gate that passes because it matched nothing is
// not evidence, and a gate that was never asked is not evidence either.
//
// ci.yml's own comment at the site of the FIRST fix says "The control existed and was on the wrong
// path". The fix then reproduced that shape one path over. So the thing under test here is not the
// strip's arithmetic, it is the CLAIM THAT EVERY HOSTED RENDER PATH CALLS IT -- and the population
// of hosted render paths is DERIVED from the workflows rather than listed here, because a
// hand-maintained list of paths is exactly the artifact whose drift caused this issue twice.
//
// LIMIT, stated here rather than discovered later (the derivation is a matcher and matchers have
// coverage boundaries): the population is derived from workflow files that name
// `wrangler.toml.example` AND render it. A future path that renders a hosted config by some other
// mechanism -- a new script invoked from a workflow, a composite action, a provisioner in another
// repo -- is outside what this file can see. It covers the two shapes that exist and it refuses if
// the derivation returns nothing, which is the failure mode that would otherwise read as a pass.

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = "scripts/strip-local-gpu.sh";
const TEMPLATE = "wrangler.toml.example";
const WORKFLOW_DIR = ".github/workflows";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function scratchDir(): string {
  const d = mkdtempSync(join(tmpdir(), "vivijure-cf560-"));
  scratch.push(d);
  return d;
}

/** Drive the SHIPPED script, never a re-implementation of it. */
function strip(inputText: string): { status: number; stderr: string; stdout: string; out: string } {
  const dir = scratchDir();
  const inPath = join(dir, "in.toml");
  const outPath = join(dir, "out.toml");
  writeFileSync(inPath, inputText);
  try {
    const stdout = execFileSync("sh", [SCRIPT, inPath, outPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "", out: readFileSync(outPath, "utf8") };
  } catch (e: any) {
    let out = "";
    try {
      out = readFileSync(outPath, "utf8");
    } catch {
      /* the script may refuse before writing anything; absence is a valid observation here */
    }
    return {
      status: e.status ?? 1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
      out,
    };
  }
}

const template = readFileSync(TEMPLATE, "utf8");

/**
 * DERIVED, never a second hand-maintained copy of the path list. A membership guard whose
 * right-hand side is a copy of its left-hand side can only fail when a member is REMOVED, which is
 * not the direction that happens: the direction that happens is a path being ADDED without the
 * strip, which is cf#560 itself.
 */
function hostedRenderWorkflows(): { name: string; text: string }[] {
  const all = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const hits: { name: string; text: string }[] = [];
  for (const name of all) {
    const text = readFileSync(join(WORKFLOW_DIR, name), "utf8");
    // UNION, NOT INTERSECTION, and the mutation proof is why. The first version required a
    // workflow to NAME wrangler.toml.example AND render. Reconstructing the original defect --
    // deleting the strip from studio-release.yml -- also removed that file's only mention of the
    // template, because the envsubst then reads a pre-stripped intermediate. So the path dropped
    // OUT of the population and its assertion did not go red, it CEASED TO EXIST: 13 tests became
    // 12 and the run was green. An assertion that can vanish is worse than one that can be wrong.
    // Selecting on EITHER signal means a path cannot leave the population by changing which file
    // it names; it has to stop producing a wrangler config altogether.
    const namesTemplate = text.includes(TEMPLATE);
    const writesWranglerToml = />\s*wrangler\.toml\b/.test(text);
    if (namesTemplate || writesWranglerToml) hits.push({ name, text });
  }
  return hits;
}

/**
 * A MENTION IS NOT A CALLER. `text.includes(SCRIPT)` was the first version and the mutation proof
 * killed it: the explanatory comment this fix added to ci.yml names the script by path, so deleting
 * the actual invocation left the substring behind and the assertion stayed green over a workflow
 * that no longer strips anything. Anchor on a line that RUNS it.
 */
function invokesStrip(text: string): boolean {
  // NO REGEX BUILT FROM A STRING. The first version escaped `.` in SCRIPT and not `\`, which CodeQL
  // correctly flagged as an incomplete sanitizer (js/incomplete-sanitization). It was inert only
  // because SCRIPT happens to be a constant with no backslashes in it, and "inert because of a
  // property of today's input" is not a property anything pins. A line-prefix test needs no
  // escaping at all, so the whole class is unreachable by construction rather than by a correct
  // escape routine -- and a property held by absence of a mechanism cannot regress.
  return text.split("\n").some((line) => line.trim().startsWith(`sh ${SCRIPT} `));
}

describe("cf#560 -- the LOCAL-GPU strip, and the claim that every hosted render path calls it", () => {
  // ---------------------------------------------------------------------------------------------
  // THE CONTROL RUNS FIRST. Every refusal below is uninterpretable unless the instrument has been
  // shown producing the PASSING answer against the real subject.
  // ---------------------------------------------------------------------------------------------
  it("CONTROL: the committed template strips clean, removing exactly one MODULE_ line", () => {
    const before = (template.match(/MODULE_/g) ?? []).length;
    expect(before).toBeGreaterThan(1); // a studio template with one MODULE_ line is not one

    const r = strip(template);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("delta 1, as required");
    expect(r.out).not.toContain("MODULE_LOCAL_GPU");

    const after = (r.out.match(/MODULE_/g) ?? []).length;
    expect(before - after).toBe(1);
    // The output must still be a config, not a stub. Truncation is the failure mode the delta
    // exists to catch, and this is its cheap independent restatement.
    expect(r.out.length).toBeGreaterThan(template.length * 0.8);
  });

  it("the committed template carries exactly one well-formed LOCAL-GPU marker pair", () => {
    // The strip's delta==1 contract is a claim about the TEMPLATE, not only about the awk. If a
    // second binding is ever added inside the markers the delta becomes 2 and every hosted render
    // refuses -- at deploy time, on a tag, which is the worst moment to find out. Fail here instead.
    const open = (template.match(/^# >>> LOCAL-GPU:/gm) ?? []).length;
    const close = (template.match(/^# <<< LOCAL-GPU:/gm) ?? []).length;
    expect(open).toBe(1);
    expect(close).toBe(1);

    const block = /^# >>> LOCAL-GPU:[\s\S]*?^# <<< LOCAL-GPU:/m.exec(template)?.[0] ?? "";
    expect(block).not.toBe("");
    expect((block.match(/MODULE_/g) ?? []).length).toBe(1);
    expect(block).toContain("MODULE_LOCAL_GPU");
  });

  // ---------------------------------------------------------------------------------------------
  // REFUSALS, each asserted on its NAMED diagnostic rather than on the exit code. A control that
  // has stopped testing anything still exits 1; only the specific string it can no longer produce
  // catches that.
  // ---------------------------------------------------------------------------------------------
  it("REFUSES silent truncation: a removed CLOSING marker eats the file and absence alone passes", () => {
    // This is the load-bearing case. `skip` is set on the opening marker and cleared only on the
    // closing one, so removing the closing marker skips to EOF. MODULE_LOCAL_GPU really is gone, so
    // an absence-only guard reports success on a config missing most of its bindings.
    const mutated = template.replace(/^# <<< LOCAL-GPU:.*$/m, "");
    expect(mutated).not.toBe(template); // the mutation must LAND before the result means anything

    const r = strip(mutated);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("expected exactly 1");
    // ...and it must NOT fire the absence diagnostic, which would send a reader to the wrong file.
    expect(r.stderr).not.toContain("survived the strip");
    // The absence check really would have passed here: that is why the delta exists.
    expect(r.out).not.toContain("MODULE_LOCAL_GPU");
  });

  it("REFUSES a vacuous strip: a renamed OPENING marker copies the block straight through", () => {
    const mutated = template.replace(/^# >>> LOCAL-GPU:/m, "# >>> LOCALGPU:");
    expect(mutated).not.toBe(template);

    const r = strip(mutated);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("survived the strip");
  });

  it("REFUSES a file that cannot be a studio config (zero MODULE_ lines)", () => {
    // Every other check passes vacuously on this input: absence is satisfied and the delta is
    // merely wrong. An answer that is fixed under all hypotheses identifies the harness.
    const mutated = template
      .split("\n")
      .filter((l) => !l.includes("MODULE_"))
      .join("\n");
    expect(mutated).not.toBe(template);

    const r = strip(mutated);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("ZERO MODULE_ lines");
  });

  it("REFUSES an empty input rather than reporting a clean strip", () => {
    const r = strip("");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("EMPTY");
  });

  it("REFUSES an unreadable input, distinctly from an empty one", () => {
    const dir = scratchDir();
    let status = 0;
    let stderr = "";
    try {
      execFileSync("sh", [SCRIPT, join(dir, "nope.toml"), join(dir, "out.toml")], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e: any) {
      status = e.status ?? 1;
      stderr = String(e.stderr ?? "");
    }
    expect(status).not.toBe(0);
    expect(stderr).toContain("cannot read");
  });

  // ---------------------------------------------------------------------------------------------
  // THE ACTUAL cf#560 FIX: the population, derived, with its denominator asserted.
  // ---------------------------------------------------------------------------------------------
  describe("every DERIVED hosted render path invokes the shared strip", () => {
    const paths = hostedRenderWorkflows();

    it("the derivation finds a non-empty population (a zero here is a harness failure, not a pass)", () => {
      // Without this floor, a broken derivation returns [] and the per-path assertions below
      // vacuously pass, reporting full coverage of nothing.
      expect(paths.length).toBeGreaterThan(0);
      // Both known hosted render paths must be in it. This is a positive control on the
      // derivation, not the derivation itself: it proves the matcher can see what it must see.
      const names = paths.map((p) => p.name);
      expect(names).toContain("ci.yml");
      expect(names).toContain("studio-release.yml");
    });

    it("NEGATIVE CONTROL: the derivation excludes workflows that render nothing", () => {
      // A matcher that selects everything has failed as completely as one selecting nothing, and
      // the loose case is caught less often because a large result looks like coverage.
      const all = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
      expect(all.length).toBeGreaterThan(paths.length);
      expect(paths.map((p) => p.name)).not.toContain("codeql.yml");
    });

    for (const { name, text } of paths) {
      it(`${name} calls ${SCRIPT}`, () => {
        expect(invokesStrip(text)).toBe(true);
      });
    }

    it("NEGATIVE CONTROL: the caller matcher rejects a mere mention of the script", () => {
      // The matcher that produced a false green must be shown refusing the input that fooled it,
      // or the fix rests on the author's belief about what they changed.
      expect(invokesStrip(`          # the strip lives in ${SCRIPT}, not here\n`)).toBe(false);
      expect(invokesStrip(`          sh ${SCRIPT} a.toml b.toml\n`)).toBe(true);
    });

    it("the strip is not duplicated back inline in any workflow", () => {
      // Two copies is how the second path came to have none. If the awk reappears in a workflow,
      // the single definition has been forked again and this issue is queued to recur.
      for (const { name, text } of paths) {
        expect(text, `${name} carries an inline copy of the strip`).not.toContain(
          "/^# >>> LOCAL-GPU:/ { skip=1; next }",
        );
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  // The self-host path is deliberately NOT in the population, and saying so is part of the fix:
  // an omission and a considered exclusion must not look the same.
  // ---------------------------------------------------------------------------------------------
  it("deploy.sh keeps its own INSTALL_LOCAL_GPU switch and is deliberately excluded", () => {
    const sh = readFileSync("deploy.sh", "utf8");
    expect(sh).toContain("INSTALL_LOCAL_GPU");
    // Self-host is where this door is ALLOWED. Bolting the unconditional hosted strip onto it would
    // remove a door its operator is entitled to run, so it must NOT call the hosted-only script.
    expect(sh).not.toContain(SCRIPT);
  });
});

// ------------------------------------------------------------------------------------------------
// cf#560 ROUND THREE: the strip being CALLED is not the strip's output being DEPLOYED.
//
// The block above asserts that every derived hosted render path carries a line which RUNS
// scripts/strip-local-gpu.sh. Driven on 2026-08-16, that is not sufficient, and the gap is one line
// wide. Leave ci.yml's strip invocation exactly where it is and revert only the NEXT line, so the
// render reads the TEMPLATE again instead of the stripped intermediate:
//
//   sh scripts/strip-local-gpu.sh wrangler.toml.example .wrangler.hosted.toml   <- untouched
//   envsubst ... < wrangler.toml.example > wrangler.toml                        <- reverted
//
// The strip still runs, still exits 0, still prints "delta 1, as required", and writes its output to
// an intermediate that nothing then reads. local-gpu ships to the hosted studio and THIS SUITE
// REPORTED 14/14 GREEN. That is this file's own lesson moved up exactly one level: it already knew a
// MENTION IS NOT A CALLER, and the same shape survived one rung higher, because A CALLER IS NOT A
// CONSUMER. The guard could not go red on the defect it exists for.
//
// So assert the DATA PATH rather than the invocation: the file the strip WRITES must be the file the
// render READS.
// ------------------------------------------------------------------------------------------------
describe("cf#560 -- the strip OUTPUT is what gets rendered, not merely that the strip ran", () => {
  /** Per workflow: every strip invocation OUT argument must feed the rendered wrangler.toml. */
  function stripDataPath(text: string): { calls: number; consumed: number } {
    const lines = text.split("\n");
    let calls = 0;
    let consumed = 0;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t.startsWith("sh " + SCRIPT + " ")) continue;
      calls++;
      const out = t.split(/\s+/)[3];
      if (!out) continue;
      const feeds = lines
        .slice(i + 1)
        .some((l) => l.includes("< " + out) && />\s*wrangler\.toml\b/.test(l));
      if (feeds) consumed++;
    }
    return { calls, consumed };
  }

  it("NEGATIVE CONTROL: the matcher refuses the exact reversion that kept this suite green", () => {
    // The mutation is applied to the REAL ci.yml rather than to a hand-written fixture, so the
    // control cannot drift away from the file it is a control for.
    const ci = readFileSync(join(WORKFLOW_DIR, "ci.yml"), "utf8");
    const real = stripDataPath(ci);
    expect(real.calls).toBeGreaterThan(0);
    expect(real.consumed).toBe(real.calls);

    const reverted = ci.replace(
      "< .wrangler.hosted.toml > wrangler.toml",
      "< wrangler.toml.example > wrangler.toml",
    );
    expect(reverted).not.toBe(ci); // the mutation must LAND before the result means anything
    const broken = stripDataPath(reverted);
    // The strip is still INVOKED exactly as often -- that is the point. Only the data path breaks.
    expect(broken.calls).toBe(real.calls);
    expect(broken.consumed).toBe(0);
    expect(invokesStrip(reverted)).toBe(true);
  });

  for (const { name, text } of hostedRenderWorkflows()) {
    it(name + ": every strip invocation output feeds the rendered wrangler.toml", () => {
      const { calls, consumed } = stripDataPath(text);
      expect(calls).toBeGreaterThan(0); // a zero would make the next line vacuously true
      expect(consumed).toBe(calls);
    });
  }
});

// ------------------------------------------------------------------------------------------------
// THE HOSTED PATHS THAT RENDER NO CONFIG AT ALL.
//
// The population derived above answers "which paths render wrangler.toml.example", which is a
// NARROWER question than the invariant. The invariant is about HOSTED STUDIOS. Two hosted paths
// carry a local-gpu control that nothing asserted, and neither renders the template, so neither can
// ever appear in that derivation:
//
//   * ci.yml exports EXCLUDE="... local-gpu" before scripts/deploy-module-workers.sh, which deploys
//     every modules/*/wrangler.toml to OUR account. Delete that export and no test noticed.
//   * scripts/tenant-release-modules.txt drives the tenant module bundles studio-release.yml
//     publishes. Add local-gpu to that file and no test noticed.
//
// An uncovered path that reads as covered because a NEIGHBOURING path is covered is the entire
// cf#560 shape. Named and asserted here rather than left to be rediscovered a fourth time.
// ------------------------------------------------------------------------------------------------
describe("cf#560 -- hosted paths that render no config still exclude local-gpu", () => {
  const ci = readFileSync(join(WORKFLOW_DIR, "ci.yml"), "utf8");

  it("ci.yml excludes local-gpu BEFORE it invokes the module-worker deployer", () => {
    const lines = ci.split("\n");
    const at = lines.findIndex((l) => l.trim().startsWith("scripts/deploy-module-workers.sh"));
    // FLOOR: if the deployer is no longer invoked, the ordering assertion below proves nothing.
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(0, at).join("\n")).toMatch(/^\s*export EXCLUDE=.*local-gpu/m);
  });

  it("...and the deployer HONOURS EXCLUDE (an export nothing reads is decoration)", () => {
    // Half a control is not a control: the caller setting a variable and the callee acting on it
    // are two independent facts, and asserting only the first is how a gate stops being one.
    const sh = readFileSync("scripts/deploy-module-workers.sh", "utf8");
    expect(sh).toContain("EXCLUDE=");
    expect(sh).toContain("for ex in $EXCLUDE");
  });

  it("the tenant release module list does not publish local-gpu", () => {
    const names = readFileSync("scripts/tenant-release-modules.txt", "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));
    // FLOOR + POSITIVE CONTROL. An empty list satisfies the absence below for the wrong reason, and
    // a matcher that can find nothing cannot prove that local-gpu in particular is missing.
    expect(names.length).toBeGreaterThan(1);
    expect(names).toContain("keyframe");
    expect(names).not.toContain("local-gpu");
    expect(names).not.toContain("i2v-local-gpu");
  });
});
