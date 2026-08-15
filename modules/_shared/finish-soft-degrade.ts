// THE POLL-PATH BACKEND SOFT-DEGRADE CONTRACT, in one place (cf#594).
//
// WHAT A BACKEND SOFT DEGRADE IS. A finish door (vivijure-musetalk, vivijure-upscale,
// vivijure-blender, vivijure-backend) that cannot polish a clip but has NOT crashed returns a
// STRUCTURED result saying so: {"ok": false, "detail": "<reason>"}. No face in the frame, a
// wall-clock guard expiring, a model that would not load. The clip is fine; the polish did not
// happen. House doctrine (#77, #249) is that a polish step never fails the chain: the module
// returns ok:true with the ORIGINAL clip passed through, `applied` tagged so the degrade is
// counted, and `degraded` carrying the reason. Only malformed I/O fails loud.
//
// WHY IT LIVES HERE RATHER THAN IN A MODULE. Measured at origin/main 895c38c, all four
// modules/finish-*/src/index.ts:
//
//   module            ok === false   softDegradeInFailedEnvelope   terminalErrorInOutput (CONTROL)
//   finish-lipsync         1                    2                            2
//   finish-upscale         0                    0                            2
//   finish-rife            0                    0                            2
//   finish-blender         0                    0                            2
//
// The control column is present twice in all four, so the zeros are measured zeros and not a dead
// matcher. The contract existed in ONE of the four modules. In the other three the identical door
// return reached `parseBackendOutput`, found no `clip_key`, returned module ok:false, and
// vivijure-core's `failOrRetry` classified it deterministic and FAILED THE FILM. So the same
// honest degrade shape was a one-shot degrade through one module and a destroyed film through the
// other three, and a door author could not know which they had without reading the module they sit
// behind. Four independent copies of one contract is how vivijure-core#205 happened; this is one
// implementation with four callers instead.
//
// WHAT THIS FILE DOES NOT OWN, and it matters because cf#585 landed while cf#594 was in flight. Each
// module has a LOCAL `pollPassthrough(st, reason, detail)` that BUILDS the passthrough over its own
// vendored FinishOutput and returns null when the poll token carries no source clip. That function
// stays where it is and cf#594 converged on it rather than adding a second responder beside it: this
// file decides WHETHER an answer is a soft degrade, the module decides what its own output looks
// like. Adding a fifth shape here would have been the exact duplication this issue exists to end.
//
// THE TWO ROUTES, AND WHY BOTH EXIST. RunPod lifts a top-level `error` key out of a handler RETURN
// into a job-level status FAILED envelope (cf#565), so the SAME honest degrade arrives by two
// different doors depending on which key the handler used:
//
//   door returns                          RunPod envelope   recovered by
//   {"ok": false, "detail": "<reason>"}    COMPLETED         softDegradeInCompletedOutput
//   {"ok": false, "error":  "<reason>"}    FAILED            softDegradeInFailedEnvelope
//
// `detail` is the CURRENT convention (musetalk#25); `error` is the legacy handler shape, kept
// working because doors are released independently of panels and a door still on `error` must not
// destroy a film.
//
// THE DISCRIMINATOR, AND IT MUST NOT WIDEN. A soft degrade is `output.ok === false` WITH STRUCTURED
// OUTPUT PRESENT. A genuine crash (a Python raise) leaves no structured `output` in the envelope,
// and it MUST keep failing loud. That distinction is the entire safety property of this file: if
// the discriminator is widened to absorb an envelope with no structured output, every real backend
// crash silently becomes an unpolished shot and the chain reports success. Do not relax it.
//
// SCOPE, deliberately narrow. This file decides WHETHER a poll answer is a soft degrade and returns
// the door's reason text. It does not build the passthrough output (each module has its own
// `passthroughOutput` over its own vendored `FinishOutput`) and it does not decide the TAG. The tag
// is `passthrough:backend-soft-degrade` for every cause today, which is generic; per
// vivijure-core#226 the tag prefix is the only thing `summarizeFinish` counts, so a wall-clock
// timeout and a no-face degrade are indistinguishable downstream. That is a real gap and it is
// filed separately: it is a contract addition across four doors and this fix must not wait on it.

/** The `reason` every poll-path backend soft degrade is tagged with today, so the four call sites
 *  cannot drift into four spellings of it. Passed to each module's `passthroughOutput`, which
 *  renders it as `applied: ["passthrough:backend-soft-degrade"]`. Generic on purpose for now; see
 *  the SCOPE note above. */
export const BACKEND_SOFT_DEGRADE = "backend-soft-degrade";

/** Shared body of both entry points below: given an envelope whose `output` is already known to be
 *  a structured `ok:false`, which string is the door's reason? Preference order is the door's own
 *  `detail` (current convention), then its nested `error` (legacy handler), then whatever RunPod
 *  lifted to the envelope's top level. Returns "" when the envelope kept no reason at all -- "" is
 *  a MATCH WITH NO DETAIL and must stay distinguishable from `null`, which is "not a degrade".
 *  Capped at 120 chars: the reason rides in `FinishOutput.degraded`, which is a short human note,
 *  never a log. */
function degradeReason(output: object, envelopeError?: unknown): string {
  const o = output as { error?: unknown; detail?: unknown };
  if (typeof o.detail === "string" && o.detail.length > 0) return o.detail.slice(0, 120);
  if (typeof o.error === "string" && o.error.length > 0) return o.error.slice(0, 120);
  return typeof envelopeError === "string" ? envelopeError.slice(0, 120) : "";
}

/** Pure: is a job-level FAILED envelope actually the handler's own structured soft-degrade? RunPod
 *  lifts any top-level `error` key in a handler RETURN into a job-level FAILED envelope, so a door
 *  soft-degrade using the legacy `error` key never arrives as COMPLETED -- the COMPLETED branch is
 *  unreachable for it (cf#565). The handler's `ok:false` survives inside `output`, while a genuine
 *  crash (a raise) leaves no structured output there: that is the discriminator. Returns the degrade
 *  detail ("" when the envelope kept none) for a structured soft-degrade, or null for a real
 *  failure.
 *
 *  Lifted VERBATIM from modules/finish-lipsync/src/lipsync.ts (cf#594); the status guard is kept
 *  exactly as it was, so the COMPLETED half stays with `softDegradeInCompletedOutput` below and
 *  neither function can quietly start answering for the other's status. */
export function softDegradeInFailedEnvelope(s: { status?: string; output?: unknown; error?: unknown }): string | null {
  if (s.status !== "FAILED") return null;
  if (!s.output || typeof s.output !== "object") return null;
  if ((s.output as { ok?: unknown }).ok !== false) return null;
  return degradeReason(s.output, s.error);
}

/** Pure: is a COMPLETED job's `output` the handler's own structured soft-degrade? Same
 *  discriminator as the FAILED half -- structured output carrying `ok:false` -- reached when the
 *  door used the current `detail` key, which RunPod does not lift, so the envelope stays COMPLETED
 *  and the output arrives intact. Returns the degrade detail ("" when the door sent none), or null
 *  when this is a normal result to parse for a `clip_key`.
 *
 *  Takes the OUTPUT rather than the envelope because that is all this decision needs: the caller has
 *  already established that the status is COMPLETED. */
export function softDegradeInCompletedOutput(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  if ((output as { ok?: unknown }).ok !== false) return null;
  return degradeReason(output);
}
