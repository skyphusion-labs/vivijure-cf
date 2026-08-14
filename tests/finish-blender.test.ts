import { describe, expect, it } from "vitest";
import {
  coerceConfig,
  blenderKey,
  buildRunPodBody,
  passthroughOutput,
  encodePoll,
  decodePoll,
  parseBackendOutput,
  defaultConfig,
} from "../modules/finish-blender/src/finish";
import type { FinishInput } from "../modules/finish-blender/src/contract";

const sample: FinishInput = {
  shot_id: "shot_01",
  clip_key: "renders/p/clips/shot_01.mp4",
  src_fps: 24,
  frames: 48,
};

describe("finish-blender: coerceConfig", () => {
  it("defaults", () => {
    expect(defaultConfig()).toEqual({
      job_type: "grade",
      preset: "filmic_warm",
      strength: 1,
    });
  });
  it("clamps strength and rejects unknown preset", () => {
    const c = coerceConfig({ strength: 9, preset: "nope", job_type: "grade" });
    expect(c.strength).toBe(2);
    expect(c.preset).toBe("filmic_warm");
  });
  it("accepts known preset", () => {
    expect(coerceConfig({ preset: "cool" }).preset).toBe("cool");
  });
});

describe("finish-blender: blenderKey", () => {
  it("appends _bl before extension", () => {
    expect(blenderKey("renders/p/clips/shot.mp4")).toBe("renders/p/clips/shot_bl.mp4");
  });
});

describe("finish-blender: buildRunPodBody", () => {
  it("forwards project and output key", () => {
    const body = buildRunPodBody(sample, coerceConfig({}), "p");
    expect(body.input.project).toBe("p");
    expect(body.input.output_key).toBe("renders/p/clips/shot_01_bl.mp4");
    expect(body.input.preset).toBe("filmic_warm");
  });
});

describe("finish-blender: poll token", () => {
  it("round-trips", () => {
    const tok = encodePoll({
      jobId: "j1",
      shotId: "shot_01",
      srcFps: 24,
      frames: 48,
      submittedAt: 100,
    });
    expect(decodePoll(tok)?.jobId).toBe("j1");
  });
});

describe("finish-blender: parseBackendOutput", () => {
  it("reads clip_key", () => {
    expect(parseBackendOutput({ clip_key: "a_bl.mp4", frames: 10 })?.frames).toBe(10);
  });
});

describe("finish-blender: passthroughOutput", () => {
  it("marks degraded", () => {
    const o = passthroughOutput(sample, "no-runpod-secrets");
    expect(o.degraded).toBe("no-runpod-secrets");
    expect(o.clip_key).toBe(sample.clip_key);
  });
});
