// Forwarding the tenant per-job R2 credential into the RunPod body, and the drift guard that keeps
// it out of logs (cp#270, step 3).
//
// TWO KINDS OF TEST HERE, and the second is the one that has to survive future edits.
//
//   1. The FORWARDING rules: the block lands inside the RunPod `input` object, and it is OMITTED
//      rather than nulled when there is nothing to send. The backend REFUSES an explicit
//      `"r2": null` rather than reading it as absent, so a producer that nulls fails every job on a
//      dedicated endpoint -- which is the entire installed base today.
//
//   2. The DRIFT GUARD: no module may serialise its own invoke request or input. That is what keeps
//      a live tenant credential out of `Logs`, and `Logs` is the exposure surface -- Cloudflare's
//      workers_trace_events dataset carries no request-body field, so the platform does not capture
//      the body and the only way this leaks is if our own code writes it. An audit proved that true
//      once; this test is what keeps it true.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { withTenantR2Body } from "../modules/_shared/tenant-r2-body";

const CRED = {
  endpoint: "https://acct.r2.cloudflarestorage.com",
  access_key_id: "tok-1",
  secret_access_key: "deadbeef",
  bucket: "vivijure-tenant-hero",
};

// Typed explicitly rather than inferred: a narrowly-inferred object literal makes reading
// `out.input.r2` a type error, and the RunPod body genuinely is an open record.
const body = (): { input: Record<string, unknown> } => ({
  input: { action: "preview", project: "demo", bundle_key: "b/k.tar.gz" },
});

describe("withTenantR2Body", () => {
  it("puts the block INSIDE the RunPod input object, beside action/project/bundle_key", () => {
    // Placement is contract, not taste: vivijure-backend reads `job["input"]["r2"]`.
    const out = withTenantR2Body(body(), CRED);
    expect(out.input.r2).toEqual(CRED);
    expect(out.input.action).toBe("preview");
  });

  it("OMITS the key entirely when there is no credential, never nulls it", () => {
    // THE RULE THAT BREAKS THE FAR END. Asserted on the SERIALISED form, because the object-level
    // check alone would also pass for `r2: undefined`, which disappears only by a property of
    // JSON.stringify rather than by intent.
    const out = withTenantR2Body(body(), null);
    expect("r2" in out.input).toBe(false);
    const wire = JSON.parse(JSON.stringify(out)) as { input: Record<string, unknown> };
    expect("r2" in wire.input).toBe(false);
    expect(JSON.stringify(out)).not.toContain("null");
  });

  it("CONTROL: the attached form really does serialise the block", () => {
    // Without this, an implementation that never attached anything would pass every other test.
    const wire = JSON.parse(JSON.stringify(withTenantR2Body(body(), CRED))) as {
      input: { r2?: typeof CRED };
    };
    expect(wire.input.r2).toEqual(CRED);
  });

  it("does not mutate the caller's body", () => {
    const original = body();
    withTenantR2Body(original, CRED);
    expect("r2" in original.input).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// THE DRIFT GUARD
// ---------------------------------------------------------------------------------------------

const MODULES_DIR = join(__dirname, "..", "modules");

function moduleSourceFiles(): { module: string; file: string; text: string }[] {
  const out: { module: string; file: string; text: string }[] = [];
  for (const mod of readdirSync(MODULES_DIR, { withFileTypes: true })) {
    if (!mod.isDirectory()) continue;
    const src = join(MODULES_DIR, mod.name, "src");
    if (!existsSync(src)) continue;
    for (const f of readdirSync(src)) {
      if (!f.endsWith(".ts")) continue;
      out.push({ module: mod.name, file: join(src, f), text: readFileSync(join(src, f), "utf8") });
    }
  }
  return out;
}

describe("drift guard: no module serialises its own invoke request or input", () => {
  it("finds module sources to scan at all", () => {
    // POSITIVE-EVIDENCE FLOOR. A scan that silently found nothing would pass every assertion below
    // and prove nothing -- the failure mode where "no findings" and "never ran" are the same result.
    const files = moduleSourceFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.module === "keyframe")).toBe(true);
    expect(files.some((f) => f.module === "own-gpu")).toBe(true);
  });

  it("no module logs or stringifies `req` / `input` / `body` / `payload` wholesale", () => {
    // The credential rides the invoke request, so serialising the request -- into a console line, an
    // error message, anything -- is what would put it in `Logs` and from there into the tail worker
    // and Loki. Field-scoped logging (shot_id, a status code, an error message) stays fine and is
    // what every module does today.
    const offenders: string[] = [];
    // SCOPE, and it was narrowed by a real false positive on the first run rather than guessed.
    //
    // The LEAK VECTOR is console output: it lands in `Logs`, which the tail worker forwards to Loki.
    // So the console patterns cover every name an invoke object goes by. The BARE-stringify pattern
    // is deliberately narrower -- `req` only -- because `payload` and `input` are ordinary local
    // names with legitimate uses that have nothing to do with logging: local-gpu's `encodePoll` does
    // `btoa(JSON.stringify(payload))` on a PollState to build a poll token, which this guard flagged
    // and which is not a leak of anything.
    //
    // `req` is the invoke-request variable by convention in every module handler, and there is no
    // legitimate reason to serialise it, so it is flagged wherever it appears. Scoping by MEANING
    // beats an exemption list, which would have to grow every time someone names a local `payload`.
    const patterns = [
      /console\.(log|warn|error|info|debug)\s*\(\s*(req|input|body|payload)\b/,
      /JSON\.stringify\s*\(\s*req\b/,
      /console\.(log|warn|error|info|debug)\s*\([^)]*JSON\.stringify\s*\(\s*(req|input|payload)\b/,
    ];
    for (const { module, file, text } of moduleSourceFiles()) {
      text.split("\n").forEach((line, i) => {
        // The RunPod submit legitimately stringifies the BODY it just built, which is a different
        // object from the invoke request and is where the credential is deliberately placed.
        if (/JSON\.stringify\(\s*withTenantR2Body\(/.test(line)) return;
        if (/JSON\.stringify\(build[A-Z]/.test(line)) return;
        for (const p of patterns) {
          if (p.test(line)) offenders.push(`${module} ${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("CONTROL: the matcher DOES catch the pattern it exists to catch", () => {
    // A drift guard that cannot fire is decoration, and a scan over clean sources cannot tell the
    // difference. Run the same matcher over a constructed offender and require a hit.
    const offending = 'console.warn("submit failed: " + JSON.stringify(req));';
    const p = /console\.(log|warn|error|info|debug)\s*\([^)]*JSON\.stringify\s*\(\s*(req|input|payload)\b/;
    expect(p.test(offending)).toBe(true);

    const alsoOffending = "console.log(req);";
    expect(/console\.(log|warn|error|info|debug)\s*\(\s*(req|input|body|payload)\b/.test(alsoOffending)).toBe(true);
  });

  it("the two pooled-endpoint modules STRIP the credential at the parse boundary", () => {
    // The strip is what guarantees nothing below the handler holds an object containing the
    // credential. Asserted per module, by name, so deleting the call in one of them fails here
    // rather than silently widening the window.
    for (const mod of ["keyframe", "own-gpu"]) {
      // cf#285 moved needs_tenant_r2 (part of MANIFEST) out of index.ts into manifest.ts for both
      // of these modules; takeTenantR2(req) stays in index.ts (runtime code, not manifest data).
      // Concatenate both files so this still asserts on the module as a whole.
      let text = readFileSync(join(MODULES_DIR, mod, "src", "index.ts"), "utf8");
      try {
        text += readFileSync(join(MODULES_DIR, mod, "src", "manifest.ts"), "utf8");
      } catch { /* not extracted */ }
      expect(text, `${mod} must call takeTenantR2`).toContain("takeTenantR2(req)");
      expect(text, `${mod} must declare needs_tenant_r2`).toContain("needs_tenant_r2: true");
    }
  });

  it("CONTROL: a module that does NOT ride a pooled endpoint declares neither", () => {
    // Declaring it hands a live tenant credential to a worker with no use for one. This is the check
    // that stops the field spreading by copy-paste; finish-upscale reaches a satellite endpoint and
    // must stay clean.
    const text = readFileSync(join(MODULES_DIR, "finish-upscale", "src", "index.ts"), "utf8");
    expect(text).not.toContain("needs_tenant_r2");
    expect(text).not.toContain("takeTenantR2");
  });
});
