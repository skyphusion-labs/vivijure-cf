// cf#923: measure a delivered clip's frame rate and frame count from the artifact.
//
// THE RULE THIS EXISTS TO ENFORCE: a value computed from the request is not a measurement, no matter
// what the field is named. Both talking doors reported `fps` as a hardcoded 24 and `frames` as either
// duration x 24 or requested_seconds x 24. Neither number had ever been compared to a real file.
// Measured: infinitetalk delivers 25fps, alibaba-wan delivers 30fps. The constant was wrong on both,
// in different directions.
//
// WHY SHARED AND NOT VENDORED. The doors vendor their RunPod helpers per-module on purpose, so each
// stays independent. This one is deliberately NOT vendored, because the defect it fixes WAS a vendored
// copy: one `OUT_FPS = 24` pasted into two modules where nobody re-checked it against a file. A copied
// helper forks at copy time and the copy inherits the assumption without inheriting the check. One
// parser, one place to be wrong, one place to fix.
//
// UNMEASURED IS A RESULT. Every function here returns null rather than a fallback when the container
// cannot be parsed. A caller must then report the field as unmeasured; substituting a constant is what
// produced cf#923 in the first place, and a constant that looks measured is worse than a gap.

function u32be(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function fourcc(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

interface Box { type: string; start: number; end: number; header: number }

/** Iterate the boxes directly inside [start,end). Tolerates truncation by stopping, never throwing. */
function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  let o = start;
  while (o + 8 <= end) {
    let size = u32be(b, o);
    const type = fourcc(b, o + 4);
    let header = 8;
    if (size === 1) {
      // 64-bit largesize. We read the low 32 bits: a >4GiB clip is not a case this pipeline produces,
      // and reading the low word of a genuinely huge box yields a short size that stops the walk
      // rather than running off the end.
      if (o + 16 > end) break;
      size = u32be(b, o + 12);
      header = 16;
    }
    if (size === 0) size = end - o;
    if (size < header) break;
    out.push({ type, start: o, end: Math.min(o + size, end), header });
    o = Math.min(o + size, end);
  }
  return out;
}

function findBox(b: Uint8Array, start: number, end: number, type: string): Box | null {
  for (const box of boxes(b, start, end)) if (box.type === type) return box;
  return null;
}

/** Is this `trak` a video track? Reads mdia/hdlr handler_type, which is the only reliable marker. */
function isVideoTrak(b: Uint8Array, trak: Box): boolean {
  const mdia = findBox(b, trak.start + trak.header, trak.end, "mdia");
  if (!mdia) return false;
  const hdlr = findBox(b, mdia.start + mdia.header, mdia.end, "hdlr");
  if (!hdlr) return false;
  // hdlr: version+flags (4), pre_defined (4), handler_type (4)
  const p = hdlr.start + hdlr.header + 8;
  if (p + 4 > hdlr.end) return false;
  return fourcc(b, p) === "vide";
}

export interface VideoTiming {
  /** Frames counted from the sample table, never derived from a duration. */
  frames: number;
  /** Frames divided by the track's own duration. Null when the duration is unusable. */
  fps: number | null;
}

/**
 * Measure the video track's frame count and rate from the MP4 sample tables.
 *
 * `frames` is the sum of `stts` sample counts, which IS the frame count, not an estimate.
 * `fps` is that count over the track duration taken from `stts` deltas in the media timescale
 * (`mdhd`), which is exact for constant-rate video and honest for variable-rate.
 *
 * Returns null when there is no parseable video track. Callers must surface that as unmeasured.
 */
export function mp4VideoTiming(bytes: Uint8Array): VideoTiming | null {
  const moov = findBox(bytes, 0, bytes.length, "moov");
  if (!moov) return null;

  for (const trak of boxes(bytes, moov.start + moov.header, moov.end)) {
    if (trak.type !== "trak" || !isVideoTrak(bytes, trak)) continue;

    const mdia = findBox(bytes, trak.start + trak.header, trak.end, "mdia");
    if (!mdia) continue;
    const mdhd = findBox(bytes, mdia.start + mdia.header, mdia.end, "mdhd");
    const minf = findBox(bytes, mdia.start + mdia.header, mdia.end, "minf");
    if (!minf) continue;
    const stbl = findBox(bytes, minf.start + minf.header, minf.end, "stbl");
    if (!stbl) continue;
    const stts = findBox(bytes, stbl.start + stbl.header, stbl.end, "stts");
    if (!stts) continue;

    // mdhd: version/flags(4), then v0 [creation(4) modification(4) timescale(4) duration(4)]
    //                          or v1 [creation(8) modification(8) timescale(4) duration(8)]
    let timescale = 0;
    if (mdhd) {
      const p = mdhd.start + mdhd.header;
      if (p + 4 <= mdhd.end) {
        const version = bytes[p];
        if (version === 1) {
          if (p + 24 <= mdhd.end) timescale = u32be(bytes, p + 20);
        } else if (p + 16 <= mdhd.end) {
          timescale = u32be(bytes, p + 12);
        }
      }
    }

    // stts: version/flags(4), entry_count(4), then entry_count x [sample_count(4), sample_delta(4)]
    const sp = stts.start + stts.header;
    if (sp + 8 > stts.end) continue;
    const entries = u32be(bytes, sp + 4);
    let frames = 0;
    let ticks = 0;
    for (let i = 0; i < entries; i++) {
      const e = sp + 8 + i * 8;
      if (e + 8 > stts.end) break; // truncated table: stop, do not invent the rest
      const count = u32be(bytes, e);
      const delta = u32be(bytes, e + 4);
      frames += count;
      ticks += count * delta;
    }
    if (frames <= 0) continue;

    const seconds = timescale > 0 && ticks > 0 ? ticks / timescale : 0;
    return { frames, fps: seconds > 0 ? frames / seconds : null };
  }

  return null;
}
