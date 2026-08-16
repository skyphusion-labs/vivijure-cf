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
 *   unprovisionable  no operator action reaches this studio, so "not yet" would be a promise
 *                    nobody can keep.
 *
 * WHAT `unprovisionable` MEANS NOW, WHICH IS NOT WHAT IT MEANT WHEN THIS SHIPPED (cf#243).
 *
 * It was written for the cp#112 population: studios provisioned before the tier existed, which the
 * plane had no path to reach. cp#112 then SHIPPED that path (`refresh-studio-bindings`, control
 * plane v1.8.0, bindings-only), which collapses exactly that population back into `provisionable`,
 * the collapse the held SWAP POINT predicted. So the state no longer describes "an old studio". It
 * describes a studio the PLANE has declared unreachable, and only the plane can say that.
 *
 * WHO READS THE SENTENCE BELOW TODAY: nobody, and that is stated rather than implied. Census taken
 * 2026-07-25 (CF-side through a third credential, D1-side through the admin surface, both agreeing):
 * binding+channel 0, channel-only 0, neither 1, and that one is the `rollins-e2e` testbed, whose
 * bindings were refreshed and whose studio bytes move separately. The estate becomes honest through
 * that refresh and that bytes move, NOT through this constant. This swap ships as correctness for
 * future tenants and for after the bytes move; and since nothing sets `VIDEO_FINISH_TIER_STATE`
 * yet, the state is not reachable in production at all until the plane decides who writes it.
 *
 * A FOURTH COMBINATION, which that census did not enumerate and which cp#112 creates (Strummer,
 * evidence on control-plane#112). Binding and channel do NOT travel together: a bindings refresh
 * adds `VIDEO_FINISH_VPC` without touching studio bytes, so a studio can be binding-WITHOUT-channel.
 * The live tenant is exactly that (18 -> 19 bindings, bytes byte-identical before and after).
 * Followed through the resolver it lands right: an ABSENT `hooks_unavailable` reads as available,
 * and for a studio that genuinely HAS the binding that optimism is TRUE. The silent-and-optimistic
 * case for the one live tenant was not fixed by better wording; it was fixed by making the optimism
 * true. No sentence in this file would have reached it either way.
 */
export type VideoFinishState = "available" | "provisionable" | "unprovisionable";

/**
 * KEY NAMESPACE RULE for `hooks_unavailable`, and it is the contract for anyone adding a key here:
 * HOOK keys use DOTS (`film.finish`, `motion.backend`, `plan.enhance`); CAPABILITY keys use the
 * `capability:` COLON PREFIX. The two spaces never overlap, so a capability can never collide with
 * a hook name or be read as something a module provides. Asserted in the tests, both panels.
 *
 * This key is the video-finish BINDING itself, not a hook (cf#229).
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
 * SWAPPED (cf#243, was the SWAP POINT held identical in cf#240 lane D). The sentence for a studio
 * no operator action can reach.
 *
 * It differs from the sentence above in the words that were the whole argument. "Not yet" is a
 * promise of future availability, and for a studio nobody can reach it is a promise nobody can
 * keep. It also does not send the reader to whoever operates the studio, because in this state that
 * person cannot act either, and being sent to someone who must say no is worse than being told
 * plainly. What it keeps is the half that matters to a person mid-render: what they DO get.
 *
 * WHAT WAS GATED, AND WHAT NOW IS NOT (updated 2026-07-26; the paragraph this replaces said the
 * state was unreachable from both ends, which was true when it was written and is not now).
 *
 * Both halves moved:
 *
 *   the WRITER   control-plane#136 shipped one. The plane records a declaration on the tenant row
 *                and PROJECTS it into `VIDEO_FINISH_TIER_STATE` at every write to the studio, so
 *                this state can now occur in production. The plane decides WHEN a studio is in it;
 *                this file still only has to be right about what to SAY.
 *   the READER   the live tenant no longer predates it. That studio was moved v1.6.0 -> v1.9.0 in
 *                place by cf#248, and the reader landed in ba61789, first tagged v1.9.0, so the
 *                bundle running there observes the var. (The earlier note recorded the opposite,
 *                measured by Strummer in the deployed bytes before that move.)
 *
 * WHAT IS STILL TRUE, and it is the part to keep: setting the var on a studio that predates the
 * reader is a silent no-op, which is why the plane route REFUSES rather than writes when the target
 * studio does not serve `capability:video-finish`. And a studio that HAS the tier bound cannot
 * display these words at all, by construction: `videoFinishState` checks the binding first, so an
 * observation beats a label. Do not read the presence of this constant as evidence any particular
 * studio is displaying it.
 *
 * The swap is ONE constant on purpose. Everything deciding WHEN a studio is in this state lives in
 * the plane, so this file only has to be right about what to say.
 */
export const VIDEO_FINISH_UNPROVISIONABLE_REASON =
  "Video finishing is not available for this studio and cannot be turned on for it; finished " +
  "renders deliver as per-shot clips.";

/**
 * Optional operator/plane signal naming which absent-state this studio is in. Absent -> the
 * conservative default `provisionable`, which is also what lane A (the cp#112 re-upload path) makes
 * true for every studio. NOTHING sets this var today: the plane-side half (who sets it, and when) is
 * a control-plane decision, not a panel one.
 */
type VideoFinishEnv = Pick<Env, "VIDEO_FINISH_URL" | "VIDEO_FINISH_TIER_STATE">;

/** Which state this studio is in. A public URL (or the default Traefik origin) is available. */
export function videoFinishState(env: VideoFinishEnv): VideoFinishState {
  if (env.VIDEO_FINISH_URL === "") {
    return env.VIDEO_FINISH_TIER_STATE === "unprovisionable" ? "unprovisionable" : "provisionable";
  }
  return "available";
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
  // One channel, two key namespaces: capability keys carry the `capability:` prefix, hook keys are
  // bare dotted hook names. See the KEY NAMESPACE RULE above before adding a key.
  return Object.fromEntries(
    [VIDEO_FINISH_CAPABILITY_KEY, ...VIDEO_FINISH_GATED_HOOKS].map((k) => [k, reason]),
  );
}
