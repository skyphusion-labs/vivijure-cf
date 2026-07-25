// WHAT THE ABSENT VIDEO-FINISH TIER ACTUALLY TAKES WITH IT (cf#118, split by cf#229).
//
// `VIDEO_FINISH_VPC` is a Workers VPC binding to the always-on fleet video-finish container. A
// self-host or flagship deploy binds it; a hosted TENANT studio does not (the provisioner cannot
// attach it to an already-provisioned studio today, cp#112), so the tier is genuinely absent there
// and the render degrades honestly.
//
// The panel needs to say so BEFORE a user spends a render on something this host cannot deliver, and
// it says it through the generic cf#98 channel (`host.hooks_unavailable` on GET /api/modules), never
// through a bespoke "is video finish available" branch in the frontend. One attribute on a control,
// one answer from the host.
//
// THE SET IS READ OFF THE EXECUTION PATHS, not off intuition, because both errors are bad in
// opposite ways: name too few and the panel offers buttons that cannot deliver; name too many and it
// hides capability that works. With no VIDEO_FINISH_VPC the film path does this (core
// film-orchestrator):
//
//   assemble  -> `degradeAssembleUnavailable` sets `phase = "done"` DIRECTLY ("no assembled film to
//                finish/notify; the clips ARE the delivered render"). `transitionToDone` never runs.
//   master    -> `enterMasterOrMux` runs AFTER assemble, so it is never reached.
//   mux       -> downstream of assemble; never reached.
//
// ---------------------------------------------------------------------------------------------
// cf#229: WHY `score` IS NOT IN THE UNAVAILABLE SET, AND WHAT REPLACED IT
//
// The cf#118 contract pinned `score` here because the two controls that were throwing ("add audio",
// "narrate") are score-adjacent. That was BEHAVIOUR-correct and SEMANTICALLY wrong, and cf#229 is
// the receipt: `score` names two capabilities that do not fail together.
//
//   bed GENERATION  POST /api/storyboard/score-bed -> src/score-bed.ts, which references
//                   VIDEO_FINISH_VPC nowhere. The film path never calls the score hook at all (the
//                   bed is an artifact the planner attaches BEFORE submit, job.audio_key). On a
//                   studio with no video-finish tier this works, start to finish.
//   the MUX         laying that bed onto a finished MP4 -- core render-mux.js, which refuses with
//                   "video-finish VPC binding not configured". Dead without the tier.
//
// Reporting `score` unavailable therefore says "this host cannot serve score", which is BROADER than
// the truth, and the moment anyone correctly declares the hook their bed-generation control drives
// (which cf#98 doctrine actively encourages) those controls would go dark on a studio where they
// work. cf#98 stopped the panel over-promising; this would have had it under-promising.
//
// So the absent thing gets named directly. `capability:video-finish` is the key for the BINDING
// itself, and the colon namespace is deliberate: hook names use dots, so a capability key can never
// collide with one or be mistaken for a hook some module provides. Controls that die because the
// container is absent (the two mux buttons) declare THAT, and the four-keys-proxying-one-binding
// shape the lead named on cf#229 becomes one key that says what it means.
//
// The bed generators keep the honest half of the old report through the panel's ADVISORY
// relationship (`data-hook-advisory`, see public/hook-availability.js): they run, they are never
// disabled, and they carry a note saying the bed cannot be attached to a finished film here. The
// host does not need a second wire channel for that -- required-vs-advisory is a property of the
// CONTROL, not of the host. The host says what it cannot do; each control declares how much it cares.
//
// And what is NOT here, deliberately: keyframe, motion.backend, finish, speech, dialogue,
// plan.enhance, image.generate, cast.image. All of those are PER-SHOT work, and per-shot clips are
// exactly what a VPC-less host delivers. A panel that greyed those out would lie the other way.
//
// Scope note: this describes the FILM path. A clips-only render is unaffected by construction, and
// the scatter path degrades through its own gates in the same family.

import type { Env } from "./env";

/**
 * The three states this studio can be in with respect to the video-finish tier (cf#240 lane D).
 *
 * `provisionable` and `unprovisionable` are BOTH "the tier is absent right now"; they differ only in
 * whether anyone can do anything about it, which is the distinction cp#112 forced:
 *
 *   provisionable    the tier can be attached to this studio (a self-host operator binds it; a
 *                    hosted tenant's operator provisions it). "Not yet" is a promise that can be kept.
 *   unprovisionable  this studio was provisioned before the tier existed and the plane has no
 *                    re-upload path, so no operator action reaches it. "Not yet" would be a promise
 *                    nobody can keep.
 *
 * MECHANISM ONLY, BY DESIGN. Both states currently resolve to the SAME sentence: the copy swap is
 * gated on cp#112 (lane A) landing, because a re-upload path collapses `unprovisionable` back into
 * `provisionable` and writing the divergent sentence first would be writing copy for a world that
 * changes next sprint. When lane A lands, the swap is the one constant marked SWAP POINT below.
 */
export type VideoFinishState = "available" | "provisionable" | "unprovisionable";

/**
 * The key for the BINDING, not for a hook (cf#229). Namespaced with a colon so it can never collide
 * with a hook name (hooks use dots) or be read as a capability some module provides.
 */
export const VIDEO_FINISH_CAPABILITY_KEY = "capability:video-finish";

/** Hooks that genuinely never RUN without the tier. See the header for the execution paths. */
export const VIDEO_FINISH_GATED_HOOKS = ["master", "film.finish", "notify"] as const;

/**
 * Hooks that RUN but whose product cannot be DELIVERED without the tier (cf#229). Not emitted as
 * unavailable -- disabling them would hide capability that works. Exported so the panel-side
 * advisory declarations and the parity tests have one place to read the list from rather than each
 * re-deriving it.
 */
export const VIDEO_FINISH_ADVISORY_HOOKS = ["score"] as const;

/**
 * The reason string, printed VERBATIM by the panel (cf#98 does not rewrite or soften it).
 *
 * Written for the person who will read it: a hosted TENANT, who cannot fix this and must not be told
 * to set a binding they have no access to. It also says what they DO get, because "unavailable"
 * alone reads as broken. vivijure-local's twin deliberately words this differently (it names
 * VIDEO_FINISH_URL, because there the reader IS the operator): parity is the SET and the BIAS, never
 * the bytes (local#226).
 */
export const VIDEO_FINISH_UNAVAILABLE_REASON =
  "Video finishing is not yet provisioned for this studio; finished renders deliver as per-shot clips.";

/**
 * SWAP POINT (cf#240 lane D). The sentence for a studio no operator action can reach.
 *
 * Deliberately IDENTICAL to the sentence above today: shipping the divergence before cp#112 is
 * answered would tell today's tenants something that stops being true the moment lane A lands. The
 * mechanism is here so the swap is one constant, reviewed on its own, rather than a re-plumbing.
 */
export const VIDEO_FINISH_UNPROVISIONABLE_REASON = VIDEO_FINISH_UNAVAILABLE_REASON;

/**
 * Optional operator/plane signal naming which absent-state this studio is in. Absent -> the
 * conservative default `provisionable`, which is also what lane A (the cp#112 re-upload path) makes
 * true for every studio. NOTHING sets this var today: the plane-side half (who sets it, and when) is
 * a control-plane decision, not a panel one.
 */
type VideoFinishEnv = Pick<Env, "VIDEO_FINISH_VPC" | "VIDEO_FINISH_TIER_STATE">;

/** Which state this studio is in. Bound tier wins over any var: an observation beats a label. */
export function videoFinishState(env: VideoFinishEnv): VideoFinishState {
  if (env.VIDEO_FINISH_VPC) return "available";
  return env.VIDEO_FINISH_TIER_STATE === "unprovisionable" ? "unprovisionable" : "provisionable";
}

/** The sentence for a state. `available` has no sentence: the host reports nothing at all. */
export function videoFinishReason(state: VideoFinishState): string | null {
  if (state === "available") return null;
  return state === "unprovisionable"
    ? VIDEO_FINISH_UNPROVISIONABLE_REASON
    : VIDEO_FINISH_UNAVAILABLE_REASON;
}

/**
 * `{}` when the tier is present -- ABSENT KEY MEANS AVAILABLE, and that bias is load-bearing: a
 * deploy that binds the tier must report nothing at all, so the panel's positive control is a real
 * observation rather than the absence of a field nobody sets.
 */
export function videoFinishHooksUnavailable(env: VideoFinishEnv): Record<string, string> {
  const state = videoFinishState(env);
  const reason = videoFinishReason(state);
  if (!reason) return {};
  return Object.fromEntries(
    [VIDEO_FINISH_CAPABILITY_KEY, ...VIDEO_FINISH_GATED_HOOKS].map((k) => [k, reason]),
  );
}
