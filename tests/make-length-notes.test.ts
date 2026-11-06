// cf#1067 follow-up: the Make a video page tells a first-time creator, before anything starts, when the
// chosen style will not make a scene at its planned length. The rule lives in the studio
// (src/door-duration-preflight.ts); the page only words the numbers. So this runs the REAL preflight
// route against the REAL cf-veo manifest and hands its answer to the page's own lengthNote, which is
// the path the page takes. No copy of the rule exists to drift.
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { _resetModuleDiscoveryCache } from "@skyphusion-labs/vivijure-core/modules/registry";
import cfVeoWorker from "../modules/cf-veo/src/index";
import { lengthNote, talkingStyleLine } from "../public/make-style.js";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
type Door = { fetch(request: Request, env: never): Promise<Response> };
const env = () => ({
  ALLOW_UNAUTHENTICATED: "true",
  ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
  MODULE_CF_VEO: { fetch: (input: string, init?: RequestInit) => (cfVeoWorker as unknown as Door).fetch(new Request(input, init), {} as never) },
}) as unknown as Env;

async function notesFor(seconds: number[]): Promise<string[]> {
  const scenes = seconds.map((s, i) => ({ id: `shot_0${i + 1}`, prompt: "a wide neon alley in the rain at night", target_seconds: s }));
  const res = await worker.fetch(new Request("https://studio.example/api/storyboard/preflight", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ storyboard: { title: "len", scenes }, motion_backend: "cf-veo" }),
  }), env(), ctx);
  expect(res.status).toBe(200);
  const out = (await res.json()) as { issues: unknown[] };
  return out.issues.map((i) => lengthNote(i as never)).filter(Boolean);
}

describe("Make page length notes, from the studio's own check", () => {
  beforeEach(() => _resetModuleDiscoveryCache());

  it("a 20 second scene on cf-veo is told it will be cut to 8", async () => {
    expect(await notesFor([6, 20])).toEqual([
      "Scene 2 is 20 seconds. This style makes clips of at most 8 seconds, so it will be cut to 8 seconds.",
    ]);
  });
  it("a scene between steps is told the lengths the style makes", async () => {
    expect(await notesFor([5])).toEqual([
      "Scene 1 is 5 seconds. This style makes clips of 4, 6 or 8 seconds, so it will not be exactly 5 seconds.",
    ]);
  });
  it("scenes that fit say nothing", async () => {
    expect(await notesFor([4, 6, 8])).toEqual([]);
  });
  it("an issue with no numbers words nothing", () => {
    expect(lengthNote({ level: "warning", scope: "storyboard", message: "x" } as never)).toBe("");
  });
});

describe("#1253 ruling: one talking style for the whole video, said plainly", () => {
  const talker = { name: "t", usage: { native_audio: true } };
  const line = "Some scenes in this video speak, so the whole video uses a talking style.";
  const board = (lines: boolean[]) => ({ scenes: lines.map((l) => (l ? { prompt: "p", dialogue: { slot: "A", text: "Hi" } } : { prompt: "p" })) });
  it("some scenes speak: the line is shown", () => expect(talkingStyleLine(board([true, false]), talker as never)).toBe(line));
  it("every scene speaks: nothing to explain", () => expect(talkingStyleLine(board([true, true]), talker as never)).toBe(""));
  it("no scene speaks: nothing to explain", () => expect(talkingStyleLine(board([false, false]), talker as never)).toBe(""));
});
