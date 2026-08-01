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
// REVISED BY cf#295. This file used to assert that plan-enhance had NO /ready, on the premise that it
// "holds no RunPod credentials ... and writes no job log, so the probe would have nothing to report."
// That premise was wrong: plan-enhance reads GATEWAY_ID and CF_AIG_TOKEN (they pick the Opus-vs-local
// provider), which IS something a credential-visibility probe can report. cf#295 measured that 20 of
// 26 modules had no /ready at all, and a caller sweeping readiness could not tell "not ready" from
// "no endpoint exists" -- so every module now exposes /ready for whatever it can honestly check
// (a RunPod key, an AI Gateway id, a service binding), even when it writes no job-log row. The
// invariant below is therefore a SUBSET (every job-log writer is askable), never an equality (not
// every askable module is a job-log writer) -- see the "DISCRIMINATES" test.
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

  it("the filter DISCRIMINATES: READY is a strict superset of WRITERS, not the same set (cf#295)", () => {
    // Before cf#295, a module with no job-log binding genuinely had no /ready either, so WRITERS and
    // READY happened to be the same six names -- a filter that always returns its input unchanged
    // would have passed every test in this file. cf#295 broadened /ready to every module for
    // credential/binding visibility, a reason that has nothing to do with job-log recording, so
    // WRITERS is now a PROPER subset of READY: some modules are askable without ever writing a row.
    // Without this the invariant above could pass by accident (e.g. a copy-paste that made every
    // module both a "writer" and "ready").
    expect(READY.length).toBe(ENTRIES.length); // cf#295: every module now exposes /ready
    expect(WRITERS.length).toBeLessThan(READY.length);
    // plan-enhance is the named case: it now HAS /ready (reports GATEWAY_ID / CF_AIG_TOKEN
    // visibility, informationally -- see modules/plan-enhance/src/index.ts) but still writes no
    // job-log row, so it must never appear in WRITERS even though it appears in READY.
    expect(READY).toContain("plan-enhance");
    expect(WRITERS).not.toContain("plan-enhance");
    const silent = WRITERS.filter((name) => !READY.includes(name));
    expect(silent).not.toContain("plan-enhance");
  });
});
