import { describe, expect, it } from "vitest";
import vidu, { CfViduQ3TurboWorkflow } from "../modules/cf-vidu-q3-turbo/src/index";
import { encodePoll, stateKey } from "../modules/cf-vidu-q3-turbo/src/params";

// The door keeps the model's talking audio by default, so a finished clip has to say so on poll.
// Core copies has_audio onto the shot only when it is a boolean.

function env() {
  const store = new Map<string, string | ArrayBuffer>();
  return {
    store,
    GATEWAY_ID: "gw",
    AI: { run: async () => ({ state: "Completed", result: { video: "https://cdn.example/x.mp4" } }) },
    R2_RENDERS: {
      put: async (k: string, v: string | ArrayBuffer) => { store.set(k, v); },
      get: async (k: string) => {
        const o = store.get(k);
        return o === undefined ? null : { text: async () => o as string, arrayBuffer: async () => o as ArrayBuffer };
      },
    },
  };
}

async function runAndPoll(generate_audio: boolean) {
  const e = env();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch;
  try {
    const wf = new CfViduQ3TurboWorkflow({} as never, e as never);
    await wf.run(
      {
        payload: {
          job_id: "job-1",
          project: "p",
          shot_id: "shot_01",
          seconds: 5,
          input: { shot_id: "shot_01", keyframe_url: "https://r2.example/k.png", prompt: "p", seconds: 5 },
          config: { resolution: "720p", generate_audio },
        },
      } as never,
      { do: async (_n: string, _c: unknown, fn: () => Promise<void>) => fn() } as never,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(e.store.has(stateKey("job-1"))).toBe(true);
  const resp = await (vidu as unknown as { fetch(r: Request, env: never, ctx: never): Promise<Response> }).fetch(
    new Request("http://module/poll", { method: "POST", body: JSON.stringify({ poll: encodePoll({ job_id: "job-1" }) }) }),
    e as never,
    {} as never,
  );
  return (await resp.json()) as { ok: boolean; output?: { has_audio?: unknown; clip_key?: string } };
}

describe("cf-vidu-q3-turbo reports has_audio", () => {
  it("true when the model's talking audio is kept", async () => {
    const r = await runAndPoll(true);
    expect(r.ok).toBe(true);
    expect(r.output?.clip_key).toBeTruthy();
    expect(r.output?.has_audio).toBe(true);
  });

  it("false when it is off, as a boolean, so core records it", async () => {
    expect((await runAndPoll(false)).output?.has_audio).toBe(false);
  });
});
