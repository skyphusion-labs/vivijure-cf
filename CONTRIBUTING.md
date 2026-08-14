# Contributing

## Changelog entries: fragment files, not `## Unreleased` directly (cf#539)

**Preferred: add a file under `changelog.d/`, not an edit to `CHANGELOG.md`.** Every entry used
to land at the same shared heading, so the moment ANY PR merged, that heading moved (or, before
cf#542, there was no `## Unreleased` heading at all and entries landed under whichever dated
section happened to be on top) and re-conflicted every other open PR touching it -- measured
2026-08-14: seven open PRs all appending to `## v1.26.0 -- 2026-08-14`, so merging any one
re-dirtied the other six. Two PRs adding two DIFFERENT fragment files never touch the same file,
so the conflict class disappears rather than being made cheaper. Ported unchanged from
`vivijure-control-plane`, which hit this first (cp#358): "20 mechanical conflicts resolved, one PR
merged, and the queue was back to 5 DIRTY with 16 more recomputing within seconds."

**Filename:** `<issue>-<short-slug>.md` (e.g. `321-proxy-branch.md`), issue number first so a
directory listing sorts by issue. No issue number: `pr<N>-<slug>.md`.

**Content:** exactly the `### ...` block that would have gone under `## Unreleased` today. No new
syntax, no front matter, no type taxonomy -- move the same prose to a different file.

**`scripts/changelog-entry-required.py` accepts EITHER form during the migration window**: a
`changelog.d/` fragment or a direct `CHANGELOG.md` edit. Fragments are preferred for every new PR;
a direct edit still passes the guard so this does not break PRs already open when the fragment
convention landed. Tightening to fragment-only once the queue drains is a deliberate follow-up
(cf#539), not the current state. The guard applies to PRs touching `src/`, `public/`, or
`modules/` -- `containers/` ships on its own GHCR image cadence, not this repo's `v*` SemVer line,
so a container-only change does not need a CHANGELOG entry.

At release time `python3 scripts/changelog-assemble.py vX.Y.Z YYYY-MM-DD` reads every fragment
(plus whatever is still sitting under `## Unreleased` from a direct-edit PR), writes the
`## vX.Y.Z -- YYYY-MM-DD` section, and deletes the consumed fragments. **The version is always an
explicit argument, never inferred from CHANGELOG.md's current top heading** -- this is the fix for
cf#542, where entries landed under a stale, already-released heading because nothing forced "the
next thing written" to target the release actually being cut. Refuses loudly and writes nothing if
`vX.Y.Z` already appears as a heading, so re-running it for an already-promoted version cannot
duplicate the heading. Run it, then commit the result (including the deleted fragment files) in
the same release-prep commit as the `package.json` version bump, before pushing the tag.

## The gate

`npm run typecheck` and `npm test` run in CI on every PR (`.github/workflows/ci.yml`); `.github/workflows/changelog.yml` is the changelog entry gate described above.
