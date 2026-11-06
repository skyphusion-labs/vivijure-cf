// RIFF/WAVE PCM helpers shared by the dialogue modules (dialogue-gen, chatterbox). Modules do not import
// core; they share this file instead. No I/O.
//
// cf#957: a line WAV ends a short tail after the last speech. Every Cast line used to run to 3.000s
// because of a fixed pad, so audio-driven doors billed and animated about 1.66s of silence per shot. The
// producer now cuts trailing silence. A door that needs a longer file declares its own floor.

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

/** Parse a linear PCM WAVE. Returns null when the buffer is not a usable RIFF PCM file.
 *  A streamed WAV (Aura writes data size 0x7FFF0000) is read to the bytes actually present. */
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

export function pcmBytesFor(seconds: number, format: { byteRate: number; blockAlign: number }): number {
  const raw = Math.round(seconds * format.byteRate);
  const aligned = raw - (raw % format.blockAlign);
  return Math.max(0, aligned);
}

export function writeWav(
  format: { channels: number; sampleRate: number; byteRate: number; blockAlign: number; bitsPerSample: number },
  pcm: Uint8Array,
): Uint8Array {
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

// --- trailing silence (cf#957) ---
//
// Speech ends at the last 10 ms block whose peak reaches SPEECH_FLOOR_DBFS. Measured on real Aura-1 lines
// (2026-11-06): the last word falls from about -20 to -50 dBFS in about 60 ms, and reaches -60 within 20 ms
// more. -60 sits under that decay, so a soft final consonant counts as speech. A noise floor above -60
// only means nothing is cut, which is the safe direction.
//
// TAIL_SECONDS of the silence is kept after speech ends. 200 ms covers the decay under the floor and
// the breath after the word, and gives a lip-sync door five frames at 25 fps to close the mouth. It is
// twice the 100 ms window silencedetect uses at d=0.1, so a trimmed line still reads as ending in silence.
export const SPEECH_FLOOR_DBFS = -60;
export const TAIL_SECONDS = 0.2;
const BLOCK_SECONDS = 0.01;

/** Byte length of the PCM up to the end of the last block that holds speech. 0 when no block does.
 *  null for a depth this helper does not read (only 16-bit PCM). */
export function speechEndBytes(pcm: Uint8Array, format: WavFormat): number | null {
  if (format.bitsPerSample !== 16) return null;
  const floor = 10 ** (SPEECH_FLOOR_DBFS / 20) * 32768;
  const frames = Math.floor(pcm.length / format.blockAlign);
  const blockFrames = Math.max(1, Math.round(format.sampleRate * BLOCK_SECONDS));
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.length);
  for (let start = Math.floor((frames - 1) / blockFrames) * blockFrames; start >= 0; start -= blockFrames) {
    const end = Math.min(start + blockFrames, frames);
    for (let f = start; f < end; f++) {
      for (let c = 0; c < format.channels; c++) {
        const s = view.getInt16(f * format.blockAlign + c * 2, true);
        if (Math.abs(s) >= floor) return end * format.blockAlign;
      }
    }
  }
  return 0;
}

/** The PCM cut to TAIL_SECONDS after the last speech. Unchanged when there is no speech to measure
 *  against (an all-silent line), when the depth is not 16-bit, or when the tail is already short. */
export function trimTrailingSilencePcm(pcm: Uint8Array, format: WavFormat): Uint8Array {
  const speechEnd = speechEndBytes(pcm, format);
  if (!speechEnd) return pcm;
  const keep = Math.min(pcm.length, speechEnd + pcmBytesFor(TAIL_SECONDS, format));
  return keep < pcm.length ? pcm.subarray(0, keep) : pcm;
}

export interface TrimmedWav {
  bytes: Uint8Array;
  seconds: number;
  /** Seconds of trailing silence removed. 0 when nothing was cut. */
  tail_trimmed_s: number;
}

/** A whole WAV with its trailing silence cut. Returns the original bytes when nothing is cut, and null
 *  when the buffer is not PCM WAV. */
export function trimTrailingSilence(bytes: Uint8Array): TrimmedWav | null {
  const parsed = parseWav(bytes);
  if (!parsed) return null;
  const { format } = parsed;
  const pcm = bytes.subarray(format.dataOffset, format.dataOffset + format.dataSize);
  const kept = trimTrailingSilencePcm(pcm, format);
  if (kept.length === pcm.length) return { bytes, seconds: parsed.seconds, tail_trimmed_s: 0 };
  return {
    bytes: writeWav(format, kept),
    seconds: kept.length / format.byteRate,
    tail_trimmed_s: (pcm.length - kept.length) / format.byteRate,
  };
}
