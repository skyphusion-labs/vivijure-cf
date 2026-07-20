// Project a cast's trained Wan 2.2 A14B LoRA adapters into an alibaba-wan-lora motion config.
//
// resolveCastLoras (core) sorts a bound cast into two DISJOINT maps: SDXL adapters land in
// `pretrained` (forwarded as pretrained_loras, staged from R2 by our own GPU backend), Wan adapters
// land in `wanPretrained` (per slot: { high, low } expert R2 keys). The alibaba-wan-lora module is a
// CLOUD i2v backend with no R2 binding, so it receives its LoRAs as fetchable URLs inside its own
// config fields (high_noise_loras / low_noise_loras, each a JSON string of [{ path, scale }]). This
// projection is the ONLY place that reads wanPretrained on the render side, so a Wan cast and an SDXL
// cast can never cross-wire: an SDXL cast has an empty wanPretrained and is skipped here; a Wan cast
// has an empty `pretrained` and never touches pretrained_loras.
import type { Env } from "./env";
import { presignR2Get } from "./r2-presign";

// The one motion backend that takes cast LoRAs through its config.
export const WAN_LORA_BACKEND = "alibaba-wan-lora";

// Scale 1.5, never silently 1.0: the Phase-0 spike (cf#29) found scale 1.0 UNDERperformed the no-LoRA
// control (it perturbed the trajectory without asserting identity), while ~1.5 bound the character
// cleanly. Mirrors core buildWanLoraConfigArrays. Callers may override; the default must never be 1.0.
export const WAN_LORA_DEFAULT_SCALE = 1.5;

// The alibaba-wan-lora endpoint fetches each LoRA file by URL during the MOTION phase, which runs
// AFTER the whole keyframe phase (plus any queue) has completed. These URLs are presigned at the
// render DOOR, so unlike core keyframe_url (presigned just-in-time at the motion phase with a 30-min
// TTL), the LoRA URL must outlive the entire keyframe -> motion window of the slowest render. 6h
// matches FILM_DOWNLOAD_TTL and safely covers any render; a short-lived GET of one private LoRA file
// is a negligible exposure next to the permanent R2 credential.
export const WAN_LORA_PRESIGN_TTL_SECONDS = 6 * 60 * 60;

// The Wan endpoint runs a single two-expert pass; cap the LoRA count so a large bound cast cannot
// balloon the payload (and the GPU VRAM). 8 pairs is generous for one shot worth of on-screen cast.
// Overflow is DROPPED and LOGGED, never silently truncated (the honest-degrade discipline).
export const MAX_LORAS_PER_PASS = 8;

interface LoraEntry {
  path: string;
  scale: number;
}

// Read any user-supplied LoRA list already present in the config so the cast adapters accumulate
// AFTER it (never clobbering a caller-provided list). A non-string, non-array, or unparseable value
// yields [] -- the module treats a missing/"[]" field as plain Wan i2v.
function parseExistingLoras(value: unknown): LoraEntry[] {
  if (typeof value !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (e): e is LoraEntry =>
      !!e && typeof e === "object" && typeof (e as { path?: unknown }).path === "string",
  );
}

// True when this render should project Wan cast adapters: the chosen motion backend IS
// alibaba-wan-lora AND at least one bound cast member resolved to a Wan adapter. The SAME predicate
// gates every call site, so no render path can diverge on when to project.
export function shouldProjectWanLoras(
  motionBackend: string | undefined,
  wanPretrained: Record<string, unknown>,
): boolean {
  return (motionBackend ?? "").trim() === WAN_LORA_BACKEND && Object.keys(wanPretrained).length > 0;
}

export interface WanProjectionResult {
  injected: number; // cast slots projected into the config
  dropped: number; // cast slots dropped by the MAX_LORAS_PER_PASS cap
  applied: boolean; // whether the config was mutated
}

// Ensure `overrides.config[moduleName]` is a live object, creating the nesting as needed, and return
// both the (possibly newly created) overrides bag and the module config object to project into. Used
// by the scatter path, which forwards render_overrides RAW and has no door-built motion_config.
export function ensureModuleOverrideConfig(
  overrides: Record<string, unknown> | undefined,
  moduleName: string,
): { overrides: Record<string, unknown>; config: Record<string, unknown> } {
  const base: Record<string, unknown> =
    overrides && typeof overrides === "object" && !Array.isArray(overrides) ? overrides : {};
  const cfgBag: Record<string, Record<string, unknown>> =
    base.config && typeof base.config === "object" && !Array.isArray(base.config)
      ? (base.config as Record<string, Record<string, unknown>>)
      : {};
  const existing = cfgBag[moduleName];
  const moduleCfg: Record<string, unknown> =
    existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  cfgBag[moduleName] = moduleCfg;
  base.config = cfgBag;
  return { overrides: base, config: moduleCfg };
}

// Project the cast Wan adapters into `motionConfig` IN PLACE. No-ops (applied: false) unless the
// motion backend is alibaba-wan-lora and wanPretrained is non-empty -- this internal gate is the
// safety net behind shouldProjectWanLoras, so a call site that forgets to guard still cannot
// cross-wire an SDXL cast or a non-Wan backend. Each cast slot contributes one high-noise + one
// low-noise expert: both R2 keys are presigned to fetchable URLs and appended (after any existing
// entries) to high_noise_loras / low_noise_loras as JSON [{ path, scale }]. The total pair count is
// capped at MAX_LORAS_PER_PASS; the overflow is dropped and logged. Slots are sorted so the emitted
// order is deterministic.
export async function projectWanLorasIntoModuleConfig(
  env: Env,
  motionBackend: string | undefined,
  wanPretrained: Record<string, { high: string; low: string }>,
  motionConfig: Record<string, unknown>,
  scale: number = WAN_LORA_DEFAULT_SCALE,
): Promise<WanProjectionResult> {
  if (!shouldProjectWanLoras(motionBackend, wanPretrained)) {
    return { injected: 0, dropped: 0, applied: false };
  }

  const high: LoraEntry[] = parseExistingLoras(motionConfig.high_noise_loras);
  const low: LoraEntry[] = parseExistingLoras(motionConfig.low_noise_loras);
  const preExisting = high.length;

  const slots = Object.keys(wanPretrained).sort();
  let injected = 0;
  let dropped = 0;
  for (const slot of slots) {
    if (high.length >= MAX_LORAS_PER_PASS || low.length >= MAX_LORAS_PER_PASS) {
      dropped += 1;
      continue;
    }
    const pair = wanPretrained[slot];
    const [highUrl, lowUrl] = await Promise.all([
      presignR2Get(env, pair.high, WAN_LORA_PRESIGN_TTL_SECONDS),
      presignR2Get(env, pair.low, WAN_LORA_PRESIGN_TTL_SECONDS),
    ]);
    high.push({ path: highUrl, scale });
    low.push({ path: lowUrl, scale });
    injected += 1;
  }

  if (dropped) {
    console.warn(
      "[wan-lora] bound cast has " +
        slots.length +
        " Wan adapter(s) but the pass caps at " +
        MAX_LORAS_PER_PASS +
        (preExisting ? " (" + preExisting + " already in config)" : "") +
        "; dropped " +
        dropped +
        ".",
    );
  }

  if (injected > 0) {
    motionConfig.high_noise_loras = JSON.stringify(high);
    motionConfig.low_noise_loras = JSON.stringify(low);
  }
  return { injected, dropped, applied: injected > 0 };
}
