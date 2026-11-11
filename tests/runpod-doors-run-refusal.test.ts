import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyInvokeFailure } from "@skyphusion-labs/vivijure-core/render-orchestrator";
import localGpu from "../modules/local-gpu/src/index";
import minimax from "../modules/minimax-hailuo/src/index";
import narration from "../modules/narration-gen/src/index";
import infinitetalk from "../modules/infinitetalk/src/index";
import wanLora from "../modules/alibaba-wan-lora/src/index";
import ownGpu from "../modules/own-gpu/src/index";
import wan from "../modules/alibaba-wan/src/index";

// cf#1272: after cf#1271 fixed the keyframe door, seven more RunPod doors still reported a refused /run as a bare
// status ("infinitetalk /run -> 409"). Core read that as final. Each door must now say why and declare 409 and 5xx
// upstream-unavailable and 429 rate-limited, judged by core's real classifier.

type Worker = { fetch(req: Request, env: never, ctx: never): Promise<Response> };

const motion = {
  hook: "motion.backend",
  input: { shot_id: "s1", keyframe_url: "https://k/x.png", prompt: "walk", audio_url: "https://k/a.mp3", duration: 5 },
  config: {},
  context: { project: "p", job_id: "j" },
};
const keyframe = {
  hook: "keyframe",
  input: { project: "p", bundle_key: "bundles/p-1.tar.gz" },
  config: {},
  context: { project: "p", job_id: "j" },
};
const score = {
  hook: "score",
  input: { film_key: "renders/p/film.mp4", project: "p" },
  config: { text: "Hello there." },
  context: { project: "p", job_id: "j" },
};
const runpodEnv = { RUNPOD_API_KEY: "k", RUNPOD_ENDPOINT_ID: "ep123" } as never;
const localEnv = { LOCAL_BACKEND_URL: "https://local.example" } as never;

const DOORS: Array<[string, string, Worker, unknown, unknown]> = [
  ["local-gpu", "local-gpu", localGpu as unknown as Worker, motion, localEnv],
  ["local-gpu keyframe", "local-gpu keyframe", localGpu as unknown as Worker, keyframe, localEnv],
  ["minimax-hailuo", "minimax-hailuo", minimax as unknown as Worker, motion, runpodEnv],
  ["narration-gen", "narration-gen", narration as unknown as Worker, score, runpodEnv],
  ["infinitetalk", "infinitetalk", infinitetalk as unknown as Worker, motion, runpodEnv],
  ["alibaba-wan-lora", "alibaba-wan-lora", wanLora as unknown as Worker, motion, runpodEnv],
  ["own-gpu", "own-gpu", ownGpu as unknown as Worker, motion, runpodEnv],
  ["alibaba-wan", "alibaba-wan", wan as unknown as Worker, motion, runpodEnv],
];

async function invoke(w: Worker, body: unknown, env: unknown, status: number, resBody: string) {
  vi.stubGlobal("fetch", vi.fn(async (u: string) =>
    String(u).endsWith("/run") ? new Response(resBody, { status }) : new Response("{}", { status: 200 })));
  const req = new Request("http://m/invoke", { method: "POST", body: JSON.stringify(body) });
  return (await (await w.fetch(req, env as never, {} as never)).json()) as { ok: boolean; error?: string; reason?: string };
}

describe.each(DOORS)("%s: a refused /run", (_n, label, worker, body, env) => {
  afterEach(() => vi.unstubAllGlobals());

  it("a 409 says why and core tries again", async () => {
    const r = await invoke(worker, body, env, 409, '{"error":"endpoint update in progress"}');
    expect(r.ok).toBe(false);
    expect(r.error).toBe(`${label} /run -> 409: endpoint update in progress`);
    expect(r.reason).toBe("upstream-unavailable");
    expect(classifyInvokeFailure(r as never)).toBe("transient");
  });

  it("a 429 is rate-limited and a 503 is upstream-unavailable", async () => {
    expect((await invoke(worker, body, env, 429, "{}")).reason).toBe("rate-limited");
    expect((await invoke(worker, body, env, 503, "{}")).reason).toBe("upstream-unavailable");
  });

  it("a 400 stays final", async () => {
    const r = await invoke(worker, body, env, 400, '{"error":"bad field"}');
    expect(r.error).toBe(`${label} /run -> 400: bad field`);
    expect(r.reason).toBeUndefined();
    expect(classifyInvokeFailure(r as never)).toBe("deterministic");
  });

  it("never shows a credential or URL the body echoes back", async () => {
    const echo = JSON.stringify({ error: "bad input secret=AKIAABCDEFGHIJKLMNOPQRSTUVWXYZ0123 at https://acct.r2.cloudflarestorage.com/b/k?X-Amz-Signature=deadbeef" });
    const r = await invoke(worker, body, env, 400, echo);
    expect(r.error).not.toMatch(/AKIA|r2\.cloudflarestorage|Signature|deadbeef/);
  });
});
