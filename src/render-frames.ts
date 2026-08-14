// cf#322: make a rendered clip VISIBLE, by turning it into an artifact the transport can carry.
//
// WHY THIS EXISTS. Our MCP tool-result content union is exactly two variants, text and image
// (vivijure-mcp/src/mcp-tools.ts). There is no video variant, so a finished film can only ever be
// handed over as a LINK, and an agent asked to judge render quality has nothing to look at. Meanwhile
// 128 of the 129 most recent COMPLETED renders carry `keyframes: null`, so the mp4 is the only
// artifact that exists for them. The one artifact type we produce is the one type the transport
// cannot carry; the one type it can carry is the one we almost never produce.
//
// So we produce it: sample frames out of the clip, tile them into ONE jpeg, and write it to R2 as a
// NORMAL artifact. It is deliberately not returned as bytes. `view_artifact` fetches
// `GET /api/artifact/<key>`, so bytes from a new route would be unreachable to it; a key means the
// panel, the serve route, `artifact_url` and `view_artifact` all pick the frame up with no new MCP
// tool and no second vivijure-mcp release.
//
// WHAT A CONTACT SHEET PROVES, AND WHAT IT DOES NOT. It is evidence about the frames it sampled, not
// about the clip. It can show composition, lighting, and whether the subject is on-model. Sampling
// across the clip additionally exposes drift, identity change between shots, and the degenerate
// still-image-with-a-timestamp case, which a single frame structurally cannot. It still cannot show
// per-frame flicker or motion judder between the samples. Nothing built on this may describe a clip
// as "checked"; the honest claim is "N frames sampled at these timestamps looked like this".
import { presignR2Get, presignR2Put } from "./r2-presign";
import type { Env } from "./env";

export const FRAMES_MIN_COUNT = 1;
export const FRAMES_MAX_COUNT = 25;
export const FRAMES_DEFAULT_COUNT = 9;
/** The source clip is presigned for the container to GET, and the sheet for it to PUT. Both are
 *  capability credentials handed to a service on our own private VPC, so they are short-lived: long
 *  enough to download a 256 MB clip and upload a jpeg, not long enough to be worth capturing. */
export const FRAMES_PRESIGN_TTL_SECONDS = 900;

/** Frames are stored as jpeg DELIBERATELY. `safeArtifactContentType` remaps anything outside its
 *  allowlist to application/octet-stream, and `view_artifact` only inlines a response whose type
 *  matches /^image\//. image/jpeg is inside that allowlist, so the sheet survives the remap and is
 *  actually displayable. This constant and the container's PUT header must agree; they are asserted
 *  against each other in tests/render-frames-322.test.ts. */
export const FRAMES_CONTENT_TYPE = "image/jpeg";

export interface FramesGrid { cols: number; rows: number; }

/** Square-ish grid for n samples: 9 -> 3x3, 4 -> 2x2, 6 -> 3x2. */
export function gridFor(count: number): FramesGrid {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  return { cols, rows: Math.max(1, Math.ceil(count / cols)) };
}

/** Clamp a caller-supplied sample count into the allowed band. Absent/blank/garbage -> the default;
 *  never throws, mirroring clampArtifactUrlTtl -- a bad count is worth ignoring, not failing over. */
export function clampFrameCount(raw: string | null): number {
  if (raw === null || raw.trim() === "") return FRAMES_DEFAULT_COUNT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return FRAMES_DEFAULT_COUNT;
  return Math.min(FRAMES_MAX_COUNT, Math.max(FRAMES_MIN_COUNT, Math.floor(n)));
}

/** Parse the single-frame timestamp. Only meaningful when count === 1; null means "let the container
 *  pick the midpoint", which it can do because only it knows the duration. Negative/garbage -> null. */
export function parseFrameAt(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** The output key, derived DETERMINISTICALLY from the source key and the sample spec, so a repeat
 *  request is idempotent and can be served straight from R2 without touching the container.
 *
 *  The derived key keeps the source key's own directory and therefore its top-level prefix BY
 *  CONSTRUCTION: `renders/film-x/film.mp4` -> `renders/film-x/frames/film-3x3.jpg`. That matters more
 *  than it looks. The sheet is only reachable through `/api/artifact` and `/api/artifact-url` if its
 *  key is inside ARTIFACT_PREFIXES, and a key built from a fixed literal prefix could drift out of
 *  that set silently (chat-artifacts.ts records exactly that bug: a namespace mismatch that 404'd
 *  every chat image preview while everything else looked fine). Inheriting the prefix means the
 *  derived key is inside the set whenever the source was, which the guard has already enforced. */
export function deriveFramesKey(sourceKey: string, count: number, at: number | null): string {
  const slash = sourceKey.lastIndexOf("/");
  const dir = slash === -1 ? "" : sourceKey.slice(0, slash);
  const base = slash === -1 ? sourceKey : sourceKey.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const safeStem = (stem.replace(/[^\w.-]+/g, "_").slice(0, 120) || "clip").replace(/^\.+/, "_");
  const spec = count === 1
    ? `at${at === null ? "mid" : String(Math.round(at * 1000)) + "ms"}`
    : (() => { const g = gridFor(count); return `${g.cols}x${g.rows}`; })();
  return `${dir ? dir + "/" : ""}frames/${safeStem}-${spec}.jpg`;
}

/** Every distinguishable way this can fail. These are NOT cosmetic: each one implies a different
 *  operator action, and collapsing them is the defect cf#286/#288 exist to remove elsewhere in the
 *  stack. The `route-not-served` case in particular is EXPECTED during a rollout window (the Worker
 *  ships before the container image is rebuilt and the always-on service rolled), and an operator who
 *  reads a generic error there will go hunting for a bug that does not exist. */

/** Sidecar for reuse path (cf#330). Container PUT of the sheet cannot set customMetadata
 *  we control, so we store frame_times + duration next to the jpeg under a deterministic key. */
export function deriveFramesMetaKey(sheetKey: string): string {
  return sheetKey + ".frames-meta.json";
}

export type FramesFailureState =
  | "tier-unavailable"
  | "route-not-served"
  | "container-unreachable"
  | "container-error";

export interface FramesFailure {
  ok: false;
  state: FramesFailureState;
  status: number;
  reason: string;
}

export interface FramesSuccess {
  ok: true;
  key: string;
  count: number;
  grid: FramesGrid;
  frame_times: number[];
  duration: number | null;
  reused: boolean;
}

export type FramesOutcome = FramesSuccess | FramesFailure;

const FAILURES: Record<FramesFailureState, { status: number; reason: string }> = {
  "tier-unavailable": {
    status: 503,
    reason:
      "the video-finish tier is not installed on this studio (VIDEO_FINISH_VPC is unbound), so no frame can be extracted. This is a provisioning state, not a fault: bind the tier to enable frame extraction.",
  },
  "route-not-served": {
    status: 503,
    reason:
      "the video-finish container is reachable but does not serve POST /frames yet, so its image predates cf#322. EXPECTED during a rollout: the studio Worker ships before the container image is rebuilt and the always-on service is rolled. No bug to hunt; re-try after the container rolls.",
  },
  "container-unreachable": {
    status: 502,
    reason:
      "the video-finish container did not answer (transport failure, or 503/504 after retries). The tier is bound and the route may well exist; the service itself is down or unreachable over the VPC.",
  },
  "container-error": {
    status: 502,
    reason:
      "the video-finish container serves POST /frames and rejected or failed on this clip. The tier and the route are both fine; the fault is with this input or with ffmpeg on it.",
  },
};

export function framesFailure(state: FramesFailureState): FramesFailure {
  const f = FAILURES[state];
  return { ok: false, state, status: f.status, reason: f.reason };
}

interface FetcherLike { fetch(input: string, init?: RequestInit): Promise<Response>; }

function asFetcher(binding: unknown): FetcherLike | null {
  if (binding && typeof (binding as FetcherLike).fetch === "function") return binding as FetcherLike;
  return null;
}

/** Ask the container for a contact sheet. Retries only the transient gateway statuses, the way
 *  callVideoFinishInspect does, and maps every other outcome onto its OWN state rather than folding
 *  them into one null. */
export async function requestFramesFromContainer(
  vpc: FetcherLike,
  payload: unknown,
  opts: { retries?: number; backoffMs?: number } = {},
): Promise<{ ok: true; body: Record<string, unknown> } | FramesFailure> {
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 1500;
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
  let resp: Response | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      resp = await vpc.fetch("http://video-finish/frames", init);
    } catch {
      resp = null;
    }
    if (resp && resp.status !== 503 && resp.status !== 504) break;
    if (attempt < retries - 1) await new Promise((r) => setTimeout(r, backoffMs));
  }
  if (!resp) return framesFailure("container-unreachable");
  // A 404 from a container that ANSWERED is the rollout state: the service is up, this route is not
  // in its image yet. Distinguished from an unreachable service on purpose.
  if (resp.status === 404) return framesFailure("route-not-served");
  if (resp.status === 503 || resp.status === 504) return framesFailure("container-unreachable");
  if (!resp.ok) return framesFailure("container-error");
  let body: Record<string, unknown>;
  try {
    body = (await resp.json()) as Record<string, unknown>;
  } catch {
    return framesFailure("container-error");
  }
  if (!body || body.ok !== true) return framesFailure("container-error");
  return { ok: true, body };
}

/** The whole operation: reuse an existing sheet if one is already in R2, else presign both ends and
 *  ask the container to build one. The caller has already guarded `sourceKey`. */
export async function buildFramesSheet(
  env: Env,
  sourceKey: string,
  count: number,
  at: number | null,
  opts: { retries?: number; backoffMs?: number } = {},
): Promise<FramesOutcome> {
  const key = deriveFramesKey(sourceKey, count, at);
  const grid = gridFor(count);

  // Idempotence: a deterministic key means a repeat request is already answered. Checked BEFORE the
  // tier check on purpose -- an existing sheet is serveable on a studio whose tier was later unbound.
  const existing = await env.R2_RENDERS.head(key);
  if (existing) {
    // cf#330: restore sampling metadata written on first build. Empty frame_times on reuse
    // left the payload claiming "sampled at frame_times" with no times.
    let frame_times: number[] = [];
    let duration: number | null = null;
    try {
      const metaObj = await env.R2_RENDERS.get(deriveFramesMetaKey(key));
      if (metaObj) {
        const meta = (await metaObj.json()) as { frame_times?: unknown; duration?: unknown };
        if (Array.isArray(meta.frame_times)) {
          frame_times = meta.frame_times.filter((n): n is number => typeof n === "number");
        }
        if (typeof meta.duration === "number") duration = meta.duration;
      }
    } catch {
      // best-effort: sheet still serves; metadata stays empty rather than failing the request
    }
    return { ok: true, key, count, grid, frame_times, duration, reused: true };
  }

  const vpc = asFetcher(env.VIDEO_FINISH_VPC);
  if (!vpc) return framesFailure("tier-unavailable");

  let videoUrl: string;
  let outputUrl: string;
  try {
    videoUrl = await presignR2Get(env, sourceKey, FRAMES_PRESIGN_TTL_SECONDS);
    outputUrl = await presignR2Put(env, key, FRAMES_PRESIGN_TTL_SECONDS);
  } catch {
    return framesFailure("container-error");
  }

  const r = await requestFramesFromContainer(
    vpc,
    { videoUrl, outputUrl, outputKey: key, count, at, cols: grid.cols, rows: grid.rows, contentType: FRAMES_CONTENT_TYPE },
    opts,
  );
  if (!r.ok) return r;

  const times = Array.isArray(r.body.frame_times)
    ? (r.body.frame_times as unknown[]).filter((n): n is number => typeof n === "number")
    : [];
  const duration = typeof r.body.duration === "number" ? r.body.duration : null;
  // cf#330: persist for the reuse path (deterministic sheet key already exists in R2).
  try {
    await env.R2_RENDERS.put(
      deriveFramesMetaKey(key),
      JSON.stringify({ frame_times: times, duration }),
      { httpMetadata: { contentType: "application/json" } },
    );
  } catch {
    // sheet is already written by the container; missing meta only weakens reuse, not first response
  }
  return { ok: true, key, count, grid, frame_times: times, duration, reused: false };
}
