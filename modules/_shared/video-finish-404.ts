// video-finish 404 policy (fleet-chezmoi#1662).
//
// WHY THIS FILE EXISTS. subtitle and film-titles poll GET /async/status/:id on the
// video-finish VIP. The job registry is in-process. The service is 3 replicas, VIP
// 10.0.1.90, hostname video-finish:8000, no host port (#1874: keep that address; do
// not copy blender's host.ipv4 pin). A replica that does not hold the job answers
// 404, correctly, forever.
//
// MEASURED 2026-08-14 (new TCP to the VIP, from each cloudflared connector):
// found=4 / 404=8. That is 1/3, the replica that holds the job. P(peer 404 | job
// alive) = 2/3. Keepalive pins one connector to one replica; the three connectors
// do not share that pin. Submit and poll are different studio invocations, so they
// can land on different connectors. A lone 404 cannot distinguish "lost" from
// "not mine".
//
// THE PREVIOUS RULE. One 404 past CONTAINER_NOTFOUND_GRACE_MS (30s) was terminal
// ("container restarted; resubmit"). That is the defect. A 5xx was already
// retried. The 30s window is also where a short test encode stops, so the suite
// could not see this.
//
// THE NEW RULE. 404 stays pending. Terminal only after CONTAINER_NOTFOUND_STREAK
// consecutive 404s (count lives on the poll token), or after the existing core
// 90-min phase deadline (PHASE_HARD_DEADLINE_SECONDS) measured from submittedAt.
//
// ARITHMETIC. Independent new-TCP scatter, P(miss) = 2/3:
//   N=3  -> (2/3)^3  = 8/27        ≈ 29.6%   same defect, longer fuse. Do not use.
//   N=12 -> (2/3)^12 = 4096/531441 ≈ 0.771%
// N=12 is the named streak. A caller that cannot persist the count (today's core
// PollResponse pending shape has no `poll` field, so it will not increment) still
// has the 90-min submittedAt backstop: assemble/mux is not in POLLABLE_PHASES, so
// without it a genuine all-replica 404 would hang. Longest film.finish encode is
// documented below FILM_FINISH_INFLIGHT_WINDOW (20 min), so a 404 at 90 min is
// not a long-encode peer miss. At 1 poll/min, P(90 misses) = (2/3)^90 ≈ 1.35e-16.
//
// This is a poll-policy change in vivijure-cf. It is not a shared registry, not a
// container change, and not a tunnel retarget.

/** Previous terminal window. One 404 past this was fail. Kept so the suite can pin the defect. */
export const CONTAINER_NOTFOUND_GRACE_MS = 30_000;

/**
 * Consecutive 404s that mean "no replica holds this id", not "not mine".
 * (2/3)^12 = 4096/531441 ≈ 0.771% false-fatal under independent 2/3 scatter.
 * N=3 is (2/3)^3 = 8/27 ≈ 29.6% and is the same defect.
 */
export const CONTAINER_NOTFOUND_STREAK = 12;

/**
 * Existing vivijure-core PHASE_HARD_DEADLINE_SECONDS (90 min), in ms. Production
 * backstop when the poll token cannot carry an incrementing streak.
 */
export const CONTAINER_NOTFOUND_DEADLINE_MS = 90 * 60 * 1000;

export type VideoFinish404Verdict = "pending" | "fail";

export interface VideoFinish404Input {
  /** 404s in a row, INCLUDING this one. 1 = the first 404. */
  consecutiveNotFound: number;
  /** Epoch ms from the poll token. null = the token carried none. */
  submittedAt: number | null;
  now: number;
}

/** The rule that shipped the defect: one 404 past 30s -> fail. Test-only pin. */
export function legacyClassifyVideoFinish404(
  submittedAt: number | null,
  now: number,
): VideoFinish404Verdict {
  if (submittedAt !== null && now - submittedAt < CONTAINER_NOTFOUND_GRACE_MS) return "pending";
  return "fail";
}

export function classifyVideoFinish404(input: VideoFinish404Input): VideoFinish404Verdict {
  const n = Number.isFinite(input.consecutiveNotFound)
    ? Math.max(0, Math.floor(input.consecutiveNotFound))
    : 0;
  if (n >= CONTAINER_NOTFOUND_STREAK) return "fail";
  if (
    input.submittedAt !== null &&
    Number.isFinite(input.submittedAt) &&
    input.now - input.submittedAt >= CONTAINER_NOTFOUND_DEADLINE_MS
  ) {
    return "fail";
  }
  return "pending";
}

/** Next streak after this 404. Absent / non-finite / negative token field starts at 0. */
export function nextNotFoundStreak(current: number | null | undefined): number {
  const n = typeof current === "number" && Number.isFinite(current) ? Math.floor(current) : 0;
  return Math.max(0, n) + 1;
}

export function parseNotFoundStreak(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}
