# Contributing

## Changelog entries: fragment files, not a direct `CHANGELOG.md` edit (cf#539)

**Preferred: add a file under `changelog.d/`, not an edit to `CHANGELOG.md`.** Every entry used
to append to the same top `## vX.Y.Z` section -- this repo has no separate `## Unreleased`
heading; the current top heading of `CHANGELOG.md` IS the in-progress section, matching whatever
`package.json` declares (see `tests/changelog-version.test.ts`, cf#274) -- so the moment ANY
CHANGELOG-touching PR merged, that section moved and re-conflicted every other open PR appending
to it. Measured 2026-08-14: 7 open PRs, all appending to `## v1.26.0`, none bumping
`package.json` -- one file, one region, seven writers, and merging any one of them re-dirtied the
other six. Two PRs adding two DIFFERENT fragment files never touch the same file, so the conflict
class disappears rather than being made cheaper. `vivijure-control-plane` hit the identical
problem first (cp#358) and this is the same convention, ported so the estate has one shape rather
than two dialects.

**Filename:** `<issue>-<short-slug>.md` (e.g. `353-real-retry-route.md`), issue number first so a
directory listing sorts by issue. No issue number: `pr<N>-<slug>.md`.

**Content:** exactly the `### ...` block that would have gone under the current release heading
today. No new syntax, no front matter, no type taxonomy -- move the same prose to a different
file.

**`scripts/changelog-entry-required.py` accepts EITHER form during the migration window**: a
`changelog.d/` fragment or a direct `CHANGELOG.md` edit. Fragments are preferred for every new PR;
a direct edit still passes the guard so this does not break PRs already open when the fragment
convention landed. Tightening to fragment-only once the queue drains is a deliberate follow-up
(cf#539), not the current state.

**At release-prep time, `scripts/changelog-assemble.py <version>` appends every fragment (plus
whatever is still sitting in the top section from a direct-edit PR) into that same section, and
deletes the consumed fragments.** Unlike `vivijure-control-plane`'s version, it does not create or
rename a heading -- it asserts `<version>` matches the CURRENT top heading and refuses otherwise,
because in this repo the release-prep PR (bump `package.json`, add the `## vX.Y.Z -- <date>`
heading) already has to land before feature PRs accumulate under it. See
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md#cutting-a-release-tag-an-existing-studio).

**Scope of the merge-time guard:** `src/`, `public/`, and `modules/` code (each module worker's
own `src/`, plus `modules/_shared/`) need an entry. `modules/<name>/README.md` and
`modules/<name>/wrangler.toml` do not -- docs and config, not shipped behaviour. The `no-changelog`
label is a loud, recorded escape hatch for a deliberate skip.
