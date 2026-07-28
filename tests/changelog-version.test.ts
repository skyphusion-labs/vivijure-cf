// package.json version vs the top CHANGELOG heading (cf#274, following cf#272).
//
// cf#272 added a tag-vs-version guard to studio-release.yml: a v* tag whose package.json version
// does not match is refused at RELEASE time. That is the last possible moment -- the mislabelled
// commit is already reviewed and merged, and the person who hits the failure is whoever cuts the
// tag, not whoever wrote the commit. It also never fires on a release that is never attempted, so
// main can carry a version that disagrees with its own CHANGELOG indefinitely and nothing says so.
//
// This is the REVIEW-time half: a unit test asserting package.json version equals the newest
// "## vX.Y.Z" heading in CHANGELOG.md. It fails on the PR that bumps one without the other, which
// is the moment a human is already looking at the diff, not the moment someone cuts a tag weeks
// later.
//
// Both drifted tags cf#272 found (v1.12.0 declaring 1.11.0, v1.10.1 declaring 1.10.0) had the same
// underlying cause: a release cut with no version-bump commit, so package.json and the CHANGELOG
// both silently lagged. v1.12.0 shipped with no CHANGELOG entry at all, which is how it stayed
// invisible until cf#272 went looking.
//
// POSITIVE CONTROL, not a hypothetical one: while building the cp#187 gate this same sprint, a
// draft assertion checked a manifest field that exists in no real artifact and passed a
// hand-written fixture while failing every genuine release. So this test proves its own detector
// fires against a planted mismatch, using the SAME parser the real check uses, rather than trusting
// that "it looks right" means it would ever go red.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..");

/** The newest "## vX.Y.Z" heading. Headings may carry a trailing " -- <date>"; only the version is
 *  read. Returns null when the changelog has no heading in that shape at all, so a broken parse is a
 *  failure rather than a silent pass against an empty string. */
export function topChangelogVersion(changelog: string): string | null {
  const m = /^##\s+v(\d+\.\d+\.\d+)\b/m.exec(changelog);
  return m ? m[1] : null;
}

describe("package.json version matches the top CHANGELOG heading (cf#274)", () => {
  it("agrees with the newest CHANGELOG entry", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
    const top = topChangelogVersion(changelog);
    expect(top, "CHANGELOG.md has no \"## vX.Y.Z\" heading to compare against").not.toBeNull();
    expect(
      pkg.version,
      `package.json declares ${pkg.version} but the top CHANGELOG heading is v${top}; bump whichever one lagged`,
    ).toBe(top);
  });

  it("CONTROL: the parser reads a planted heading, including one with a trailing date", () => {
    expect(topChangelogVersion("# Changelog\n\n## v2.4.1 -- 2026-01-01\n\nnotes\n")).toBe("2.4.1");
  });

  it("CONTROL: a planted mismatch is what this test exists to catch", () => {
    // Same predicate the real assertion runs, over a fixture instead of the real files. If the
    // detector below ever answered true here it would mean the comparison had degenerated into a
    // vacuous pass, which is exactly the shape the draft cp#187 gate went through before it was
    // caught.
    const pkgVersion = "1.11.0";
    const changelog = "# Changelog\n\n## v1.12.0\n\nnotes\n";
    expect(pkgVersion === topChangelogVersion(changelog)).toBe(false);
  });

  it("CONTROL: the real files today are the matching case, not a vacuous default", () => {
    // Guards against the assertion above passing only because topChangelogVersion silently returns
    // null (e.g. a moved file or a changed heading shape) rather than because the versions agree.
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
    expect(topChangelogVersion(changelog)).not.toBeNull();
    expect(typeof pkg.version).toBe("string");
  });
});
