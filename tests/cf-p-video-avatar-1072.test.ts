// cf#1072. Portrait plus Cast audio. The provider page lists no duration.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core";
import { hostedSilentDoor, hostedSpokenDoor } from "../src/motion-scatter";
import { checkDoorDurations } from "../src/door-duration-preflight";
import { buildParams, clipTiming, normalizeConfig, parseVideoUrl } from "../modules/cf-p-video-avatar/src/params";
import worker from "../modules/cf-p-video-avatar/src/index";
import { fx, FX_25FPS_B64 } from "./fixtures/mp4-timing-fixtures";

type Worker = { fetch(request: Request, env: never): Promise<Response> };

const shot = {
  shot_id: "shot_01",
  keyframe_url: "https://example.invalid/portrait.png",
  prompt: "She nods once",
  seconds: 8,
  audio_url: "https://example.invalid/line.wav",
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
      min_seconds: number;
      max_seconds: number;
      duration_steps?: number[];
      first_last?: boolean;
    };
    config_schema: { resolution: { default: string; values: string[] } };
  };
}

describe("cf-p-video-avatar params (cf#1072)", () => {
  it("sends the Cast audio and does not invent a duration or a script", () => {
    const p = buildParams(shot, normalizeConfig({}));
    expect(p.image).toBe(shot.keyframe_url);
    expect(p.audio).toBe(shot.audio_url);
    expect(p.voice_script).toBe("");
    expect(p.resolution).toBe("720p");
    expect(p.voice).toBe("Zephyr (Female)");
    expect(p).not.toHaveProperty("duration");
    expect(JSON.stringify(p)).not.toMatch(/voice_ref/);
  });

  it("1080p is a choice, not the default", () => {
    expect(buildParams(shot, normalizeConfig({ resolution: "1080p" })).resolution).toBe("1080p");
    expect(buildParams(shot, normalizeConfig({ resolution: "4k" })).resolution).toBe("720p");
  });

  it("reads the documented video field and ignores a stray URL", () => {
    expect(parseVideoUrl({ state: "Completed", result: { video: "https://cdn.example/a.mp4" } }))
      .toBe("https://cdn.example/a.mp4");
    expect(parseVideoUrl({ result: { image: "https://cdn.example/still.png" } })).toBeNull();
  });

  it("measures clip timing from the file", () => {
    const t = clipTiming(fx(FX_25FPS_B64));
    expect(t).not.toBeNull();
    expect(t!.frames).toBe(25);
    expect(Math.round(t!.fps)).toBe(25);
    expect(clipTiming(new Uint8Array(0))).toBeNull();
  });
});

describe("cf-p-video-avatar is installable and is not a default", () => {
  it("declares driving audio, no native audio, and our own 15 second cap", async () => {
    const m = await manifest();
    expect(m.name).toBe("cf-p-video-avatar");
    expect(m.hooks).toContain("motion.backend");
    expect(m.usage.driving_audio).toBe(true);
    expect(m.usage.native_audio).toBe(false);
    expect(m.usage.max_seconds).toBe(15);
    expect(m.usage.min_seconds).toBe(1);
    expect(m.usage.duration_steps).toBeUndefined();
    expect(m.usage.first_last).toBeUndefined();
    expect(m.ui.order).toBeGreaterThan(90);
    expect(m.config_schema.resolution.default).toBe("720p");
    expect(m.ui.limits.join(" ")).toMatch(/own cap.*#931/);
    expect(m.ui.cost).toMatch(/0\.025/);
    expect(m.ui.cost).toMatch(/0\.045/);
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
    expect(hostedSpokenDoor([m, infinitetalk])?.name).toBe("infinitetalk");
    expect(hostedSpokenDoor([infinitetalk, m])?.name).toBe("infinitetalk");
    expect(hostedSilentDoor([m, hailuo])?.name).toBe("cf-hailuo");
    expect(hostedSilentDoor([hailuo, m])?.name).toBe("cf-hailuo");
  });

  it("preflight applies our 15 second cap", async () => {
    const m = await manifest();
    const door = { name: m.name, usage: m.usage };
    expect(checkDoorDurations({ scenes: [{ id: "shot_01", target_seconds: 15 }] }, door)).toEqual([]);
    const over = checkDoorDurations({ scenes: [{ id: "shot_01", target_seconds: 16 }] }, door);
    expect(over.map((i) => i.level)).toEqual(["error"]);
  });

  it("is not in the tenant catalog", () => {
    const catalog = readFileSync("scripts/tenant-module-catalog.txt", "utf8");
    expect(catalog).not.toMatch(/^cf-p-video-avatar$/m);
  });

  it("refuses a shot with no Cast audio", async () => {
    const res = await (worker as unknown as Worker).fetch(new Request("https://m.internal/invoke", {
      method: "POST",
      body: JSON.stringify({
        hook: "motion.backend",
        input: { ...shot, audio_url: "" },
        config: {},
        context: { project: "p" },
      }),
    }), { GATEWAY_ID: "gw" } as never);
    const body = await res.json() as { ok: boolean; jobId?: string; error?: string };
    expect(body.ok).toBe(false);
    expect(body.jobId).toBeUndefined();
    expect(body.error).toMatch(/audio_url/);
  });
});
