import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as viaShared from "../modules/_shared/runpod-job-log";
import * as viaCore from "@skyphusion-labs/vivijure-core/runpod-job-log";

// cf#475: modules/_shared/runpod-job-log.ts stopped being an implementation and became a POINTER at
// vivijure-core, so the cast-LoRA training path in core could reach the SAME recorder the 97 module
// call sites use instead of growing a second one. Both failure modes of that move are silent, which
// is why the assertions exist rather than trusting the deletion to stay done.
//
// 1. THE RE-EXPORT STOPS COVERING WHAT MODULES IMPORT. 15 module workers import this path by name.
//    tsc catches a missing export for code that is compiled; this asserts the surface at RUNTIME,
//    through the same specifier the modules use.
// 2. A HAND COPY COMES BACK. Sync-checking the copy you KEPT protects only the copy you kept. This
//    file's whole value is that it holds nothing, and an absence decays with nothing noticing it.
//
// The estate has the receipt for that second one: TWO copies of this recorder existed before this
// change (here and vivijure-local's src/runpod-job-log.ts) and had already drifted -- local still
// truncates detail at 160 where cf#320 raised it to 480, has no `unknown` outcome, and no timing
// columns. Drift on this file is measured history, not a hypothetical.

const sharedPath = join(import.meta.dirname, "..", "modules", "_shared", "runpod-job-log.ts");

describe("modules/_shared/runpod-job-log re-exports core and adds nothing", () => {
  it("exposes the SAME export names as core, derived from both sides rather than listed here", () => {
    // Derived on both sides on purpose. A hardcoded name list would be a third copy of the contract,
    // written into the test whose job is to stop there being a second one.
    const shared = Object.keys(viaShared).sort();
    const core = Object.keys(viaCore).sort();
    expect(shared.length).toBeGreaterThan(0); // floor: two empty namespaces are trivially equal
    expect(shared).toEqual(core);
  });

  it("re-exports the SAME objects, not lookalikes", () => {
    // Identity, not shape. A local re-implementation with a matching surface passes a name-only
    // comparison and IS the duplicate this change removed.
    expect(viaShared.recordRunpodJob).toBe(viaCore.recordRunpodJob);
    expect(viaShared.RUNPOD_JOB_LOG_UPSERT).toBe(viaCore.RUNPOD_JOB_LOG_UPSERT);
    expect(viaShared.probeRunpodJobLog).toBe(viaCore.probeRunpodJobLog);
    expect(viaShared.reconcileOpenRunpodJobs).toBe(viaCore.reconcileOpenRunpodJobs);
  });

  it("carries the cf#320 bound and the cf#298 vocabulary through, not an older core copy", () => {
    // The two places the pre-move copies had ALREADY diverged. If a future core version regresses
    // either, this repo hears about it here rather than through a truncated diagnosis in production.
    expect(viaShared.DETAIL_MAX).toBe(480);
    expect(viaShared.RESOLVED_RUNPOD_OUTCOMES).toContain("cancelled");
    expect(viaShared.RESOLVED_RUNPOD_OUTCOMES).not.toContain("unknown");
  });

  it("behaves through the shared path: a real write lands the real upsert with the real arguments", async () => {
    // The integration the type system cannot assert: that the package subpath resolves at runtime
    // from a module's point of view, and that the code arriving through it is the working recorder.
    const seen: { sql: string; args: unknown[] }[] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          seen.push({ sql, args });
          return { run: async () => ({ success: true }) };
        },
      }),
    } as unknown as D1Database;

    await viaShared.recordRunpodJob(db, {
      jobId: "job-x",
      module: "finish-upscale",
      outcome: "submitted",
      submittedAtMs: 1_700_000_000_000,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].sql).toBe(viaCore.RUNPOD_JOB_LOG_UPSERT);
    expect(seen[0].args[0]).toBe("job-x");
    expect(seen[0].args[2]).toBe("submitted");
    expect(seen[0].args[5]).toBeNull(); // terminal_at NULL while the job is open
  });

  it("DECLARES NOTHING OF ITS OWN -- the guard on the deletion, not on the survivor", () => {
    const src = readFileSync(sharedPath, "utf8");
    // Comments are stripped FIRST. Without that, the file's own prose ("If you are about to add a
    // `const`, a `function`...") trips every matcher below, and a guard its own documentation fails
    // is a guard someone deletes.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    // Positive control on the stripper: the declaration keyword must be findable in a string KNOWN
    // to contain one, or "no declarations" is a claim about a matcher that matches nothing.
    expect(/\bexport\s+const\b/.test("export const X = 1;")).toBe(true);
    expect(code).not.toMatch(/\bexport\s+(const|function|class|interface|type|enum)\b/);
    expect(code).not.toMatch(/\b(const|function|class|interface|enum)\s+[A-Za-z_]/);
    // And it must still be a re-export of core, so "declares nothing" cannot be satisfied by an
    // empty file that silently breaks all 15 modules.
    expect(code).toMatch(/export\s+\*\s+from\s+["']@skyphusion-labs\/vivijure-core\/runpod-job-log["']/);
  });
});
