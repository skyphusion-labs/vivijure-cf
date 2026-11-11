// The header that keeps one film's card jobs on one video-finish instance. The door routes on it, so
// the submit and every status read of a job must send the same value, which is why it rides in the
// poll token. A token with no value sends no header, and the door then uses its fixed instance, which
// is where any job submitted before this shipped is running.
export const FINISH_AFFINITY_HEADER = "x-vivijure-finish-affinity";

/** The film id when the core sent one, since it is the same for every step of a film. The film key
 *  changes per step (film.mp4, then film-ff0.mp4), so it would give each step its own instance. */
export function finishAffinity(corr: { contextJobId?: string; filmKey?: string }): string | undefined {
  return corr.contextJobId || corr.filmKey || undefined;
}

export function withAffinity<T extends Record<string, string>>(headers: T, affinity: string | undefined): T & Record<string, string> {
  return affinity ? { ...headers, [FINISH_AFFINITY_HEADER]: affinity } : headers;
}
