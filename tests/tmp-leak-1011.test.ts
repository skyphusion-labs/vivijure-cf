// cf#1011: tests/module-binding-requirements-942.test.ts must not leave fixture dirs in TMPDIR.
//
// cf#1240 added per-test cleanup to that suite, plus an in-file check that every dir its own
// `fixture()` helper made is gone. That check can only see dirs made THROUGH the helper: a later
// case calling `mkdtempSync` directly would leak and the in-file check would still pass, because
// the dir is not in its list. This guard closes that gap from the outside. It runs the suite in a
// child vitest whose TMPDIR is a fresh directory this test owns, then asserts that no `cf942-`
// entry is left in it, however it was made. Same shape as vivijure-core#485.
//
// The child gets its OWN temp root, never the shared one. `$TMPDIR` is per-user, and several seats
// run as one unix user, so a sibling run makes `cf942-*` dirs at the same moment; a count against
// the shared TMPDIR would be flaky in both directions. This test never lists, matches or deletes
// anything it did not make: the only path it removes is the root it created.

import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SUITE = "tests/module-binding-requirements-942.test.ts";
const PREFIX = "cf942-";

const isolated = mkdtempSync(join(tmpdir(), "cf1011-leak-"));
afterAll(() => rmSync(isolated, { recursive: true, force: true }));

function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, TMPDIR: isolated };
}

interface VitestJson {
  success: boolean;
  numTotalTests: number;
  numPassedTests: number;
  testResults: { name: string }[];
}

describe("cf#1011: the 942 suite leaves no fixture dir in TMPDIR", () => {
  it("CONTROL: a child process given this TMPDIR resolves it as os.tmpdir()", () => {
    const seen = execFileSync(
      process.execPath,
      ["-e", "process.stdout.write(require('node:os').tmpdir())"],
      { env: childEnv(), encoding: "utf8" },
    );
    expect(realpathSync(seen)).toBe(realpathSync(isolated));
  });

  it("running the suite leaves no cf942- entry in its own TMPDIR", { timeout: 180_000 }, () => {
    const vitest = join(ROOT, "node_modules", "vitest", "vitest.mjs");
    // The report goes to a named file, not stdout: vitest prints a status line on stdout too.
    const reportPath = join(isolated, "report.json");
    execFileSync(
      process.execPath,
      [vitest, "run", "--reporter=json", `--outputFile=${reportPath}`, SUITE],
      { cwd: ROOT, env: childEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as VitestJson;

    // The run has to have happened, and made fixtures, for an empty directory to mean anything.
    expect(report.success).toBe(true);
    expect(report.testResults.map((r) => r.name.slice(ROOT.length + 1))).toEqual([SUITE]);
    expect(report.numPassedTests).toBe(report.numTotalTests);
    expect(report.numPassedTests).toBeGreaterThanOrEqual(10);

    const left = readdirSync(isolated).filter((name) => name.startsWith(PREFIX));
    expect(left).toEqual([]);
  });
});
