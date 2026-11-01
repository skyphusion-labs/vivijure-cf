// Vendored RIFF/WAVE helpers (Aura writes linear16 PCM). Modules do not import core.
// Pad short lines to Wan's 3s floor; cap at 15s (both driving-audio doors).
export const LINE_WAV_MIN_SECONDS = 3;
export const LINE_WAV_MAX_SECONDS = 15;
export const SILENCE_WAV_SAMPLE_RATE = 24_000;
export const SILENCE_WAV_CHANNELS = 1;
export const SILENCE_WAV_BITS = 16;

const encoder = new TextEncoder();

export interface WavFormat {
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
}

export interface WavDuration {
  seconds: number;
  format: WavFormat;
}

function u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}
function u16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value & 0xffff, true);
}
function readFourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/** Parse a linear16 (PCM) WAVE. Returns null when the buffer is not a usable RIFF PCM file. */
export function parseWav(bytes: Uint8Array): WavDuration | null {
  if (bytes.length < 12) return null;
  if (readFourCC(bytes, 0) !== "RIFF" || readFourCC(bytes, 8) !== "WAVE") return null;
  let offset = 12;
  let format: Omit<WavFormat, "dataOffset" | "dataSize"> | null = null;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const id = readFourCC(bytes, offset);
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
    const body = offset + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= bytes.length) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + body, size);
      const audioFormat = view.getUint16(0, true);
      if (audioFormat !== 1) return null;
      const channels = view.getUint16(2, true);
      const sampleRate = view.getUint32(4, true);
      const byteRate = view.getUint32(8, true);
      const blockAlign = view.getUint16(12, true);
      const bitsPerSample = view.getUint16(14, true);
      if (!channels || !sampleRate || !byteRate || !blockAlign || !bitsPerSample) return null;
      format = { channels, sampleRate, byteRate, blockAlign, bitsPerSample };
    } else if (id === "data") {
      dataOffset = body;
      dataSize = size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!format || dataOffset < 0) return null;
  const available = Math.max(0, bytes.length - dataOffset);
  const usable = Math.min(dataSize, available);
  const aligned = usable - (usable % format.blockAlign);
  if (aligned < 0 || format.byteRate <= 0) return null;
  return {
    seconds: aligned / format.byteRate,
    format: { ...format, dataOffset, dataSize: aligned },
  };
}

export function parseWavDurationSeconds(bytes: Uint8Array): number | null {
  const parsed = parseWav(bytes);
  return parsed ? parsed.seconds : null;
}

function pcmBytesFor(seconds: number, format: { byteRate: number; blockAlign: number }): number {
  const raw = Math.round(seconds * format.byteRate);
  const aligned = raw - (raw % format.blockAlign);
  return Math.max(0, aligned);
}

function writeWav(format: { channels: number; sampleRate: number; byteRate: number; blockAlign: number; bitsPerSample: number }, pcm: Uint8Array): Uint8Array {
  const header = 44;
  const out = new Uint8Array(header + pcm.length);
  const view = new DataView(out.buffer);
  out.set(encoder.encode("RIFF"), 0);
  u32(view, 4, 36 + pcm.length);
  out.set(encoder.encode("WAVE"), 8);
  out.set(encoder.encode("fmt "), 12);
  u32(view, 16, 16);
  u16(view, 20, 1);
  u16(view, 22, format.channels);
  u32(view, 24, format.sampleRate);
  u32(view, 28, format.byteRate);
  u16(view, 32, format.blockAlign);
  u16(view, 34, format.bitsPerSample);
  out.set(encoder.encode("data"), 36);
  u32(view, 40, pcm.length);
  out.set(pcm, header);
  return out;
}

export interface NormalizedLineWav {
  bytes: Uint8Array;
  seconds: number;
  padded: boolean;
  trimmed: boolean;
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

/** Level the line, pad PCM under 3.0s with silence, trim above 15.0s. Returns null when the buffer is not PCM WAV. */
export function normalizeLineWav(bytes: Uint8Array): NormalizedLineWav | null {
  const parsed = parseWav(bytes);
  if (!parsed) return null;
  const { format } = parsed;
  const minBytes = pcmBytesFor(LINE_WAV_MIN_SECONDS, format);
  const maxBytes = pcmBytesFor(LINE_WAV_MAX_SECONDS, format);
  const whole = bytes.subarray(format.dataOffset, format.dataOffset + format.dataSize);
  // Trim first: a click in audio that is thrown away must not set the gain of what is kept.
  const trimmed = whole.length > maxBytes;
  const { pcm, gain_db } = levelPcm(trimmed ? whole.subarray(0, maxBytes) : whole, format);
  let next = pcm;
  let padded = false;
  if (pcm.length < minBytes) {
    const grown = new Uint8Array(minBytes);
    grown.set(pcm);
    next = grown;
    padded = true;
  }
  if (!padded && !trimmed && gain_db === 0) {
    return { bytes, seconds: parsed.seconds, padded: false, trimmed: false, gain_db: 0 };
  }
  const out = writeWav(format, next);
  return { bytes: out, seconds: next.length / format.byteRate, padded, trimmed, gain_db };
}

/** 3s (or `seconds`) of linear16 silence. Same encoding Aura writes. */
export function mintSilenceWav(seconds: number = LINE_WAV_MIN_SECONDS): Uint8Array {
  const sampleRate = SILENCE_WAV_SAMPLE_RATE;
  const channels = SILENCE_WAV_CHANNELS;
  const bits = SILENCE_WAV_BITS;
  const blockAlign = channels * (bits / 8);
  const byteRate = sampleRate * blockAlign;
  const pcm = new Uint8Array(pcmBytesFor(seconds, { byteRate, blockAlign }));
  return writeWav({ channels, sampleRate, byteRate, blockAlign, bitsPerSample: bits }, pcm);
}
