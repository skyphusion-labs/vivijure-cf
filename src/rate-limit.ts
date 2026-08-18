// Rate limiting for the GPU/spend endpoints (security finding F3): denial-of-wallet protection.
//
// The studio's render/train/generate routes each submit a RunPod GPU job or paid AI work. With no
// limit, a compromised or abused session can hammer them and burn the operator's balance (Conrad
// self-funds). This caps the submission rate, and (S4) optionally the per-day submission total.
//
// Posture: FAIL CLOSED by default (S9 F7). A HEALTHY limiter allows within-limit requests and 429s
// over-limit ones -- ordinary rate limiting. But when the limiter itself is BROKEN (binding unbound
// or `.limit()` throws), the request is DENIED 503, not allowed: the money path fails closed like the
// F2 auth backstop, because a novice self-funds the GPU and must never silently run unmetered on a
// misconfigured limiter. A healthy default deploy (wrangler.toml.example binds SPEND_RATE_LIMITER) is
// unaffected -- fail-closed bites only a broken limiter, never a working one.
//
// Operator knobs:
//   SPEND_LIMIT_FAIL_CLOSED="false" -- opt OUT to the old fail-open posture: a broken/unbound limiter
//     (or a failing daily-ceiling check) ALLOWS + warns instead of denying, so a limiter blip never
//     blocks a render (at the cost of a bounded unmetered window). Any other value, incl. unset,
//     keeps the fail-closed default.
//   SPEND_DAILY_CEILING="<n>" -- at most n spend-route submissions per UTC day, counted atomically
//     in D1 (spend_counter, migration 0008). Submissions, not dollars: every spend route is one
//     bounded GPU/paid-AI job, so a per-day cap is an honest ceiling the operator can size. Over
//     the ceiling denies 429 with Retry-After = seconds to UTC midnight.
//
// Backend: the Cloudflare native Rate Limiting binding (`env.SPEND_RATE_LIMITER.limit({ key })`),
// zero-storage and per-colo. The binding is added to wrangler.toml by infra (Strummer); this module
// authors the Worker-side logic + the `Env` shape. The backend is swappable for a Durable Object
// token bucket later if cross-colo (global) accuracy is ever required.

// The native Rate Limiting binding's shape (a single fixed {limit, period} policy per binding).
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

// Structural D1 slice the daily ceiling needs (keeps this module testable with a fake).
export interface SpendCounterDb {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T = unknown>(): Promise<T | null> };
  };
}

export interface SpendLimitEnv {
  SPEND_RATE_LIMITER?: RateLimitBinding;
  // Fail-CLOSED by default for BOTH checks (broken limiter / broken ceiling check => deny 503). Set
  // to the literal "false" to opt back to fail-open (allow + warn on a broken check). See failClosed.
  SPEND_LIMIT_FAIL_CLOSED?: string;
  // Positive integer as a string; unset/0/garbage = ceiling off, EXCEPT AUTH_MODE=token
  // (hosted) defaults to 25 so a stolen studio token is not an open GPU tap.
  SPEND_DAILY_CEILING?: string;
  AUTH_MODE?: string;
  DB?: SpendCounterDb;
}

// Retry-After (seconds) advertised on a 429. Matches the binding's configured period (Strummer sets
// the real period on the binding; this is the client hint).
export const SPEND_RETRY_AFTER_SECONDS = 60;

// The POST routes that submit GPU jobs or paid AI work. Kept as explicit regexes (not a dependency on
// the router) so the spend surface is auditable in one place; :id / child segments are wildcarded.
//
// cf#256: the PLANNER entry points are spend routes in exactly the sense this list means, and were
// missing. Every route below that dispatches the plan.enhance hook runs an operator-billed frontier
// model (the module model enum defaults to Opus, 4096 max_tokens per call, keyless on Unified
// Billing) with a caller-supplied system_message + message. Unmetered, that is a general-purpose AI
// proxy for anyone holding a studio token. The file claimed this surface was auditable in one
// place; until now that claim was false.
const SPEND_PATTERNS: RegExp[] = [
  // GPU submits: render / animate / train / audio generation.
  /^\/api\/storyboard\/render$/,
  /^\/api\/render\/clips$/,
  /^\/api\/render\/film$/,

  /^\/api\/storyboard\/render-from-keyframes$/,
  /^\/api\/storyboard\/renders\/[^/]+\/animate-cloud$/,
  /^\/api\/storyboard\/renders\/[^/]+\/animate-hybrid$/,
  // Found while auditing this list for cf#256, same defect class, fixed in the same pass: three
  // more GPU/paid submits were escaping the meter. regen-shot calls startFilmJob (a keyframe GPU
  // submit); finalize goes through animateFromPreview, the SAME submit path as animate-cloud and
  // animate-hybrid two lines up; add-narration calls startScoreBedGenerate, the SAME path as
  // score-bed and music-generate below. add-audio is deliberately NOT here: it only muxes an
  // existing artifact and dispatches nothing.
  /^\/api\/storyboard\/renders\/[^/]+\/regen-shot$/,
  /^\/api\/storyboard\/renders\/[^/]+\/finalize$/,
  /^\/api\/storyboard\/renders\/[^/]+\/add-narration$/,
  // cf#423: /retry is the FOURTH render-child GPU submit to reach this list late, and the second
  // time this same family has drifted. retryFailedRender (src/render-retry.ts) calls startFilmJob
  // for full / keyframes-only rows and animateFromPreview for finalize rows -- the identical submit
  // paths as regen-shot and finalize above, re-dispatched from a stored row. The panel disables its
  // button, but the MCP studio_request hatch reaches this route directly and never touches the DOM,
  // so the button is not a bound. Asserted against the ROUTER, not against a transcribed list, in
  // tests/spend-surface-render-children.test.ts: a render-child POST route added later fails there
  // until it is classified, which is the check this list has twice lacked.
  /^\/api\/storyboard\/renders\/[^/]+\/retry$/,
  /^\/api\/cast\/[^/]+\/train-lora$/,
  /^\/api\/cast\/[^/]+\/train-wan-lora$/,
  /^\/api\/cast\/[^/]+\/generate-refs$/,
  /^\/api\/storyboard\/score-bed$/,
  /^\/api\/storyboard\/music-generate$/,
  // Paid-AI submits (cf#256): the four POST routes that dispatch the plan.enhance hook. /api/chat
  // covers BOTH of its branches -- the text planner (chatComplete) and the image branch
  // (chatImageViaModule), which is paid image generation and belongs here just as much.
  /^\/api\/storyboard\/plan$/,
  /^\/api\/storyboard\/refine$/,
  /^\/api\/storyboard\/enhance$/,
  /^\/api\/chat$/,
];

// True for a request that triggers GPU/paid spend and so must pass the limiter.
export function isSpendRoute(method: string, pathname: string): boolean {
  if (method !== "POST") return false;
  return SPEND_PATTERNS.some((re) => re.test(pathname));
}

export type SpendLimitResult =
  | { ok: true }
  // status 429 = an explicit over-limit / over-ceiling verdict (Retry-After set);
  // status 503 = fail-closed posture denying because a check itself is broken.
  | { ok: false; status: 429 | 503; retryAfter?: number; message: string };

let warnedUnbound = false;

/** Pure: the daily ceiling from env, or null when the knob is off (unset / 0 / garbage).
 *  Hosted token mode defaults to 25 when the var is unset. Set 0 to disable. */
export function dailyCeiling(env: SpendLimitEnv): number | null {
  const raw = env.SPEND_DAILY_CEILING;
  if (typeof raw === "string" && raw.trim() === "0") return null;
  if (typeof raw !== "string" || raw.trim() === "") {
    return env.AUTH_MODE === "token" ? 25 : null;
  }
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Fail CLOSED by DEFAULT (S9 F7): a broken/unbound limiter (or a failing ceiling check) DENIES the
// spend routes. The money path fails closed like the auth gate -- a novice self-funds the GPU and
// must not silently run unmetered when the limiter is misconfigured. Only the literal "false" opts
// back to fail-open. NOTE: this governs BROKEN-check handling only; a HEALTHY limiter allows
// within-limit requests either way (fail-closed never denies a working default deploy).
export function failClosed(env: SpendLimitEnv): boolean {
  return env.SPEND_LIMIT_FAIL_CLOSED !== "false";
}

/** Pure: UTC day key + seconds until the counter resets (UTC midnight), for Retry-After. */
export function utcDay(nowMs: number): { day: string; secondsToReset: number } {
  const d = new Date(nowMs);
  const day = d.toISOString().slice(0, 10);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return { day, secondsToReset: Math.max(1, Math.ceil((midnight - nowMs) / 1000)) };
}

// Atomically count this submission against the UTC-day row and return the post-increment total.
// Denied requests also increment -- that only makes the ceiling stricter, and a denial spends
// nothing. Throws on a D1 error; the caller maps that through the fail posture.
async function bumpDailyCount(db: SpendCounterDb, day: string): Promise<number> {
  const row = await db
    .prepare(
      "INSERT INTO spend_counter (day, count) VALUES (?, 1) " +
        "ON CONFLICT(day) DO UPDATE SET count = count + 1 RETURNING count",
    )
    .bind(day)
    .first<{ count: number }>();
  if (!row || typeof row.count !== "number") throw new Error("spend_counter increment returned no row");
  return row.count;
}

// Enforce the spend limit for a request already known to be a spend route: the per-IP rate limiter
// first, then the optional daily ceiling. Default posture fails OPEN on a broken check (warns);
// SPEND_LIMIT_FAIL_CLOSED="true" denies 503 instead. An explicit over-limit / over-ceiling verdict
// is always a 429.
export async function enforceSpendLimit(
  request: Request,
  env: SpendLimitEnv,
  nowMs: number = Date.now(),
): Promise<SpendLimitResult> {
  const closed = failClosed(env);

  const limiter = env.SPEND_RATE_LIMITER;
  if (!limiter) {
    if (!warnedUnbound) {
      warnedUnbound = true;
      console.warn(
        `rate-limit: SPEND_RATE_LIMITER unbound -> ${closed ? "DENYING spend endpoints (fail closed)" : "spend endpoints are NOT rate-limited (fail open)"}. Bind it in wrangler.toml.`,
      );
    }
    if (closed) return { ok: false, status: 503, message: "spend limiter unavailable (fail-closed posture); renders are blocked until the limiter binding is fixed" };
  } else {
    // Key by client IP so one abusive source is throttled without starving others. (Single-operator
    // today; IP keying is the right primitive if this is ever fronted for multiple users.)
    const key = request.headers.get("cf-connecting-ip") || "global";
    try {
      const { success } = await limiter.limit({ key });
      if (!success) {
        return { ok: false, status: 429, retryAfter: SPEND_RETRY_AFTER_SECONDS, message: "rate limited: too many render/spend requests; slow down" };
      }
    } catch (e) {
      console.warn(`rate-limit: limiter errored (${(e as Error).message}) -> ${closed ? "denying (fail closed)" : "allowing (fail open)"}`);
      if (closed) return { ok: false, status: 503, message: "spend limiter unavailable (fail-closed posture); renders are blocked until the limiter recovers" };
    }
  }

  const ceiling = dailyCeiling(env);
  if (ceiling !== null) {
    const { day, secondsToReset } = utcDay(nowMs);
    if (!env.DB) {
      console.warn(`rate-limit: SPEND_DAILY_CEILING set but DB unbound -> ${closed ? "denying (fail closed)" : "ceiling NOT enforced (fail open)"}`);
      if (closed) return { ok: false, status: 503, message: "daily spend ceiling cannot be checked (no database); renders are blocked (fail-closed posture)" };
    } else {
      try {
        const count = await bumpDailyCount(env.DB, day);
        if (count > ceiling) {
          return { ok: false, status: 429, retryAfter: secondsToReset, message: `daily spend ceiling reached (${ceiling} submissions today); resets at UTC midnight` };
        }
      } catch (e) {
        console.warn(`rate-limit: daily ceiling check errored (${(e as Error).message}) -> ${closed ? "denying (fail closed)" : "allowing (fail open)"}`);
        if (closed) return { ok: false, status: 503, message: "daily spend ceiling check failed (fail-closed posture); renders are blocked until the database recovers" };
      }
    }
  }

  return { ok: true };
}

// Test-only: reset the one-time unbound warning latch.
export function __resetRateLimitWarnForTest(): void {
  warnedUnbound = false;
}
