import { describe, expect, it } from "vitest";
import {
  isSdxlLoraReady,
  isWanLoraReady,
  toPublicCast,
} from "../src/cast-public";
import type { CastMember } from "@skyphusion-labs/vivijure-core/cast-db";

// cf#383: public cast must distinguish SDXL vs Wan adapter readiness so a
// caller never binds by lora_status alone into silent no-identity keyframes.

function baseCast(over: Partial<CastMember> = {}): CastMember {
  return {
    id: 7,
    public_id: "7b899c7a-4209-4a98-9295-e35ef75f0aec",
    slug: "strummer-cf278-vale",
    name: "Strummer CF278 Vale",
    bible: null,
    portrait_key: "cast/7/p.jpg",
    portrait_mime: "image/jpeg",
    ref_keys: [],
    source_keys: [],
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    lora_key: null,
    lora_status: "ready",
    lora_job_id: null,
    lora_error: null,
    lora_trained_at: "2026-01-01 00:00:00",
    voice_id: null,
    wan_lora_key_high: null,
    wan_lora_key_low: null,
    ...over,
    voice_ref_key: over.voice_ref_key ?? null,
  };
}

describe("cast-public family readiness (cf#383)", () => {
  it("Vale shape: lora_status ready + Wan keys + null lora_key => sdxl false, wan true", () => {
    const pub = toPublicCast(
      baseCast({
        wan_lora_key_high:
          "loras/lora-strummer-cf278-vale-1785586586/A/wan_high_noise.safetensors",
        wan_lora_key_low:
          "loras/lora-strummer-cf278-vale-1785586586/A/wan_low_noise.safetensors",
        lora_key: null,
        lora_status: "ready",
      }),
    );
    expect(pub.id).toBe("7b899c7a-4209-4a98-9295-e35ef75f0aec");
    expect(pub.lora_status).toBe("ready");
    expect(pub.sdxl_lora_ready).toBe(false);
    expect(pub.wan_lora_ready).toBe(true);
  });

  it("Mara shape: both families present => both ready booleans true", () => {
    const pub = toPublicCast(
      baseCast({
        lora_key: "loras/cast-mara/one.safetensors",
        wan_lora_key_high: "loras/cast-mara/h.safetensors",
        wan_lora_key_low: "loras/cast-mara/l.safetensors",
        voice_id: "athena",
      }),
    );
    expect(pub.sdxl_lora_ready).toBe(true);
    expect(pub.wan_lora_ready).toBe(true);
  });

  it("helpers match the public fields", () => {
    const wanOnly = baseCast({
      wan_lora_key_high: "loras/h.safetensors",
      wan_lora_key_low: "loras/l.safetensors",
    });
    expect(isSdxlLoraReady(wanOnly)).toBe(false);
    expect(isWanLoraReady(wanOnly)).toBe(true);
    expect(isSdxlLoraReady(baseCast({ lora_key: "loras/x.safetensors" }))).toBe(true);
  });
});
