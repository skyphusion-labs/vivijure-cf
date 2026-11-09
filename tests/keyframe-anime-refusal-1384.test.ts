import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyInvokeFailure } from "@skyphusion-labs/vivijure-core/render-orchestrator";
import { validateConfig } from "@skyphusion-labs/vivijure-core/modules/registry";
import { resolveModuleRenderConfigs } from "@skyphusion-labs/vivijure-core/render-module-config";
import kfWorker from "../modules/keyframe/src/index";
import { styleRefusal } from "../modules/keyframe/src/keyframe";
import { MANIFEST } from "../modules/keyframe/src/manifest";

// cf#1384: the GPU keyframe door refuses style anime before any GPU spend. Animagine is not on the GPU
// image (vivijure-backend#557), so the job used to fail late, on a worker.

type Env = Parameters<typeof kfWorker.fetch>[1];
const ENV = { RUNPOD_API_KEY: "k", RUNPOD_ENDPOINT_ID: "ep123", RUNPOD_WORKERS_MAX: "12" } as unknown as Env;

async function invoke(config: Record<string, unknown>) {
  const req = new Request("http://m/invoke", {
    method: "POST",
    body: JSON.stringify({ hook: "keyframe", input: { project: "p", bundle_key: "bundles/p-1.tar.gz" }, config, context: { project: "p", job_id: "j" } }),
  });
  return (await (await kfWorker.fetch(req, ENV, {} as never)).json()) as { ok: boolean; error?: string; reason?: string; pending?: boolean };
}

describe("cf#1384: style anime on the GPU keyframe door", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is refused by name, before any fetch (no /run, no capacity reconcile), and core does not retry it", async () => {
    const fetchSpy = vi.fn(async () => new Response('{"id":"job-1"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const r = await invoke(validateConfig(MANIFEST.config_schema, { style: "anime" }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("bad-input");
    expect(r.error).toContain("style anime");
    expect(r.error).toContain("cloud-keyframe");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(classifyInvokeFailure(r)).toBe("deterministic");
  });

  it("photoreal still submits", async () => {
    const fetchSpy = vi.fn(async (u: string) =>
      String(u).endsWith("/run") ? new Response('{"id":"job-1"}', { status: 200 }) : new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const r = await invoke(validateConfig(MANIFEST.config_schema, { style: "photoreal" }));
    expect(r.ok).toBe(true);
    expect(r.pending).toBe(true);
    expect(fetchSpy.mock.calls.some(([u]) => String(u).endsWith("/run"))).toBe(true);
  });

  it("the default config (no style) still submits", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) =>
      String(u).endsWith("/run") ? new Response('{"id":"job-1"}', { status: 200 }) : new Response("{}", { status: 200 })));
    expect((await invoke(validateConfig(MANIFEST.config_schema, {}))).ok).toBe(true);
  });

  it("anime stays in the enum, so it reaches the module and its refusal names the door to use", () => {
    // Since core#343 (core 1.43.0) a narrower enum would no longer clamp anime to photoreal: core would
    // refuse it by name. The module keeps its own refusal because that message names cloud-keyframe,
    // which a generic "not supported" does not. Whether to narrow the enum instead is a separate call.
    const narrowed = { ...MANIFEST.config_schema, style: { type: "enum" as const, values: ["photoreal"], default: "photoreal" } };
    expect(() => validateConfig(narrowed, { style: "anime" })).toThrow(/"style": "anime" is not supported/);
    expect(validateConfig(MANIFEST.config_schema, { style: "anime" }).style).toBe("anime");
  });

  it("under core 1.43 (core#343) anime survives the resolve, reaches this module, and is refused before any fetch", async () => {
    // The whole path a render takes: core resolves the caller's bag against the shipped manifest, then
    // the module is invoked with the result. If core ever refused or clamped anime first, or the module
    // stopped refusing it, a GPU job would be submitted or the wrong refusal would fire. Either fails here.
    const mod = { ...MANIFEST, binding: "MODULE_KEYFRAME", hooks: ["keyframe"] } as never;
    const mapped = resolveModuleRenderConfigs({ keyframe_backend: MANIFEST.name, config: { [MANIFEST.name]: { style: "anime" } } }, "final", [mod]);
    expect(mapped.keyframe_config.style).toBe("anime");
    const fetchSpy = vi.fn(async () => new Response('{"id":"job-1"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const r = await invoke(mapped.keyframe_config);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("cloud-keyframe");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("styleRefusal is null for every other value", () => {
    for (const s of ["photoreal", undefined, "", "ANIME", 3]) expect(styleRefusal({ style: s })).toBeNull();
    expect(styleRefusal({ style: "anime" })).not.toBeNull();
  });
});
