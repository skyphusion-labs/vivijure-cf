// Pure finish-upscale logic: build the RunPod request body, derive the output key, parse the result,
// encode/decode the async poll token. No I/O here -- unit-tests without runtime or spend.

import type { FinishInput, FinishOutput } from "./contract";

/** Passthrough FinishOutput that records WHY the clip went through unchanged, so a real failure
 *  (misconfig / backend down) is never indistinguishable from the legitimate no-op -- the silent-
 *  degrade bug of #77. A genuine degrade tags `applied` with `passthrough:<reason>` and sets
 *  `degraded`; the intentional no-op tags `noop:<reason>` and leaves `degraded` unset. Pure: no I/O. */
export function passthroughOutput(
  input: FinishInput,
  reason: string,
  opts: { degraded?: boolean; detail?: string } = {},
): FinishOutput {
  const degraded = opts.degraded ?? true;
  const out: FinishOutput = {
    shot_id: input.shot_id,
    clip_key: input.clip_key,
    out_fps: input.src_fps ?? 24,
    frames: input.frames ?? 0,
    applied: [`${degraded ? "passthrough" : "noop"}:${reason}`],
  };
  if (degraded) out.degraded = opts.detail ? `${reason}: ${opts.detail}` : reason;
  return out;
}

export interface UpscaleConfig {
  scale: number;   // final factor: 2 | 4
  model: string;   // RealESRGAN_x4plus (photoreal/general) | realesr-animevideov3 (anime/fast)
  /** Did the CALLER actually set `scale`, or is this the module default?
   *
   *  Load-bearing, and it is the third instance in this change of one rule: an absence must never
   *  render as a value. Here the absence is "the user expressed no preference", and the old
   *  `Number(cfg.scale ?? base.scale)` could not express it -- an explicit 2 and an absent one were
   *  byte-identical, so a target-derived factor could not tell a choice from a default and would
   *  have silently overridden the choice.
   *
   *  That is core#174 one field over: `resolveCastTrainFamily` treated an explicit `"wan"` as
   *  identical to sending nothing and billed a user for a job they did not choose. `scale` has a UI
   *  control, so setting it is a request actually made. */
  scaleExplicit: boolean;
}

const MODELS = ["realesr-animevideov3", "RealESRGAN_x4plus"] as const;

// Default REVERTED to animevideov3: the #585 flip to RealESRGAN_x4plus CUDA-OOM'd every real
// finish job ("tried to allocate 45.7 GiB" -- the natively-4x RRDB model on a 48fps rife'd 720p
// clip; film-01bfda9c, all 5 shots). x4plus stays an explicit opt-in until the vivijure-upscale
// handler gains tiled inference for it (upscale v0.2.9 work); re-flip only after that proves out
// on a real render. The photoreal-texture rationale of #585 still stands -- the default follows
// the handler's proven memory envelope, not the wish.
export function defaultConfig(): UpscaleConfig {
  return { scale: 2, model: "realesr-animevideov3", scaleExplicit: false };
}

export function coerceConfig(cfg: Record<string, unknown>): UpscaleConfig {
  const base = defaultConfig();
  const raw = Number(cfg?.scale);
  // A usable number is a PREFERENCE. Garbage is not a choice: treating a typo as explicit would pin
  // the user to a factor they never expressed and suppress derivation on the strength of it.
  const scaleExplicit = Number.isFinite(raw) && raw > 0;
  const scale = scaleExplicit ? raw : base.scale;
  return {
    scale: scale >= 4 ? 4 : 2,   // integer factors; the handler clamps to 2/4 as well
    model: (MODELS as readonly string[]).includes(String(cfg.model)) ? String(cfg.model) : base.model,
    scaleExplicit,
  };
}

/** The factor this job will actually request, and WHERE IT CAME FROM.
 *
 *  EXPLICIT ALWAYS WINS. Derivation exists to choose sensibly for someone who did not choose;
 *  someone who chose is not that person. Overriding them would be silent -- a user who set 4 and
 *  got 2 sees a correct-looking film, no error, no degrade tag, nothing to notice.
 *
 *  An explicit factor that CANNOT reach the delivery target is honoured AND the shortfall is
 *  reported. Not silently overridden ("we ignored you") and not silently under-delivered ("we did
 *  what you asked and said nothing about what it means"). */
export function resolveUpscaleScale(
  cfg: UpscaleConfig,
  src: { width?: unknown; height?: unknown },
  target: { width?: unknown; height?: unknown },
): ScaleChoice {
  if (cfg.scaleExplicit) {
    const probe = chooseUpscaleScale(src, target);
    return {
      scale: cfg.scale as UpscaleFactor,
      derived: false,
      // Only meaningful when the comparison was possible at all; an unmeasurable source cannot
      // shortfall against anything, and claiming it could would be a guess.
      undershoots: probe.derived ? cfg.scale < probe.scale || probe.undershoots : false,
    };
  }
  return chooseUpscaleScale(src, target);
}

/** The only factors the shipped handler will honour. MEASURED at vivijure-upscale origin/main,
 *  handler.py:446/:623/:714, three identical call sites:
 *
 *    final_scale = 4 if int(inp.get("scale", 2) or 2) >= 4 else 2
 *
 *  It hard-clamps to 2 or 4 AND `int()` truncates, so a fractional request is silently rounded
 *  DOWN rather than refused -- asking for 2.18 yields 2 with no error. That is why this module
 *  chooses deliberately from a closed set instead of computing the exact ratio: a float would be
 *  a plausible wrong value, which is the same failure shape as the `?? 1920` default this work
 *  exists to fix. */
export const UPSCALE_FACTORS = [2, 4] as const;
export type UpscaleFactor = (typeof UPSCALE_FACTORS)[number];

export interface ScaleChoice {
  scale: UpscaleFactor;
  /** True only when BOTH source and target dimensions were known and the factor came from them.
   *  A defaulted factor and a derived one must never be the same observation -- that exact
   *  indistinguishability is how a blind `?? 1920` survived in the film path with nothing able to
   *  flag it. The caller reports this rather than asserting it targeted anything. */
  derived: boolean;
  /** True when even the largest factor the handler accepts still lands below the target on some
   *  axis. Reported, never silently absorbed: downstream will stretch it and the operator should
   *  know the shortfall came from the source, not from this choice. */
  undershoots: boolean;
}

function usableDim(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Choose the upscale factor that reaches the DELIVERY target in one learned pass.
 *
 *  Smallest factor that clears the target on BOTH axes; the largest available if none does.
 *  Overshooting is fine and is the point: the downstream resize to the delivery resolution is
 *  then a DOWNSAMPLE (supersampling) rather than a second, naive upscale.
 *
 *  The bug this replaces: a blind 2x on a 864x496 draft clip lands at 1728x992, below a 1080p
 *  delivery, so ffmpeg stretches it back up -- and the handler had already computed a 4x result on
 *  the GPU and discarded it down to 992 lines first. Downsample then upsample, in one pipeline.
 *
 *  Choosing 4 is a RESIZE decision, not a memory one: both models are 4x native (handler.py:10)
 *  and a scale-2 request runs the same model then rescales down on the GPU, so 4 costs no more
 *  model memory than 2. #585's CUDA-OOM was a MODEL decision (RealESRGAN_x4plus, the heavy RRDB)
 *  and this does not touch the model. */
export function chooseUpscaleScale(
  src: { width?: unknown; height?: unknown },
  target: { width?: unknown; height?: unknown },
): ScaleChoice {
  const sw = usableDim(src?.width), sh = usableDim(src?.height);
  const tw = usableDim(target?.width), th = usableDim(target?.height);

  // Not derivable. Say so; do not dress a default as a measurement.
  if (!sw || !sh || !tw || !th) {
    return { scale: defaultConfig().scale as UpscaleFactor, derived: false, undershoots: false };
  }

  for (const f of UPSCALE_FACTORS) {
    if (sw * f >= tw && sh * f >= th) return { scale: f, derived: true, undershoots: false };
  }
  const largest = UPSCALE_FACTORS[UPSCALE_FACTORS.length - 1];
  return { scale: largest, derived: true, undershoots: true };
}

/** The upscaled clip lands beside the source with a `_up` suffix, so the original survives and the
 *  chain passes the new key downstream. `renders/p/clips/shot.mp4` -> `renders/p/clips/shot_up.mp4`. */
export function upscaledKey(clipKey: string): string {
  const dot = clipKey.lastIndexOf(".");
  return dot > clipKey.lastIndexOf("/") ? `${clipKey.slice(0, dot)}_up${clipKey.slice(dot)}` : `${clipKey}_up`;
}

/** The RunPod /run body for the dedicated vivijure-upscale endpoint (R2 mode: it reads `clip_key`
 *  and writes `output_key` in the shared bucket itself, exactly as vivijure-backend does for finish). */
export function buildRunPodBody(input: FinishInput, cfg: UpscaleConfig, project: string): { input: Record<string, unknown> } {
  // cf#507b: the factor now comes from resolveUpscaleScale rather than straight off the config.
  // TWO QUANTITIES, kept distinct: input.width/height are the MEASURED source (what this clip is),
  // input.delivery_* is the DECIDED target (what the film ships at). A blind 2x on an 864x496 draft
  // lands at 1728x992, below a 1080p delivery, and ffmpeg stretches it back up -- after the handler
  // had already computed a 4x result on the GPU and discarded it down to 992 lines.
  //
  // Explicit config still wins; this only decides for a caller who did not.
  const chosen = resolveUpscaleScale(
    cfg,
    { width: input.width, height: input.height },
    { width: input.delivery_width, height: input.delivery_height },
  );
  return {
    input: {
      project,
      clip_key: input.clip_key,
      output_key: upscaledKey(input.clip_key),
      scale: chosen.scale,
      model: cfg.model,
      ...(input.output_hash ? { output_hash: input.output_hash } : {}), // #583: forward verbatim for the sidecar stamp
    },
  };
}

// --- poll token (same shape as the other finish modules) --------------------------------------

// submittedAt (epoch ms) lets the stateless /poll measure a grace window before treating a RunPod
// "job not found" as a real terminal GC vs a post-submit propagation race (issue #141).
export interface PollState {
  jobId: string;
  shotId: string;
  /** cf#578 THE INPUT CLIP, so a poll-time degrade can pass it through.
   *
   *  OPTIONAL, and the optionality is the backward compatibility, exactly as `door` above: a token
   *  minted before this change carries no clipKey, and a poll-time degrade cannot invent the clip it
   *  would be passing through. Those tokens keep the pre-cf#578 terminal error, which says so.
   *  finish-lipsync has carried this field since it shipped; this is the sibling catching up, and
   *  the reason the two modules could not make the same decision at their poll sites before. */
  clipKey?: string;
  srcFps: number;
  frames: number;
  submittedAt?: number;
  /** cf#480 AFFINITY. Which transport minted this job id, recorded so a poll cannot be served by
   *  the other one. The on-iron door keeps job state in a PER-PROCESS registry
   *  (`runpod_http_serve.py`'s JobRegistry is an in-memory dict keyed by a uuid4 hex), so a door
   *  job id means nothing to RunPod and a RunPod job id means nothing to the door -- and the miss
   *  does not read as a miss: both answer 404, which `runpodJobGone` correctly classifies as a
   *  GC'd job and, past the grace window, FAILS THE SHOT. Cross-route polling would therefore
   *  destroy completed work while every component behaved correctly.
   *
   *  ABSENT means RunPod. That is deliberate and it is what makes this backward compatible: a
   *  token minted before this change carries no label and a token minted on the RunPod route
   *  carries no label, and those two cases want identical handling. */
  door?: string;
}

export function encodePoll(s: PollState): string {
  return btoa(JSON.stringify(s));
}

export function decodePoll(token: string): PollState | null {
  try {
    const o = JSON.parse(atob(token)) as PollState;
    if (o && typeof o.jobId === "string" && typeof o.shotId === "string") {
      return {
        jobId: o.jobId, shotId: o.shotId, srcFps: Number(o.srcFps) || 16, frames: Number(o.frames) || 0,
        clipKey: typeof o.clipKey === "string" && o.clipKey ? o.clipKey : undefined,
        submittedAt: typeof o.submittedAt === "number" ? o.submittedAt : undefined,
        door: typeof o.door === "string" && o.door ? o.door : undefined,
      };
    }
  } catch { /* fall through */ }
  return null;
}

// How long after submit a RunPod "job not found" is treated as a propagation race vs a real GC.
export const RUNPOD_NOTFOUND_GRACE_MS = 150_000;

/** Pure: did RunPod report this job as gone? A GC'd job returns HTTP 404 with a body like
 *  {"status":404,...} where `status` is the NUMBER 404, not a run state. (#141) */
export function runpodJobGone(httpStatus: number, body: { status?: unknown; title?: unknown } | null): boolean {
  if (httpStatus === 404) return true;
  if (!body) return false;
  const st = body.status;
  if (typeof st === "string" && st.length > 0) return false;
  if (typeof st === "number") return st === 404;
  return typeof body.title === "string" && /not\s*found/i.test(body.title);
}

/** Pure: classify a gone job -- "gone-failed" past the grace window (or for a legacy token without
 *  submittedAt, where a 404 is a real GC not a fresh race); "gone-grace" while still inside it. (#141) */
export function classifyGoneState(
  submittedAt: number | undefined,
  now: number,
  graceMs: number = RUNPOD_NOTFOUND_GRACE_MS,
): "gone-failed" | "gone-grace" {
  if (submittedAt === undefined) return "gone-failed";
  return now - submittedAt >= graceMs ? "gone-failed" : "gone-grace";
}

/** What the vivijure-upscale endpoint returns on completion (R2 mode). */
export interface BackendOutput {
  shot_id?: string;
  clip_key?: string;   // the upscaled key (the handler echoes output_key here)
  /** cf#578 PRESIGNED MODE. The satellite carries TWO return shapes and dispatches on the INPUT:
   *  with `clip_key` it runs the credentialed R2 branch and echoes the written key back as
   *  `clip_key`; without it, it runs the credentialless presigned branch and returns the SAME
   *  written key as `output_key` (vivijure-upscale handler.py, presigned return). One artifact, two
   *  field names. Reading only the first is what made a finished, paid-for upload read as a parse
   *  failure. */
  output_key?: string;
  out_fps?: number;
  /** cf#578: the factor the ENDPOINT reports it ran at. Present on BOTH branches (R2 :674,
   *  presigned :770). Load-bearing because the presigned branch is the one that sends no
   *  `applied` -- see appliedTags below. */
  scale?: number;
  frames?: number;
  applied?: string[];
}

export function parseBackendOutput(output: unknown): BackendOutput | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  return {
    shot_id: typeof o.shot_id === "string" ? o.shot_id : undefined,
    clip_key: typeof o.clip_key === "string" ? o.clip_key : undefined,
    output_key: typeof o.output_key === "string" ? o.output_key : undefined,
    out_fps: typeof o.out_fps === "number" ? o.out_fps : undefined,
    scale: typeof o.scale === "number" ? o.scale : undefined,
    frames: typeof o.frames === "number" ? o.frames : undefined,
    applied: Array.isArray(o.applied) ? (o.applied as string[]) : [],
  };
}


/** The key the endpoint actually WROTE, whichever transport it ran on (cf#578).
 *
 *  Named apart from the two fields on purpose: which field carries it is decided by a branch on the
 *  SATELLITE (key present -> R2 -> `clip_key`; key absent -> presigned -> `output_key`), so the
 *  caller cannot know from its own response which to read, and must not have to. `undefined` means
 *  the job COMPLETED and produced no artifact -- a real absence, and the only case that degrades. */
export function finishedKey(out: BackendOutput | null): string | undefined {
  return out?.clip_key ?? out?.output_key;
}

/** The provenance tags for a COMPLETED job (cf#578).
 *
 *  The R2 branch sends `applied: ["upscale:Nx"]`; the presigned branch (vivijure-upscale
 *  handler.py:770) sends NO `applied` at all, while still reporting the `scale` it ran at. Mapping
 *  only the key name would therefore have cost the module its provenance tag on every presigned
 *  render, silently, and `applied: []` is the value a caller reads as "nothing was done".
 *
 *  THE TAG IS DERIVED FROM WHAT THE ENDPOINT REPORTED, NEVER FROM WHAT WE ASKED FOR. `out.scale` is
 *  the endpoint own account of the factor it ran; the config is only our request, and a tag built
 *  from a request is a fabricated tag whether or not it happens to be right. No scale reported means
 *  no tag: an absence must not render as a value.
 */
export function appliedTags(out: BackendOutput | null): string[] {
  if (out?.applied && out.applied.length > 0) return out.applied;
  if (typeof out?.scale === "number") return [`upscale:${out.scale}x`];
  return [];
}

// Cold-start cap: on a VIRGIN host the image pull (10-20GB) can outlive the normal #141 grace window
// while /status 404s, so the first-ever job on a fresh endpoint false-failed ("GC'd or never ran")
// and only the warm retry succeeded. When the endpoint's /health shows no worker has EVER come up,
// the 404 means "still initializing", not "dropped" -- keep polling up to this cap instead.
export const RUNPOD_COLD_GRACE_MS = 900_000; // 15 min; the film pipeline's 90-min deadline still bounds it

/** Pure: has NO worker ever come up on this endpoint (ready/idle/running all 0) while one is still
 *  coming (initializing/throttled > 0)? That is the virgin-host image pull. A dead endpoint (nothing
 *  up, nothing coming) returns false so a gone job still fails instead of pending forever. */
export function workersStillCold(health: unknown): boolean {
  if (!health || typeof health !== "object") return false;
  const w = (health as Record<string, unknown>).workers;
  if (!w || typeof w !== "object") return false;
  const n = (k: string): number => {
    const v = (w as Record<string, unknown>)[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  const up = n("ready") + n("idle") + n("running");
  const coming = n("initializing") + n("throttled");
  return up === 0 && coming > 0;
}

/** Pure: did the backend report a TERMINAL error inside `output` while the RunPod envelope status
 *  never advanced? (F17: a handler error path that returns instead of raising leaves the job
 *  IN_PROGRESS forever -- billing the worker -- while output already carries
 *  {status:"error", error:{stage, message}}.) Returns the human error string, or null when the
 *  output is a normal progress snapshot. */
export function terminalErrorInOutput(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  const err = o.error;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const msg = typeof e.message === "string" && e.message.length > 0
      ? e.message
      : JSON.stringify(e).slice(0, 200);
    const stage = typeof e.stage === "string" && e.stage.length > 0 ? " (stage: " + e.stage + ")" : "";
    return msg + stage;
  }
  if (typeof err === "string" && err.length > 0) return err;
  if (o.status === "error") return "backend reported status=error with no error detail";
  return null;
}
