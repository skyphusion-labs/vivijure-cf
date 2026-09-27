### fix(cast): constrain a copy-into-served-space source to served artifact space

Ref: GHSA-5fj8-6pc2-x9p5.

The rule for "this key names an object this deployment may serve" was written down in each place that
needed it: three times in the serve routes, once in the report door, and not at all in the paths that
read an object in order to COPY it into served space. A rule stated in more than one place is a rule
that drifts, and the paths that re-publish bytes under a new key held no opinion at all.

There is now ONE definition, `isServedArtifactKey` in `src/shared.ts`: safe relative key, not a held
key, and inside `ARTIFACT_PREFIXES`. The three serve guards, the report door's `keyRefusal`, and the
copy paths all use it, so the serve side and the write side cannot come to disagree.

`getServedArtifact(bucket, key)` is the read a copy path uses. The constraint lives at the READ rather
than at each caller, which is the difference that matters: a copy path added later inherits it by
reading through the helper instead of restating the rule, and there is no per-caller check to forget.
A key outside served space reads as ABSENT rather than as a distinct refusal, matching what the serve
route already answers for such a key, so the helper cannot be used to probe what exists beyond the
caller's reach. `copyChatArtifactToRenders` (portrait, refs, sources) and
`attachCastVoiceSampleFromKey` read through it.

`isQuarantineKey` moved to `src/shared.ts` alongside the allowlist, since it is a fact about the key
space rather than about the report door, and is re-exported from `src/abuse-report.ts` so existing
importers are unaffected. Worth recording because it is not obvious: the hold prefix sits OUTSIDE
`ARTIFACT_PREFIXES` and the allowlist is tested against the WHOLE key, so a held key matches no
allowed prefix however ordinary its trailing path looks. That is what makes the allowlist sufficient
here rather than merely suggestive, and it was verified rather than assumed.

`tests/cast-copy-source-ghsa-5fj8.test.ts` drives all four doors and asserts HTTP status plus bucket
state using only APIs that predate this change, following the convention in
`tests/abuse-report-ghsa-wmjq.test.ts`, so each case can be run against the tree without the change
and be seen to fail. The control half asserts every door still copies a legitimate source, and the
discriminator case feeds a door the held key's own un-prefixed tail, which must still be accepted: the
refusal is a statement about the prefix, not about the fixture. The `isServedArtifactKey` unit table is
marked as added coverage rather than proof, because it imports a symbol the unfixed tree does not have.

Files: `src/shared.ts`, `src/abuse-report.ts`, `src/index.ts`, `src/cast-media.ts`,
`src/cast-voice-sample.ts`, `tests/cast-copy-source-ghsa-5fj8.test.ts`.
