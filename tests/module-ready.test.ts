// cf#114: the module-contract GET /ready credential-visibility probe, on all six RunPod TENANT modules.
//
// What this endpoint has to be true about, and what each test below therefore pins:
//   1. it reports VISIBILITY, never VALUES (a probe that leaks the thing it is checking is worse
//      than no probe);
//   2. it observes THIS worker version, so it can distinguish a credential that is configured but
//      not yet served from one that is genuinely absent;
//   3. its shape is identical across all six, because the control-plane prober is module-agnostic
//      by design (the alternative is the two-hand-maintained-lists drift class that produced #116).
//
// The env stubs here are plain strings on purpose: secretValue() in each module resolves a
// SecretsStoreSecret OR a string, and the string path is the one a test can drive. That is a stub of
// the BINDING, not of the decision under test -- the routing, the boolean derivation, and the error
// text are all the shipped code.

import { describe, it, expect } from "vitest";

import keyframeWorker from "../modules/keyframe/src/index";
import ownGpuWorker from "../modules/own-gpu/src/index";
import finishUpscaleWorker from "../modules/finish-upscale/src/index";
import finishLipsyncWorker from "../modules/finish-lipsync/src/index";
import speechUpscaleWorker from "../modules/speech-upscale/src/index";
import finishRifeWorker from "../modules/finish-rife/src/index";

const KEY = "rpa_A_REAL_LOOKING_KEY_VALUE";
const ENDPOINT = "nbfj3iatp62ek9";

type Worker = { fetch(request: Request, env: never): Promise<Response> };

const MODULES: { name: string; worker: Worker }[] = [
  { name: "keyframe", worker: keyframeWorker as unknown as Worker },
  { name: "own-gpu", worker: ownGpuWorker as unknown as Worker },
  { name: "finish-upscale", worker: finishUpscaleWorker as unknown as Worker },
  { name: "finish-lipsync", worker: finishLipsyncWorker as unknown as Worker },
  { name: "speech-upscale", worker: speechUpscaleWorker as unknown as Worker },
  // cf#291: finish-rife was missed when this shipped. It is in the tenant release set and writes
  // job-log rows like the rest, so it belongs in the module-agnostic contract, not beside it.
  { name: "finish-rife", worker: finishRifeWorker as unknown as Worker },
];

const env = (apiKey?: string, endpointId?: string, telemetryDb?: unknown) =>
  ({ RUNPOD_API_KEY: apiKey, RUNPOD_ENDPOINT_ID: endpointId, TELEMETRY_DB: telemetryDb }) as never;

const ready = async (worker: Worker, apiKey?: string, endpointId?: string, telemetryDb?: unknown) => {
  const res = await worker.fetch(new Request("https://m.internal/ready"), env(apiKey, endpointId, telemetryDb));
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, text: "" };
};

describe.each(MODULES)("$name: GET /ready", ({ name, worker }) => {
  it("reports ok with both credentials visible", async () => {
    const { status, body } = await ready(worker, KEY, ENDPOINT);
    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      module: name,
      credentials: { runpod_api_key: true, runpod_endpoint_id: true },
      // cf#394: which RunPod route this worker would take. Additive, and false on every
      // case here because none of them binds RUNPOD_PROXY_BASE. The field name
      // runpod_api_key is deliberately unchanged: the control plane parses it and
      // refuses a module whose /ready omits it.
      runpod_proxied: false,
      telemetry: { job_log: "unavailable" },
    });
  });

  it("reports the propagation shape: endpoint visible, key not yet", async () => {
    const { body } = await ready(worker, undefined, ENDPOINT);
    expect(body).toEqual({
      ok: false,
      module: name,
      credentials: { runpod_api_key: false, runpod_endpoint_id: true },
      // cf#394: which RunPod route this worker would take. Additive, and false on every
      // case here because none of them binds RUNPOD_PROXY_BASE. The field name
      // runpod_api_key is deliberately unchanged: the control plane parses it and
      // refuses a module whose /ready omits it.
      runpod_proxied: false,
      telemetry: { job_log: "unavailable" },
    });
  });

  it("reports both absent (a genuinely unconfigured module)", async () => {
    const { body } = await ready(worker, undefined, undefined);
    expect(body).toEqual({
      ok: false,
      module: name,
      credentials: { runpod_api_key: false, runpod_endpoint_id: false },
      // cf#394: which RunPod route this worker would take. Additive, and false on every
      // case here because none of them binds RUNPOD_PROXY_BASE. The field name
      // runpod_api_key is deliberately unchanged: the control plane parses it and
      // refuses a module whose /ready omits it.
      runpod_proxied: false,
      telemetry: { job_log: "unavailable" },
    });
  });
  // cf#279 CONTROL, updated for cf#284: the three assertions above all read unavailable, which is
  // also what a field hardcoded to unavailable would produce. These are the cases that tell them
  // apart, and they are the probe an operator uses to distinguish an empty job log from a worker
  // that cannot write one.
  it("reports ok when the table is really there, and ok does not depend on it", async () => {
    const withTable = { prepare: () => ({ bind: () => ({ first: async () => ({ name: "runpod_job_log" }) }) }) };
    const { body } = await ready(worker, KEY, ENDPOINT, withTable);
    expect(body.telemetry).toEqual({ job_log: "ok" });
    expect(body.ok).toBe(true);
    const without = await ready(worker, KEY, ENDPOINT);
    expect(without.body.ok).toBe(true);   // telemetry absence must NOT unready a module
  });

  // cf#284, THE case this issue was filed for: a real binding attached to a database where the table
  // does not exist. This reported job_log:true before, while the worker could not write a single row.
  it("a bound database with NO table reports unavailable, not ok", async () => {
    const noTable = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };
    const { body } = await ready(worker, KEY, ENDPOINT, noTable);
    expect(body.telemetry).toEqual({ job_log: "unavailable" });
    expect(body.ok).toBe(true);   // still telemetry: a module without a job log still renders
  });

  // A binding whose shape we cannot drive is NOT evidence of health. Before cf#284 this exact stub
  // reported true, which is the disease in one line: a probe that could not answer said yes.
  it("a binding the probe cannot drive reports unknown, never ok", async () => {
    const { body } = await ready(worker, KEY, ENDPOINT, { prepare: () => ({}) });
    expect(body.telemetry).toEqual({ job_log: "unknown" });
    expect(body.ok).toBe(true);
  });

  // THE test that makes this endpoint safe to leave unauthenticated. Booleans only: the serialized
  // response must not contain either credential value, in any field, at any nesting.
  it("never leaks a credential VALUE in any form", async () => {
    const res = await worker.fetch(new Request("https://m.internal/ready"), env(KEY, ENDPOINT));
    const raw = await res.text();
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain(ENDPOINT);
    // Control: the assertion above can only mean something if these strings COULD have appeared.
    expect(JSON.stringify({ k: KEY, e: ENDPOINT })).toContain(KEY);
  });

  it("is a GET-only route (a POST /ready is not silently accepted)", async () => {
    const res = await worker.fetch(
      new Request("https://m.internal/ready", { method: "POST" }),
      env(KEY, ENDPOINT),
    );
    expect(res.status).toBe(404);
  });
});

// cf#114b: the error text a caller actually sees. The distinction is not cosmetic -- "not
// configured" about a correctly-configured credential is what sent a real tenant chasing a
// non-existent misconfiguration during the cf#99 finale.
describe("honest credential text: endpoint present + key absent reads as propagation", () => {
  const invoke = async (
    worker: Worker, hook: string, input: unknown,
    apiKey?: string, endpointId?: string, config: Record<string, unknown> = {},
  ) => {
    const res = await worker.fetch(
      new Request("https://m.internal/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hook, input, config, context: { project: "p", job_id: "j" } }),
      }),
      env(apiKey, endpointId),
    );
    return (await res.json()) as { ok: boolean; error?: string; output?: { degraded?: string } };
  };

  it("keyframe fails LOUD, and says retry rather than misconfiguration", async () => {
    const r = await invoke(keyframeWorker as unknown as Worker, "keyframe",
      { project: "p", bundle_key: "b" }, undefined, ENDPOINT);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not yet visible on this worker version");
    expect(r.error).not.toContain("not configured");
  });

  it("keyframe with BOTH absent still says not configured (the honest negative)", async () => {
    const r = await invoke(keyframeWorker as unknown as Worker, "keyframe",
      { project: "p", bundle_key: "b" }, undefined, undefined);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not configured");
    expect(r.error).not.toContain("not yet visible");
  });

  it("own-gpu fails LOUD with the same distinction", async () => {
    const notVisible = await invoke(ownGpuWorker as unknown as Worker, "motion.backend",
      { shot_id: "s1", keyframe_key: "k.png", prompt: "a shot" }, undefined, ENDPOINT);
    expect(notVisible.error).toContain("not yet visible on this worker version");
    const absent = await invoke(ownGpuWorker as unknown as Worker, "motion.backend",
      { shot_id: "s1", keyframe_key: "k.png", prompt: "a shot" }, undefined, undefined);
    expect(absent.error).toContain("not configured");
  });

  // The polish modules DEGRADE rather than fail (the #249/#77 discipline), so the distinction has to
  // survive into the degrade REASON -- otherwise the honest-degrade record itself carries the lie.
  it("finish-upscale degrades with runpod-key-not-yet-visible, not no-runpod-secrets", async () => {
    const notVisible = await invoke(finishUpscaleWorker as unknown as Worker, "finish",
      { shot_id: "s1", clip_key: "c.mp4" }, undefined, ENDPOINT);
    expect(notVisible.ok).toBe(true);
    expect(notVisible.output?.degraded).toBe("runpod-key-not-yet-visible");

    const absent = await invoke(finishUpscaleWorker as unknown as Worker, "finish",
      { shot_id: "s1", clip_key: "c.mp4" }, undefined, undefined);
    expect(absent.ok).toBe(true);
    expect(absent.output?.degraded).toBe("no-runpod-secrets");
  });

  it("finish-lipsync degrades with the same distinction", async () => {
    const notVisible = await invoke(finishLipsyncWorker as unknown as Worker, "finish",
      { shot_id: "s1", clip_key: "c.mp4", audio_key: "a.wav" }, undefined, ENDPOINT);
    expect(notVisible.ok).toBe(true);
    expect(notVisible.output?.degraded).toBe("runpod-key-not-yet-visible");

    const absent = await invoke(finishLipsyncWorker as unknown as Worker, "finish",
      { shot_id: "s1", clip_key: "c.mp4", audio_key: "a.wav" }, undefined, undefined);
    expect(absent.output?.degraded).toBe("no-runpod-secrets");
  });

  it("speech-upscale degrades with the same distinction", async () => {
    const notVisible = await invoke(speechUpscaleWorker as unknown as Worker, "speech",
      { shot_id: "s1", audio_key: "a.wav" }, undefined, ENDPOINT, { enable: true });
    expect(notVisible.ok).toBe(true);
    expect(notVisible.output?.degraded).toBe("runpod-key-not-yet-visible");

    const absent = await invoke(speechUpscaleWorker as unknown as Worker, "speech",
      { shot_id: "s1", audio_key: "a.wav" }, undefined, undefined, { enable: true });
    expect(absent.output?.degraded).toBe("no-runpod-secrets");
  });
});
