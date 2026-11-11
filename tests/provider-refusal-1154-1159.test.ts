import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyTransientFailure } from "@skyphusion-labs/vivijure-core/render-orchestrator";
import { callWithRefusals, readRefusal, refusalFromLog } from "../modules/_shared/gateway-log";
import { CfPVideoAvatarWorkflow } from "../modules/cf-p-video-avatar/src/index";
import { CfVeoWorkflow } from "../modules/cf-veo/src/index";
import { generateClip as veoGenerateClip } from "../modules/cf-veo/src/generate";
import { buildParams as avatarParams } from "../modules/cf-p-video-avatar/src/params";

// cf#1154 / cf#1159. The response heads below are the provider replies the lead read from the AI Gateway log
// on 2026-11-05 (`skyphusion-llm`, success=false), trimmed to what the map reads.
const MODERATION = '{"state":"Failed","error":"Model execution failed (User Input Error): Prediction failed: Async prediction failed: ValueError: Content moderation: Blocked by content policy (violence). Enforced by the safety checker, can be disabled: violence"}';
const BALANCE = '{"state":"Failed","error":"Insufficient balance; add money to your gateway or use BYOK"}';
const VEO_500 = '{"state":"Failed","error":"Model execution failed"}';
const BASE64 = '{"state":"Failed","error":"Model execution failed (User Input Error): Async process failed with the following error: Invalid base64 encoded bytes."}';

describe("refusalFromLog maps the logged replies to plain words", () => {
  it("avatar moderation 400, violence", () => {
    expect(refusalFromLog({ status_code: 400, response_head: MODERATION }))
      .toBe("The video service refused this shot as violent, by its own safety check. Change the shot's wording or pick another style.");
  });
  it("another policy category is named, and a bare moderation line still maps", () => {
    expect(refusalFromLog({ status_code: 400, response_head: "Blocked by content policy (nudity)" })).toContain("under its nudity rule");
    expect(refusalFromLog({ status_code: 400, response_head: "Content moderation: blocked" })).toContain("under its content rules");
  });
  it("402 credit balance", () => {
    expect(refusalFromLog({ status_code: 402, response_head: BALANCE })).toMatch(/^The AI credit balance ran out/);
  });
  it("veo 500 with no detail", () => {
    expect(refusalFromLog({ status_code: 500, response_head: VEO_500 })).toMatch(/^The video service failed on this shot and gave no reason/);
  });
  it("our own bad base64 says it is a studio bug", () => {
    expect(refusalFromLog({ status_code: 400, response_head: BASE64 })).toMatch(/studio bug/);
  });
  it("an entry we do not know is not mapped", () => {
    expect(refusalFromLog({ status_code: 400, response_head: '{"error":"something else"}' })).toBeNull();
    expect(refusalFromLog({ status_code: 503, response_head: "" })).toBeNull();
  });
  it("every mapped sentence reads as deterministic to core, with a log id on it, so none is resubmitted", () => {
    for (const head of [MODERATION, BALANCE, VEO_500, BASE64]) {
      const status = head === BALANCE ? 402 : head === VEO_500 ? 500 : 400;
      const words = `${refusalFromLog({ status_code: status, response_head: head })} (gateway log 01JC7003ABCDEF)`;
      expect(classifyTransientFailure(words), words).toBe("deterministic");
    }
  });
  it("CONTROL: the bare provider code IS read as transient, which is what bought three submits", () => {
    expect(classifyTransientFailure("AiGatewayError: 7003: User Input Error")).toBe("transient");
  });
  it("never carries the provider's 'can be disabled' advice", () => {
    expect(refusalFromLog({ status_code: 400, response_head: MODERATION })).not.toMatch(/disab/i);
  });
});

describe("readRefusal", () => {
  const reader = (getLog: (id: string) => Promise<{ status_code: number; response_head?: string }>, logId: string | null = "L1") => ({
    aiGatewayLogId: logId,
    gateway: vi.fn(() => ({ getLog: vi.fn(getLog) })),
  });
  const now = { sleep: async () => {} };

  it("reads the failed call's own log entry from the named gateway", async () => {
    const ai = reader(async () => ({ status_code: 402, response_head: BALANCE }));
    expect(await readRefusal(ai, "gw", now)).toMatch(/credit balance/);
    expect(ai.gateway).toHaveBeenCalledWith("gw");
  });
  it("waits for an entry that is not written yet", async () => {
    let n = 0;
    const ai = reader(async () => { if (n++ < 2) throw new Error("AiGatewayLogNotFound"); return { status_code: 500, response_head: VEO_500 }; });
    expect(await readRefusal(ai, "gw", now)).toMatch(/failed on this shot/);
  });
  it("gives up after its attempts and returns null, never throws", async () => {
    const ai = reader(async () => { throw new Error("nope"); });
    expect(await readRefusal(ai, "gw", { ...now, attempts: 2 })).toBeNull();
  });
  it("needs a log id and a reader", async () => {
    expect(await readRefusal(reader(async () => ({ status_code: 402 }), null), "gw", now)).toBeNull();
    expect(await readRefusal({ aiGatewayLogId: "L1" }, "gw", now)).toBeNull();
  });
});

describe("callWithRefusals", () => {
  const now = { sleep: async () => {} };
  it("a mapped refusal comes back as { refused } with its log id", async () => {
    const ai = { aiGatewayLogId: "L9", gateway: () => ({ getLog: async () => ({ status_code: 400, response_head: MODERATION }) }) };
    const r = await callWithRefusals(ai, "gw", async () => { throw new Error("7003: User Input Error"); }, now);
    expect(r).toEqual({ refused: expect.stringMatching(/refused this shot as violent.*\(gateway log L9\)$/) });
  });
  it("an unknown failure keeps the provider's own error, with its log id, as before", async () => {
    const ai = { aiGatewayLogId: "L9", gateway: () => ({ getLog: async () => ({ status_code: 400, response_head: "{}" }) }) };
    await expect(callWithRefusals(ai, "gw", async () => { throw new Error("7003: User Input Error"); }, now))
      .rejects.toThrow("7003: User Input Error (gateway log L9)");
  });
  it("CONTROL: a success is returned untouched and reads no log", async () => {
    const gateway = vi.fn();
    expect(await callWithRefusals({ aiGatewayLogId: "x", gateway }, "gw", async () => ({ video: "v" }), now)).toEqual({ video: "v" });
    expect(gateway).not.toHaveBeenCalled();
  });
});

// The doors, end to end over a step fake that honours `retries.limit` as a workflow does.
type Ctor = new (ctx: never, env: never) => { run(event: never, step: never): Promise<void> };
const step = {
  do: async (_name: string, config: { retries?: { limit: number } }, fn: () => Promise<unknown>) => {
    const tries = (config.retries?.limit ?? 0) + 1;
    let last: unknown;
    for (let i = 0; i < tries; i++) {
      try { return await fn(); } catch (e) { last = e; }
    }
    throw last;
  },
};
const payload = {
  job_id: "job-1", project: "p", shot_id: "shot_02", seconds: 6,
  input: { shot_id: "shot_02", keyframe_url: "https://r2.example/k.png", prompt: "p", seconds: 6, audio_url: "https://r2.example/a.wav" },
  config: { resolution: "720p", aspect_ratio: "16:9", generate_audio: true },
};

describe.each([
  ["cf-p-video-avatar", CfPVideoAvatarWorkflow as unknown as Ctor, MODERATION, 400, /refused this shot as violent/],
  ["cf-veo", CfVeoWorkflow as unknown as Ctor, VEO_500, 500, /failed on this shot and gave no reason/],
])("%s", (_name, Workflow, head, status, words) => {
  afterEach(() => vi.unstubAllGlobals());

  function harness(withLog: boolean) {
    const store = new Map<string, string>();
    const env = {
      GATEWAY_ID: "gw",
      AI: {
        aiGatewayLogId: "01JLOG" as string | null,
        run: vi.fn(async () => { throw new Error("AiGatewayError: 7003: User Input Error"); }),
        gateway: vi.fn(() => ({
          getLog: async () => { if (!withLog) throw new Error("AiGatewayLogNotFound"); return { status_code: status, response_head: head }; },
        })),
      },
      R2_RENDERS: { put: async (k: string, v: string) => { store.set(k, v); }, get: async () => null },
    };
    const last = () => [...store.entries()].filter(([k]) => k.endsWith(".state.json")).map(([, v]) => JSON.parse(v) as { status: string; error?: string }).at(-1);
    return { env, last };
  }
  const run = (env: unknown) => new Workflow({} as never, env as never).run({ payload } as never, step as never);

  it("a refusal its log names is ONE provider call, and the film reads it in plain words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } })));
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => { fn(); return 0; }) as never);
    const h = harness(true);
    await run(h.env);
    expect(h.env.AI.run).toHaveBeenCalledTimes(1);
    const st = h.last();
    expect(st?.status).toBe("failed");
    expect(st?.error).toMatch(words);
    expect(st?.error).toMatch(/\(gateway log 01JLOG\)$/);
    expect(classifyTransientFailure(st?.error)).toBe("deterministic");
  });

  it("CONTROL: with no readable log the door fails as before, and the step retries the call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } })));
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => { fn(); return 0; }) as never);
    const h = harness(false);
    await run(h.env);
    expect(h.env.AI.run).toHaveBeenCalledTimes(3);
    expect(h.last()?.error).toBe("AiGatewayError: 7003: User Input Error (gateway log 01JLOG)");
  });
});

describe("the avatar door never switches the provider's safety checker off", () => {
  it("disable_safety_filter stays false", () => {
    const p = avatarParams({ shot_id: "s", keyframe_url: "k", prompt: "p", audio_url: "a" } as never, { resolution: "720p" });
    expect(p.disable_safety_filter).toBe(false);
  });
});

// cf#1159 ruling 1. The log's six "Invalid base64 encoded bytes" (2026-10-30, 19:12Z to 19:15Z) fall inside
// the window when #1086 sent a data: URI (17:13Z) and before #1102 sent bare base64 (19:32Z). Main sends bare
// base64. This holds the exact string the door hands the provider, across chunk boundaries, byte for byte.
describe("cf-veo sends the keyframe as exact bare base64", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("the image_input generateClip passes to env.AI.run decodes to the fetched bytes", async () => {
    const bytes = new Uint8Array(100_003);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 131 + 7) % 256;  // varied, so a chunk mix-up shows
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { status: 200, headers: { "content-type": "image/png" } })));
    let sent: Record<string, unknown> = {};
    const env = { GATEWAY_ID: "gw", AI: { run: vi.fn(async (_m: string, params: Record<string, unknown>) => { sent = params; return { video: "v" }; }) } };
    await veoGenerateClip(env as never, payload as never);
    const b64 = sent.image_input as string;
    expect(b64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(b64.startsWith("data:")).toBe(false);
    const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(back.length).toBe(bytes.length);
    expect(back.every((b, i) => b === bytes[i])).toBe(true);
  });
});
