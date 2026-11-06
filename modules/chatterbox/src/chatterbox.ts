// Pure helpers for the chatterbox module: TTS param construction, R2 key layout, poll tokens, run
// state, and line validation. No I/O -- unit-tested without bindings or spend.
//
// Backed by the RunPod public chatterbox-turbo endpoint. We request WAV (not the
// default MP3) so the spoken track stays clean and lossless all the way into the final mux.

import type { DialogueInput, DialogueLine, DialogueOutput, DialogueShotAudio } from "./contract";

export const MODEL = "chatterbox-turbo" as const;

// --- vendored voice catalog (kept in sync with the core's src/voices.ts; modules vendor, not import) ---
export const VOICE_IDS = [
  "angus", "asteria", "arcas", "orion", "orpheus", "athena",
  "luna", "zeus", "perseus", "helios", "hera", "stella",
] as const;
export type VoiceId = (typeof VOICE_IDS)[number];
export const DEFAULT_VOICE_ID: VoiceId = "angus";
const VOICE_SET: ReadonlySet<string> = new Set(VOICE_IDS);

// Resolve a requested voice to a valid speaker, falling back to the default for absent/unknown ones.
// (The core normally resolves this; the fallback keeps a stray line from failing the whole batch.)
export function resolveVoice(voiceId: string | undefined): VoiceId {
  return voiceId && VOICE_SET.has(voiceId) ? (voiceId as VoiceId) : DEFAULT_VOICE_ID;
}

// Per-line cap, mirrors the core's DIALOGUE_MAX_CHARS. A second guard here keeps the billed TTS call
// bounded even if a caller skipped core validation.
export const DIALOGUE_MAX_CHARS = 300;

const AURA_TO_CHATTERBOX: Record<VoiceId, string> = {
  angus: "gordon",
  asteria: "lucy",
  arcas: "aaron",
  orion: "archer",
  orpheus: "ethan",
  athena: "chloe",
  luna: "madison",
  zeus: "walter",
  perseus: "brian",
  helios: "gavin",
  hera: "laura",
  stella: "evelyn",
};

export function chatterboxVoice(voice: VoiceId): string {
  return AURA_TO_CHATTERBOX[voice] || "lucy";
}

export function buildTtsParams(text: string, voice: VoiceId): Record<string, unknown> {
  return { prompt: text, voice: chatterboxVoice(voice), format: "wav" };
}

export const AUDIO_MIME = "audio/wav";

export interface PollToken { job_id: string; }

export function encodePoll(t: PollToken): string {
  return btoa(JSON.stringify(t));
}
export function decodePoll(token: string): PollToken | null {
  try {
    const o = JSON.parse(atob(token)) as PollToken;
    if (o && typeof o.job_id === "string" && o.job_id.length > 0) return { job_id: o.job_id };
  } catch { /* fall through */ }
  return null;
}

export function stateKey(jobId: string): string {
  return `chatterbox/${jobId}.state.json`;
}

// Per-shot audio lands beside the shot's other render artifacts. shot_id is already a safe
// `shot_NN` token (the core validates it), so it is a safe key segment.
export function audioKey(project: string, shotId: string): string {
  return `renders/${project}/dialogue/${shotId}.wav`;
}

// `running` carries the workflow instance id so /poll can surface an errored/terminated workflow as a
// failure instead of pending-forever; R2 presence of the done state remains the authoritative signal.
export type RunState =
  | { status: "running"; started_at: number; project: string; workflow_id?: string }
  | { status: "done"; project: string; audio: DialogueShotAudio[]; applied: string[] }
  | { status: "failed"; error: string };

export function appliedTags(audio: DialogueShotAudio[]): string[] {
  return [`dialogue:${MODEL}`, `lines:${audio.length}`];
}

export function readOutput(state: Extract<RunState, { status: "done" }>): DialogueOutput {
  return { project: state.project, audio: state.audio, applied: state.applied };
}

/** Validate + normalize the batch input. Returns the cleaned lines or an error string. Empty text or
 *  a missing shot_id drops that line (a no-op shot), but an over-cap line is a hard error so a caller
 *  can't silently truncate a character's words. */
export function normalizeInput(input: DialogueInput | undefined): { ok: true; project: string; lines: NormalizedLine[] } | { ok: false; error: string } {
  const project = typeof input?.project === "string" ? input.project.trim() : "";
  if (!project) return { ok: false, error: "input.project required" };
  if (!Array.isArray(input?.lines)) return { ok: false, error: "input.lines must be an array" };
  const lines: NormalizedLine[] = [];
  for (const raw of input.lines as DialogueLine[]) {
    const shotId = typeof raw?.shot_id === "string" ? raw.shot_id.trim() : "";
    const text = typeof raw?.text === "string" ? raw.text.trim() : "";
    if (!shotId || !text) continue;  // nothing to say for this shot -> skip it
    if (text.length > DIALOGUE_MAX_CHARS) {
      return { ok: false, error: `line for ${shotId} is ${text.length} chars; cap is ${DIALOGUE_MAX_CHARS}` };
    }
    lines.push({ shot_id: shotId, text, voice: resolveVoice(raw.voice_id) });
  }
  return { ok: true, project, lines };
}

export interface NormalizedLine {
  shot_id: string;
  text: string;
  voice: VoiceId;
}

// --- the provider job (cf#1164) ---
//
// `/runsync` waits about 90 s. A job still queued or running at that point comes back as
// `{ id, status: "IN_QUEUE" | "IN_PROGRESS" }` with no output, and the job keeps going. A failed job comes
// back as `{ id, status: "FAILED", error }`, often with HTTP 400. So a reply is read by its status, and a
// non-terminal job is polled by its id, never submitted again.

/** What one reply from `/runsync` or `/status/<id>` says about a line. */
export type LineProgress =
  | { kind: "done"; url: string }
  | { kind: "pending"; id: string; status: string }
  | { kind: "failed"; error: string };

const PENDING_STATUSES: ReadonlySet<string> = new Set(["IN_QUEUE", "IN_PROGRESS"]);
const FAILED_STATUSES: ReadonlySet<string> = new Set(["FAILED", "CANCELLED", "TIMED_OUT"]);

function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const m = (e as Record<string, unknown>).message;
    if (typeof m === "string" && m.length > 0) return m;
    return JSON.stringify(e);
  }
  return "";
}

/** Pure. Reads one provider reply. Returns null when the reply carries no job status at all, so the caller
 *  can tell "the provider answered" from "the request did not reach a job" (an HTTP error with no body). */
export function readJobReply(httpStatus: number, body: unknown): LineProgress | null {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const status = typeof b.status === "string" ? b.status : "";
  const id = typeof b.id === "string" ? b.id : "";
  const err = errorText(b.error).slice(0, 300);
  if (status === "COMPLETED") {
    const out = b.output && typeof b.output === "object" ? (b.output as Record<string, unknown>) : {};
    const url = typeof out.audio_url === "string" ? out.audio_url : "";
    if (url) return { kind: "done", url };
    return { kind: "failed", error: "chatterbox job " + (id || "?") + " COMPLETED with no audio_url" + (err ? ": " + err : "") };
  }
  if (PENDING_STATUSES.has(status)) {
    // A job we cannot name cannot be polled or cancelled. Report it, rather than submit a second one.
    if (!id) return { kind: "failed", error: "chatterbox reply " + status + " carried no job id" };
    return { kind: "pending", id, status };
  }
  if (FAILED_STATUSES.has(status)) {
    return { kind: "failed", error: "chatterbox job " + (id || "?") + " " + status + (err ? ": " + err : "") + " (HTTP " + httpStatus + ")" };
  }
  if (status) return { kind: "failed", error: "chatterbox job " + (id || "?") + " has unknown status " + status + " (HTTP " + httpStatus + ")" };
  return null;
}

/** Poll cadence for a queued line. 20 s apart, 30 polls: a line waits at most about 10 minutes in the
 *  provider queue, then it is cancelled and the film fails with the status it was stuck in. */
export const LINE_POLL_DELAY = "20 seconds" as const;
export const LINE_MAX_POLLS = 30;
