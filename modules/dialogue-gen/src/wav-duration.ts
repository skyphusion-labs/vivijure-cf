// RIFF/WAVE helpers (Aura writes linear16 PCM). The parser and writer are shared with chatterbox in
// modules/_shared/wav-pcm.ts. Cap at 15s (both driving-audio doors).
//
// cf#957: no pad. A line used to be padded to 3.0s for Wan, so every door billed and animated about
// 1.66s of silence per short line. Wan declares that floor itself (usage.driving_audio_min_seconds) and
// the core pads for that door only. Here a line ends TAIL_SECONDS after its last speech.
import {
  parseWav,
  pcmBytesFor,
  writeWav,
  trimTrailingSilencePcm,
  type WavFormat,
} from "../../_shared/wav-pcm";

export { parseWav, SPEECH_FLOOR_DBFS, TAIL_SECONDS, type WavFormat, type WavDuration } from "../../_shared/wav-pcm";

export const LINE_WAV_MAX_SECONDS = 15;
export const SILENCE_WAV_SAMPLE_RATE = 24_000;
export const SILENCE_WAV_CHANNELS = 1;
export const SILENCE_WAV_BITS = 16;

export function parseWavDurationSeconds(bytes: Uint8Array): number | null {
  const parsed = parseWav(bytes);
  return parsed ? parsed.seconds : null;
}

export interface NormalizedLineWav {
  bytes: Uint8Array;
  seconds: number;
  /** Cut at the 15s cap. */
  trimmed: boolean;
  /** Seconds of trailing silence removed after the last speech (cf#957). 0 when nothing was cut. */
  tail_trimmed_s: number;
  /** Gain applied to the line, in dB. 0 when nothing was changed. */
  gain_db: number;
}

// Aura's level varies by about 20 dB from line to line, and short lines come back quietest, so one speaker can
// be hard to hear beside another. Each line is brought to one speech level. Measured on speech only, in 20 ms
// blocks above the gate, so the pauses in a line and the pad after it do not count.
//
// Noise must not come out at speech level. Full gain applies down to LINE_FULL_GAIN_DBFS, the quietest of 40 real
// lines measured -34.8, and the gain fades to nothing at the gate. So output only falls as input falls, with no
// step at either end, and a faint line stays faint.
export const LINE_TARGET_DBFS = -20;
export const LINE_PEAK_LIMIT_DBFS = -1;
export const LINE_GATE_DBFS = -50;
export const LINE_FULL_GAIN_DBFS = -40;
const FULL_SCALE = 32768;
const toDb = (x: number) => 20 * Math.log10(x);

/** The gain to apply to 16-bit PCM, in dB: to the target, faded for a faint line, no more than the peak limit allows. */
export function lineGainDb(samples: Int16Array, blockSamples: number): number {
  const gate = 10 ** (LINE_GATE_DBFS / 20) * FULL_SCALE;
  let sum = 0;
  let count = 0;
  let peak = 0;
  for (let start = 0; start < samples.length; start += blockSamples) {
    const end = Math.min(start + blockSamples, samples.length);
    let block = 0;
    for (let i = start; i < end; i++) {
      block += samples[i] * samples[i];
      peak = Math.max(peak, Math.abs(samples[i]));
    }
    if (Math.sqrt(block / (end - start)) >= gate) {
      sum += block;
      count += end - start;
    }
  }
  if (count === 0) return 0; // Nothing but silence: nothing to level.
  const level = toDb(Math.sqrt(sum / count) / FULL_SCALE);
  const room = LINE_PEAK_LIMIT_DBFS - toDb(peak / FULL_SCALE);
  const wanted = LINE_TARGET_DBFS - level;
  const fade = (level - LINE_GATE_DBFS) / (LINE_FULL_GAIN_DBFS - LINE_GATE_DBFS);
  return Math.min(wanted > 0 ? wanted * Math.max(0, Math.min(1, fade)) : wanted, room);
}

/** A leveled copy of PCM, and the gain used. Only 16-bit PCM is leveled; other depths come back as they were. */
function levelPcm(pcm: Uint8Array, format: WavFormat): { pcm: Uint8Array; gain_db: number } {
  if (format.bitsPerSample !== 16 || pcm.length < 2) return { pcm, gain_db: 0 };
  // A copy, since the source may not be aligned for 16-bit reads.
  const copy = new Uint8Array(pcm.length - (pcm.length % 2));
  copy.set(pcm.subarray(0, copy.length));
  const samples = new Int16Array(copy.buffer);
  const gain_db = lineGainDb(samples, Math.max(1, Math.round(format.sampleRate * format.channels * 0.02)));
  if (gain_db === 0) return { pcm, gain_db: 0 };
  const factor = 10 ** (gain_db / 20);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * factor)));
  }
  return { pcm: copy, gain_db };
}

/** Trim above 15.0s, cut trailing silence to TAIL_SECONDS, then level the line. Never pads (cf#957).
 *  Returns the original bytes when nothing changes, and null when the buffer is not PCM WAV. */
export function normalizeLineWav(bytes: Uint8Array): NormalizedLineWav | null {
  const parsed = parseWav(bytes);
  if (!parsed) return null;
  const { format } = parsed;
  const maxBytes = pcmBytesFor(LINE_WAV_MAX_SECONDS, format);
  const whole = bytes.subarray(format.dataOffset, format.dataOffset + format.dataSize);
  // Cap first: a click in audio that is thrown away must not set the gain, or the speech end, of what is kept.
  const trimmed = whole.length > maxBytes;
  const capped = trimmed ? whole.subarray(0, maxBytes) : whole;
  const spoken = trimTrailingSilencePcm(capped, format);
  const tail_trimmed_s = (capped.length - spoken.length) / format.byteRate;
  const { pcm, gain_db } = levelPcm(spoken, format);
  if (!trimmed && tail_trimmed_s === 0 && gain_db === 0) {
    return { bytes, seconds: parsed.seconds, trimmed: false, tail_trimmed_s: 0, gain_db: 0 };
  }
  const out = writeWav(format, pcm);
  return { bytes: out, seconds: pcm.length / format.byteRate, trimmed, tail_trimmed_s, gain_db };
}

/** `seconds` of linear16 silence. Same encoding Aura writes. */
export function mintSilenceWav(seconds: number): Uint8Array {
  const sampleRate = SILENCE_WAV_SAMPLE_RATE;
  const channels = SILENCE_WAV_CHANNELS;
  const bits = SILENCE_WAV_BITS;
  const blockAlign = channels * (bits / 8);
  const byteRate = sampleRate * blockAlign;
  const pcm = new Uint8Array(pcmBytesFor(seconds, { byteRate, blockAlign }));
  return writeWav({ channels, sampleRate, byteRate, blockAlign, bitsPerSample: bits }, pcm);
}
