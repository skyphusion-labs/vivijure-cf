/// <reference types="node" />
// cf#586: the two SELF-HOST installers disagree on whether the local-gpu door is installed by
// default, and until this file nothing made them say so.
//
// THIS FILE DOES NOT ASSERT WHICH DEFAULT IS RIGHT. That is a product ruling and it is open. What it
// does is convert an UNOWNED DIVERGENCE INTO A COUNTABLE ONE: the current behaviour of both
// installers is pinned in both directions, so neither can move quietly and the ruling arrives at a
// gate rather than as a surprise on an operator install. Do not guess the value; make the silence
// fail.
//
// NOT the cf#560 question. local-gpu is ALLOWED on self-host; cf#560 is the HOSTED bright line. The
// only thing at issue here is the DEFAULT, and that the two installers answer it differently.
//
// WHEN THE RULING LANDS THIS FILE GOES RED, whichever way it goes. That is intended: updating it is
// the deliberate act that closes cf#586. A pin that silently kept passing through the fix would be
// the same defect one level up.
//
// PROVENANCE. An earlier report of mine called this a DANGLING binding. It is not: the same installer
// that keeps the core binding also DEPLOYS the module, and LOCAL_BACKEND_URL / LOCAL_BACKEND_TOKEN
// seed as a marked placeholder precisely so the deploy resolves instead of failing CF 10182. A
// dangling binding would have failed loudly at wrangler deploy; this fails at render time, after
// reporting itself available. The quieter mode is why it is worth pinning.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

const SH = "deploy.sh";
const PY = "deploy/vivijure_deploy.py";
const SWITCH = "INSTALL_LOCAL_GPU";
const PLACEHOLDER = "REPLACE_ME";

const sh = readFileSync(SH, "utf8");
const py = readFileSync(PY, "utf8");

/** Lines that are not wholly a comment. A MENTION IS NOT A CALLER, and both files prove it below. */
function code(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

/**
 * The line carrying a needle, plus the N lines before it (a guard is often one line up).
 *
 * COMMENTS ARE STRIPPED FIRST, and that is not tidiness. Written as plain text.split(), this helper
 * reported a guard PRESENT when only the PROSE above the guard still named the switch. Driven:
 * mutation M4 replaced the real if-guard on the secret-seeding branch with an unconditional one, and
 * all six tests stayed GREEN, because deploy.sh has a comment four lines up reading "validated up top
 * when INSTALL_LOCAL_GPU=1".
 *
 * A MENTION IS NOT A CALLER -- which is exactly what the ci.yml control below asserts, and this
 * helper broke it two functions above that assertion. Writing a rule down does not apply it. It was
 * caught by driving the mutation, not by re-reading the helper, and it is the same shape as cf#560
 * (a control that could not go red on a partial ungating) landing inside the test written to pin it.
 */
function withGuard(text: string, needle: string, back = 5): string {
  const lines = code(text).split("\n");
  const i = lines.findIndex((l) => l.includes(needle));
  if (i === -1) return "";
  return lines.slice(Math.max(0, i - back), i + 1).join("\n");
}

describe("cf#586 -- the self-host installers local-gpu default, pinned in both directions", () => {
  it("FLOOR: both installers exist and both still install a studio", () => {
    // Every assertion below is a statement about a file that still does this job. If either stops
    // being an installer, the pins are describing something else and must not quietly pass.
    expect(existsSync(SH)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(sh).toContain("wrangler.toml.example");
    expect(py).toContain("wrangler.toml.example");
    expect(py).toContain("def module_dirs");
  });

  it("NEGATIVE CONTROL: ci.yml only MENTIONS the switch in prose; deploy.sh ACTS on it", () => {
    // The hosted workflow names INSTALL_LOCAL_GPU twice, both times in comments explaining that
    // self-host owns the switch. Without this control that mention reads as a counterexample to the
    // whole file. It is the same distinction the cf#560 suite had to learn: a mention is not a
    // caller, so the matcher must be shown separating the two.
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toContain(SWITCH); // positive control: the matcher CAN see it
    expect(code(ci)).not.toContain(SWITCH); // ...and it is prose only
    expect(code(sh)).toContain(SWITCH); // ...while deploy.sh acts on it in executable lines
  });

  // ---------------------------------------------------------------------------------------------
  // deploy.sh: ONE switch governs all THREE actions. Gating one and forgetting another is the shape
  // that produced cf#560, so each is asserted separately rather than inferred from the switch count.
  // ---------------------------------------------------------------------------------------------
  it("deploy.sh gates the module deploy, the core binding AND the secret seeding on " + SWITCH, () => {
    expect(withGuard(sh, "MODULES local-gpu", 0)).toContain(SWITCH);
    expect(withGuard(sh, "KEEP_LGPU=1", 0)).toContain(SWITCH);
    expect(withGuard(sh, "seed_secret LOCAL_BACKEND_URL")).toContain(SWITCH);
  });

  // ---------------------------------------------------------------------------------------------
  // vivijure_deploy.py: NO switch. Pinned as CURRENT STATE, explicitly not as correct.
  // ---------------------------------------------------------------------------------------------
  it("PINNED DIVERGENCE (cf#586 OPEN): vivijure_deploy.py has no switch and no marker handling", () => {
    expect(py).not.toContain(SWITCH);
    expect(py).not.toContain("LOCAL-GPU"); // render_core_toml strips other markers, not this one
    // "No switch" means ALWAYS INSTALLED, not never installed, and the two read identically in a
    // grep while meaning opposite things. So assert the mechanism that decides which: an
    // unfiltered enumeration of every module directory.
    expect(py).toContain("def module_dirs");
    expect(withGuard(py, "def module_dirs", 0) + code(py)).not.toMatch(/module_dirs[^)]*exclude/i);
    // ...and the placeholder that makes the resulting deploy SUCCEED rather than fail loudly.
    expect(py).toContain("REPLACE_ME__vivijure-deploy-operator-secret");
  });

  it("DENOMINATOR: 1 of 2 self-host installers gates the door on a named switch", () => {
    const installers = [
      { name: SH, text: sh },
      { name: PY, text: py },
    ];
    expect(installers).toHaveLength(2); // the denominator, stated rather than implied
    const gated = installers.filter((i) => code(i.text).includes(SWITCH)).map((i) => i.name);
    // The moment this becomes 2 of 2, or 0 of 2, this line reports it. Either is the ruling landing.
    expect(gated).toEqual([SH]);
  });

  // ---------------------------------------------------------------------------------------------
  // WHY THE OPERATOR NOTICES. Established by CONTRAST, because an absence on its own is not a
  // measurement: an empty grep over modules/local-gpu/src looks identical to a clean one until the
  // same matcher is shown FINDING the thing in a door that has it.
  // ---------------------------------------------------------------------------------------------
  it("CONTRAST: image-generate treats the operator placeholder as absent, local-gpu does not", () => {
    const ig = readFileSync("modules/image-generate/src/index.ts", "utf8");
    const lg = readFileSync("modules/local-gpu/src/index.ts", "utf8");
    expect(ig).toContain(PLACEHOLDER); // POSITIVE CONTROL, and it runs first for a reason
    expect(lg).not.toContain(PLACEHOLDER);
    // local-gpu does bind the secrets, so the placeholder reaches it as a live value rather than
    // being unread. That is what turns the divergence into a door advertised as available.
    expect(lg).toContain("LOCAL_BACKEND_URL");
  });
});
