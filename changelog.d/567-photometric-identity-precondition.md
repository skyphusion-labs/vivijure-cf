### Fixed: photometric identity gate names its semantic precondition (cf#567)

The 2% luma check is only valid when the operation is supposed to preserve
level (identity-preset grade: preset=neutral at strength 1, or strength 0).
A creative grade that darkens on purpose would read wrecked. The gate now
exports `SEMANTIC_PRECONDITION = "identity_preserving"` and
`POST /photometric-check` relays it as `applies_when`. Wiring the blender
caller is a sibling; this PR does not close #567.

Refs https://github.com/skyphusion-labs/vivijure-cf/issues/567
