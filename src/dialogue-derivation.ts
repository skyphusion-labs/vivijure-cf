// fc#2250 item 7: what a FAILED dialogue derivation means, in one place.
//
// cf#334 made every render door derive dialogue_lines from the bundle storyboard so a voiced
// storyboard could not ship silent. All three derivation sites wrapped that in
// `catch { /* best-effort */ }`, and the catch is the defect: a swallowed exception leaves
// `dialogue` undefined, `spokenLinesPresent` reads false, the talking-door 400 never fires, and the
// operator is billed for a film that comes back silent with a 201.
//
// A swallowed exception and a genuinely silent storyboard produce the IDENTICAL state, which is why
// this survived: nothing downstream can tell "no dialogue" from "we could not tell".
//
// THE DISTINCTION THIS RESTS ON is a property of core, not a convention, so it is safe to build on:
// `readBundleScenes` returns `[]` when the bundle object is missing or carries no storyboard.yaml,
// and THROWS only on a real failure (an R2 error, a corrupt gzip, unparseable YAML). So the two
// cases the old catch collapsed are already distinguishable at the seam:
//
//   []     -- the storyboard genuinely has nothing to voice. Render silent. Unchanged, and the
//             reason "a missing bundle must not block a render" still holds: a missing bundle
//             returns [], it does not throw.
//   throw  -- whether this storyboard has spoken lines is UNDETERMINED. Refusing costs the
//             filmmaker a retry; proceeding spends GPU money on a film that may be silently wrong,
//             and reports it as a success.
//
// WHY 503 AND NOT 400. The storage ceiling already answers "this check could not be performed" with
// 503 rather than inventing a 400 for a condition the caller did not cause, and this is the same
// shape: the render is refused because a gate could not be evaluated, not because the request was
// malformed. The underlying reason is carried through verbatim, because "dialogue undetermined" with
// no cause reads as a transient blip and gets retried forever against a corrupt bundle.

/** The refusal text for a render whose dialogue state could not be established. */
export function dialogueUndeterminedMessage(e: unknown): string {
  const reason = e instanceof Error ? e.message : String(e);
  return (
    "could not determine whether this storyboard has spoken lines, so the render was refused "
    + "rather than risk shipping a silent film: " + reason
  );
}
