// Every motion.backend door stamps filmmaker copy + an honest usage envelope.
// Blurbs are film cards, not API jargon. usage matches how WE call the door.

import { describe, expect, it } from "vitest";

import alibabaWanWorker from "../modules/alibaba-wan/src/index";
import alibabaWanLoraWorker from "../modules/alibaba-wan-lora/src/index";
import cfFlux3VideoWorker from "../modules/cf-flux-3-video/src/index";
import cfGrokVideoWorker from "../modules/cf-grok-video/src/index";
import cfHh1R2vWorker from "../modules/cf-hh1-r2v/src/index";
import cfSeedanceWorker from "../modules/cf-seedance/src/index";
import cfWan27Worker from "../modules/cf-wan-27/src/index";
import googleVeoWorker from "../modules/google-veo/src/index";
import klingWorker from "../modules/kling/src/index";
import localGpuWorker from "../modules/local-gpu/src/index";
import minimaxHailuoWorker from "../modules/minimax-hailuo/src/index";
import ownGpuWorker from "../modules/own-gpu/src/index";
import seedanceWorker from "../modules/seedance/src/index";
import viduQ3Worker from "../modules/vidu-q3/src/index";

type Worker = { fetch(request: Request, env: never): Promise<Response> };

type Usage = {
  native_audio: boolean;
  voice: string;
  scatter_native_audio: boolean;
  min_seconds: number;
  max_seconds: number;
  duration_steps?: number[];
  first_last?: boolean;
  seed?: boolean;
};

type Manifest = {
  name: string;
  hooks: string[];
  provides?: { id: string; label: string }[];
  ui?: { blurb?: string; limits?: string[]; cost?: string };
  usage?: Usage;
};

const VOICES = new Set(["prompt_lock", "seed_and_prompt", "cast_tts", "prev_clip"]);
const JARGON = /i2v|Unified Billing|endpoint|schema|RunPod|Workers AI|generate_audio/i;

const DOORS: { name: string; worker: Worker; usage: Usage }[] = [
  {
    name: "cf-flux-3-video",
    worker: cfFlux3VideoWorker as unknown as Worker,
    usage: {
      native_audio: true, voice: "prompt_lock", scatter_native_audio: false,
      min_seconds: 5, max_seconds: 20, duration_steps: [5, 10, 15, 20], first_last: true, seed: false,
    },
  },
  {
    name: "cf-seedance",
    worker: cfSeedanceWorker as unknown as Worker,
    usage: {
      native_audio: true, voice: "seed_and_prompt", scatter_native_audio: false,
      min_seconds: 4, max_seconds: 30, first_last: true, seed: true,
    },
  },
  {
    name: "seedance",
    worker: seedanceWorker as unknown as Worker,
    usage: {
      native_audio: true, voice: "seed_and_prompt", scatter_native_audio: false,
      min_seconds: 4, max_seconds: 12, first_last: true, seed: true,
    },
  },
  {
    name: "google-veo",
    worker: googleVeoWorker as unknown as Worker,
    usage: {
      native_audio: true, voice: "prompt_lock", scatter_native_audio: false,
      min_seconds: 4, max_seconds: 8, duration_steps: [4, 6, 8], first_last: false, seed: false,
    },
  },
  {
    name: "vidu-q3",
    worker: viduQ3Worker as unknown as Worker,
    usage: {
      native_audio: true, voice: "prompt_lock", scatter_native_audio: false,
      min_seconds: 3, max_seconds: 10,
    },
  },
  {
    name: "cf-grok-video",
    worker: cfGrokVideoWorker as unknown as Worker,
    usage: {
      native_audio: true, voice: "prompt_lock", scatter_native_audio: false,
      min_seconds: 1, max_seconds: 15,
    },
  },
  {
    name: "cf-wan-27",
    worker: cfWan27Worker as unknown as Worker,
    usage: {
      native_audio: true, voice: "prompt_lock", scatter_native_audio: false,
      min_seconds: 2, max_seconds: 15, first_last: true, seed: true,
    },
  },
  {
    name: "kling",
    worker: klingWorker as unknown as Worker,
    usage: {
      native_audio: false, voice: "cast_tts", scatter_native_audio: true,
      min_seconds: 5, max_seconds: 10, duration_steps: [5, 10],
    },
  },
  {
    name: "minimax-hailuo",
    worker: minimaxHailuoWorker as unknown as Worker,
    usage: {
      native_audio: false, voice: "cast_tts", scatter_native_audio: true,
      min_seconds: 6, max_seconds: 10, duration_steps: [6, 10],
    },
  },
  {
    name: "alibaba-wan",
    worker: alibabaWanWorker as unknown as Worker,
    usage: {
      native_audio: true, voice: "prompt_lock", scatter_native_audio: false,
      min_seconds: 5, max_seconds: 15, duration_steps: [5, 10, 15],
    },
  },
  {
    name: "alibaba-wan-lora",
    worker: alibabaWanLoraWorker as unknown as Worker,
    usage: {
      native_audio: false, voice: "cast_tts", scatter_native_audio: false,
      min_seconds: 5, max_seconds: 8, duration_steps: [5, 8], seed: true,
    },
  },
  {
    name: "cf-hh1-r2v",
    worker: cfHh1R2vWorker as unknown as Worker,
    usage: {
      native_audio: false, voice: "cast_tts", scatter_native_audio: false,
      min_seconds: 3, max_seconds: 15, first_last: true, seed: true,
    },
  },
  {
    name: "own-gpu",
    worker: ownGpuWorker as unknown as Worker,
    usage: {
      native_audio: false, voice: "cast_tts", scatter_native_audio: false,
      min_seconds: 2, max_seconds: 8, seed: true,
    },
  },
  {
    name: "local-gpu",
    worker: localGpuWorker as unknown as Worker,
    usage: {
      native_audio: false, voice: "cast_tts", scatter_native_audio: false,
      min_seconds: 2, max_seconds: 8, seed: true,
    },
  },
];

async function moduleJson(worker: Worker): Promise<Manifest> {
  const res = await worker.fetch(new Request("https://module/module.json"), {} as never);
  expect(res.status).toBe(200);
  return (await res.json()) as Manifest;
}

describe.each(DOORS)("$name filmmaker card + usage", ({ name, worker, usage }) => {
  it("GET /module.json stamps usage, limits, and filmmaker copy", async () => {
    const m = await moduleJson(worker);
    expect(m.name).toBe(name);
    expect(m.hooks).toContain("motion.backend");
    expect(m.usage).toBeDefined();
    expect(VOICES.has(m.usage!.voice)).toBe(true);
    expect(m.usage!.native_audio).toBe(usage.native_audio);
    expect(m.usage!.voice).toBe(usage.voice);
    expect(m.usage!.scatter_native_audio).toBe(usage.scatter_native_audio);
    expect(m.usage!.min_seconds).toBe(usage.min_seconds);
    expect(m.usage!.max_seconds).toBe(usage.max_seconds);
    if (usage.duration_steps) expect(m.usage!.duration_steps).toEqual(usage.duration_steps);
    if (usage.first_last !== undefined) expect(m.usage!.first_last).toBe(usage.first_last);
    if (usage.seed !== undefined) expect(m.usage!.seed).toBe(usage.seed);

    const label = m.provides?.[0]?.label ?? "";
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toMatch(/cloud i2v/i);

    const blurb = m.ui?.blurb ?? "";
    expect(blurb.length).toBeGreaterThan(0);
    expect(blurb).not.toMatch(JARGON);

    expect(Array.isArray(m.ui?.limits) && m.ui!.limits!.length).toBeTruthy();
    expect(typeof m.ui?.cost).toBe("string");
  });
});
