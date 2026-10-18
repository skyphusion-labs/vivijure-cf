// A film with a song is not done until the song has been read and the picture has been joined.
// The published core package still marks a missed join as phase "done". The studio poll reports
// that job as failed. The beat read is an R2 marker written when /api/audio/analyze succeeds,
// because the published job document has no beats_read field.

import type { FilmJob } from "@skyphusion-labs/vivijure-core/film-orchestrator";
import type { DialogueLine } from "@skyphusion-labs/vivijure-core/modules/types";

/** 150 words per minute. Used when the line's WAV does not exist yet. */
export const LINE_WORDS_PER_SECOND = 2.5;

/** Beat-sync max_scene_s. A longer estimate cannot sit in one window. */
export const LINE_WINDOW_MAX_SECONDS = 12;

export function beatsMarkerKey(audioKey: string): string {
  return audioKey.trim() + ".beats.json";
}

export function lineWordCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

/** Seconds implied by the word count. This is an estimate, not a measured WAV. */
export function lineSecondsEstimate(text: string): number {
  const words = lineWordCount(text);
  if (words === 0) return 0;
  return words / LINE_WORDS_PER_SECOND;
}

/**
 * Refusal when a staged song has not been read, or a spoken line cannot sit in one window.
 * Null when there is no song, or the marker exists and every line fits.
 * The line message says the number is an estimate from the word count.
 */
export async function songStartRefusal(
  head: (key: string) => Promise<unknown>,
  audioKey: string | undefined,
  lines: DialogueLine[] | undefined,
): Promise<string | null> {
  const key = audioKey?.trim();
  if (!key) return null;
  const marker = await head(beatsMarkerKey(key));
  if (!marker) {
    return "beats were not read for this song. Analyze the track before starting the film.";
  }
  return lineWindowRefusal(lines);
}

/**
 * Refusal for a spoken line that cannot sit in one window, or null when every line fits.
 * The message says the number is an estimate from the word count.
 */
export function lineWindowRefusal(
  lines: DialogueLine[] | undefined,
  windowSeconds = LINE_WINDOW_MAX_SECONDS,
): string | null {
  if (!lines) return null;
  for (const line of lines) {
    const text = typeof line.text === "string" ? line.text : "";
    const words = lineWordCount(text);
    const seconds = words === 0 ? 0 : words / LINE_WORDS_PER_SECOND;
    if (seconds > windowSeconds) {
      const shot = line.shot_id?.trim() || "a shot";
      return (
        `${shot} line is about ${seconds.toFixed(1)}s (${words} words at ${LINE_WORDS_PER_SECOND} words/second). ` +
        `That estimate does not fit one ${windowSeconds}s window.`
      );
    }
  }
  return null;
}

/** Published core can still say phase done after a join that did not run. Report that film as failed. */
export function jobAfterSkippedJoin(job: FilmJob): FilmJob {
  const missed = job.finish_unavailable;
  if (job.phase === "done" && missed?.at === "assemble") {
    return { ...job, phase: "failed", error: missed.reason || "the join did not run" };
  }
  return job;
}
