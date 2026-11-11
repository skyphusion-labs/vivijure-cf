/// <reference types="node" />
// cf#840 part 2 -- an unset OPTIONAL door must be DISTINGUISHABLE from a bound one by reading the
// deploy log.
//
// WHAT IS AND IS NOT THE DEFECT. cf#489's failure mode is real and still live in shape: an id
// missing from the ci.yml env block leaves the door var empty, the door is not bound, and the
// deploy stays GREEN. But a HARD FAIL on an unset optional id would be the wrong fix -- optional
// means optional, unset is the NORMAL state and the state every self-host ships in, so refusing it
// breaks the ordinary path to catch a typo. The gap is not a missing failure, it is a missing
// REPORT: a deliberate opt-out and a forgotten variable produce a byte-identical rendered toml, so
// the difference is knowable only in the filling script, before substitution.
//
// SO THIS GUARD ASSERTS THE REPORT, AND ASSERTS IT ON THE EXECUTED PATH. A `run:` block or a
// script line is printed into a GitHub log whether or not its branch ran, so reading the source
// tells you what COULD be emitted and only running it tells you what IS. Every case here drives
// the SHIPPED scripts/fill-module-placeholders.sh -- the same script deploy-module-workers.sh
// invokes per module in the tag deploy -- and asserts on its real stdout.
//
// The un-stubbable seam: the last case uses the REAL modules/finish-upscale/wrangler.toml rather
// than a fixture, so the report cannot keep passing against a synthetic toml while the shipped one
// stops declaring its door var. A stub encodes this file's assumption; the shipped toml does not.

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, copyFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const SCRIPT = "scripts/fill-module-placeholders.sh";
const REAL_TOML = join(ROOT, "modules/finish-upscale/wrangler.toml");

// The script edits IN PLACE, so every case needs its own copy; tracked and removed rather than
// left behind (cf#482's suite leaked 234 directories before a close-out sweep found them).
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const REQ = { SECRETS_STORE_ID: "store_cf840", D1_DATABASE_ID: "d1_cf840" };

/** Drive the SHIPPED script. `unset` names vars that must NOT be in the child env at all. */
function run(toml: string | { copyReal: true }, env: Record<string, string>, unset: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "vivijure-cf840-"));
  scratch.push(dir);
  const path = join(dir, "wrangler.toml");
  if (typeof toml === "string") writeFileSync(path, toml);
  else copyFileSync(REAL_TOML, path);

  const childEnv: Record<string, string | undefined> = { ...process.env, ...REQ, ...env };
  for (const k of unset) delete childEnv[k];
  try {
    const out = execFileSync("sh", [SCRIPT, path], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: childEnv as NodeJS.ProcessEnv,
    });
    return { status: 0, out, text: readFileSync(path, "utf8") };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}`, text: readFileSync(path, "utf8") };
  }
}

const ONE_DOOR = `name = "vivijure-module-probe"

[vars]
FINISH_UPSCALE_DOORS = "\${FINISH_UPSCALE_DOORS}"
`;

const NO_DOOR = `name = "vivijure-module-probe"

[vars]
RUNPOD_WORKERS_MAX = "2"
`;

const COMMENTED_DOOR = `name = "vivijure-module-probe"
# example: FINISH_BLENDER_DOORS = "\${FINISH_BLENDER_DOORS}"

[vars]
RUNPOD_WORKERS_MAX = "2"
`;

describe("cf#840: a stripped optional door is reported, loudly, by the executed path", () => {
  it("an UNSET optional door var is named as STRIPPED, as a warning annotation", () => {
    const r = run(ONE_DOOR, {}, ["FINISH_UPSCALE_DOORS"]);
    expect(r.out).toContain("::warning::");
    expect(r.out).toMatch(/STRIPPED FINISH_UPSCALE_DOORS/);
    // Optional stays OPTIONAL: reporting it must not turn the normal state into a failed deploy.
    expect(r.status, `unset optional door must not fail the deploy; out=${r.out}`).toBe(0);
    // And it still fills empty-is-off, so the report did not change what ships.
    expect(r.text).toContain('FINISH_UPSCALE_DOORS = ""');
  });

  it("DISCRIMINATES: a SET door var is reported as BOUND and never as STRIPPED", () => {
    // Without this the report could be a line that always prints, which distinguishes nothing --
    // the same shape as a check that cannot go red.
    const r = run(ONE_DOOR, { FINISH_UPSCALE_DOORS: "https://door.invalid" });
    expect(r.out).toMatch(/BOUND\s+FINISH_UPSCALE_DOORS/);
    expect(r.out).not.toMatch(/STRIPPED FINISH_UPSCALE_DOORS/);
    expect(r.status).toBe(0);
  });

  it("NAMES ONLY: the report never prints the origin value", () => {
    const r = run(ONE_DOOR, { FINISH_UPSCALE_DOORS: "https://secret-origin.invalid" });
    // POSITIVE ANCHOR FIRST. A bare not.toContain passes on EMPTY output, so on the pre-fix script
    // (which printed nothing at all) this case went green while the other five went red -- an
    // absent check reading exactly like a passed one. Verified: reverting the script made this the
    // one survivor. Anchor it on the report actually being present, then assert the omission.
    expect(r.out).toMatch(/BOUND\s+FINISH_UPSCALE_DOORS/);
    expect(r.out).not.toContain("secret-origin.invalid");
  });

  it("DENOMINATOR: a toml declaring no door var says so rather than printing nothing", () => {
    // Silence and "nothing to strip" are the same output to a reader, which is the whole family of
    // defect this issue is about. The count is stated either way.
    const r = run(NO_DOOR, {}, ["FINISH_UPSCALE_DOORS", "FINISH_BLENDER_DOORS"]);
    expect(r.out).toContain("declares 0 optional door vars");
    expect(r.out).not.toMatch(/STRIPPED/);
    expect(r.status).toBe(0);
  });

  it("a COMMENTED example door is not counted as a stripped door", () => {
    // Documenting a binding at the point of use must stay inert (the cf#482 lesson: a comment-blind
    // grep failed the deploy for every module after one commented example).
    const r = run(COMMENTED_DOOR, {}, ["FINISH_BLENDER_DOORS"]);
    expect(r.out).toContain("declares 0 optional door vars");
    expect(r.out).not.toMatch(/STRIPPED FINISH_BLENDER_DOORS/);
  });

  it("LIVE ARTIFACT: the real finish-upscale toml reports its own door, both ways", () => {
    const off = run({ copyReal: true }, {}, ["FINISH_UPSCALE_DOORS"]);
    expect(off.out, "the shipped finish-upscale toml no longer declares ${FINISH_UPSCALE_DOORS}, or the report stopped covering it").toMatch(/STRIPPED FINISH_UPSCALE_DOORS/);
    expect(off.status).toBe(0);

    const on = run({ copyReal: true }, { FINISH_UPSCALE_DOORS: "https://door.invalid" });
    expect(on.out).toMatch(/BOUND\s+FINISH_UPSCALE_DOORS/);
    expect(on.status).toBe(0);
  });
});
