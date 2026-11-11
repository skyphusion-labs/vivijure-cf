// core#389: the default is a delivery height and not a factor. Measured on film-6e71cf89: the schema
// default of 2 was filled into every config, so `scale` always read as explicit and the height route never ran.
import { describe, expect, it } from "vitest";
import { validateConfig } from "@skyphusion-labs/vivijure-core/modules/registry";
import { alreadyAtTarget, buildRunPodBody, coerceConfig } from "../modules/finish-upscale/src/finish";
import worker from "../modules/finish-upscale/src/index";

const manifest = async () => {
  const r = await worker.fetch(new Request("https://module/module.json"), {} as never);
  return r.json() as Promise<{ config_schema: Record<string, never>; finish_scales_frame?: boolean }>;
};
const base = { shot_id: "s", clip_key: "renders/p/clips/s.mp4", width: 1344, height: 768, delivery_width: 1890, delivery_height: 1080 };

describe("finish-upscale default", () => {
  it("a config the core validated from nothing sends the height and no factor", async () => {
    const m = await manifest();
    const cfg = coerceConfig(validateConfig(m.config_schema, {}));
    expect(cfg.scaleExplicit).toBe(false);
    const body = buildRunPodBody(base, cfg, "p").input;
    expect(body.target_height).toBe(1080);
    expect(body.scale).toBeUndefined();
  });

  it("a vertical clip is sent the vertical height", async () => {
    const m = await manifest();
    const cfg = coerceConfig(validateConfig(m.config_schema, {}));
    const body = buildRunPodBody({ ...base, width: 720, height: 1280, delivery_width: 1080, delivery_height: 1920 }, cfg, "p").input;
    expect(body.target_height).toBe(1920);
  });

  it("an explicit factor still survives validation and wins", async () => {
    const m = await manifest();
    const cfg = coerceConfig(validateConfig(m.config_schema, { scale: 2 }));
    expect(cfg.scaleExplicit).toBe(true);
    const body = buildRunPodBody(base, cfg, "p").input;
    expect(body.scale).toBe(2);
    expect(body.target_height).toBeUndefined();
  });

  it("declares that it changes the frame, so the core can price it", async () => {
    expect((await manifest()).finish_scales_frame).toBe(true);
  });
});

describe("a clip already at the target", () => {
  const def = coerceConfig({});
  it.each([
    [{ height: 1080, delivery_height: 1080 }, true],
    [{ height: 2160, delivery_height: 1080 }, true],
    [{ height: 768, delivery_height: 1080 }, false],
    [{ delivery_height: 1080 }, false],
    [{ height: 1080 }, false],
  ])("%o is %s", (input, want) => {
    expect(alreadyAtTarget(input, def)).toBe(want);
  });
  it("an explicit factor is never skipped", () => {
    expect(alreadyAtTarget({ height: 2160, delivery_height: 1080 }, coerceConfig({ scale: 2 }))).toBe(false);
  });
  it("calls no door and reads as a no-op, not a degrade", async () => {
    const r = await worker.fetch(new Request("https://module/invoke", {
      method: "POST",
      body: JSON.stringify({ hook: "finish", input: { ...base, height: 1080, delivery_height: 1080 }, config: {}, context: { project: "p", job_id: "j" } }),
    }), {} as never);
    const out = await r.json() as { ok: boolean; output: { applied: string[]; degraded?: string } };
    expect(out.output.applied).toEqual(["noop:already-at-target"]);
    expect(out.output.degraded).toBeUndefined();
  });
});
