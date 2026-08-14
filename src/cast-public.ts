// Public cast projection for API responses (cf#383).
//
// Core's toPublicCast maps the integer PK to the opaque public id. This host wrapper ADDS
// per-family adapter readiness booleans so callers never treat shared `lora_status === "ready"`
// as "both SDXL and Wan adapters exist".
//
// Fields are additive (existing clients ignore them). When `@skyphusion-labs/vivijure-core`
// ships the same keys on toPublicCast, we prefer those and only fill gaps -- so this wrapper
// stays correct across the pin bump without double-logic divergence.
//
// Legacy `lora_status` meaning (retained): shared last training-job state across BOTH families.
// "ready" means at least one family was marked ready; it does NOT imply both have adapters.
// Prefer `sdxl_lora_ready` (keyframe identity) and `wan_lora_ready` (Wan motion experts).

import {
  toPublicCast as coreToPublicCast,
  type CastMember,
  type PublicCastMember,
} from "@skyphusion-labs/vivijure-core/cast-db";

export type PublicCastWithFamilyReady = PublicCastMember & {
  sdxl_lora_ready: boolean;
  wan_lora_ready: boolean;
};

function isLorasKey(key: string | null | undefined): boolean {
  return typeof key === "string" && key.startsWith("loras/");
}

/** Key-presence SDXL readiness (same gate as resolveCastLoras / core isSdxlLoraReady). */
export function isSdxlLoraReady(cast: { lora_key?: string | null }): boolean {
  return isLorasKey(cast.lora_key);
}

/** Key-presence Wan dual-expert readiness (same gate as core isWanLoraReady). */
export function isWanLoraReady(cast: {
  wan_lora_key_high?: string | null;
  wan_lora_key_low?: string | null;
}): boolean {
  return isLorasKey(cast.wan_lora_key_high) && isLorasKey(cast.wan_lora_key_low);
}

type CorePublicMaybeReady = PublicCastMember & {
  sdxl_lora_ready?: boolean;
  wan_lora_ready?: boolean;
};

/**
 * Project a cast row for the API: opaque public id + family readiness booleans.
 * Drop-in replacement for core `toPublicCast` at every host response site.
 */
export function toPublicCast(row: CastMember): PublicCastWithFamilyReady {
  const pub = coreToPublicCast(row) as CorePublicMaybeReady;
  return {
    ...pub,
    sdxl_lora_ready:
      typeof pub.sdxl_lora_ready === "boolean" ? pub.sdxl_lora_ready : isSdxlLoraReady(pub),
    wan_lora_ready:
      typeof pub.wan_lora_ready === "boolean" ? pub.wan_lora_ready : isWanLoraReady(pub),
  };
}
