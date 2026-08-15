/// <reference types="node" />
// cf#562: a v* tag must not be able to publish anything the tag's own gates have not passed.
//
// WHY THIS FILE EXISTS. cf#559 widened the deploy job's needs: to [ci, container-tests,
// migrations-gate, assert-on-main], so a tag can no longer deploy the studio Worker with a gate red.
// studio-release.yml then fired on the SAME v* tag from a SEPARATE workflow file, and needs: cannot
// cross workflow files -- there is no mechanism for it. So the workflow that publishes the artifact
// every hosted tenant is provisioned from, and that advances the hosted STUDIO_RELEASE pin, ran in
// PARALLEL with the gates meant to guard it. Observed on the v1.27.0 tag: both in_progress at once.
//
// The fix is structural rather than asserted -- the release is now a JOB of the gate-owning
// workflow -- so the thing this file tests is NOT the ordering (needs: enforces that, or the run
// does not start). It tests the PROPERTY THAT MAKES THE ORDERING REACHABLE: that no workflow other
// than the gate owner can be started by a v* tag or publish on its own trigger. That property is
// what a future workflow file silently breaks, and nothing else in the repo would report it.
//
// DERIVED, NOT LISTED, and by UNION rather than intersection. A workflow joins the population if it
// is tag-triggered OR carries a publish verb. Intersection would let a path leave its own
// population by changing one attribute -- the assertion would then VANISH rather than fail, which
// is how cf#560 stayed green over a broken path (13 tests became 12 and the run was green).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW_DIR = ".github/workflows";

type Wf = { name: string; text: string };

function allWorkflows(): Wf[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((name) => ({ name, text: readFileSync(join(WORKFLOW_DIR, name), "utf8") }));
}

/** The on: block -- from a line that is exactly "on:" to the next column-0 key. */
function onBlock(text: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf("on:");
  if (start === -1) return "";
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z_]/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

/** Declares any trigger of its own, i.e. anything other than workflow_call. */
function hasOwnTrigger(text: string): boolean {
  return onBlock(text)
    .split("\n")
    .filter((l) => /^  [a-z_]+:/.test(l))
    .some((l) => l.trim() !== "workflow_call:");
}

function tagTriggered(text: string): boolean {
  const b = onBlock(text);
  return /tags:\s*\[[^\]]*v\*/.test(b) || /tags:[^:]*\n\s*-\s*"?v\*/.test(b);
}

// Deliberately loose, and being in the population is not itself a finding: the assertion below is
// about TRIGGERS, so a false positive costs nothing and a false negative is the whole defect.
const PUBLISH_VERBS = [
  "gh release upload",
  "gh release create",
  "advance-studio-pin.sh",
  "wrangler r2 object put",
  "wrangler deploy",
  "wrangler versions upload",
];
function publishes(text: string): boolean {
  return PUBLISH_VERBS.some((v) => text.includes(v));
}

/** Non-comment lines only: prose in this repo quotes needs: arrays verbatim. */
function jobBlock(text: string, job: string): string {
  const lines = text.split("\n").filter((l) => !l.trim().startsWith("#"));
  const start = lines.findIndex((l) => l === "  " + job + ":");
  if (start === -1) return "";
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [a-z][a-z0-9_-]*:/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

function needsOf(text: string, job: string): string[] {
  const m = /needs:\s*\[([^\]]*)\]/.exec(jobBlock(text, job));
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
}

const all = allWorkflows();

// The gate owner is DERIVED: the workflow that defines the migrations-gate job. Naming ci.yml here
// would make the assertion a copy of its own subject.
const owners = all.filter((w) => /^  migrations-gate:/m.test(w.text));
const population = all.filter((w) => tagTriggered(w.text) || publishes(w.text));

describe("cf#562 -- a v* tag can start nothing that its own gates do not gate", () => {
  it("FLOOR: exactly one workflow owns the gates (zero or many makes every check below vacuous)", () => {
    expect(owners.map((w) => w.name)).toHaveLength(1);
  });

  it("FLOOR + POSITIVE CONTROL: the population is non-empty and contains both known members", () => {
    expect(population.length).toBeGreaterThan(0);
    const names = population.map((w) => w.name);
    expect(names).toContain("ci.yml");
    expect(names).toContain("studio-release.yml");
  });

  it("NEGATIVE CONTROL: the derivation does not select every workflow", () => {
    expect(all.length).toBeGreaterThan(population.length);
    expect(population.map((w) => w.name)).not.toContain("codeql.yml");
  });

  it("NEGATIVE CONTROL: the trigger matchers refuse the inputs they must refuse", () => {
    expect(hasOwnTrigger("on:\n  workflow_call:\n")).toBe(false);
    expect(hasOwnTrigger("on:\n  push:\n    tags: [v*]\n")).toBe(true);
    expect(tagTriggered("on:\n  push:\n    tags: [v*]\n")).toBe(true);
    expect(tagTriggered("on:\n  push:\n    branches: [main]\n")).toBe(false);
  });

  // THE ASSERTION. Everything above exists so that a failure here means what it says.
  for (const wf of population) {
    it(wf.name + " is the gate owner, or has no trigger of its own", () => {
      const isOwner = owners.some((o) => o.name === wf.name);
      expect(isOwner || !hasOwnTrigger(wf.text)).toBe(true);
    });
  }

  it("no workflow other than the gate owner declares a v* tag trigger", () => {
    const offenders = all
      .filter((w) => tagTriggered(w.text))
      .map((w) => w.name)
      .filter((n) => !owners.some((o) => o.name === n));
    expect(offenders).toEqual([]);
  });

  // ---------------------------------------------------------------------------------------------
  // The release job must be gated at least as hard as the deploy job. DERIVED from deploy's own
  // needs: array rather than restating the four names, so widening cf#559's gate set drags this
  // with it instead of leaving a second list to drift.
  // ---------------------------------------------------------------------------------------------
  it("the release job needs everything the deploy job needs", () => {
    const owner = owners[0];
    const deployNeeds = needsOf(owner.text, "deploy");
    const releaseNeeds = needsOf(owner.text, "studio-release");
    expect(deployNeeds.length).toBeGreaterThan(0); // a zero here would make the next line vacuous
    for (const n of deployNeeds) expect(releaseNeeds).toContain(n);
  });

  it("every job the release job needs is a real job in the same workflow", () => {
    const owner = owners[0];
    const releaseNeeds = needsOf(owner.text, "studio-release");
    expect(releaseNeeds.length).toBeGreaterThan(0);
    for (const n of releaseNeeds) {
      expect(new RegExp("^  " + n + ":", "m").test(owner.text)).toBe(true);
    }
  });

  it("the release job calls the release workflow, and that file is workflow_call-only", () => {
    const owner = owners[0];
    const block = jobBlock(owner.text, "studio-release");
    const m = /uses:\s*(\.\/\S+)/.exec(block);
    expect(m, "the studio-release job must call a local reusable workflow").not.toBeNull();
    const called = (m as RegExpExecArray)[1].replace(/^\.\//, "");
    expect(existsSync(called)).toBe(true);
    expect(hasOwnTrigger(readFileSync(called, "utf8"))).toBe(false);
  });

  it("the release job runs only on a v* tag, like the deploy job", () => {
    const owner = owners[0];
    expect(jobBlock(owner.text, "studio-release")).toContain("refs/tags/v");
  });
});
