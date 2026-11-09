import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyInvokeFailure } from "@skyphusion-labs/vivijure-core/render-orchestrator";
import { validateConfig } from "@skyphusion-labs/vivijure-core/modules/registry";
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

  it("anime stays in the enum, because core clamps an undeclared value to photoreal", () => {
    // Why the refusal is in the module and not a narrower enum: this is what core does with a value
    // the schema does not declare.
    const narrowed = { ...MANIFEST.config_schema, style: { type: "enum" as const, values: ["photoreal"], default: "photoreal" } };
    expect(validateConfig(narrowed, { style: "anime" }).style).toBe("photoreal");
    expect(validateConfig(MANIFEST.config_schema, { style: "anime" }).style).toBe("anime");
  });

  it("styleRefusal is null for every other value", () => {
    for (const s of ["photoreal", undefined, "", "ANIME", 3]) expect(styleRefusal({ style: s })).toBeNull();
    expect(styleRefusal({ style: "anime" })).not.toBeNull();
  });
});
