/// <reference types="node" />
// cf#850: the core render's origin-var report, driven in BOTH directions.
//
// The issue this closes is about a check that could not distinguish two states, so a test that only
// proved the refusal would be the same defect one level up. Every case below asserts the exit status
// AND the text, because "it failed" and "it failed for the reason I think" are different claims.
//
// The two directions the lead named, and they are the whole contract:
//   - a LISTED-BUT-EMPTY var in a contradictory config must go RED;
//   - a legitimately-absent optional var must stay GREEN, reported but not failing.
// A gate that fails on the ordinary self-host case gets routed around, and a routed-around gate is
// worth less than no gate because it also costs the next author an argument.

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = "scripts/report-origin-vars.sh";
const CI = ".github/workflows/ci.yml";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** Drive the SHIPPED script, never a re-implementation of it. */
function report(tomlText: string): { status: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "vivijure-cf850-"));
  scratch.push(dir);
  const p = join(dir, "wrangler.toml");
  writeFileSync(p, tomlText);
  try {
    const out = execFileSync("sh", [SCRIPT, p], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, out };
  } catch (e: any) {
    return { status: e.status ?? 1, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

const ORIGIN = "https://door-under-test.example.invalid";

/** A rendered config, with knobs for the two things that interact. */
function rendered(opts: { videoFinish?: string; mixEmpty?: boolean; containers?: boolean }): string {
  const vf = opts.videoFinish === undefined ? ORIGIN : opts.videoFinish;
  return [
    'name = "vivijure-studio"',
    "",
    "[vars]",
    'AUTH_MODE = "token"',
    `VIDEO_FINISH_URL = "${vf}"`,
    `IMAGE_PREP_URL = "${ORIGIN}"`,
    `AUDIO_BEAT_SYNC_URL = "${ORIGIN}"`,
    `AUDIO_MIX_URL = "${opts.mixEmpty ? "" : ORIGIN}"`,
    `AUDIO_MASTER_URL = "${ORIGIN}"`,
    `FINISH_UPSCALE_DOORS = "${ORIGIN}"`,
    `FINISH_BLENDER_DOORS = "${ORIGIN}"`,
    "",
    ...(opts.containers === false ? [] : ["[[containers]]", 'class_name = "FinishContainer"', 'image = "./containers/video-finish/Dockerfile"']),
  ].join("\n") + "\n";
}

describe("cf#850 -- the report direction: green, but never silent", () => {
  it("CONTROL: a fully bound config passes, names every door, and warns about none", () => {
    const r = report(rendered({}));
    expect(r.status).toBe(0);
    // the denominator, printed rather than implied
    expect(r.out).toMatch(/7 media-door var\(s\).*: 7 bound, 0 empty/);
    expect(r.out).not.toContain("::warning::");
    expect(r.out).toContain("[[containers]] is bound and VIDEO_FINISH_URL is non-empty");
    // the positive control on the instrument: it really did look at the names
    expect(r.out).toContain("BOUND    FINISH_BLENDER_DOORS");
  });

  it("an optional door left EMPTY stays GREEN and is reported by name", () => {
    const r = report(rendered({ mixEmpty: true }));
    expect(r.status).toBe(0); // the ordinary self-host / deliberate-opt-out case must not fail
    expect(r.out).toContain("::warning::origin-vars: EMPTY    AUDIO_MIX_URL");
    expect(r.out).toMatch(/7 media-door var\(s\).*: 6 bound, 1 empty/);
  });

  it("NAMES ONLY: no origin VALUE is ever printed, on the pass path or the warn path", () => {
    for (const r of [report(rendered({})), report(rendered({ mixEmpty: true }))]) {
      expect(r.out).not.toContain(ORIGIN);
      expect(r.out).not.toContain("door-under-test");
    }
  });
});

describe("cf#850 -- the refusal direction: one contradiction, not an opinion", () => {
  it("RED: [[containers]] bound AND VIDEO_FINISH_URL empty is refused, with the reason", () => {
    const r = report(rendered({ videoFinish: "" }));
    expect(r.status).toBe(1);
    expect(r.out).toContain("binds a [[containers]] block AND renders VIDEO_FINISH_URL empty");
    // the report still runs BEFORE the refusal, so a red run is diagnosable rather than just red
    expect(r.out).toMatch(/6 bound, 1 empty/);
  });

  it("GREEN: the SAME empty var with NO [[containers]] block is an ordinary off-state", () => {
    const r = report(rendered({ videoFinish: "", containers: false }));
    expect(r.status).toBe(0);
    expect(r.out).toContain("::warning::origin-vars: EMPTY    VIDEO_FINISH_URL");
    expect(r.out).toContain("no [[containers]] block in this render");
    // THE PAIR IS THE POINT: identical var state, opposite verdicts, decided by the OTHER half of
    // the config. Without this case the refusal above would read as "empty VIDEO_FINISH_URL is
    // banned", which would be wrong about every self-host.
  });

  it("a render with NO door vars at all is could-not-measure, not a pass", () => {
    const r = report('name = "vivijure-studio"\n[vars]\nAUTH_MODE = "token"\n');
    expect(r.status).toBe(1);
    expect(r.out).toContain("found ZERO *_URL / *_DOORS lines");
  });

  it("a missing file is a failure, not a silent skip", () => {
    let status = 0;
    let out = "";
    try {
      execFileSync("sh", [SCRIPT, "no/such/rendered.toml"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e: any) {
      status = e.status ?? 1;
      out = String(e.stdout ?? "") + String(e.stderr ?? "");
    }
    expect(status).toBe(1);
    expect(out).toContain("no such file");
  });
});

describe("cf#850 -- wired to the render that uses REAL values, and to no other", () => {
  const ci = readFileSync(CI, "utf8");

  it("the deploy job's core render invokes the reporter", () => {
    const calls = ci.split("\n").filter((l) => l.includes(SCRIPT) && !l.trim().startsWith("#"));
    expect(calls.length, `expected exactly one live invocation of ${SCRIPT} in ci.yml`).toBe(1);
    // and it must sit AFTER the render it inspects, not before
    const renderAt = ci.indexOf('envsubst "$VARS" < .wrangler.hosted.toml > wrangler.toml');
    expect(renderAt).toBeGreaterThan(0);
    expect(ci.indexOf(calls[0])).toBeGreaterThan(renderAt);
  });

  it("the EMPTY-substitution renders deliberately do NOT invoke it", () => {
    // bundle-gate and container-deploy-shape render the template with EMPTY substitutions on purpose
    // (they check shape and build, credential-free), and studio-release renders with dummy ids. Every
    // one of those would hit the containers-plus-empty-VIDEO_FINISH_URL refusal and fail for a reason
    // that is not a defect. This asserts the reporter stays off those paths: it is a control that
    // would be WRONG if generalised, which is a thing worth pinning rather than leaving to memory.
    const release = readFileSync(".github/workflows/studio-release.yml", "utf8");
    expect(release).not.toContain(SCRIPT);
    // both empty-render sites still exist, so the exclusion above is about live paths and not vacuous
    const emptyRenders = ci.split("\n").filter((l) => l.includes("envsubst < .wrangler.hosted.toml"));
    expect(emptyRenders.length).toBeGreaterThanOrEqual(2);
  });
});
