/// <reference types="node" />
// fc#2250 item 2: A MISMATCHED TAG STILL DEPLOYS PROD.
//
// cf#562 made `studio-release` a JOB of ci.yml so `needs:` could gate it at all (needs: cannot
// cross workflow files). That fixed the ORDERING. It did not fix WHAT gates it, and the two
// publishing jobs ended up siblings on the same needs: array with the version check on neither:
//
//   deploy:          needs: [ci, container-tests, migrations-gate, assert-on-main]
//   studio-release:  needs: [ci, container-tests, migrations-gate, assert-on-main]
//
// The `vX.Y.Z == package.json` assert lives only INSIDE studio-release.yml, as a step. A step
// cannot gate a sibling job, so:
//
//   Scenario A: `v1.99.0` pushed on a commit whose package.json says 1.33.9 deploys the Worker,
//               applies remote D1 migrations and deploys MCP. The assert fires later, in the other
//               job, after prod has already moved.
//   Scenario B (the reverse): a FAILED deploy does not stop studio-release advancing the hosted
//               STUDIO_RELEASE pin, so every tenant provisioned afterwards is pinned to an artifact
//               whose Worker deploy failed.
//
// Both are the same root cause: the version assert is a STEP inside one publishing job instead of a
// JOB both publishing paths depend on.
//
// DERIVED, NOT LISTED, and by the same reasoning as cf#562: a job joins the population if it is
// gated on a v* tag AND carries a publish verb (its own, or its called workflow's). A publishing job
// added on a tag trigger later lands in that population and fails here until it is gated, rather
// than the assertion quietly VANISHING, which is how cf#560 stayed green over a broken path.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

const CI_PATH = ".github/workflows/ci.yml";
const CI = readFileSync(CI_PATH, "utf8");

/** The version-assert JOB every publishing path must depend on. */
const VERSION_JOB = "assert-tag-version";

const PUBLISH_VERBS = [
  "wrangler deploy",
  "wrangler versions upload",
  "wrangler d1 migrations apply",
  "gh release create",
  "gh release upload",
  "advance-studio-pin.sh",
  "wrangler r2 object put",
];

type Job = { name: string; body: string; needs: string[]; ifExpr: string; effective: string };

/** Split the top-level `jobs:` mapping into one block per job (2-space keys). */
function parseJobs(text: string): Job[] {
  const lines = text.split("\n");
  const start = lines.indexOf("jobs:");
  if (start === -1) return [];
  const jobs: Job[] = [];
  let cur: { name: string; lines: string[] } | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^[A-Za-z_]/.test(l)) break; // back to a column-0 key: jobs: is over
    const m = /^  ([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (m) {
      if (cur) jobs.push(finish(cur));
      cur = { name: m[1], lines: [] };
      continue;
    }
    if (cur) cur.lines.push(l);
  }
  if (cur) jobs.push(finish(cur));
  return jobs;

  function finish(c: { name: string; lines: string[] }): Job {
    const body = c.lines.join("\n");
    // needs: [a, b] or a block list
    let needs: string[] = [];
    const inline = /^\s*needs:\s*\[([^\]]*)\]/m.exec(body);
    if (inline) {
      needs = inline[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else {
      const blockStart = /^\s*needs:\s*$/m.exec(body);
      if (blockStart) {
        const after = body.slice(blockStart.index + blockStart[0].length).split("\n").slice(1);
        for (const ln of after) {
          const mm = /^\s*-\s*["']?([A-Za-z0-9_-]+)["']?\s*$/.exec(ln);
          if (!mm) break;
          needs.push(mm[1]);
        }
      }
    }
    const ifm = /^\s*if:\s*(.+)$/m.exec(body);
    // A job that delegates to a local workflow publishes whatever THAT file publishes.
    let effective = body;
    const usesLocal = /^\s*uses:\s*\.(\/[^\s]+\.ya?ml)/m.exec(body);
    if (usesLocal) {
      const p = "." + usesLocal[1];
      if (existsSync(p)) effective += "\n" + readFileSync(p, "utf8");
    }
    return { name: c.name, body, needs, ifExpr: ifm ? ifm[1].trim() : "", effective };
  }
}

const jobs = parseJobs(CI);
const byName = new Map(jobs.map((j) => [j.name, j]));

/** Every job reachable through needs:, so a gate satisfied one hop away still counts. */
function needsClosure(name: string, seen = new Set<string>()): Set<string> {
  const j = byName.get(name);
  if (!j) return seen;
  for (const n of j.needs) {
    if (seen.has(n)) continue;
    seen.add(n);
    needsClosure(n, seen);
  }
  return seen;
}

const tagGated = (j: Job) => /refs\/tags\/v/.test(j.ifExpr);
const publishes = (j: Job) => PUBLISH_VERBS.some((v) => j.effective.includes(v));
const publishers = jobs.filter((j) => tagGated(j) && publishes(j));

describe("fc#2250 item 2 -- a v* tag cannot publish without the version assert", () => {
  it("HARNESS FLOOR: the job table and the publisher population both parsed", () => {
    // A zero in either number means the parser broke, not that ci.yml has no publishing jobs.
    // Without this floor every assertion below passes vacuously on an empty array.
    console.log(
      `[fc2250] parsed ${jobs.length} jobs from ${CI_PATH}: ${jobs.map((j) => j.name).join(" ")}`,
    );
    console.log(
      `[fc2250] tag-gated publishers: ${publishers.length} (${publishers.map((j) => j.name).join(" ")})`,
    );
    expect(jobs.length).toBeGreaterThanOrEqual(5);
    expect(publishers.length).toBeGreaterThanOrEqual(2);
    // The two the issue names must be IN the population, or the derivation missed them and the
    // partition below is measuring something else.
    expect(publishers.map((j) => j.name)).toContain("deploy");
    expect(publishers.map((j) => j.name)).toContain("studio-release");
  });

  it(`the ${VERSION_JOB} job exists and actually compares the tag to package.json`, () => {
    const j = byName.get(VERSION_JOB);
    expect(j, `ci.yml must define a ${VERSION_JOB} job`).toBeDefined();
    // A job that exists but compares nothing is decoration, so assert the comparison itself.
    expect(j!.body).toMatch(/package\.json/);
    expect(j!.body, "must read the declared version").toMatch(/require\(.*package\.json.*\)\.version|\.version/);
    expect(j!.body, "must strip the leading v from the tag").toMatch(/#v|slice|sed/);
    expect(j!.body, "must exit non-zero on a mismatch").toMatch(/exit 1/);
    // It has to run on a tag push, or it can never gate one.
    expect(j!.ifExpr).toMatch(/refs\/tags\/v/);
    // ubuntu-latest with a real checkout: the deploy job runs in node:22-alpine whose checkout has
    // no .git, which is exactly why assert-on-main is its own job rather than a step in deploy.
    expect(j!.body).toMatch(/runs-on:\s*ubuntu-latest/);
  });

  it("EVERY tag-gated publishing job depends on the version assert (scenario A)", () => {
    const ungated = publishers.filter((j) => !needsClosure(j.name).has(VERSION_JOB));
    console.log(
      `[fc2250] gated ${publishers.length - ungated.length} of ${publishers.length} tag-gated publishers`,
    );
    expect(
      ungated.map((j) => j.name),
      `job(s) can be started by a v* tag and publish without the tag-vs-package.json assert having `
        + `passed. A step inside one publishing job cannot gate a sibling job: add ${VERSION_JOB} to `
        + `their needs:. Offending: ${ungated.map((j) => j.name).join(", ")}`,
    ).toEqual([]);
  });

  it("studio-release depends on deploy, so a failed deploy cannot advance the tenant pin (scenario B)", () => {
    // The reverse direction. studio-release publishes the artifact every hosted tenant is
    // provisioned from and advances the STUDIO_RELEASE pin. Running it after a FAILED deploy pins
    // tenants to a release whose Worker never shipped.
    const sr = byName.get("studio-release");
    expect(sr).toBeDefined();
    expect(
      needsClosure("studio-release").has("deploy"),
      "studio-release must need deploy, or a failed prod deploy still advances the hosted pin",
    ).toBe(true);
  });

  it("NO DEADLOCK: every gate a publisher needs also runs on a v* tag", () => {
    // The check to make BEFORE widening a needs: array, and the reason ci.yml already argues this
    // is safe: needs: waits forever on a job that never starts. A gate must therefore be either
    // unconditional or itself tag-gated.
    const bad: string[] = [];
    for (const p of publishers) {
      for (const n of needsClosure(p.name)) {
        const g = byName.get(n);
        if (!g) { bad.push(`${p.name} -> ${n} (no such job)`); continue; }
        if (g.ifExpr && !/refs\/tags\/v/.test(g.ifExpr)) bad.push(`${p.name} -> ${n} (if: ${g.ifExpr})`);
      }
    }
    expect(bad, `a publisher needs a job that a v* tag does not start: ${bad.join("; ")}`).toEqual([]);
  });
});
