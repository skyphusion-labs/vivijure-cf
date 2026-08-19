// Cast talking-voice sample. The filmmaker hears a 5/10s clip from the portrait
// on a talking door, then keeps it. Seedance later sends that clip as
// reference_video. Veo cannot honor it.

import { getCastById, updateCast } from "@skyphusion-labs/vivijure-core/cast-db";
import { discoverModules, invokeModule, pollModule, resolveFetcher } from "@skyphusion-labs/vivijure-core/modules/registry";
import { composeMotionPrompt } from "@skyphusion-labs/vivijure-core/film-orchestrator";
import { isSafeRelKey } from "@skyphusion-labs/vivijure-core/key-safety";
import { presignR2Get } from "@skyphusion-labs/vivijure-core/presign";
import { voiceLockHint } from "@skyphusion-labs/vivijure-core/voices";
import type { Env } from "./env";
import { studioEnv } from "./orchestrator-env";

function fail(status: 400 | 404, msg: string): never {
  const e = new Error(msg) as Error & { sampleStatus: 400 | 404 };
  e.sampleStatus = status;
  throw e;
}

export function isSampleError(e: unknown): e is Error & { sampleStatus: 400 | 404 } {
  return !!e && typeof e === "object" && "sampleStatus" in e;
}

const SAMPLE_STATE_PREFIX = "casts/voice-sample/";

export const TALKING_VOICE_HONOR = [
  {
    name: "cf-seedance",
    honor: "exact" as const,
    label: "Uses the sample you kept. Same voice on every shot.",
  },
  {
    name: "seedance",
    honor: "none" as const,
    label: "RunPod 1.5 cannot lock the sample. Use Cloudflare Seedance.",
  },
  {
    name: "cf-veo",
    honor: "neighborhood" as const,
    label: "Cannot lock the sample you heard. Same description, not the same take.",
  },
  {
    name: "google-veo",
    honor: "neighborhood" as const,
    label: "Cannot lock the sample you heard. Same description, not the same take.",
  },
  {
    name: "cf-flux-3-video",
    honor: "neighborhood" as const,
    label: "Cannot lock the sample you heard. Same description, not the same take.",
  },
  {
    name: "cf-grok-video",
    honor: "neighborhood" as const,
    label: "Cannot lock the sample you heard. Same description, not the same take.",
  },
  {
    name: "vidu-q3",
    honor: "neighborhood" as const,
    label: "Cannot lock the sample you heard. Same description, not the same take.",
  },
  {
    name: "alibaba-wan",
    honor: "neighborhood" as const,
    label: "RunPod Wan 2.6. Sends the Cast sample as audio when kept. Prompt for the line.",
  },
];

type SampleState = {
  poll: string;
  binding: string;
  module_name: string;
  clip_key?: string;
};

function stateKey(publicId: string): string {
  return SAMPLE_STATE_PREFIX + publicId + ".json";
}

async function putState(env: Env, publicId: string, state: SampleState): Promise<void> {
  await env.R2_RENDERS.put(stateKey(publicId), JSON.stringify(state));
}

async function getState(env: Env, publicId: string): Promise<SampleState | null> {
  const obj = await env.R2_RENDERS.get(stateKey(publicId));
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text()) as SampleState;
  } catch {
    return null;
  }
}

function pickSampleDoor(modules: { name: string; binding: string; usage?: { native_audio?: boolean; voice_ref?: boolean } }[]) {
  const seedance = modules.find((m) => m.name === "cf-seedance" && m.usage?.voice_ref);
  if (seedance) return seedance;
  return modules.find((m) => m.usage?.native_audio) ?? null;
}

export async function startCastVoiceSample(
  env: Env,
  castId: number,
  opts: { seconds?: number; line?: string; motion_backend?: string },
): Promise<{ poll: string; module_name: string; seconds: number }> {
  const cast = await getCastById(env, castId);
  if (!cast) fail(404, "cast member");
  if (!cast.portrait_key) fail(400, "Add a portrait first. The sample is image-to-video of that still.");
  const seconds = opts.seconds === 10 ? 10 : 5;
  const line = (opts.line || "Hello. This is how I sound.").trim();
  const orch = studioEnv(env);
  const envRec = env as unknown as Record<string, unknown>;
  const modules = await discoverModules(envRec);
  const talking = modules.filter((m) => m.hooks.includes("motion.backend"));
  const door = opts.motion_backend
    ? talking.find((m) => m.name === opts.motion_backend)
    : pickSampleDoor(talking);
  if (!door) fail(400, "No talking door is installed. Bind Cloudflare Seedance to sample a voice.");
  const fetcher = resolveFetcher(envRec, door.binding);
  if (!fetcher) fail(400, "Talking door is bound in the catalog but has no fetcher.");
  const keyframe_url = await presignR2Get(orch, cast.portrait_key, 1800);
  const prompt = composeMotionPrompt("The person in the still speaks to camera.", {
    voice_lock: voiceLockHint(cast.voice_id) || (cast.name || "this character") + ": same speaking voice.",
    spoken_line: line,
    speaker: cast.name || undefined,
  });
  const r = await invokeModule(fetcher, {
    hook: "motion.backend",
    input: {
      shot_id: "voice-sample",
      keyframe_url,
      keyframe_key: cast.portrait_key,
      prompt,
      seconds,
    },
    config: { generate_audio: true },
    context: { project: "cast", job_id: "voice-sample-" + cast.public_id },
  });
  if (!r.ok) fail(400, r.error || "voice sample failed to start");
  if (!("pending" in r) || !r.poll) {
    fail(400, "talking door did not return a poll token");
  }
  await putState(env, cast.public_id, { poll: r.poll, binding: door.binding, module_name: door.name });
  return { poll: r.poll, module_name: door.name, seconds };
}

export async function pollCastVoiceSample(
  env: Env,
  castId: number,
): Promise<{ status: "pending" | "done" | "failed"; clip_key?: string; error?: string; module_name?: string }> {
  const cast = await getCastById(env, castId);
  if (!cast) fail(404, "cast member");
  const state = await getState(env, cast.public_id);
  if (!state) fail(400, "No voice sample in flight. Generate one first.");
  const envRec = env as unknown as Record<string, unknown>;
  const modules = await discoverModules(envRec);
  const door = modules.find((m) => m.binding === state.binding);
  if (!door) fail(400, "Talking door is no longer bound.");
  const fetcher = resolveFetcher(envRec, door.binding);
  if (!fetcher) fail(400, "Talking door is bound in the catalog but has no fetcher.");
  const r = await pollModule(fetcher, { poll: state.poll });
  if (!r.ok) return { status: "failed", error: r.error, module_name: state.module_name };
  if ("pending" in r && r.pending) return { status: "pending", module_name: state.module_name };
  const out = "output" in r ? r.output as { clip_key?: string } : undefined;
  const clip_key = out && typeof out.clip_key === "string" ? out.clip_key : undefined;
  if (!clip_key) return { status: "failed", error: "sample finished with no clip", module_name: state.module_name };
  await putState(env, cast.public_id, { ...state, clip_key });
  return { status: "done", clip_key, module_name: state.module_name };
}

export async function keepCastVoiceSample(env: Env, castId: number): Promise<{ voice_ref_key: string }> {
  const cast = await getCastById(env, castId);
  if (!cast) fail(404, "cast member");
  const state = await getState(env, cast.public_id);
  if (!state?.clip_key) fail(400, "No finished sample to keep. Generate one and wait for it.");
  const row = await updateCast(env, castId, { voice_ref_key: state.clip_key });
  if (!row) fail(404, "cast member");
  return { voice_ref_key: state.clip_key };
}

export async function clearCastVoiceSample(env: Env, castId: number): Promise<void> {
  await updateCast(env, castId, { voice_ref_key: null });
}

/** Map talking shots to the kept Cast sample. Slot comes from the storyboard line. */
export function voiceRefKeysFromScenes(
  scenes: Array<{ shot_id?: string; dialogue?: { slot?: string; text?: string } }>,
  voiceRefs: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!voiceRefs) return undefined;
  const out: Record<string, string> = {};
  for (const s of scenes) {
    const text = s.dialogue && s.dialogue.text;
    const slot = s.dialogue && s.dialogue.slot;
    const shot = s.shot_id;
    const key = slot ? voiceRefs[slot] : undefined;
    if (shot && key && typeof text === "string" && text.trim()) out[shot] = key;
  }
  return Object.keys(out).length ? out : undefined;
}

const VOICE_REF_MAX = 32 * 1024 * 1024;
const VOICE_REF_EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
};

/** Magic-byte sniff. Fail closed: HTML/unknown never becomes a voice lock. */
export function sniffVoiceRefMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return "video/mp4";
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "video/webm";
  }
  if (
    bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45
  ) {
    return "audio/wav";
  }
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "audio/mpeg";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg";
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return "audio/ogg";
  }
  return null;
}

async function persistVoiceRef(
  env: Env,
  castId: number,
  bytes: Uint8Array,
  claimedMime: string,
): Promise<{ voice_ref_key: string; mime: string }> {
  if (!bytes.byteLength) fail(400, "empty upload body");
  if (bytes.byteLength > VOICE_REF_MAX) fail(400, "upload too large (max 32MB)");
  const sniffed = sniffVoiceRefMime(bytes);
  if (!sniffed) fail(400, "bytes are not a recognizable video or audio clip");
  const claimed = (claimedMime || "").toLowerCase().split(";")[0].trim();
  if (claimed && claimed !== "application/octet-stream" && !VOICE_REF_EXT[claimed]) {
    fail(400, "unsupported content-type " + claimed + " (video or audio clip only)");
  }
  const ext = VOICE_REF_EXT[sniffed] || "bin";
  const key = "cast/" + castId + "/voice-ref." + ext;
  await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: sniffed } });
  const row = await updateCast(env, castId, { voice_ref_key: key });
  if (!row) fail(404, "cast member");
  return { voice_ref_key: key, mime: sniffed };
}

/** Attach a clip the filmmaker already has (generated elsewhere, or their own take). */
export async function attachCastVoiceSample(
  env: Env,
  castId: number,
  opts: { bytes: ArrayBuffer; claimedMime: string },
): Promise<{ voice_ref_key: string; mime: string }> {
  const cast = await getCastById(env, castId);
  if (!cast) fail(404, "cast member");
  return persistVoiceRef(env, castId, new Uint8Array(opts.bytes), opts.claimedMime);
}

export async function attachCastVoiceSampleFromKey(
  env: Env,
  castId: number,
  srcKey: string,
): Promise<{ voice_ref_key: string; mime: string }> {
  const cast = await getCastById(env, castId);
  if (!cast) fail(404, "cast member");
  if (!isSafeRelKey(srcKey)) fail(400, "unsafe key");
  const obj = await env.R2_RENDERS.get(srcKey);
  if (!obj) fail(404, "source clip not found");
  const bytes = new Uint8Array(await obj.arrayBuffer());
  return persistVoiceRef(env, castId, bytes, obj.httpMetadata?.contentType || "");
}
