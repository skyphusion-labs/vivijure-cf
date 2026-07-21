// Types for the pure LoRA-preflight helpers in lora-preflight.js. Hand-authored
// (the project has no build step) so tests/lora-preflight.test.ts typechecks
// under the CI tsc gate. Runtime stays plain vanilla JS.

export interface CastMember {
  // S9 (F13): opaque public id (UUID string), never a number.
  id: string;
  name?: string;
  lora_status?: string;
  lora_key?: string | null;
  wan_lora_key_high?: string | null;
  wan_lora_key_low?: string | null;
}

export interface UnreadyLoraSlot {
  slot: string;
  castId: string;
  name: string;
}

export interface LoraPreflightOptions {
  motionBackend?: string;
}

export function isCastLoraReady(
  cast: CastMember | null | undefined,
  options?: LoraPreflightOptions,
): boolean;

export function unreadyBoundLoraSlots(
  bindings: Record<string, string> | null | undefined,
  catalog: CastMember[] | null | undefined,
  options?: LoraPreflightOptions,
): UnreadyLoraSlot[];

export function loraSlotSignature(unready: UnreadyLoraSlot[] | null | undefined): string;

export const WAN_LORA_BACKEND: string;
