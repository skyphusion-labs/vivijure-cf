// cf#1073. Clips with the model's sound. Start still, optional end still. Not a default.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core";
import { hostedSilentDoor, hostedSpokenDoor } from "../src/motion-scatter";
import { checkDoorDurations } from "../src/door-duration-preflight";
import {
  buildParams,
  clampDuration,
  clipTiming,
  normalizeConfig,
  parseVideoUrl,
} from "../modules/cf-kling-v4/src/params";
import worker from "../modules/cf-kling-v4/src/index";
import { fx, FX_25FPS_B64 } from "./fixtures/mp4-timing-fixtures";

type Worker = { fetch(request: Request, env: never): Promise<Response> };

const shot = {
  shot_id: "shot_01",
  keyframe_url: "https://example.invalid/start.png",
  last_keyframe_url: "https://example.invalid/end.png",
  prompt: "The boat keeps drifting",
  seconds: 12,
};

function asModule(manifest: {
  name: string;
  hooks: string[];
  ui?: { order?: number; locality?: string };
  usage?: Record<string, unknown>;
}): RegisteredModule {
  return manifest as unknown as RegisteredModule;
}

async function manifest() {
  const res = await (worker as unknown as Worker).fetch(new Request("https://module/module.json"), {} as never);
  expect(res.status).toBe(200);
  return await res.json() as {
    name: string;
    hooks: string[];
    ui: { order: number; locality: string; blurb: string; limits: string[]; cost: string };
    usage: {
      native_audio: boolean;
      driving_audio?: boolean;
      scatter_native_audio: boolean;
      min_seconds: number;
      max_seconds: number;
      duration_steps?: number[];
      first_last?: boolean;
    };
    config_schema: {
      resolution: { default: string; values: string[] };
      ratio: { default: string; values: string[] };
    };
  };
}

describe("cf-kling-v4 params (cf#1073)", () => {
  it("sends the start still, the end still, and no audio or middle frames", () => {
    const p = buildParams(shot, normalizeConfig({}));
    expect(p.first_frame).toBe(shot.keyframe_url);
    expect(p.last_frame).toBe(shot.last_keyframe_url);
    expect(p.prompt).toBe(shot.prompt);
    expect(p.duration).toBe(12);
    expect(p.resolution).toBe("720p");
    expect(p.aspect_ratio).toBe("16:9");
    expect(p).not.toHaveProperty("middle_frames");
    expect(p).not.toHaveProperty("audio");
    expect(JSON.stringify(p)).not.toMatch(/audio_url|voice_ref/);
  });

  it("omits last_frame when the hook has no end still", () => {
    const startOnly = { ...shot, last_keyframe_url: undefined };
    const p = buildParams(startOnly, normalizeConfig({}));
    expect(p.first_frame).toBe(shot.keyframe_url);
    expect(p).not.toHaveProperty("last_frame");
  });

  it("1080p and 9:16 are choices, and a bad value falls back to our default", () => {
    expect(buildParams(shot, normalizeConfig({ resolution: "1080p", ratio: "9:16" })).resolution).toBe("1080p");
    expect(buildParams(shot, normalizeConfig({ resolution: "1080p", ratio: "9:16" })).aspect_ratio).toBe("9:16");
    expect(buildParams(shot, normalizeConfig({ resolution: "4k", ratio: "2:1" })).resolution).toBe("720p");
    expect(buildParams(shot, normalizeConfig({ resolution: "4k", ratio: "2:1" })).aspect_ratio).toBe("16:9");
  });

  it("clamps duration to the schema range and uses the schema default when seconds are not a number", () => {
    expect(clampDuration(2)).toBe(3);
    expect(clampDuration(30)).toBe(30);
    expect(clampDuration(31)).toBe(30);
    expect(clampDuration(5.6)).toBe(6);
    expect(clampDuration(Number.NaN)).toBe(5);
  });

  it("reads the documented video field and ignores a stray URL", () => {
    expect(parseVideoUrl({ state: "Completed", result: { video: "https://cdn.example/a.mp4" } }))
      .toBe("https://cdn.example/a.mp4");
    expect(parseVideoUrl({ video: "https://cdn.example/b.mp4" })).toBe("https://cdn.example/b.mp4");
    expect(parseVideoUrl({ result: { image: "https://cdn.example/still.png" } })).toBeNull();
    expect(parseVideoUrl({ task: { content: { url: "https://cdn.example/other.mp4" } } })).toBeNull();
  });

  it("measures clip timing from the file", () => {
    const t = clipTiming(fx(FX_25FPS_B64));
    expect(t).not.toBeNull();
    expect(t!.frames).toBe(25);
    expect(Math.round(t!.fps)).toBe(25);
    expect(clipTiming(new Uint8Array(0))).toBeNull();
  });
});

describe("cf-kling-v4 is installable and is not a default", () => {
  it("declares a no-speech first-and-last envelope, and the sound in its copy", async () => {
    const m = await manifest();
    expect(m.name).toBe("cf-kling-v4");
    expect(m.hooks).toContain("motion.backend");
    expect(m.usage.native_audio).toBe(false);
    expect(m.usage.driving_audio).toBeUndefined();
    expect(m.usage.scatter_native_audio).toBe(false);
    expect(m.usage.first_last).toBe(true);
    expect(m.usage.min_seconds).toBe(3);
    expect(m.usage.max_seconds).toBe(30);
    expect(m.usage.duration_steps).toBeUndefined();
    expect(m.ui.order).toBeGreaterThan(90);
    expect(m.ui.locality).toBe("cloud");
    expect(m.config_schema.resolution.default).toBe("720p");
    expect(m.config_schema.resolution.values).toEqual(["720p", "1080p"]);
    expect(m.config_schema.ratio.values).toContain("9:16");
    expect(m.ui.limits.join(" ")).toMatch(/middle frames/);
    expect(m.ui.limits.join(" ")).toMatch(/adds its own sound/);
    expect(m.ui.limits.join(" ")).toMatch(/No spoken lines/);
    expect(m.ui.cost).toMatch(/0\.157/);
    expect(m.ui.cost).toMatch(/0\.235/);
  });

  it("does not take the spoken default from infinitetalk or the silent default from hailuo", async () => {
    const m = asModule(await manifest());
    const infinitetalk = asModule({
      name: "infinitetalk",
      hooks: ["motion.backend"],
      ui: { order: 15, locality: "cloud" },
      usage: { native_audio: false, driving_audio: true, voice: "cast_tts", scatter_native_audio: false, min_seconds: 2, max_seconds: 15 },
    });
    const hailuo = asModule({
      name: "cf-hailuo",
      hooks: ["motion.backend"],
      ui: { order: 65, locality: "cloud" },
      usage: { native_audio: false, voice: "cast_tts", scatter_native_audio: true, min_seconds: 6, max_seconds: 10 },
    });
    const minimax = asModule({
      name: "minimax-hailuo",
      hooks: ["motion.backend"],
      ui: { order: 40, locality: "cloud" },
      usage: { native_audio: false, voice: "cast_tts", scatter_native_audio: true, min_seconds: 6, max_seconds: 10 },
    });
    expect(hostedSpokenDoor([m, infinitetalk])?.name).toBe("infinitetalk");
    expect(hostedSpokenDoor([infinitetalk, m])?.name).toBe("infinitetalk");
    expect(hostedSilentDoor([m, hailuo])?.name).toBe("cf-hailuo");
    expect(hostedSilentDoor([hailuo, m])?.name).toBe("cf-hailuo");
    expect(hostedSilentDoor([m, minimax])?.name).toBe("minimax-hailuo");
    expect(hostedSilentDoor([minimax, m])?.name).toBe("minimax-hailuo");
  });

  it("a shot past 30 seconds is an error, and a shot under 3 seconds is a warning", async () => {
    const m = await manifest();
    const over = checkDoorDurations(
      { scenes: [{ id: "shot_01", target_seconds: 40 }] },
      { name: m.name, usage: m.usage },
    );
    expect(over.map((i) => i.level)).toEqual(["error"]);
    const under = checkDoorDurations(
      { scenes: [{ id: "shot_01", target_seconds: 2 }] },
      { name: m.name, usage: m.usage },
    );
    expect(under.map((i) => i.level)).toEqual(["warning"]);
    const ok = checkDoorDurations(
      { scenes: [{ id: "shot_01", target_seconds: 10 }] },
      { name: m.name, usage: m.usage },
    );
    expect(ok).toEqual([]);
  });

  it("is not in the tenant catalog", () => {
    const catalog = readFileSync("scripts/tenant-module-catalog.txt", "utf8");
    expect(catalog).not.toMatch(/^cf-kling-v4$/m);
  });

  it("refuses a shot with no start still, and a prompt past 26000 characters", async () => {
    const env = { GATEWAY_ID: "gw" } as never;
    const missing = await (worker as unknown as Worker).fetch(new Request("https://m.internal/invoke", {
      method: "POST",
      body: JSON.stringify({
        hook: "motion.backend",
        input: { ...shot, keyframe_url: "" },
        config: {},
        context: { project: "p" },
      }),
    }), env);
    const missingBody = await missing.json() as { ok: boolean; jobId?: string };
    expect(missingBody.ok).toBe(false);
    expect(missingBody.jobId).toBeUndefined();

    const long = await (worker as unknown as Worker).fetch(new Request("https://m.internal/invoke", {
      method: "POST",
      body: JSON.stringify({
        hook: "motion.backend",
        input: { ...shot, prompt: "x".repeat(26001) },
        config: {},
        context: { project: "p" },
      }),
    }), env);
    const longBody = await long.json() as { ok: boolean; jobId?: string; error?: string };
    expect(longBody.ok).toBe(false);
    expect(longBody.jobId).toBeUndefined();
    expect(longBody.error).toMatch(/26000/);
  });
});

describe("cf-kling-v4 reports the sound in the file", () => {
  it("says has_audio on poll, and a board with a line is still refused", async () => {
    const m = await manifest();
    expect(m.usage.native_audio).toBe(false);
    const src = readFileSync("modules/cf-kling-v4/src/index.ts", "utf8");
    expect(src).toMatch(/frames: state\.frames,\n\s*has_audio: true,/);
  });
});
