// cf#957: a Cast line WAV ends a short tail after its last speech. It used to run to 3.000s because
// dialogue-gen padded every short line for Wan, so audio-driven doors billed and animated ~1.66s of
// silence per shot. These tests run on real files: one Aura-1 line from the studio (2026-11-06) and two
// made with ffmpeg. The speech end each test asserts against was measured with ffmpeg silencedetect
// at -60 dB, outside this code, and is written next to it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseWav,
  trimTrailingSilence,
  speechEndBytes,
  writeWav,
  TAIL_SECONDS,
  SPEECH_FLOOR_DBFS,
} from "../modules/_shared/wav-pcm";
import { normalizeLineWav, mintSilenceWav } from "../modules/dialogue-gen/src/wav-duration";
import { DialogueGenWorkflow } from "../modules/dialogue-gen/src/index";
import { ChatterboxWorkflow } from "../modules/chatterbox/src/index";
import wanWorker from "../modules/alibaba-wan/src/index";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(__dirname, "fixtures", "line-tail-957", name)));

// Aura-1 "We should go. Now." in asteria. 0.998s, speech to the end of the file (silencedetect: none).
const AURA = "aura-asteria-we-should-go.wav";
// 220 Hz at -12 dB for 1.0s with a 60 ms fade, then 1.0s of zeros. silencedetect -60 dB: 0.997208.
const TONE = "tone-1s-then-1s-silence.wav";
const TONE_SPEECH_END_S = 0.997208;
// 8 kHz stereo. Left is silent; right is 330 Hz for 0.5s, then 1.0s of zeros. silencedetect: 0.5.
const STEREO = "stereo-right-only-0.5s-then-1s.wav";

/** The old artifact: a line padded with zeros to `seconds`, as dialogue-gen and the core did. */
function padTo(bytes: Uint8Array, seconds: number): Uint8Array {
  const p = parseWav(bytes)!;
  const pcm = bytes.subarray(p.format.dataOffset, p.format.dataOffset + p.format.dataSize);
  const grown = new Uint8Array(Math.round(seconds * p.format.sampleRate) * p.format.blockAlign);
  grown.set(pcm);
  return writeWav(p.format, grown);
}

/** Independent of the code under test: the time of the last sample at or above `dbfs`, any channel. */
function lastLoudSeconds(bytes: Uint8Array, dbfs: number): number {
  const p = parseWav(bytes)!;
  const v = new DataView(bytes.buffer, bytes.byteOffset + p.format.dataOffset, p.format.dataSize);
  const floor = 10 ** (dbfs / 20) * 32768;
  for (let i = p.format.dataSize / 2 - 1; i >= 0; i--) {
    if (Math.abs(v.getInt16(i * 2, true)) >= floor) {
      return Math.floor((i * 2) / p.format.blockAlign + 1) / p.format.sampleRate;
    }
  }
  return 0;
}

const pcmOf = (bytes: Uint8Array) => {
  const p = parseWav(bytes)!;
  return bytes.subarray(p.format.dataOffset, p.format.dataOffset + p.format.dataSize);
};

describe("trailing silence on real line files (cf#957)", () => {
  it("the 3.000s artifact the issue measured comes back to speech plus the tail", () => {
    const old = padTo(fixture(AURA), 3);
    expect(parseWav(old)!.seconds).toBeCloseTo(3, 6);
    const r = trimTrailingSilence(old)!;
    const end = lastLoudSeconds(old, SPEECH_FLOOR_DBFS);
    expect(end).toBeGreaterThan(0.95);
    // Speech end rounded up to a 10 ms block, plus the tail, and never past the speech in the source.
    expect(r.seconds).toBeGreaterThanOrEqual(end + TAIL_SECONDS - 1e-9);
    expect(r.seconds).toBeLessThanOrEqual(end + TAIL_SECONDS + 0.01 + 1e-9);
    expect(r.tail_trimmed_s).toBeCloseTo(3 - r.seconds, 6);
    expect(r.seconds).toBeLessThan(1.25);
  });

  it("no speech is cut: every kept sample is the source sample, and nothing loud is dropped", () => {
    const old = padTo(fixture(AURA), 3);
    const r = trimTrailingSilence(old)!;
    const kept = pcmOf(r.bytes);
    expect(Array.from(kept)).toEqual(Array.from(pcmOf(old).subarray(0, kept.length)));
    expect(lastLoudSeconds(r.bytes, SPEECH_FLOOR_DBFS)).toBeCloseTo(lastLoudSeconds(old, SPEECH_FLOOR_DBFS), 6);
  });

  it("the raw Aura line already ends in speech, so it is returned as it was", () => {
    const raw = fixture(AURA);
    const r = trimTrailingSilence(raw)!;
    expect(r.tail_trimmed_s).toBe(0);
    expect(r.bytes).toBe(raw);
  });

  it("an ffmpeg tone with a fade keeps its fade and loses its silence", () => {
    const r = trimTrailingSilence(fixture(TONE))!;
    expect(lastLoudSeconds(fixture(TONE), SPEECH_FLOOR_DBFS)).toBeCloseTo(TONE_SPEECH_END_S, 2);
    expect(r.seconds).toBeGreaterThanOrEqual(TONE_SPEECH_END_S + TAIL_SECONDS - 0.001);
    expect(r.seconds).toBeLessThanOrEqual(TONE_SPEECH_END_S + TAIL_SECONDS + 0.011);
    // A literal, so a tail of zero fails on the file and not only on the constant: 150 ms at least.
    expect(r.seconds - TONE_SPEECH_END_S).toBeGreaterThanOrEqual(0.15);
    // The file after the cut is still a file ffmpeg would read: a 44-byte header and the PCM.
    expect(parseWav(r.bytes)!.seconds).toBeCloseTo(r.seconds, 9);
  });

  it("speech on one channel only still counts as speech", () => {
    const r = trimTrailingSilence(fixture(STEREO))!;
    expect(r.seconds).toBeGreaterThanOrEqual(0.5 + TAIL_SECONDS - 1e-9);
    expect(r.seconds).toBeLessThanOrEqual(0.5 + TAIL_SECONDS + 0.011);
    expect(parseWav(r.bytes)!.format.channels).toBe(2);
  });

  it("an all-silent line is left alone, not cut to the tail", () => {
    const silent = mintSilenceWav(3);
    const r = trimTrailingSilence(silent)!;
    expect(r.tail_trimmed_s).toBe(0);
    expect(r.bytes).toBe(silent);
    const p = parseWav(silent)!;
    expect(speechEndBytes(silent.subarray(p.format.dataOffset), p.format)).toBe(0);
  });

  it("refuses bytes that are not WAV", () => {
    expect(trimTrailingSilence(new TextEncoder().encode("not a wav"))).toBeNull();
  });

  it("the tail and the floor are the values the issue chose", () => {
    expect(TAIL_SECONDS).toBeGreaterThanOrEqual(0.15);
    expect(TAIL_SECONDS).toBeLessThanOrEqual(0.25);
    expect(SPEECH_FLOOR_DBFS).toBeLessThanOrEqual(-55);
  });
});

describe("dialogue-gen no longer pads (cf#957)", () => {
  it("a short line is not grown to 3s; the old 3s artifact is cut to speech plus the tail", () => {
    const raw = normalizeLineWav(fixture(AURA))!;
    expect(raw.seconds).toBeCloseTo(0.998417, 5);
    const old = normalizeLineWav(padTo(fixture(AURA), 3))!;
    expect(old.seconds).toBeLessThan(1.25);
    expect(old.tail_trimmed_s).toBeGreaterThan(1.7);
  });

  it("the workflow writes the trimmed line and reports its real length", async () => {
    const store = new Map<string, { body: unknown; meta?: Record<string, string> }>();
    const env = {
      GATEWAY_ID: "gw",
      AI: { run: async () => padTo(fixture(TONE), 3) },
      R2_RENDERS: {
        async put(key: string, v: unknown, o?: { customMetadata?: Record<string, string> }) { store.set(key, { body: v, meta: o?.customMetadata }); },
        async get(key: string) { const s = store.get(key); return s && typeof s.body === "string" ? { text: async () => s.body as string } : null; },
      },
      DIALOGUE_WORKFLOW: {} as never,
    };
    const step = { do: async (_n: string, _c: unknown, fn: () => Promise<unknown>) => fn() };
    await new DialogueGenWorkflow(null as never, env as never).run(
      { payload: { job_id: "j", project: "f", lines: [{ shot_id: "shot_01", text: "Hi.", voice: "orion" }] } } as never,
      step as never,
    );
    const wav = store.get("renders/f/dialogue/shot_01.wav")!;
    const written = new Uint8Array(wav.body as ArrayBuffer);
    const seconds = parseWav(written)!.seconds;
    expect(seconds).toBeLessThan(TONE_SPEECH_END_S + TAIL_SECONDS + 0.011);
    expect(Number(wav.meta?.tail_trimmed_s)).toBeCloseTo(3 - seconds, 3);
    const state = JSON.parse(store.get("dialogue-gen/j.state.json")!.body as string) as { audio: Array<{ duration_s: number }> };
    expect(state.audio[0].duration_s).toBeCloseTo(seconds, 9);
  });
});

describe("chatterbox trims at the producer (cf#957)", () => {
  it("a padded provider file is stored trimmed, with its length", async () => {
    const store = new Map<string, { body: unknown; meta?: Record<string, string> }>();
    const bought = padTo(fixture(TONE), 3);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url instanceof Request ? url.url : url);
      if (u.startsWith("https://audio.example/")) return new Response(bought);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      void body;
      return new Response(JSON.stringify({ id: "rp-1", status: "COMPLETED", output: { audio_url: "https://audio.example/line.wav" } }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const env = {
        RUNPOD_API_KEY: "k",
        R2_RENDERS: {
          async put(key: string, v: unknown, o?: { customMetadata?: Record<string, string> }) { store.set(key, { body: v, meta: o?.customMetadata }); },
          async get(key: string) { const s = store.get(key); return s && typeof s.body === "string" ? { text: async () => s.body as string } : null; },
        },
        CHATTERBOX_WORKFLOW: {} as never,
      };
      const step = {
        do: async (_n: string, a: unknown, b?: () => Promise<unknown>) => (typeof a === "function" ? (a as () => Promise<unknown>)() : b!()),
        sleep: async () => {},
      };
      await new ChatterboxWorkflow(null as never, env as never).run(
        { payload: { job_id: "j", project: "f", lines: [{ shot_id: "shot_01", text: "Hi.", voice: "orion" }] } } as never,
        step as never,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    const state = JSON.parse(store.get("chatterbox/j.state.json")!.body as string) as {
      status: string; error?: string; audio: Array<{ duration_s: number }>;
    };
    expect(state.status, state.error).toBe("done");
    const wav = store.get("renders/f/dialogue/shot_01.wav")!;
    const seconds = parseWav(new Uint8Array(wav.body as ArrayBuffer))!.seconds;
    expect(seconds).toBeGreaterThanOrEqual(TONE_SPEECH_END_S + TAIL_SECONDS - 0.001);
    expect(seconds).toBeLessThan(TONE_SPEECH_END_S + TAIL_SECONDS + 0.011);
    expect(state.audio[0].duration_s).toBeCloseTo(seconds, 9);
    expect(Number(wav.meta?.tail_trimmed_s)).toBeCloseTo(3 - seconds, 3);
  });
});

describe("the 3s floor belongs to Wan (cf#957)", () => {
  it("alibaba-wan declares driving_audio_min_seconds 3", async () => {
    const res = await wanWorker.fetch(new Request("https://m/module.json"), {} as never);
    const m = (await res.json()) as { usage: { driving_audio: boolean; driving_audio_min_seconds?: number } };
    expect(m.usage.driving_audio).toBe(true);
    expect(m.usage.driving_audio_min_seconds).toBe(3);
  });
});
