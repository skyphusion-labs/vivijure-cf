### ci(changelog): fragment files replace direct edits to the shared release section (cf#539, cf#542, cf#510)

Every CHANGELOG.md entry appended to the same top `## vX.Y.Z` section, so merging any one
CHANGELOG-touching PR re-conflicted every other open PR appending to it -- measured 2026-08-14:
7 open PRs, one section, none bumping `package.json`. Separately, main carried no `## Unreleased`
heading at all, so entries were landing under a stale, already-released heading five minors below
HEAD (cf#542). Ported `vivijure-control-plane`'s `changelog.d/` fragment convention (cp#358)
unchanged where possible: one file per PR under `changelog.d/`, filename `<issue>-<slug>.md`,
content is exactly the `### ...` block that would have gone under `## Unreleased`. A new
`## Unreleased` heading was added back to CHANGELOG.md so fragments and direct edits have a
permanent, date-free destination that cannot go stale. `scripts/changelog-entry-required.py` (a
new PR gate, cf#510) accepts EITHER a fragment or a direct CHANGELOG.md edit during the migration
window, so no currently-open PR breaks. `scripts/changelog-assemble.py <version> <date>` writes a
fresh `## <version> -- <date>` section from the accumulated fragments at release-prep time --
`<version>` is always an explicit argument, never derived from the topmost heading, which is the
direct fix for cf#542. See `CONTRIBUTING.md`.
