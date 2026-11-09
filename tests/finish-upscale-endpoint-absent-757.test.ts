// cf#757: a finish-upscale bound to a RunPod endpoint that does not exist says so in a structured field.
//
// Before this, a missing endpoint came back as `degraded: "runpod-run-failed: HTTP 404"` with
// `failure: { kind: "permanent", code: "refused" }`, the same shape as a bad request. Now it is its own
// degrade reason and its own failure code, `endpoint_absent`.
//
// The fixture is the MEASURED answer, not an assumption: with a valid key, against a missing endpoint
// id, RunPod returned HTTP 404 and this exact body on both /run and /health (lead, 2026-11-09). A 404
// with any other detail must stay a plain refusal, and the cases below hold that.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import finishUpscale from "../modules/finish-upscale/src/index";
import { runpodEndpointAbsent } from "../modules/_shared/runpod-endpoint-absent";

const MEASURED_BODY = JSON.stringify({ status: 404, title: "Not Found", detail: "endpoint not found" });
const JOB_GONE_BODY = JSON.stringify({ status: 404, title: "Not Found", detail: "job not found" });

type Worker = { fetch(r: Request, e: never): Promise<Response> };
const W = finishUpscale as unknown as Worker;
const INPUT = { shot_id: "shot_757", clip_key: "p/shot_757.mp4", src_fps: 24, frames: 96 };
const RUNPOD_ENV = { RUNPOD_API_KEY: "rpa_cf757_probe", RUNPOD_ENDPOINT_ID: "cf757missing01" };

let realFetch: typeof fetch;
beforeEach(() => { realFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = realFetch; });

function answer(status: number, body: string): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return urls;
}

async function invoke(env: unknown): Promise<{ ok: boolean; output: Record<string, unknown> }> {
  const res = await W.fetch(
    new Request("https://module.internal/invoke", {
      method: "POST",
      body: JSON.stringify({ hook: "finish", input: INPUT, config: {}, context: { project: "cf757" } }),
    }),
    env as never,
  );
  return (await res.json()) as { ok: boolean; output: Record<string, unknown> };
}

describe("cf#757: runpodEndpointAbsent recognises only the measured shape", () => {
  it("the measured 404 body is endpoint-absent", () => {
    expect(runpodEndpointAbsent(404, MEASURED_BODY)).toBe(true);
  });

  it.each([
    ["404, job not found", 404, JOB_GONE_BODY],
    ["404, detail in another case", 404, JSON.stringify({ status: 404, detail: "Endpoint not found" })],
    ["404, no detail", 404, JSON.stringify({ status: 404, title: "Not Found" })],
    ["404, not JSON", 404, "Not Found"],
    ["404, JSON null", 404, "null"],
    ["410 with the measured detail", 410, MEASURED_BODY],
    ["401 with the measured detail", 401, MEASURED_BODY],
  ])("%s is NOT endpoint-absent", (_label, status, body) => {
    expect(runpodEndpointAbsent(status as number, body as string)).toBe(false);
  });
});

describe("cf#757: through the real /invoke handler", () => {
  it("a missing endpoint is a soft degrade with failure code endpoint_absent", async () => {
    const urls = answer(404, MEASURED_BODY);
    const r = await invoke(RUNPOD_ENV);
    // CONTROL: the RunPod arm was taken, against the bound endpoint id.
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("api.runpod.ai");
    expect(urls[0]).toContain("cf757missing01/run");
    // Polish step: never fails the chain (#249/#77), and the degrade is never silent.
    expect(r.ok).toBe(true);
    expect(r.output.clip_key).toBe(INPUT.clip_key);
    expect(r.output.applied).toEqual(["passthrough:runpod-endpoint-absent"]);
    expect(String(r.output.degraded)).toMatch(/^runpod-endpoint-absent/);
    expect(r.output.failure).toEqual({ kind: "permanent", code: "endpoint_absent", detail: "HTTP 404: RunPod endpoint not found, this door has no backend" });
  });

  it("a 404 with any other detail stays a plain refusal", async () => {
    answer(404, JOB_GONE_BODY);
    const r = await invoke(RUNPOD_ENV);
    expect(r.ok).toBe(true);
    expect(r.output.applied).toEqual(["passthrough:runpod-run-failed"]);
    expect(r.output.failure).toMatchObject({ kind: "permanent", code: "refused" });
  });

  it("a 500 is unchanged: transient server_error", async () => {
    answer(500, MEASURED_BODY);
    const r = await invoke(RUNPOD_ENV);
    expect(r.output.applied).toEqual(["passthrough:runpod-run-failed"]);
    expect(r.output.failure).toMatchObject({ kind: "transient", code: "server_error" });
  });

  it("a DOOR returning the same body is not read as a missing RunPod endpoint", async () => {
    const urls = answer(404, MEASURED_BODY);
    const r = await invoke({ ...RUNPOD_ENV, FINISH_DOOR_TOKEN: "lft_cf757_door", FINISH_UPSCALE_DOORS: "https://finish-upscale-cf757.test" });
    expect(urls[0]).toContain("finish-upscale-cf757.test");
    expect(r.output.applied).toEqual(["passthrough:door-run-failed"]);
    expect(r.output.failure).toMatchObject({ code: "refused" });
  });
});
