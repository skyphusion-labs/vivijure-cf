#!/usr/bin/env python3
"""
A PR touching src/, public/, or modules/ needs a CHANGELOG.md entry OF ITS OWN (cf#510).

WHY THREE-DOT. `changed_files()` diffs `BASE...HEAD`, not `BASE..HEAD` -- three-dot compares from
the MERGE BASE, so a moving `main` cannot lend this PR somebody else's changelog edit. Ported from
vivijure-control-plane's `scripts/changelog-entry-required.py` (cp#147), which hit the two-dot
version of exactly this bug: #242 there shipped three `src/` files with no entry of its own and the
check went green, because a DIFFERENT merged PR had touched CHANGELOG.md in between and two-dot
swept it into this PR's file list.

cf did not carry that guard at all (cf#510): three PRs -- #508, #503, #499 -- landed src/-or-adjacent
changes with no CHANGELOG entry and nothing caught it, because `tests/changelog-version.test.ts`
(cf#274) only checks that package.json agrees with the newest heading; it has no opinion on whether
a given PR added one.

SCOPE, deliberately narrow, matching control-plane's own reasoning: `src/`, `public/`, and
`modules/` only -- the core Worker, the frontend, and the module workers, i.e. the surfaces
CHANGELOG.md actually narrates. `containers/` is excluded on purpose: the CPU containers ship on
their own GHCR image cadence (`build-media-images.yml`, `backend-v*`/image tags), not on this
repo's `v*` SemVer line, so a container-only change (a dependency bump in
`containers/image-prep/requirements.txt`, say) is not a change to what this CHANGELOG describes. A
check that fires on everything gets bypassed on reflex, which is worse than no check.

cf#539: TWO WAYS TO SATISFY THIS, DURING A MIGRATION WINDOW. Every entry used to land at the same
`## Unreleased` (or, per cf#542, a stale dated heading -- there was no `## Unreleased` on main at
all) anchor, so any PR touching it re-conflicts every other open PR touching it. The fix is one
fragment file per PR under `changelog.d/`, assembled into CHANGELOG.md at release by
scripts/changelog-assemble.py -- two PRs adding two different fragment files never touch the same
file, so the conflict class disappears. Flipping straight to fragment-ONLY would refuse every
currently-open PR, all of which carry a `CHANGELOG.md` edit and no fragment, so this guard accepts
EITHER form for now. Tightening to fragment-only once the queue drains is a deliberate follow-up
(see cf#539), not this change.

Logic lives here rather than in the workflow so it can be DRIVEN BY A TEST against a synthetic
repository, including a fixture that reproduces the exact two-dot false pass. A guard whose fix
cannot be watched failing is a guard nobody has verified.
"""
import json
import subprocess
import sys

GATED_PREFIXES = ("src/", "public/", "modules/")


def changed_files(root, base, head, two_dot=False):
    """Files this PR changed. THREE-dot by default: from the merge base, so a moving main cannot
    lend this PR somebody else's edits. two_dot exists ONLY so the test can reproduce the old bug."""
    spec = [base, head] if two_dot else [base + "..." + head]
    out = subprocess.run(
        ["git", "-C", root, "diff", "--name-only", *spec],
        capture_output=True, text=True, check=True,
    )
    return [l for l in out.stdout.split("\n") if l.strip()]


def has_fragment(files):
    """A changelog.d/ touch that is an actual fragment, not the tracked .gitkeep placeholder --
    otherwise the guard degenerates to "did you touch this directory", which an unrelated touch
    (or an accidental one) would satisfy without adding any entry at all."""
    return any(
        f.startswith("changelog.d/") and f != "changelog.d/.gitkeep"
        for f in files
    )


def verdict(files, labels=()):
    """(ok, message). Pure, so the decision is testable without a repository at all."""
    if any(l == "no-changelog" for l in labels):
        return True, "no-changelog label present: deliberate skip, recorded on the PR."
    touches_code = any(f.startswith(p) for f in files for p in GATED_PREFIXES)
    if not touches_code:
        return True, "no src/, public/, or modules/ changes."
    if "CHANGELOG.md" in files:
        return True, "src/, public/, or modules/ changed and CHANGELOG.md was updated."
    if has_fragment(files):
        return True, "src/, public/, or modules/ changed and a changelog.d/ fragment was added."
    return False, (
        "This PR touches src/, public/, or modules/ but neither CHANGELOG.md nor a changelog.d/ "
        "fragment changed. Preferred: add a fragment file under changelog.d/ (see "
        "CONTRIBUTING.md) named <issue>-<slug>.md, containing the `### ...` block that would "
        "have gone under `## Unreleased`. CHANGELOG.md itself is still accepted during the "
        "migration window. Or apply the `no-changelog` label if this is a deliberate skip."
    )


def main(argv):
    root, base, head = argv[1], argv[2], argv[3]
    labels = []
    if len(argv) > 4 and argv[4].strip():
        try:
            labels = json.loads(argv[4])
        except json.JSONDecodeError:
            labels = []
    files = changed_files(root, base, head)
    print("Changed files (three-dot, from the merge base):")
    for f in files:
        print("  " + f)
    ok, message = verdict(files, labels)
    if not ok:
        print("::error::" + message)
        return 1
    print("OK: " + message)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
