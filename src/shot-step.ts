// Per-shot step record. Pure. The film job document in R2 is still the orchestrator's
// copy (keyframes, dialogue_audio, clips). This row is what a retry reads so a failed
// step runs again and the steps that already have a key do not.

export const SHOT_STEPS = ["still", "wav", "clip"] as const;
export type ShotStepName = (typeof SHOT_STEPS)[number];
export type ShotStep = ShotStepName | "done";

export interface ShotRecord {
  film_id: string;
  shot_id: string;
  still_key: string | null;
  wav_key: string | null;
  clip_key: string | null;
  step: ShotStep;
  step_error: string | null;
  step_token: string | null;
  updated_at: number;
}

export interface ShotParams {
  film_id: string;
  shot_id: string;
  still_key: string | null;
  /** A cast line means the wav step has to land a key. A silent shot skips it. */
  needs_wav: boolean;
  wav_key: string | null;
  clip_key: string | null;
  /** Presigned GET of the still. The clip call receives this, never the bytes. */
  still_url: string | null;
  wav_url: string | null;
}

/** The step that still has work. A key that is already set is not that step. */
export function stepToRun(row: Pick<ShotRecord, "still_key" | "wav_key" | "clip_key">, needsWav: boolean): ShotStep {
  if (!row.still_key) return "still";
  if (needsWav && !row.wav_key) return "wav";
  if (!row.clip_key) return "clip";
  return "done";
}

export function blankShot(params: ShotParams, now: number): ShotRecord {
  return {
    film_id: params.film_id,
    shot_id: params.shot_id,
    still_key: params.still_key,
    wav_key: params.wav_key,
    clip_key: params.clip_key,
    step: stepToRun(params, params.needs_wav),
    step_error: null,
    step_token: null,
    updated_at: now,
  };
}

/** Keep a key the row already has. A later params object with a null does not wipe it. */
export function mergeShot(row: ShotRecord, params: ShotParams, now: number): ShotRecord {
  const still_key = row.still_key || params.still_key || null;
  const wav_key = row.wav_key || params.wav_key || null;
  const clip_key = row.clip_key || params.clip_key || null;
  const merged = { ...row, still_key, wav_key, clip_key, updated_at: now };
  if (!row.step_error) merged.step = stepToRun(merged, params.needs_wav);
  return merged;
}

export function failStep(row: ShotRecord, step: ShotStepName, error: string, now: number): ShotRecord {
  return { ...row, step, step_error: error, updated_at: now };
}

export function landKey(row: ShotRecord, step: ShotStepName, key: string, now: number): ShotRecord {
  const next: ShotRecord = { ...row, step, step_error: null, step_token: null, updated_at: now };
  if (step === "still") next.still_key = key;
  if (step === "wav") next.wav_key = key;
  if (step === "clip") next.clip_key = key;
  return next;
}

/** What a catalog module or the GPU is given for the clip. URLs only. */
export interface ClipCall {
  still_url: string;
  wav_url?: string;
}

export function clipCall(stillUrl: string, wavUrl?: string): ClipCall {
  const call: ClipCall = { still_url: stillUrl };
  if (wavUrl) call.wav_url = wavUrl;
  return call;
}

const CREDENTIAL_KEYS = new Set([
  "secret_access_key",
  "access_key_id",
  "R2_S3_SECRET_ACCESS_KEY",
  "R2_S3_ACCESS_KEY_ID",
]);

/** An R2 binding is not a credential. These fields are. */
export function carriesR2Credential(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => carriesR2Credential(item));
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (CREDENTIAL_KEYS.has(key)) return true;
    if (carriesR2Credential(inner)) return true;
  }
  return false;
}

export function withoutR2Credential<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => withoutR2Credential(item)) as T;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (CREDENTIAL_KEYS.has(key)) continue;
    out[key] = withoutR2Credential(inner);
  }
  return out as T;
}

/** Tenant workers and dispatch modules get this env. The S3 keys are removed. */
export function envForTenantOrDispatch<T extends Record<string, unknown>>(env: T): T {
  const out = { ...env };
  delete out.R2_S3_ACCESS_KEY_ID;
  delete out.R2_S3_SECRET_ACCESS_KEY;
  return out;
}
