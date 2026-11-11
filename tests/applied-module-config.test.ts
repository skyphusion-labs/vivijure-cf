import { describe, it, expect } from "vitest";
import { buildAppliedModuleConfig } from "../src/applied-module-config";
import type { FilmJob } from "@skyphusion-labs/vivijure-core/film-orchestrator";
import type { ClipJob } from "@skyphusion-labs/vivijure-core/render-orchestrator";

const job = (over: Partial<FilmJob> = {}) =>
  ({
    motion_backend: "infinitetalk",
    keyframe_backend: "cloud-keyframe",
    motion_config: { size: "720p" },
    keyframe_config: { quality_tier: "draft" },
    ...over,
  }) as unknown as FilmJob;

const clips = (shots: { shot_id: string; config?: Record<string, unknown> }[]) =>
  ({ shots } as unknown as ClipJob);

describe("cf#924: the applied module config is recorded, and resolved is never conflated with requested", () => {
  it("records the resolved config the module actually received", () => {
    const a = buildAppliedModuleConfig(job(), clips([{ shot_id: "shot_01", config: { size: "480p" } }]));
    expect(a?.motion_resolved).toEqual({ size: "480p" });
  });

  it("keeps the REQUESTED value distinct from the RESOLVED one -- this is the lip29 case", () => {
    // Caller asked 720p; what the module received is what decides whether we or the vendor lost it.
    const a = buildAppliedModuleConfig(job(), clips([{ shot_id: "shot_01", config: { size: "480p" } }]));
    expect(a?.motion_requested).toEqual({ size: "720p" });
    expect(a?.motion_resolved).toEqual({ size: "480p" });
    expect(a?.motion_requested).not.toEqual(a?.motion_resolved);
  });

  it("collapses to one object when every shot agrees", () => {
    const a = buildAppliedModuleConfig(
      job(),
      clips([
        { shot_id: "shot_01", config: { size: "480p" } },
        { shot_id: "shot_02", config: { size: "480p" } },
      ]),
    );
    expect(a?.motion_resolved).toEqual({ size: "480p" });
    expect(a?.motion_resolved_by_shot).toBeUndefined();
  });

  it("collapses on VALUE, not key order, so a reordered bag is not reported as a disagreement", () => {
    const a = buildAppliedModuleConfig(
      job(),
      clips([
        { shot_id: "shot_01", config: { size: "480p", enable_safety_checker: false } },
        { shot_id: "shot_02", config: { enable_safety_checker: false, size: "480p" } },
      ]),
    );
    expect(a?.motion_resolved).toBeDefined();
    expect(a?.motion_resolved_by_shot).toBeUndefined();
  });

  it("goes per-shot when shots genuinely disagree", () => {
    const a = buildAppliedModuleConfig(
      job(),
      clips([
        { shot_id: "shot_01", config: { size: "480p" } },
        { shot_id: "shot_02", config: { size: "720p" } },
      ]),
    );
    expect(a?.motion_resolved).toBeUndefined();
    expect(a?.motion_resolved_by_shot).toEqual({
      shot_01: { size: "480p" },
      shot_02: { size: "720p" },
    });
  });

  it("labels the keyframe config as requested only, because the host never sees it resolved", () => {
    const a = buildAppliedModuleConfig(job(), null);
    expect(a?.keyframe_requested).toEqual({ quality_tier: "draft" });
    expect(a).not.toHaveProperty("keyframe_resolved");
  });

  it("returns null rather than an empty shape, so absent reads as NOT RECORDED", () => {
    const bare = { motion_config: {} } as unknown as FilmJob;
    expect(buildAppliedModuleConfig(bare, null)).toBeNull();
    expect(buildAppliedModuleConfig(bare, clips([{ shot_id: "shot_01" }]))).toBeNull();
  });

  it("records the doors alongside the knobs", () => {
    const a = buildAppliedModuleConfig(job(), null);
    expect(a?.motion_backend).toBe("infinitetalk");
    expect(a?.keyframe_backend).toBe("cloud-keyframe");
  });
});
