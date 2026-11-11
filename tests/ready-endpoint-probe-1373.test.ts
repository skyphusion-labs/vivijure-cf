// vivijure-cf#1373: finish-upscale's GET /ready can say whether its RunPod endpoint exists, BEFORE a film
// runs. Agreed shape (lead, as the plane owner's delegate): opt-in with `?probe=endpoint`; the block is
// `endpoint: { present, checked_at }`; it never changes `ok`. Without the parameter /ready makes no
// network call and its body is unchanged.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import finishUpscale from "../modules/finish-upscale/src/index";
import { probeEndpointPresence } from "../modules/_shared/runpod-endpoint-absent";

const W = finishUpscale as unknown as { fetch(r: Request, env: never): Promise<Response> };
const RUNPOD_ENV = { RUNPOD_API_KEY: "rpa_cf1373_probe", RUNPOD_ENDPOINT_ID: "cf1373endpoint01" };
const MEASURED_ABSENT = JSON.stringify({ status: 404, title: "Not Found", detail: "endpoint not found" });

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
const ready = async (env: unknown, query = "") =>
  (await (await W.fetch(new Request(`https://m.internal/ready${query}`), env as never)).json()) as Record<string, unknown>;

describe("GET /ready without the probe is unchanged", () => {
  it("makes no network call and carries no endpoint block", async () => {
    const urls = answer(200, "{}");
    const b = await ready(RUNPOD_ENV);
    expect(urls).toEqual([]);
    expect("endpoint" in b).toBe(false);
    expect(b.ok).toBe(true);
  });
  it("another probe value is not the endpoint probe", async () => {
    const urls = answer(200, "{}");
    expect("endpoint" in (await ready(RUNPOD_ENV, "?probe=everything"))).toBe(false);
    expect(urls).toEqual([]);
  });
});

describe("GET /ready?probe=endpoint", () => {
  it("present: true on a 2xx from the endpoint's /health; ok unchanged", async () => {
    const urls = answer(200, JSON.stringify({ workers: { idle: 0 } }));
    const b = await ready(RUNPOD_ENV, "?probe=endpoint");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/\/cf1373endpoint01\/health$/);
    expect(b.endpoint).toMatchObject({ present: true });
    expect(typeof (b.endpoint as { checked_at: string }).checked_at).toBe("string");
    expect(b.ok).toBe(true);
  });
  it("present: false only on the measured missing-endpoint answer, and ok STILL unchanged", async () => {
    answer(404, MEASURED_ABSENT);
    const b = await ready(RUNPOD_ENV, "?probe=endpoint");
    expect(b.endpoint).toMatchObject({ present: false });
    expect(b.ok).toBe(true);
  });
  for (const [label, status, body] of [
    ["a job-level 404", 404, JSON.stringify({ detail: "job not found" })],
    ["a 401", 401, MEASURED_ABSENT],
    ["a 500", 500, "boom"],
  ] as [string, number, string][]) {
    it(`present: null on ${label}, with the reason`, async () => {
      answer(status, body);
      const b = await ready(RUNPOD_ENV, "?probe=endpoint");
      expect(b.endpoint).toMatchObject({ present: null, error: `health -> ${status}` });
    });
  }
  it("no credentials: present null, and nothing is called", async () => {
    const urls = answer(200, "{}");
    const b = await ready({}, "?probe=endpoint");
    expect(b.endpoint).toMatchObject({ present: null, error: "no RunPod credentials to probe with" });
    expect(urls).toEqual([]);
    expect(b.ok).toBe(false);
  });
  it("served by a door: present null, nothing is called", async () => {
    const urls = answer(200, "{}");
    const b = await ready({ FINISH_DOOR_TOKEN: "lft_1373", FINISH_UPSCALE_DOORS: "https://finish-upscale-a.test" }, "?probe=endpoint");
    expect(b.endpoint).toMatchObject({ present: null, error: "served by a door, not a RunPod endpoint" });
    expect(urls).toEqual([]);
  });
});

describe("probeEndpointPresence", () => {
  const at = () => new Date("2026-11-11T12:00:00Z");
  it("an unreachable endpoint is null with the error, never a guess", async () => {
    expect(await probeEndpointPresence(async () => { throw new Error("dns"); }, at))
      .toEqual({ present: null, checked_at: "2026-11-11T12:00:00.000Z", error: "health unreachable: dns" });
  });
  it("calls /health", async () => {
    const paths: string[] = [];
    await probeEndpointPresence(async (p) => (paths.push(p), new Response("{}")), at);
    expect(paths).toEqual(["/health"]);
  });
});
