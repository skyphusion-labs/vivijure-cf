import type { KeyframeInput } from "./contract";
import { isSafeJobId } from "./i2v";

const TIERS = ["draft", "standard", "final"] as const;
type Tier = (typeof TIERS)[number];

function clampTier(v: unknown): Tier {
  return (TIERS as readonly string[]).includes(v as string) ? (v as Tier) : "final";
}

function keyframeOverrides(cfg: Record<string, unknown>): Record<string, number> {
  const o: Record<string, number> = {};
  const num = (k: string, src: string) => {
    if (typeof cfg[src] === "number" && Number.isFinite(cfg[src] as number)) o[k] = cfg[src] as number;
  };
  num("width", "width");
  num("height", "height");
  num("steps", "steps");
  num("guidance_scale", "guidance_scale");
  if (typeof cfg.seed === "number" && cfg.seed >= 0) o.seed = cfg.seed;
  return o;
}

/** Build the local door's `action: preview` body (same wire as RunPod vivijure-backend preview). */
export function buildPreviewBody(input: KeyframeInput, cfg: Record<string, unknown>): {
  input: Record<string, unknown>;
} {
  const body: Record<string, unknown> = {
    action: "preview",
    project: input.project,
    bundle_key: input.bundle_key,
    quality_tier: clampTier(cfg.quality_tier),
  };
  const kf = keyframeOverrides(cfg);
  if (Object.keys(kf).length) body.render_overrides = { keyframe: kf };
  if (input.shot_ids?.length) body.process_shot_ids = input.shot_ids;
  if (input.pretrained_loras && Object.keys(input.pretrained_loras).length) {
    body.pretrained_loras = { ...input.pretrained_loras };
  }
  return { input: body };
}

export interface KeyframeShot {
  shot_id: string;
  keyframe_key: string;
}

export function parseKeyframes(result: unknown): KeyframeShot[] {
  const root =
    result && typeof result === "object" && "keyframes" in (result as object)
      ? (result as Record<string, unknown>)
      : ((result as { output?: unknown })?.output as Record<string, unknown> | undefined);
  const arr = root && Array.isArray(root.keyframes) ? (root.keyframes as unknown[]) : [];
  const out: KeyframeShot[] = [];
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const shot_id = typeof o.shot_id === "string" ? o.shot_id : null;
    const key =
      typeof o.key === "string" ? o.key : typeof o.keyframe_key === "string" ? o.keyframe_key : null;
    if (shot_id && key) out.push({ shot_id, keyframe_key: key });
  }
  return out;
}

export function parseTrainedLoras(result: unknown): Record<string, string> {
  const root =
    result && typeof result === "object" && "keyframes" in (result as object)
      ? (result as Record<string, unknown>)
      : ((result as { output?: unknown })?.output as Record<string, unknown> | undefined);
  const lora =
    root && root.lora && typeof root.lora === "object"
      ? (root.lora as Record<string, unknown>)
      : {};
  const out: Record<string, string> = {};
  for (const [slot, v] of Object.entries(lora)) {
    const id = v && typeof v === "object" ? (v as Record<string, unknown>).lora_id : undefined;
    if (typeof id === "string" && id) out[slot] = id;
  }
  return out;
}

export interface KeyframePollState {
  jobId: string;
  project: string;
  submittedAt?: number;
  kind: "keyframe";
}

export function encodeKeyframePoll(s: KeyframePollState): string {
  return btoa(JSON.stringify(s));
}

export function decodeKeyframePoll(token: string): KeyframePollState | null {
  try {
    const o = JSON.parse(atob(token)) as KeyframePollState & { shotId?: unknown };
    // kind:"keyframe" discriminator keeps motion poll tokens from being treated as keyframe polls.
    if (
      o &&
      typeof o.jobId === "string" &&
      isSafeJobId(o.jobId) &&
      typeof o.project === "string" &&
      o.kind === "keyframe" &&
      typeof o.shotId !== "string"
    ) {
      return o;
    }
  } catch {
    /* bad token */
  }
  return null;
}
