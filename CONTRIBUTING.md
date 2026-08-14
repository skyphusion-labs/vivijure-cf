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

**On cf#542 (there is no `## Unreleased` heading on `main` at all, so entries land under a stale
released heading instead of the version actually being cut -- measured: `cf#298` appears 6 times
and `cf#320` twice in `CHANGELOG.md`, the copy-up-at-tag-time signature).** The version-mismatch
refusal above closes the MECHANISM for any PR using a fragment, going forward: `assemble()` never
positions a fragment's content anywhere except the CURRENT top heading, and refuses outright if
the caller's asserted version does not match it, so a fragment cannot land under a stale heading
even by mistake -- there is no "wrong position in the file" a fragment can be edited into, because
it has no position until assembled. **It does not close the DIRECT-EDIT half during the migration
window**: a hand edit to `CHANGELOG.md` can still be placed anywhere in the file by whoever writes
it, same as today, until fragments are the only accepted form. It also does **not** retroactively
repair the entries already sitting under stale headings in `CHANGELOG.md` today -- that is a
one-time cleanup, separate from this convention landing.

**Scope of the merge-time guard is a DELIBERATE ADAPTATION, not drift.** `vivijure-control-plane`
scopes its guard to `src/` and `public/` only, because it has no `modules/` directory. This repo
does, and each module worker's own `src/` (`modules/<name>/src/*.ts`) plus the shared module code
at `modules/_shared/*.ts` are shipped code the same way `src/` and `public/` are -- a module worker
change with no entry is exactly cf#510's own hazard, arriving through a directory control-plane
never had to think about. `modules/<name>/README.md` and `modules/<name>/wrangler.toml` are
deliberately OUT of scope -- docs and config, not shipped behaviour, matching the "touch, not
content" philosophy this whole guard already applies to `src/` and `public/`. If a future sync
with control-plane's version ever "corrects" this repo's scope back to `src/`+`public/` only, that
sync is the regression, not this file. The `no-changelog` label is a loud, recorded escape hatch
for a deliberate skip.
