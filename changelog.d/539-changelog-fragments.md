### ci(changelog): fragment files replace direct edits to the shared release section (cf#539)

Every CHANGELOG.md entry appended to the same top `## vX.Y.Z` section, so merging any one
CHANGELOG-touching PR re-conflicted every other open PR appending to it -- measured 2026-08-14:
7 open PRs, one section, none bumping `package.json`. Ported `vivijure-control-plane`'s
`changelog.d/` fragment convention (cp#358) unchanged where possible: one file per PR under
`changelog.d/`, filename `<issue>-<slug>.md`, content is exactly the `### ...` block that would
have gone under the release heading. `scripts/changelog-entry-required.py` (a new PR gate, cf#510)
accepts EITHER a fragment or a direct CHANGELOG.md edit during the migration window, so no
currently-open PR breaks. `scripts/changelog-assemble.py <version>` pulls fragments into the
current top section at release-prep time -- adapted from control-plane's version, which promotes
a separate `## Unreleased` heading; this repo has no such heading, so the script appends into the
top heading directly and refuses if the given version does not match it. See `CONTRIBUTING.md`.
