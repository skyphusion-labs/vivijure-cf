// cf#394 item 3 -- "audit every other module for the same class" -- as a GUARD, not a document.
//
// WHY A TEST AND NOT ONLY A DOC. The audit's finding is a classification: for each binding a module
// reads, how does a SHARED HOSTED TENANT come to hold it. A document recording that goes stale the
// first time someone adds a module, and nothing anywhere reports the drift -- the census reads clean
// because it is a frozen list, not a measurement. So the classification lives here, where adding a
// module that reads an unclassified binding turns CI red and names the binding.
//
// WHAT THIS DOES NOT DO. It does not assert that a module IS provisioned to tenants: the tenant set
// is `TENANT_MODULE_CATALOG` in vivijure-control-plane and is not readable from this repo. It
// asserts the weaker, checkable thing -- that every binding every module reads has a WRITTEN answer
// to "where would a tenant get this", so a new operator-scoped credential cannot arrive unnoticed.
// The RunPod credential path itself is guarded separately and more strongly in
// tests/runpod-proxy-base-cf394.test.ts; this file deliberately does not restate it.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";

const MODULES_DIR = "modules";

/**
 * One module's source as CODE.
 *
 * Mechanics copied deliberately from tests/runpod-proxy-base-cf394.test.ts rather than reinvented,
 * because that file already paid for both of them: WHOLE-LINE comments only (a general `//` strip
 * eats every `https://` inside a string literal), and STRIP FIRST then FLATTEN (flattening first
 * removes the newlines the line-scoped stripper needs, and the resulting empty string passes every
 * absence assertion below).
 */
function moduleCode(m: string): string {
  const dir = `${MODULES_DIR}/${m}/src`;
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(`${dir}/${f}`, "utf8"))
    .join("\n")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
    .join("\n")
    .replace(/\s+/g, " ");
}

const modules = readdirSync(MODULES_DIR)
  .filter((m) => existsSync(`${MODULES_DIR}/${m}/src/index.ts`))
  .sort();

/** Every `env.X` a module actually READS, comment-stripped so a binding named only in prose does
 *  not count as a read. Sorted + de-duplicated. */
function bindingsRead(m: string): string[] {
  const hits = moduleCode(m).match(/env\.[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return [...new Set(hits.map((h) => h.slice("env.".length)))].sort();
}

/**
 * How a SHARED HOSTED TENANT comes to hold each binding.
 *
 *   plane-bound     vivijure-control-plane binds this at modules_upload (measured against
 *                   src/tenant-modules.ts @6730793: RUNPOD_ENDPOINT_ID, TELEMETRY_DB, AI,
 *                   TENANT_ID, TENANT_SLUG, GATEWAY_ID, CF_AIG_TOKEN).
 *   proxy           reached through the plane-side RunPod proxy instead of a tenant-held key
 *                   (modules/_shared/runpod-route.ts). On the proxied route RUNPOD_API_KEY is
 *                   deliberately absent and unused.
 *   module-var      a plain var shipped in the module's own wrangler.toml or defaulted in code.
 *                   Carries no credential and needs nothing from the plane.
 *   operator-only   an operator-scoped credential or a route into operator infrastructure. NOT
 *                   reachable by a shared tenant today. A module reading one of these cannot be
 *                   added to TENANT_MODULE_CATALOG without first giving it a mediated path --
 *                   this is the `own-gpu` class the cf#394 ruling asked to be found.
 *   self-host-only  a binding that points at the deploying operator's OWN hardware. Not a gap:
 *                   this is the self-host door, and it is a product (see runpod-route.ts).
 */
type TenantPath = "plane-bound" | "proxy" | "module-var" | "operator-only" | "self-host-only";

const CLASSIFICATION: Readonly<Record<string, { path: TenantPath; note: string }>> = {
  // --- bound by the control plane at modules_upload ---
  AI: { path: "plane-bound", note: "Workers AI binding, attached for needsAiGateway specs" },
  CF_AIG_TOKEN: { path: "plane-bound", note: "per-tenant AI Gateway token; attributable and revocable one tenant at a time (cf#56)" },
  GATEWAY_ID: { path: "plane-bound", note: "AI Gateway slug, plain_text identifier, not a secret" },
  TELEMETRY_DB: { path: "plane-bound", note: "the tenant studio D1, for runpod_job_log (cf#279 / cp#248)" },
  TENANT_ID: { path: "plane-bound", note: "opaque tenant identifier, plain_text" },
  TENANT_SLUG: { path: "plane-bound", note: "tenant display slug, plain_text" },
  RUNPOD_ENDPOINT_ID: { path: "plane-bound", note: "plain_text at upload; an endpoint id is not a secret" },

  // --- reached through the plane proxy rather than held ---
  RUNPOD_API_KEY: { path: "proxy", note: "unbound branch only (self-host / operator). On the proxied route the bearer is RUNPOD_PROXY_TOKEN and this is never read for a render" },

  // --- inert vars ---
  ENHANCE_MODEL: { path: "module-var", note: "model id var with an in-code default" },
  PLANNER_AI_MOCK: { path: "module-var", note: "test-only switch" },
  RUNPOD_WORKERS_MAX: { path: "module-var", note: "capacity hint; the reconcile it feeds is gated to !route.proxied, so it is inert for a tenant" },

  // --- operator-scoped: a tenant cannot reach these today ---
  OPENAI_API_KEY: { path: "operator-only", note: "image-generate. An OPERATOR-held third-party vendor key with no mediated tenant path -- the same class as the pre-cf394 own-gpu RunPod key, and the one live instance of it. Not in TENANT_MODULE_CATALOG, so not exposed today" },
  R2_RENDERS: { path: "operator-only", note: "bound to the OPERATOR bucket in wrangler.toml. The plane binds no R2 at all; catalog modules avoid it via the per-job tenant R2 credential on the invoke envelope (needs_tenant_r2, cp#270)" },
  IMAGES: { path: "operator-only", note: "Cloudflare Images binding on the operator account" },
  EMAIL: { path: "operator-only", note: "send_email binding on the operator account" },
  DIALOGUE_WORKFLOW: { path: "operator-only", note: "Workflow binding; the Workflow class ships with the operator's script" },
  SCORE_WORKFLOW: { path: "operator-only", note: "Workflow binding; the Workflow class ships with the operator's script" },
  AUDIO_MASTER_VPC: { path: "operator-only", note: "VPC service into the operator finishing swarm" },
  FINISH_UPSCALE_VPC: { path: "operator-only", note: "cf#480: VPC service into the operator's always-on upscale door on our own GPU iron. A tenant CANNOT hold this today and the blocker is measured, not assumed: the plane's uploadTenantModules binds no vpc_service at any of its bindings.push sites, because TenantModuleDeps carries the provisioner credential and CF will not let an API-created token mint one with Connectivity Directory scope (cp#359). Classified here rather than left to prose so a future attempt to add these modules to TENANT_MODULE_CATALOG turns this red" },
  FINISH_DOOR_TOKEN: { path: "operator-only", note: "cf#480: the upscale door's own bearer (LOCAL_FINISH_TOKEN on the container). Operator infrastructure credential; same class as the VPC binding it authenticates against, and read ONLY when that binding is bound" },
  SPEECH_UPSCALE_VPC: { path: "operator-only", note: "cf#480: VPC service into the operator's always-on speech-enhance door. Same cp#359 tenant blocker as FINISH_UPSCALE_VPC" },
  SPEECH_DOOR_TOKEN: { path: "operator-only", note: "cf#480: the speech door's own bearer. Read only when SPEECH_UPSCALE_VPC is bound" },
  FINISH_UPSCALE_VPC_PROPAGANDHI: { path: "operator-only", note: "cf#507: the SECOND upscale door, the other GPU box. Identical class to FINISH_UPSCALE_VPC and the same cp#359 tenant blocker -- a second door changes the COUNT of operator bindings, never the tenant answer" },
  FINISH_DOOR_TOKEN_PROPAGANDHI: { path: "operator-only", note: "cf#507: that door's own bearer. Given its own binding rather than sharing the first door's, because two doors are two services and a shared token binding is an undeclared coupling; an operator may point both at one store secret" },
  SPEECH_UPSCALE_VPC_PROPAGANDHI: { path: "operator-only", note: "cf#507: the SECOND speech door. Same class and same cp#359 blocker as SPEECH_UPSCALE_VPC" },
  SPEECH_DOOR_TOKEN_PROPAGANDHI: { path: "operator-only", note: "cf#507: that door's own bearer. Read only when SPEECH_UPSCALE_VPC_PROPAGANDHI is bound" },
  FINISH_BLENDER_VPC: { path: "operator-only", note: "cf#489: VPC service into the operator always-on blender door on our own iron. Same cp#359 tenant blocker as FINISH_UPSCALE_VPC. Unlike the upscale doors this one is CPU-only work on the finishing tier, and it is addressed PER NODE rather than by service name, because the swarm VIP round-robins while the door keeps job state per process (measured: twelve polls of one job id gave found=4, 404=8)" },
  BLENDER_DOOR_TOKEN: { path: "operator-only", note: "cf#489: the blender door own bearer (LOCAL_FINISH_TOKEN on the container), the same shared value the four GPU doors carry. Read ONLY when FINISH_BLENDER_VPC is bound" },
  AUDIO_BEAT_SYNC_VPC: { path: "operator-only", note: "VPC service into the operator finishing swarm" },
  VIDEO_FINISH_VPC: { path: "operator-only", note: "VPC service into the operator finishing swarm" },

  // --- the self-host door ---
  LOCAL_BACKEND_URL: { path: "self-host-only", note: "the deploying operator's own GPU box" },
  LOCAL_BACKEND_TOKEN: { path: "self-host-only", note: "credential for the operator's own GPU box" },
};

describe("cf#394 item 3: every module binding has a written tenant-reachability answer", () => {
  it("POSITIVE CONTROL: the extractor returns a known binding from a known module", () => {
    // Without this, a moved directory or a broken regex makes every exhaustiveness assertion below
    // pass vacuously: zero bindings read is trivially "all classified".
    expect(bindingsRead("own-gpu")).toContain("RUNPOD_ENDPOINT_ID");
  });

  it("NEGATIVE CONTROL: the extractor does not invent a binding that is not there", () => {
    expect(bindingsRead("own-gpu")).not.toContain("RUNPOD_NOT_A_REAL_BINDING");
  });

  it("POSITIVE-EVIDENCE FLOOR: the census is not empty", () => {
    // Measured 2026-08-03 at vivijure-cf@6730296: 26 modules carry src/index.ts. Asserted as a
    // FLOOR, so a new module is normal and only a matcher that has stopped matching turns it red.
    expect(modules.length).toBeGreaterThanOrEqual(26);
    const distinct = new Set(modules.flatMap(bindingsRead));
    expect(distinct.size).toBeGreaterThanOrEqual(20);
  });

  it("every binding read by every module is CLASSIFIED", () => {
    // THE GUARD. A new module reading an unclassified binding fails here, naming module and
    // binding, rather than being discovered when a hosted render fails.
    const unclassified: string[] = [];
    for (const m of modules) {
      for (const b of bindingsRead(m)) {
        if (!(b in CLASSIFICATION)) unclassified.push(`${m}:${b}`);
      }
    }
    expect(unclassified, `unclassified bindings (add a row to CLASSIFICATION with its tenant path): ${unclassified.join(", ")}`).toEqual([]);
  });

  it("the classification table carries no DEAD entries", () => {
    // The other direction, and it is the one a table silently fails in: an entry for a binding no
    // module reads any more is a claim about code that no longer exists, and it makes the table
    // read as more complete than it is.
    const read = new Set(modules.flatMap(bindingsRead));
    const dead = Object.keys(CLASSIFICATION).filter((b) => !read.has(b));
    expect(dead, `classified but read by no module: ${dead.join(", ")}`).toEqual([]);
  });
});
