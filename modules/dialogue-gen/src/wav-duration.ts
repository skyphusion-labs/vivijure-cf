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
}

/** Pad PCM under 3.0s with silence; trim above 15.0s. Returns null when the buffer is not PCM WAV. */
export function normalizeLineWav(bytes: Uint8Array): NormalizedLineWav | null {
  const parsed = parseWav(bytes);
  if (!parsed) return null;
  const { format } = parsed;
  const minBytes = pcmBytesFor(LINE_WAV_MIN_SECONDS, format);
  const maxBytes = pcmBytesFor(LINE_WAV_MAX_SECONDS, format);
  const pcm = bytes.subarray(format.dataOffset, format.dataOffset + format.dataSize);
  let next = pcm;
  let padded = false;
  let trimmed = false;
  if (pcm.length < minBytes) {
    const grown = new Uint8Array(minBytes);
    grown.set(pcm);
    next = grown;
    padded = true;
  } else if (pcm.length > maxBytes) {
    next = pcm.subarray(0, maxBytes);
    trimmed = true;
  }
  if (!padded && !trimmed) {
    return { bytes, seconds: parsed.seconds, padded: false, trimmed: false };
  }
  const out = writeWav(format, next);
  return { bytes: out, seconds: next.length / format.byteRate, padded, trimmed };
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
