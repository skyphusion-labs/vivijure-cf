// ONE RENDER DOOR: the shared pre-flight every render entry point runs before it spends GPU.
//
// cf#334. Six panel routes and one agent route reach core's three start functions, and each grew its
// own copy of the same guards. The comment history on `hStartFilm` is the receipt: #504, #738, #762
// Bug 1 and #762 Bug 2 are four separate production defects, and every fix is written as "mirrors
// hSubmitRender". Manual mirroring is what has been holding these doors together, and it caught each
// divergence late, in production, one door at a time. The dialogue gap (#334 Finding 1) is the same
// class pointing the other way.
//
// THE SHAPE. Each door keeps its own wire body, because they serve genuinely different clients: a
// panel button should not grow a `dialogue_lines` array and the agent route should not grow a
// `renderOverrides` bag. What must be identical is everything between "a request arrived" and "a job
// started".
//
// TWO PHASES, and the split is forced by a real dependency rather than chosen for tidiness. The
// local-gpu pairing check needs the door's RESOLVED keyframe backend, which the door can only compute
// once it has the module registry. So the cheap request-shape guards run first with no I/O, the door
// then discovers modules and maps its configs, and the module-dependent guards run second. Collapsing
// these into one call would have meant discovering modules before rejecting a malformed body.
//
// GUARDS DECLARE WHERE THEY APPLY. A door that legitimately skips a check says so in its profile
// rather than simply not having the code. That turns "this door does not run that check" from an
// absence nobody can see into a declaration a reviewer can argue with, which is the difference
// between the two states this whole issue is about.
//
// REFUSALS ARE RETURNED, NOT THROWN. The caller owns HTTP: it decides whether a refusal becomes a
// thrown 400 or a `json(..., 503)` body. It also keeps this module importable by index.ts with no cycle.
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core/modules/types";
import {
  servingForHook,
  motionBackendPreflightError,
  motionConfigPreflightError,
  localGpuKeyframePreflightError,
} from "@skyphusion-labs/vivijure-core/modules/registry";
import { resolveCastLoras, untrainedCastMessage } from "@skyphusion-labs/vivijure-core/cast-loras";
import { isSafeBundleKey } from "./shared";

/** What a door refuses with. `status` is the host status the caller should produce. */
export interface RenderRefusal {
  status: 400 | 503;
  message: string;
}

export interface ResolvedCast {
  pretrained: Record<string, string>;
  /** Wan adapters arrive as a high/low noise PAIR, not a single key. Typed off the core signature
   *  rather than from memory: a single-string map compiles and is wrong at runtime. */
  wanPretrained: Record<string, { high: string; low: string }>;
  castIds: Record<string, number>;
  voices: Record<string, string>;
}

/**
 * Per-door declarations. Everything here is something the doors genuinely differ on today; nothing
 * here is a knob invented for flexibility.
 */
export interface RenderDoorProfile {
  /** For diagnostics: which door is asking. */
  door: string;
  /**
   * The bundle-key field name AS THE CALLER SPELLS IT. The panel sends `bundleKey`, the agent route
   * sends `bundle_key`, and each refuses using its own spelling. A shared guard with a hardcoded
   * message silently rewrites one door's contract; that is a wire-visible change and it is not one
   * this extraction is entitled to make.
   */
  bundleKeyField: string;
  /** The message this door uses when scenes are missing. Preserved verbatim per door. */
  scenesRequiredMessage: string;
  /**
   * The minimum renderable-unit count this door accepts. One for the film doors; TWO for scatter,
   * where a single shard is not a scatter at all. Declared rather than defaulted, because a default
   * of 1 would silently accept a degenerate scatter and the failure would surface much later as a
   * sharding bug rather than here as a refusal.
   */
  minSceneCount?: number;
  /**
   * Whether this request has a motion leg at all. A keyframes-only preview runs no motion phase, so
   * the #500/#504 backend preflight, the #577 config preflight and the local-gpu pairing check do not
   * apply. Declared rather than omitted, because "no motion leg" and "nobody wrote the check" look
   * identical in code.
   */
  hasMotionLeg: boolean;
  /**
   * Whether an absent keyframe module is this door's refusal to make. hSubmitRender answers 503 at
   * the door; hStartFilm lets startFilmJob fail the job instead, which surfaces as a started-then-
   * failed film rather than a refusal. Kept as a per-door flag rather than unified, because changing
   * it changes what a live caller receives, and that is a behaviour decision, not a refactor.
   */
  requireKeyframeModule: boolean;
}

/** The cheap half: request shape only. No I/O, so a malformed body is refused before any lookup. */
export interface RenderRequestShape {
  bundleKey: unknown;
  scenes: unknown;
  /** Config maps to shape-check (#696). Only the ones this door actually accepts. */
  configMaps?: Array<{ label: string; value: unknown; deep: boolean }>;
}

/** The module-dependent half. Everything here needs the registry the door has already discovered. */
export interface RenderModulePreflight {
  modules: RegisteredModule[];
  /** The EXPLICIT motion.backend choice, top-level or merged from an overrides bag. Never a default. */
  motionBackend?: string;
  /** The door's RESOLVED keyframe backend, for the local-gpu pairing rule. */
  keyframeBackend?: string;
  /**
   * The motion backend the LOCAL-GPU PAIRING rule is judged against, when it differs from the one the
   * #500 preflight uses. The panel door checks #500 against the caller's EXPLICIT choice (top-level or
   * raw overrides bag) and the pairing rule against its RESOLVED choice, which has been through the
   * registry. They are usually the same string and are not the same value; collapsing them would have
   * been a silent behaviour change on any request where the resolution moves. Defaults to
   * `motionBackend` for doors that genuinely use one value for both.
   */
  pairingMotionBackend?: string;
  /** The motion config to judge against the chosen backend's schema (#577). */
  motionConfig?: Record<string, unknown>;
  /** { slot: castPublicId } bindings, or undefined when this door sends none. */
  castLoras?: Record<string, unknown>;
}

export type ShapeOutcome = { ok: true } | { ok: false; refusal: RenderRefusal };
export type ModuleOutcome = { ok: true; cast: ResolvedCast } | { ok: false; refusal: RenderRefusal };

/**
 * The one un-stubbable seam. Production passes `productionRenderDoorDeps` and nothing else, so a test
 * cannot prove a stubbed path and have it read as coverage of the shipped wiring.
 */
export interface RenderDoorDeps {
  resolveCastLoras: typeof resolveCastLoras;
}

export const productionRenderDoorDeps: RenderDoorDeps = { resolveCastLoras };

const bad = (message: string): { ok: false; refusal: RenderRefusal } => ({ ok: false, refusal: { status: 400, message } });

function describeJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * #696: a config map that is present but not a plain object bounces HERE, before any GPU spend,
 * naming the offending field. Downstream `validateConfig` is forgiving by design, so without this a
 * mis-encoded map clamps to defaults and the render degrades with no error at all (a pre-#674 client
 * sent film_finish_config as a JSON STRING; subtitle mode=both silently became burn on film-941a4d3b
 * and completed green). An OMITTED field is fine; a present non-object bounces.
 */
export function configMapShapeError(label: string, value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    const actual = describeJsonType(value);
    return `${label} must be a JSON object (a { key: value } map), not ${/^[aeiou]/.test(actual) ? "an" : "a"} ${actual}`;
  }
  return null;
}

/**
 * #696 deep: a per-module config map is object-of-objects (module -> { field: value }), so the top
 * level AND every per-module entry are checked. The flat knob maps (keyframe_config, motion_config)
 * pass `deep: false`, because their values are legitimately scalars.
 */
export function moduleConfigMapError(label: string, value: unknown, deep: boolean): string | null {
  const top = configMapShapeError(label, value);
  if (top) return top;
  if (!deep) return null;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [name, cfg] of Object.entries(value as Record<string, unknown>)) {
      const err = configMapShapeError(`${label}.${name}`, cfg);
      if (err) return err;
    }
  }
  return null;
}

/**
 * Phase 1: the request-shape guards, in one order for every door.
 *
 * ON ORDER, because it is the one thing about this extraction a caller can observe. The doors ran
 * these in slightly different sequences (hSubmitRender shape-checked its overrides bag before
 * validating scenes; hStartFilm did the reverse). A request with a SINGLE defect gets the identical
 * status and message as before, pinned per door in tests/render-door-precedence.test.ts. A request
 * with TWO defects may now be told about a different one first. That is real, it is disclosed rather
 * than folded in, and it can never turn an accepted request into a rejected one or the reverse.
 */
export function checkRenderRequestShape(shape: RenderRequestShape, profile: RenderDoorProfile): ShapeOutcome {
  if (!shape.bundleKey || typeof shape.bundleKey !== "string") {
    return bad(`${profile.bundleKeyField} required`);
  }
  if (!isSafeBundleKey(shape.bundleKey)) {
    return bad(`${profile.bundleKeyField} must be a plain relative key under bundles/`);
  }
  for (const m of shape.configMaps ?? []) {
    const err = moduleConfigMapError(m.label, m.value, m.deep);
    if (err) return bad(err);
  }
  if (!Array.isArray(shape.scenes) || shape.scenes.length < (profile.minSceneCount ?? 1)) {
    return bad(profile.scenesRequiredMessage);
  }
  return { ok: true };
}

/**
 * Phase 2: the guards that need the module registry, plus the cast resolution both doors then use.
 *
 * Returns the resolved cast so the caller does not repeat the most expensive lookup on the path.
 */
export async function preflightRenderModules(
  deps: RenderDoorDeps,
  env: unknown,
  input: RenderModulePreflight,
  profile: RenderDoorProfile,
): Promise<ModuleOutcome> {
  // An absent keyframe module: this door's call, per profile.
  if (profile.requireKeyframeModule && servingForHook(input.modules, "keyframe").length === 0) {
    return { ok: false, refusal: { status: 503, message: "no keyframe module installed (bind MODULE_KEYFRAME)" } };
  }

  // The motion leg (#500/#504, #577, vivijure-local#153). Skipped entirely for a keyframes-only
  // preview, which has no motion phase to preflight.
  if (profile.hasMotionLeg) {
    const backendErr = motionBackendPreflightError(input.modules, input.motionBackend);
    if (backendErr) return bad(backendErr);
    const cfgErr = motionConfigPreflightError(input.modules, input.motionBackend, input.motionConfig);
    if (cfgErr) return bad(cfgErr);
    const pairErr = localGpuKeyframePreflightError(
      input.modules,
      input.pairingMotionBackend ?? input.motionBackend,
      input.keyframeBackend,
    );
    if (pairErr) return bad(pairErr);
  }

  // Cast LoRAs. A bound-but-not-ready binding FAILS HARD (#738/#739): never a silent drop to a generic
  // render, which is the honest-failures rule (#245/#249). A door that sends no bindings resolves to
  // empty maps and is unaffected.
  const cast = await deps.resolveCastLoras(env as never, (input.castLoras ?? {}) as Record<string, unknown>);
  if (cast.skipped.length) return bad(untrainedCastMessage(cast.skippedDetail));

  return {
    ok: true,
    cast: {
      pretrained: cast.pretrained,
      wanPretrained: cast.wanPretrained,
      castIds: cast.castIds,
      voices: cast.voices,
    },
  };
}
