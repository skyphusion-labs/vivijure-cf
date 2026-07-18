// The release builder must RESOLVE under the runner CI actually uses: bare `node`, not tsx.
//
// WHY THIS EXISTS: the v1.3.0 tag failed here. build-studio-release.ts imported
// "../src/platform/orchestrator-vars.js", which tsx happily resolves to the .ts file, and which
// `tsc` also accepts (moduleResolution: bundler). Bare node does NOT: its type-stripping resolves
// the specifier literally, finds no .js on disk, and throws ERR_MODULE_NOT_FOUND.
//
// So three green signals all agreed the build was fine while it was broken: typecheck passed, the
// test suite passed, and a local `npx tsx` run of the builder produced a correct artifact. The
// release workflow is the ONLY place this script runs under node, and that only happens on a TAG,
// which is the worst possible moment to discover it.
//
// This closes that gap cheaply. It invokes the builder with NO arguments and asserts it gets far
// enough to complain about its own missing --bundle flag. Reaching the argument check proves the
// whole module graph resolved under node. It costs about a second and needs no wrangler bundle.
//
// It deliberately does NOT assert success: a full run needs a wrangler dry-run bundle, which belongs
// in the release workflow, not the unit suite. Module resolution is the part that was silently
// runner-dependent, so that is the part guarded here.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

function runBuilder(): { status: number; output: string } {
  try {
    const out = execFileSync("node", ["scripts/build-studio-release.ts"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output: out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("release builder resolves under bare node", () => {
  const result = runBuilder();

  it("does not fail on module resolution", () => {
    // The exact failure that broke the v1.3.0 tag.
    expect(result.output).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(result.output).not.toContain("Cannot find module");
  });

  it("reaches its own argument validation, which proves the import graph loaded", () => {
    // POSITIVE CONTROL for the assertions above: they are only meaningful if the script actually
    // ran. A script that died earlier would also contain no ERR_MODULE_NOT_FOUND.
    expect(result.output).toContain("missing --bundle");
    expect(result.status).not.toBe(0);
  });
});
