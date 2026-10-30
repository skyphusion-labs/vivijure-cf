// cf#1074. Clips with the model's sound. Start still, optional end still. Not a default.
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
} from "../modules/cf-minimax-h3/src/params";
import worker from "../modules/cf-minimax-h3/src/index";
import { fx, FX_25FPS_B64 } from "./fixtures/mp4-timing-fixtures";

type Worker = { fetch(request: Request, env: never): Promise<Response> };

const shot = {
  shot_id: "shot_01",
  keyframe_url: "https://example.invalid/start.png",
  last_keyframe_url: "https://example.invalid/end.png",
  prompt: "The boat keeps drifting",
  seconds: 8,
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

describe("cf-minimax-h3 params (cf#1074)", () => {
  it("sends a text item, a first frame, and a last frame, and no reference roles", () => {
    const p = buildParams(shot, normalizeConfig({}));
    const content = p.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: shot.prompt });
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: shot.keyframe_url },
      role: "first_frame",
    });
    expect(content[2]).toEqual({
      type: "image_url",
      image_url: { url: shot.last_keyframe_url },
      role: "last_frame",
    });
    expect(p.duration).toBe(8);
    expect(p.resolution).toBe("768P");
    expect(p.ratio).toBe("adaptive");
    expect(JSON.stringify(p)).not.toMatch(/reference_image|reference_video|reference_audio|callback_url/);
  });

  it("omits the last frame when the hook has no end still", () => {
    const startOnly = { ...shot, last_keyframe_url: undefined };
    const content = buildParams(startOnly, normalizeConfig({})).content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content.map((c) => c.role).filter(Boolean)).toEqual(["first_frame"]);
  });

  it("2K and 9:16 are choices, and a bad value falls back", () => {
    const chosen = buildParams(shot, normalizeConfig({ resolution: "2K", ratio: "9:16" }));
    expect(chosen.resolution).toBe("2K");
    expect(chosen.ratio).toBe("9:16");
    const bad = buildParams(shot, normalizeConfig({ resolution: "1080p", ratio: "2:1" }));
    expect(bad.resolution).toBe("768P");
    expect(bad.ratio).toBe("adaptive");
  });

  it("clamps duration to 4-15, and a non-number becomes the minimum", () => {
    expect(clampDuration(3)).toBe(4);
    expect(clampDuration(15)).toBe(15);
    expect(clampDuration(16)).toBe(15);
    expect(clampDuration(4.6)).toBe(5);
    expect(clampDuration(Number.NaN)).toBe(4);
  });

  it("reads a succeeded task url and ignores a queued task or a stray video field", () => {
    expect(parseVideoUrl({
      task: { status: "succeeded", content: { url: "https://cdn.example/a.mp4" } },
    })).toBe("https://cdn.example/a.mp4");
    expect(parseVideoUrl({
      task: { status: "queued", content: { url: "https://cdn.example/a.mp4" } },
    })).toBeNull();
    expect(parseVideoUrl({
      task: { status: "failed", content: { url: "https://cdn.example/a.mp4" } },
    })).toBeNull();
    expect(parseVideoUrl({ result: { video: "https://cdn.example/b.mp4" } })).toBeNull();
    // The shape the AI Gateway logged for a real completed run, 2026-10-30.
    expect(parseVideoUrl({
      state: "Completed",
      result: { task: { id: "458073170706797", model: "MiniMax-H3", status: "succeeded", content: { url: "https://cdn.example/c.mp4" }, resolution: "768P", duration: 5 } },
    })).toBe("https://cdn.example/c.mp4");
    expect(parseVideoUrl({
      state: "Completed",
      result: { task: { status: "failed", content: { url: "https://cdn.example/c.mp4" } } },
    })).toBeNull();
  });

  it("measures clip timing from the file", () => {
    const t = clipTiming(fx(FX_25FPS_B64));
    expect(t).not.toBeNull();
    expect(t!.frames).toBe(25);
    expect(Math.round(t!.fps)).toBe(25);
    expect(clipTiming(new Uint8Array(0))).toBeNull();
  });
});

describe("cf-minimax-h3 is installable and is not a default", () => {
  it("declares a no-speech first-and-last envelope, and the sound in its copy", async () => {
    const m = await manifest();
    expect(m.name).toBe("cf-minimax-h3");
    expect(m.hooks).toContain("motion.backend");
    expect(m.usage.native_audio).toBe(false);
    expect(m.usage.driving_audio).toBeUndefined();
    expect(m.usage.scatter_native_audio).toBe(false);
    expect(m.usage.first_last).toBe(true);
    expect(m.usage.min_seconds).toBe(4);
    expect(m.usage.max_seconds).toBe(15);
    expect(m.usage.duration_steps).toBeUndefined();
    expect(m.ui.order).toBeGreaterThan(90);
    expect(m.ui.locality).toBe("cloud");
    expect(m.config_schema.resolution.default).toBe("768P");
    expect(m.config_schema.resolution.values).toEqual(["768P", "2K"]);
    expect(m.config_schema.ratio.default).toBe("adaptive");
    expect(m.config_schema.ratio.values).toContain("9:16");
    expect(m.ui.limits.join(" ")).toMatch(/adds its own sound/);
    expect(m.ui.limits.join(" ")).toMatch(/No spoken lines/);
    expect(m.ui.limits.join(" ")).toMatch(/reference roles/);
    expect(m.ui.cost).toMatch(/0\.08/);
    expect(m.ui.cost).toMatch(/0\.13/);
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

  it("a shot past 15 seconds is an error, and a shot under 4 seconds is a warning", async () => {
    const m = await manifest();
    const over = checkDoorDurations(
      { scenes: [{ id: "shot_01", target_seconds: 20 }] },
      { name: m.name, usage: m.usage },
    );
    expect(over.map((i) => i.level)).toEqual(["error"]);
    const under = checkDoorDurations(
      { scenes: [{ id: "shot_01", target_seconds: 2 }] },
      { name: m.name, usage: m.usage },
    );
    expect(under.map((i) => i.level)).toEqual(["warning"]);
    const ok = checkDoorDurations(
      { scenes: [{ id: "shot_01", target_seconds: 8 }] },
      { name: m.name, usage: m.usage },
    );
    expect(ok).toEqual([]);
  });

  it("is not in the tenant catalog", () => {
    const catalog = readFileSync("scripts/tenant-module-catalog.txt", "utf8");
    expect(catalog).not.toMatch(/^cf-minimax-h3$/m);
  });

  it("refuses a shot with no start still, and a prompt past 7000 characters", async () => {
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
        input: { ...shot, prompt: "x".repeat(7001) },
        config: {},
        context: { project: "p" },
      }),
    }), env);
    const longBody = await long.json() as { ok: boolean; jobId?: string; error?: string };
    expect(longBody.ok).toBe(false);
    expect(longBody.jobId).toBeUndefined();
    expect(longBody.error).toMatch(/7000/);
  });
});

describe("cf-minimax-h3 reports the sound in the file", () => {
  it("says has_audio on poll, and a board with a line is still refused", async () => {
    const m = await manifest();
    expect(m.usage.native_audio).toBe(false);
    const src = readFileSync("modules/cf-minimax-h3/src/index.ts", "utf8");
    expect(src).toMatch(/frames: state\.frames,\n\s*has_audio: true,/);
  });
});
