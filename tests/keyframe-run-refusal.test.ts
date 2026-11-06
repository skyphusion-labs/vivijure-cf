import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyInvokeFailure } from "@skyphusion-labs/vivijure-core/render-orchestrator";
import kfWorker from "../modules/keyframe/src/index";
import { runpodSubmitFailure, safeSubmitDetail, submitFailureReason } from "../modules/_shared/runpod-submit-error";

// Measured 2026-11-06: three studio keyframes-only renders failed with only "keyframe /run -> 409", each 7 to 25 s
// after the endpoint moved to a new version, and a film 11 s later went through. Core read the bare status as final.

describe("safeSubmitDetail", () => {
  it("keeps the provider's own reason", () => {
    expect(safeSubmitDetail('{"error":"endpoint is being updated, try again"}')).toBe("endpoint is being updated, try again");
    expect(safeSubmitDetail('{"message":"Conflict"}')).toBe("Conflict");
  });
  it("never shows a credential or a URL the body echoes back", () => {
    const echo = JSON.stringify({ error: "bad input r2 secret_access_key=AKIAABCDEFGHIJKLMNOPQRSTUVWXYZ0123 at https://acct.r2.cloudflarestorage.com/b/k?X-Amz-Signature=deadbeef" });
    const out = safeSubmitDetail(echo);
    expect(out).not.toMatch(/AKIA|r2\.cloudflarestorage|Signature|deadbeef/);
    expect(out).toContain("[url]");
    expect(out).toContain("[redacted]");
  });
  it("shows nothing for a body that is not JSON, or has no reason field", () => {
    expect(safeSubmitDetail("<html>conflict</html>")).toBe("");
    expect(safeSubmitDetail('{"input":{"bundle_key":"x"}}')).toBe("");
  });
  it("is one line and capped", () => {
    const out = safeSubmitDetail(JSON.stringify({ error: "a\nb " + "word ".repeat(100) }));
    expect(out).not.toMatch(/\n/);
    expect(out.length).toBeLessThanOrEqual(203);
  });
});

describe("submitFailureReason", () => {
  it.each([[409, "upstream-unavailable"], [500, "upstream-unavailable"], [503, "upstream-unavailable"], [429, "rate-limited"], [400, undefined], [401, undefined], [404, undefined]])(
    "%i -> %s", (status, want) => expect(submitFailureReason(status)).toBe(want));
});

describe("runpodSubmitFailure against core's real classifier", () => {
  const res = (status: number, body: string) => ({ status, text: async () => body });
  it("a 409 says why and is retried by core", async () => {
    const f = await runpodSubmitFailure("keyframe", res(409, '{"error":"endpoint update in progress"}'));
    expect(f).toEqual({ ok: false, error: "keyframe /run -> 409: endpoint update in progress", reason: "upstream-unavailable" });
    expect(classifyInvokeFailure(f)).toBe("transient");
  });
  it("CONTROL: the bare 409 core saw before is final", () => {
    expect(classifyInvokeFailure({ error: "keyframe /run -> 409" })).toBe("deterministic");
  });
  it("a 400 stays final", async () => {
    const f = await runpodSubmitFailure("keyframe", res(400, '{"error":"bad field"}'));
    expect(f.reason).toBeUndefined();
    expect(classifyInvokeFailure(f)).toBe("deterministic");
  });
  it("an unreadable body still reports the status", async () => {
    const f = await runpodSubmitFailure("keyframe", { status: 502, text: async () => { throw new Error("stream"); } });
    expect(f.error).toBe("keyframe /run -> 502");
    expect(f.reason).toBe("upstream-unavailable");
  });
});

describe("the keyframe module's /invoke on a refused /run", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("returns the reason and the declared fault class", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) =>
      String(u).endsWith("/run") ? new Response('{"error":"endpoint update in progress"}', { status: 409 }) : new Response("{}", { status: 200 })));
    const env = { RUNPOD_API_KEY: "k", RUNPOD_ENDPOINT_ID: "ep123" } as unknown as Parameters<typeof kfWorker.fetch>[1];
    const req = new Request("http://m/invoke", {
      method: "POST",
      body: JSON.stringify({ hook: "keyframe", input: { project: "p", bundle_key: "bundles/p-1.tar.gz" }, config: {}, context: { project: "p", job_id: "j" } }),
    });
    const r = (await (await kfWorker.fetch(req, env, {} as never)).json()) as { ok: boolean; error?: string; reason?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe("keyframe /run -> 409: endpoint update in progress");
    expect(r.reason).toBe("upstream-unavailable");
  });
});
