// fc#2250 item 5: the storage ceiling missed four byte-writing POST routes.
//
// `checkStorageQuota` is enforced at src/index.ts against core's `isStorageSubmitRoute`, and core's
// `STORAGE_SUBMIT_PATTERNS` does not cover:
//
//   POST /api/storyboard/renders/:id/retry     a full startFilmJob -- an entire film of clips
//   POST /api/cast/:id/voice-sample            a paid image-to-video clip plus its state doc
//   POST /api/cast/:id/voice-sample/attach     up to 32MB of caller-supplied bytes
//   POST /api/render/frames                    buildFramesSheet writes a rendered sheet to R2
//
// So an over-quota studio was refused 507 on /storyboard/render and could then re-render a whole
// film through /retry. The ceiling denied the front door and left the side door open.
//
// WHY THIS LIST LIVES HERE AND NOT IN CORE, stated plainly because a second list is normally the
// wrong answer and this file should not be read as endorsing one:
//
//   * All four routes are defined in THIS repo (src/render-retry.ts, src/cast-voice-sample.ts, and
//     hRenderFrames in src/index.ts). Core's list is a published package; adding them there means a
//     cross-repo change, a version bump, a publish and a dependency bump before the live money hole
//     closes.
//   * Core already exports `storageSubmitPatterns()` "for the panel route-drift tests", so core
//     expects a panel to hold its own view of this surface and verify against it.
//
// THE COST, NAMED: a second list can drift from core's, and that is the exact defect class that
// produced this finding (and cf#789, "the served-prefix rule is stated in four places across two
// repos, and the lists have already drifted"). So this supplement is built to be SELF-RETIRING
// rather than permanent: tests/storage-submit-surface-2250.test.ts asserts that NO pattern here is
// already covered by core. The day core absorbs one of these routes, that test FAILS and this list
// must shrink. A duplicate that cannot silently persist is a different thing from a duplicate.
//
// Whether the four belong in core permanently is an ownership decision above this file; it is
// flagged rather than assumed here.

import { isStorageSubmitRoute } from "@skyphusion-labs/vivijure-core/storage-quota";

/**
 * Byte-writing POST routes this panel serves that core's list does not yet cover.
 *
 * Anchored exactly, like SPEND_PATTERNS: `/voice-sample/keep` must NOT match (it re-points the cast
 * row at a clip an already-metered run produced and writes no new artifact bytes), and the test
 * pins that so an unanchored regex cannot quietly widen this.
 */
export const PANEL_STORAGE_SUBMIT_PATTERNS: RegExp[] = [
  // Re-submits a stored row through startFilmJob: a full film of keyframes and clips, which is the
  // single largest write the studio performs. This is also the route cf#423 added to SPEND_PATTERNS
  // late, so it has now been missed by both meters.
  /^\/api\/storyboard\/renders\/[^/]+\/retry$/,
  // A paid 5s or 10s image-to-video clip, plus the sample state doc under casts/voice-sample/.
  /^\/api\/cast\/[^/]+\/voice-sample$/,
  // Caller-supplied bytes, bounded at 32MB per call by VOICE_REF_MAX and by nothing else.
  /^\/api\/cast\/[^/]+\/voice-sample\/attach$/,
  // buildFramesSheet renders a frame or a contact sheet and stores it.
  /^\/api\/render\/frames$/,
];

/**
 * True for a request whose product is stored bytes, and so must pass the storage ceiling.
 *
 * Core's list UNION the panel supplement above. This is what src/index.ts enforces, so the ceiling
 * covers every byte-writing route the panel serves rather than only those core happens to know.
 */
export function isPanelStorageSubmitRoute(method: string, pathname: string): boolean {
  if (isStorageSubmitRoute(method, pathname)) return true;
  if (method.toUpperCase() !== "POST") return false;
  return PANEL_STORAGE_SUBMIT_PATTERNS.some((re) => re.test(pathname));
}
