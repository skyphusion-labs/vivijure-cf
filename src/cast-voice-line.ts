// One Aura-1 line for a cast member. The filmmaker hears the voice they picked and that
// voice_id stays on the member. This is not a clip, and it is not a Seedance voice sample.

import { getCastById, updateCast } from "@skyphusion-labs/vivijure-core/cast-db";
import { DIALOGUE_TTS_MODEL, isValidVoiceId } from "@skyphusion-labs/vivijure-core/voices";
import type { Env } from "./env";
import { aiGatewayReady, aiRun } from "./ai-binding";
import { presignR2Get } from "./r2-presign";

export const CAST_VOICE_LINE_MAX_CHARS = 300;
export const CAST_VOICE_LINE_DEFAULT = "Hello. This is how I sound.";

export interface CastVoiceLineRequest {
  text: string;
  voiceId: string;
}

/** Pure: the line and speaker a preview will synthesize. A bad voice or an over-cap line is an error. */
export function castVoiceLineRequest(
  savedVoiceId: string | null | undefined,
  body: { text?: unknown; voice_id?: unknown } | null,
): { ok: true; value: CastVoiceLineRequest } | { ok: false; error: string } {
  const requested = body && typeof body.voice_id === "string" ? body.voice_id.trim() : "";
  const voiceId = requested || (savedVoiceId || "").trim();
  if (!voiceId) return { ok: false, error: "Pick an Aura-1 voice first." };
  if (!isValidVoiceId(voiceId)) {
    return { ok: false, error: "voice_id must be one Aura-1 speaker." };
  }
  const raw = body && typeof body.text === "string" ? body.text.trim() : "";
  const text = raw || CAST_VOICE_LINE_DEFAULT;
  if (text.length > CAST_VOICE_LINE_MAX_CHARS) {
    return { ok: false, error: `line is ${text.length} chars; cap is ${CAST_VOICE_LINE_MAX_CHARS}` };
  }
  return { ok: true, value: { text, voiceId } };
}

export function castVoiceLineKey(castId: number): string {
  return `cast/${castId}/voice-line.wav`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Speak one line in the cast member's Aura-1 voice, store the WAV, and keep that voice_id. */
export async function hearCastVoiceLine(request: Request, env: Env, castId: number): Promise<Response> {
  const cast = await getCastById(env, castId);
  if (!cast) return json({ error: "cast member not found" }, 404);
  let body: { text?: unknown; voice_id?: unknown } | null = null;
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      body = (await request.json()) as { text?: unknown; voice_id?: unknown };
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
  }
  const parsed = castVoiceLineRequest(cast.voice_id, body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  if (!(await aiGatewayReady(env))) {
    return json({ error: "Aura-1 is not available on this studio (AI binding and GATEWAY_ID)." }, 503);
  }
  if (parsed.value.voiceId !== cast.voice_id) {
    const saved = await updateCast(env, castId, { voice_id: parsed.value.voiceId });
    if (!saved) return json({ error: "cast member not found" }, 404);
  }
  let bytes: ArrayBuffer;
  try {
    const result = await aiRun(
      env,
      DIALOGUE_TTS_MODEL,
      { text: parsed.value.text, speaker: parsed.value.voiceId, encoding: "linear16", container: "wav" },
      true,
    );
    bytes = result instanceof Response
      ? await result.arrayBuffer()
      : await new Response(result as BodyInit).arrayBuffer();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: `could not speak the line: ${msg}` }, 502);
  }
  if (bytes.byteLength === 0) return json({ error: "Aura-1 returned empty audio" }, 502);
  const key = castVoiceLineKey(castId);
  await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: "audio/wav" } });
  const url = await presignR2Get(env, key, 600);
  return json({ key, url, voice_id: parsed.value.voiceId });
}
