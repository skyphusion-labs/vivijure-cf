// cf#295: the pre-phase-1 /ready gate covered 6 of 26 modules; the other 20 404'd, which a sweep
// cannot distinguish from "not implemented" -- a 404 is the ABSENCE of a verdict, not a verdict. This
// file drives the /ready endpoint this issue added to the remaining 20, grouped by the shape of what
// each module can honestly check (a single required secret, an optional/informational one, or a
// service binding). tests/module-ready.test.ts already covers the original six tenant RunPod modules
// (two required secrets + telemetry); this file does not repeat that shape.
//
// The shared discipline across every group, per docs/module-api.md "Credential readiness":
//   - booleans only, never a value, in every field these modules add;
//   - `ok` reflects what the code ACTUALLY requires (read from each module's own hard-fail guards),
//     never an invented verdict for a credential this endpoint cannot determine (cf#295's own
//     complaint about the old 404s: never answer a question you cannot see).
import { describe, it, expect } from "vitest";

import alibabaWanWorker from "../modules/alibaba-wan/src/index";
import alibabaWanLoraWorker from "../modules/alibaba-wan-lora/src/index";
import googleVeoWorker from "../modules/google-veo/src/index";
import klingWorker from "../modules/kling/src/index";
import minimaxHailuoWorker from "../modules/minimax-hailuo/src/index";
import narrationGenWorker from "../modules/narration-gen/src/index";
import seedanceWorker from "../modules/seedance/src/index";
import viduQ3Worker from "../modules/vidu-q3/src/index";
import dialogueGenWorker from "../modules/dialogue-gen/src/index";
import musicGenWorker from "../modules/music-gen/src/index";
import localGpuWorker from "../modules/local-gpu/src/index";
import castImageWorker from "../modules/cast-image/src/index";
import imageGenerateWorker from "../modules/image-generate/src/index";
import planEnhanceWorker from "../modules/plan-enhance/src/index";
import cloudKeyframeWorker from "../modules/cloud-keyframe/src/index";
import filmTitlesWorker from "../modules/film-titles/src/index";
import subtitleWorker from "../modules/subtitle/src/index";
import audioMasterWorker from "../modules/audio-master/src/index";
import beatSyncWorker from "../modules/beat-sync/src/index";
import notifyEmailWorker from "../modules/notify-email/src/index";

type Worker = { fetch(request: Request, env: never): Promise<Response> };

const KEY = "rpa_A_REAL_LOOKING_KEY_VALUE";

const get = async (worker: Worker, env: Record<string, unknown>, path = "/ready", method = "GET") => {
  const res = await worker.fetch(new Request("https://m.internal" + path, { method }), env as never);
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
};

// ---- Group A: a single RunPod API key, hard-required, no fallback -----------------------------
// The eight cloud i2v modules call a fixed PUBLIC RunPod endpoint URL baked into the code (not a
// per-tenant secret), so RUNPOD_API_KEY is the only credential worth reporting.
//
// cf#305 added `telemetry.job_log` here as well: these eight are the GPUless cost door, they now
// bind the studio D1 and write runpod_job_log rows, and a module that records must be able to say
// whether it can. The env below passes NO TELEMETRY_DB, so the honest answer is `unavailable` --
// asserted rather than omitted, because an absent field and a false one read the same to a sweep.
const RUNPOD_ONLY: { name: string; worker: Worker }[] = [
  { name: "alibaba-wan", worker: alibabaWanWorker as unknown as Worker },
  { name: "alibaba-wan-lora", worker: alibabaWanLoraWorker as unknown as Worker },
  { name: "google-veo", worker: googleVeoWorker as unknown as Worker },
  { name: "kling", worker: klingWorker as unknown as Worker },
  { name: "minimax-hailuo", worker: minimaxHailuoWorker as unknown as Worker },
  { name: "narration-gen", worker: narrationGenWorker as unknown as Worker },
  { name: "seedance", worker: seedanceWorker as unknown as Worker },
  { name: "vidu-q3", worker: viduQ3Worker as unknown as Worker },
];

describe.each(RUNPOD_ONLY)("$name: GET /ready (RunPod key, hard-required)", ({ name, worker }) => {
  it("ok:true, credentials visible, when the key is set", async () => {
    const { status, body } = await get(worker, { RUNPOD_API_KEY: KEY });
    expect(status).toBe(200);
    // cf#394: runpod_proxied is additive. runpod_api_key keeps its NAME because the control
    // plane parses that exact field and refuses a module whose /ready omits it; under the
    // proxy it means "the invoke credential this route needs is readable".
    expect(body).toEqual({
      ok: true, module: name, credentials: { runpod_api_key: true },
      runpod_proxied: false, telemetry: { job_log: "unavailable" },
    });
  });
  it("ok:false when the key is absent", async () => {
    const { body } = await get(worker, {});
    expect(body).toEqual({
      ok: false, module: name, credentials: { runpod_api_key: false },
      runpod_proxied: false, telemetry: { job_log: "unavailable" },
    });
  });
  it("cf#394: reports ok on the PROXIED route, holding no RunPod key at all", async () => {
    const { body } = await get(worker, {
      RUNPOD_PROXY_BASE: "https://proxy-probe.cf394.invalid/api/runpod/v2",
      RUNPOD_PROXY_TOKEN: "vjp1.ten_cf394probe.deadbeefcafe",
    });
    // A NON-DEFAULT base, so an honoured binding and an ignored one are distinguishable.
    expect(body).toEqual({
      ok: true, module: name, credentials: { runpod_api_key: true },
      runpod_proxied: true, telemetry: { job_log: "unavailable" },
    });
  });
  it("never leaks the key value", async () => {
    const res = await worker.fetch(new Request("https://m.internal/ready"), { RUNPOD_API_KEY: KEY } as never);
    const raw = await res.text();
    expect(raw).not.toContain(KEY);
    expect(JSON.stringify({ k: KEY })).toContain(KEY); // control: the string COULD have appeared
  });
  it("is a GET-only route", async () => {
    const { status } = await get(worker, { RUNPOD_API_KEY: KEY }, "/ready", "POST");
    expect(status).toBe(404);
  });
});

// ---- Group A2: GATEWAY_ID, hard-required, no fallback ------------------------------------------
const GATEWAY_REQUIRED: { name: string; worker: Worker }[] = [
  { name: "dialogue-gen", worker: dialogueGenWorker as unknown as Worker },
  { name: "music-gen", worker: musicGenWorker as unknown as Worker },
];

describe.each(GATEWAY_REQUIRED)("$name: GET /ready (GATEWAY_ID, hard-required)", ({ name, worker }) => {
  it("ok:true when GATEWAY_ID is set", async () => {
    const { body } = await get(worker, { GATEWAY_ID: "gw-1" });
    expect(body).toEqual({ ok: true, module: name, credentials: { gateway_id: true } });
  });
  it("ok:false when GATEWAY_ID is absent", async () => {
    const { body } = await get(worker, {});
    expect(body).toEqual({ ok: false, module: name, credentials: { gateway_id: false } });
  });
});

// ---- Group B: local-gpu -- one required secret, one optional -----------------------------------
describe("local-gpu: GET /ready (URL required, token optional)", () => {
  const worker = localGpuWorker as unknown as Worker;
  it("ok:true with just the URL (token is defense-in-depth, not required)", async () => {
    const { body } = await get(worker, { LOCAL_BACKEND_URL: "https://box.example" });
    expect(body).toEqual({
      ok: true,
      module: "local-gpu",
      credentials: { local_backend_url: true, local_backend_token: false },
    });
  });
  it("reports the token too when both are set", async () => {
    const { body } = await get(worker, { LOCAL_BACKEND_URL: "https://box.example", LOCAL_BACKEND_TOKEN: "tok" });
    expect(body).toEqual({
      ok: true,
      module: "local-gpu",
      credentials: { local_backend_url: true, local_backend_token: true },
    });
  });
  it("ok:false with no URL, even if a token is set (a token with nowhere to send it is not ready)", async () => {
    const { body } = await get(worker, { LOCAL_BACKEND_TOKEN: "tok" });
    expect(body).toEqual({
      ok: false,
      module: "local-gpu",
      credentials: { local_backend_url: false, local_backend_token: true },
    });
  });
});

// ---- Group C: informational credentials -- the module always has a working fallback ------------
// `ok` is never gated on these: each module's own code proves the credential is optional (a direct
// binding call that only conditionally routes through a gateway, or a free local-model fallback).
describe("cast-image: GET /ready (GATEWAY_ID informational)", () => {
  const worker = castImageWorker as unknown as Worker;
  it("ok:true regardless of GATEWAY_ID, reports visibility", async () => {
    expect((await get(worker, {})).body).toEqual({ ok: true, module: "cast-image", credentials: { gateway_id: false } });
    expect((await get(worker, { GATEWAY_ID: "gw" })).body).toEqual({ ok: true, module: "cast-image", credentials: { gateway_id: true } });
  });
});

describe("cloud-keyframe: GET /ready (GATEWAY_ID informational; conditionally required by config /ready cannot see)", () => {
  const worker = cloudKeyframeWorker as unknown as Worker;
  it("ok:true regardless of GATEWAY_ID, reports visibility", async () => {
    expect((await get(worker, {})).body).toEqual({ ok: true, module: "cloud-keyframe", credentials: { gateway_id: false } });
    expect((await get(worker, { GATEWAY_ID: "gw" })).body).toEqual({ ok: true, module: "cloud-keyframe", credentials: { gateway_id: true } });
  });
});

describe("image-generate: GET /ready (both credentials informational)", () => {
  const worker = imageGenerateWorker as unknown as Worker;
  it("ok:true with neither credential", async () => {
    expect((await get(worker, {})).body).toEqual({
      ok: true, module: "image-generate", credentials: { gateway_id: false, openai_api_key: false },
    });
  });
  it("ok:true with both, reports both visible", async () => {
    expect((await get(worker, { GATEWAY_ID: "gw", OPENAI_API_KEY: "sk-x" })).body).toEqual({
      ok: true, module: "image-generate", credentials: { gateway_id: true, openai_api_key: true },
    });
  });
});

describe("plan-enhance: GET /ready (Opus credentials informational; local fallback always works)", () => {
  const worker = planEnhanceWorker as unknown as Worker;
  it("ok:true with neither credential (local Workers AI fallback)", async () => {
    expect((await get(worker, {})).body).toEqual({
      ok: true, module: "plan-enhance", credentials: { gateway_id: false, cf_aig_token: false },
    });
  });
  it("ok:true with both, reports both visible", async () => {
    expect((await get(worker, { GATEWAY_ID: "gw", CF_AIG_TOKEN: "tok" })).body).toEqual({
      ok: true, module: "plan-enhance", credentials: { gateway_id: true, cf_aig_token: true },
    });
  });
});

// ---- Group D: service-binding readiness, gated (no credential involved, nothing to leak) -------
// A missing binding degrades the render (soft passthrough or, for beat-sync, a hard ok:false at
// /invoke), so `ok` mirrors what the module can actually do here, the same discipline as a required
// credential -- just reported under `bindings` instead of `credentials` since there is no secret.
const BINDING_GATED: { name: string; worker: Worker; envKey: string; bindingsKey: string }[] = [
  { name: "film-titles", worker: filmTitlesWorker as unknown as Worker, envKey: "VIDEO_FINISH_VPC", bindingsKey: "video_finish_vpc" },
  { name: "subtitle", worker: subtitleWorker as unknown as Worker, envKey: "VIDEO_FINISH_VPC", bindingsKey: "video_finish_vpc" },
  { name: "audio-master", worker: audioMasterWorker as unknown as Worker, envKey: "AUDIO_MASTER_VPC", bindingsKey: "audio_master_vpc" },
  { name: "beat-sync", worker: beatSyncWorker as unknown as Worker, envKey: "AUDIO_BEAT_SYNC_VPC", bindingsKey: "audio_beat_sync_vpc" },
];

describe.each(BINDING_GATED)("$name: GET /ready (binding-gated)", ({ name, worker, envKey, bindingsKey }) => {
  it("ok:true when the VPC binding is present", async () => {
    const { body } = await get(worker, { [envKey]: { fetch: async () => new Response("{}") } });
    expect(body).toEqual({ ok: true, module: name, bindings: { [bindingsKey]: true } });
  });
  it("ok:false when the VPC binding is absent", async () => {
    const { body } = await get(worker, {});
    expect(body).toEqual({ ok: false, module: name, bindings: { [bindingsKey]: false } });
  });
  it("is a GET-only route", async () => {
    const { status } = await get(worker, {}, "/ready", "POST");
    expect(status).toBe(404);
  });
});

// ---- Group E: notify-email -- binding informational, never gates ok ----------------------------
describe("notify-email: GET /ready (EMAIL binding informational)", () => {
  const worker = notifyEmailWorker as unknown as Worker;
  it("ok:true with no EMAIL binding (a no-op send, not a failure)", async () => {
    expect((await get(worker, {})).body).toEqual({ ok: true, module: "notify-email", bindings: { email: false } });
  });
  it("ok:true with the binding present, reports it visible", async () => {
    expect((await get(worker, { EMAIL: { send: async () => {} } })).body).toEqual({
      ok: true, module: "notify-email", bindings: { email: true },
    });
  });
});

// ---- Cross-cutting: cf#295's actual complaint -- no more 404s for any of the 26 modules --------
describe("cf#295: none of the newly-covered 20 modules 404 on GET /ready", () => {
  const ALL: { name: string; worker: Worker }[] = [
    ...RUNPOD_ONLY, ...GATEWAY_REQUIRED,
    { name: "local-gpu", worker: localGpuWorker as unknown as Worker },
    { name: "cast-image", worker: castImageWorker as unknown as Worker },
    { name: "cloud-keyframe", worker: cloudKeyframeWorker as unknown as Worker },
    { name: "image-generate", worker: imageGenerateWorker as unknown as Worker },
    { name: "plan-enhance", worker: planEnhanceWorker as unknown as Worker },
    ...BINDING_GATED,
    { name: "notify-email", worker: notifyEmailWorker as unknown as Worker },
  ];
  it.each(ALL)("$name answers 200, not 404, with zero config", async ({ worker }) => {
    const { status } = await get(worker, {});
    expect(status).toBe(200);
  });
  it("the roster itself is the expected 20 (positive control on this file's own coverage)", () => {
    expect(ALL.length).toBe(20);
  });
});
