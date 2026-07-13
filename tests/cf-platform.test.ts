import { describe, expect, it } from "vitest";
import { PLATFORM_ICD_VERSION } from "@skyphusion-labs/vivijure-core/platform";
import { cfPlatformFromEnv } from "../src/platform/cf-platform.js";
import type { Env } from "../src/env.js";

describe("cf platform adapter", () => {
  it("builds a Platform with ICD version", () => {
    const fakeFetcher = { fetch: async () => new Response("ok") };
    const env = {
      DB: {} as D1Database,
      R2: {} as R2Bucket,
      R2_RENDERS: {} as R2Bucket,
      ASSETS: fakeFetcher,
      AI: {} as Ai,
      GATEWAY_ID: "gw",
      RUNPOD_API_KEY: "k",
      RUNPOD_ENDPOINT_ID: "e",
      VIDEO_FINISH_VPC: fakeFetcher,
      IMAGE_PREP_VPC: fakeFetcher,
      AUDIO_BEAT_SYNC_VPC: fakeFetcher,
      MODULE_KEYFRAME: fakeFetcher,
    } as unknown as Env;

    const platform = cfPlatformFromEnv(env);
    expect(platform.db).toBe(env.DB);
    expect(platform.presigner).toBeTruthy();
    expect(platform.modules.listBindings()).toContain("MODULE_KEYFRAME");
    expect(PLATFORM_ICD_VERSION).toBe(1);
  });
});
