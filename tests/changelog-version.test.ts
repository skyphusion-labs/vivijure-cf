// package.json version vs the top CHANGELOG heading, and vs package-lock.json (cf#274, following
// cf#272).
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
// both silently lagged.
//
// PACKAGE-LOCK.JSON IS A THIRD COPY, and it has already drifted once undetected: cf#273 (the very
// PR that corrected this repo's package.json from 1.11.0 to 1.12.0) left package-lock.json's own
// "version" and packages[""].version fields declaring 1.11.0, because bumping package.json by hand
// does not regenerate the lock. A guard covering only package.json and the CHANGELOG would have
// stayed green through that drift, so the lock is asserted here too rather than trusted because it
// "just" mirrors package.json.
//
// POSITIVE CONTROLS, not hypothetical ones: while building the cp#187 gate this same sprint, a
// draft assertion checked a manifest field that exists in no real artifact and passed a
// hand-written fixture while failing every genuine release. So every parser here is proven against
// a planted mismatch using the SAME predicate the real check uses, rather than trusting that "it
// looks right" means it would ever go red.

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

/** The two places package-lock.json declares THIS package's own version: the top-level "version"
 *  field, and packages[""].version (the root package entry, lockfileVersion 3 shape). Returns null
 *  on anything malformed or missing rather than a partial result, so a broken parse fails the
 *  assertion instead of comparing against undefined and passing by accident. */
export function lockFileVersions(lockJson: string): { top: string; root: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(lockJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const packages = obj.packages;
  if (typeof obj.version !== "string" || typeof packages !== "object" || packages === null) return null;
  const rootEntry = (packages as Record<string, unknown>)[""];
  if (typeof rootEntry !== "object" || rootEntry === null) return null;
  const rootVersion = (rootEntry as Record<string, unknown>).version;
  if (typeof rootVersion !== "string") return null;
  return { top: obj.version, root: rootVersion };
}

describe("package.json version matches the top CHANGELOG heading (cf#274)", () => {
  it("agrees with the newest CHANGELOG entry, and the real files are not a vacuous null-equals-null pass", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
    const top = topChangelogVersion(changelog);
    expect(top, "CHANGELOG.md has no \"## vX.Y.Z\" heading to compare against").not.toBeNull();
    expect(typeof pkg.version).toBe("string");
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
});

describe("package-lock.json agrees with package.json (cf#274 review: a third copy that already drifted once)", () => {
  it("both the top-level version and packages[\"\"].version match package.json", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const lockRaw = readFileSync(join(repoRoot, "package-lock.json"), "utf8");
    const lock = lockFileVersions(lockRaw);
    expect(lock, "package-lock.json is missing or malformed at the fields this check reads").not.toBeNull();
    expect(
      lock?.top,
      `package-lock.json top-level version is ${lock?.top} but package.json declares ${pkg.version}; run npm install to refresh the lock`,
    ).toBe(pkg.version);
    expect(
      lock?.root,
      `package-lock.json packages[""].version is ${lock?.root} but package.json declares ${pkg.version}; run npm install to refresh the lock`,
    ).toBe(pkg.version);
  });

  it("CONTROL: the parser reads a planted lock file with both fields present", () => {
    const planted = JSON.stringify({
      version: "2.4.1",
      packages: { "": { version: "2.4.1" } },
    });
    expect(lockFileVersions(planted)).toEqual({ top: "2.4.1", root: "2.4.1" });
  });

  it("CONTROL: a planted mismatch on the top-level field is what this test exists to catch", () => {
    const planted = JSON.stringify({
      version: "1.11.0",
      packages: { "": { version: "1.12.0" } },
    });
    const lock = lockFileVersions(planted);
    expect(lock?.top === "1.12.0").toBe(false);
  });

  it("CONTROL: a planted mismatch on packages[\"\"].version is what this test exists to catch", () => {
    // This is the exact shape cf#273 shipped undetected: package.json and the lock top-level both
    // corrected to 1.12.0, but the root package entry left stale.
    const planted = JSON.stringify({
      version: "1.12.0",
      packages: { "": { version: "1.11.0" } },
    });
    const lock = lockFileVersions(planted);
    expect(lock?.root === "1.12.0").toBe(false);
  });

  it("CONTROL: malformed JSON and a missing root package entry both fail closed, not open", () => {
    expect(lockFileVersions("not json")).toBeNull();
    expect(lockFileVersions(JSON.stringify({ version: "1.0.0", packages: {} }))).toBeNull();
  });
});
