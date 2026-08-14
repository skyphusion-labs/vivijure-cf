### fix(modules): project `studio_release` on `GET /api/modules` (cf#287)

The module registry response carried no studio release identifier, so a caller inspecting
`/api/modules` could not tell which studio build produced the module set it was looking at. That
matters for the hosted/self-host parity invariant specifically: both doors resolve the same tag, and
without the release on the response there is no way to confirm from the outside that they did.
Adds the projection plus `tests/studio-release-287.test.ts`, and documents the field in
`docs/CONTRACT.md` and `docs/module-api.md`.
