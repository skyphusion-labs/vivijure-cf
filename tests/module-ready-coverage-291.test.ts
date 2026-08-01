// A MODULE THAT RECORDS MUST BE ASKABLE (cf#291).
//
// THE INVARIANT: every module that writes runpod_job_log rows must expose GET /ready.
//
// WHY THIS IS A GUARD AND NOT A ONE-LINE FIX. finish-rife wrote job-log rows and exposed no /ready
// at all, and it stayed that way from 2026-07-18 until cf#291 because of the shape of the gap: an
// audit built by sweeping readiness endpoints -- the natural way to build one, and the way cf#284
// made worth building -- returns a clean result across the modules that HAVE the endpoint and never
// mentions the one that does not. The absence removes the module from the census that would report
// it. A question with no owner reads as an answered question.
//
// The original commit said all five tenant modules. The tenant release set is SEVEN
// (scripts/finish-satellite-modules.txt plus keyframe, own-gpu, plan-enhance), and finish-rife
// already existed with the identical bindings the probe reports on. Nothing structural excluded it.
//
// SCOPE, stated plainly. This is source-shape analysis: it proves an endpoint is DECLARED, not that
// it answers correctly. That is deliberate division of labour -- tests/module-ready.test.ts drives
// every one of these modules through the real contract and would catch a declared-but-broken
// endpoint. This file catches the case that test cannot: a module nobody remembered to add to it.
//
// WHAT IT DELIBERATELY DOES NOT REQUIRE. plan-enhance is in the tenant release set and has no
// /ready, and that is correct rather than a second instance: it holds no RunPod credentials (Workers
// AI and AI Gateway instead) and writes no job log, so the probe would have nothing to report. The
// invariant is keyed on RECORDING, not on tenant deployment, because recording is what creates the
// question an operator needs answered.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MODULES_DIR = join(import.meta.dirname, "..", "modules");

/** Every module directory that ships a worker entry point. _shared holds no worker. */
function moduleEntryPoints(): { name: string; source: string }[] {
  return readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "_shared")
    .map((e) => ({ name: e.name, path: join(MODULES_DIR, e.name, "src", "index.ts") }))
    .filter((m) => {
      try { readFileSync(m.path); return true; } catch { return false; }
    })
    .map((m) => ({ name: m.name, source: readFileSync(m.path, "utf8") }));
}

const ENTRIES = moduleEntryPoints();
const WRITERS = ENTRIES.filter((m) => m.source.includes("recordRunpodJob")).map((m) => m.name);
const READY = ENTRIES.filter((m) => m.source.includes("\"/ready\"")).map((m) => m.name);

describe("every module that records a RunPod job can be asked whether it can", () => {
  it("no job-log writer is missing GET /ready", () => {
    const silent = WRITERS.filter((name) => !READY.includes(name));
    expect(silent, "job-log writers with no /ready endpoint: " + silent.join(", ")).toEqual([]);
  });

  it("the scan actually read the tree (positive control)", () => {
    // Both assertions in this file are filter(...).toEqual([]) shaped, which is exactly what a
    // scan that read nothing produces. Pin real data, with named members, so a parse or path
    // regression is loud rather than silently turning this file into a pass generator.
    expect(ENTRIES.length).toBeGreaterThan(20);
    expect(WRITERS.length).toBeGreaterThanOrEqual(6);
    expect(WRITERS).toContain("finish-rife");
    expect(WRITERS).toContain("keyframe");
    expect(READY).toContain("finish-upscale");
  });

  it("the filter DISCRIMINATES: a non-writer is not required to have one", () => {
    // Without this, an invariant that happened to require /ready of EVERY module would pass here
    // today and start failing the moment someone adds a module that legitimately needs neither.
    // plan-enhance is that case, and it is in the tenant release set, so it is not a strawman.
    expect(WRITERS).not.toContain("plan-enhance");
    expect(READY).not.toContain("plan-enhance");
    const silent = WRITERS.filter((name) => !READY.includes(name));
    expect(silent).not.toContain("plan-enhance");
  });
});
