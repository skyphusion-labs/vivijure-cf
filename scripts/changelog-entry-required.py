#!/usr/bin/env python3
"""
A PR touching src/, public/, or modules/ code needs a CHANGELOG.md entry OF ITS OWN (cf#510).

Ported from vivijure-control-plane's scripts/changelog-entry-required.py (cp#147, cp#358), same
shape, adapted for this repo's actual code surface (module workers under modules/*/src/ and
modules/_shared/ are shipped code the same way src/ and public/ are; control-plane has no modules/
directory at all).

THREE-DOT, NOT TWO. `git diff BASE...HEAD` diffs from the merge base, so it sees only what THIS
PR did. A two-dot diff against a base that MOVES sweeps another merged PR's files into this PR's
changed-file list -- control-plane's #242 shipped three src/ files with no entry of its own while
its check went green, because a DIFFERENT PR had touched CHANGELOG.md in the interim and main had
moved under this one. Same hazard here: this repo has 12+ CHANGELOG-touching PRs open at any time.

cf#539: TWO WAYS TO SATISFY THIS, DURING A MIGRATION WINDOW. Every entry appending to the same
existing `## vX.Y.Z` section (this repo has no separate `## Unreleased` heading -- the current top
heading IS the in-progress section) makes the PR queue quadratic: the moment ANY CHANGELOG-touching
PR merges, that section moves and re-conflicts every other open PR appending to it. Measured
2026-08-14: 7 open PRs, all appending to the same section, none bumping package.json -- one file,
one region, seven writers. The fix is one fragment file per PR under `changelog.d/`, assembled into
CHANGELOG.md at release by scripts/changelog-assemble.py: two PRs adding two DIFFERENT fragment
files never touch the same file, so the conflict class disappears rather than being made cheaper.
Flipping straight to fragment-ONLY would refuse every currently-open PR, all of which carry a direct
CHANGELOG.md edit and no fragment, so this guard accepts EITHER form for now. Tightening to
fragment-only once the queue drains is a deliberate follow-up, not this change.

Deliberately narrow, same as control-plane: touch, not content -- no parsing of the entry, no
format enforcement. The check exists to make the author STOP and decide, not to grade prose. The
`no-changelog` label is a loud, recorded escape hatch for a deliberate skip.
"""
import json
import subprocess
import sys


def changed_files(root, base, head, two_dot=False):
    """Files this PR changed. THREE-dot by default: from the merge base, so a moving main cannot
    lend this PR somebody else's edits. two_dot exists ONLY so the test can reproduce the old bug
    shape (control-plane's #242 / cp#147)."""
    spec = [base, head] if two_dot else [base + "..." + head]
    out = subprocess.run(
        ["git", "-C", root, "diff", "--name-only", *spec],
        capture_output=True, text=True, check=True,
    )
    return [l for l in out.stdout.split("\n") if l.strip()]


def touches_code(f):
    """src/ and public/ match control-plane's own scope. modules/ additionally counts as shipped
    code here: modules/<name>/src/*.ts (each module worker's own source) and modules/_shared/*.ts
    (shared module code, no nested src/ of its own) -- but NOT modules/<name>/README.md or
    modules/<name>/wrangler.toml, which are docs/config rather than shipped behaviour."""
    if f.startswith("src/") or f.startswith("public/"):
        return True
    if f.startswith("modules/") and ("/src/" in f or f.startswith("modules/_shared/")):
        return True
    return False


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
    if not any(touches_code(f) for f in files):
        return True, "no src/, public/, or modules/ code changes."
    if "CHANGELOG.md" in files:
        return True, "code changed and CHANGELOG.md was updated."
    if has_fragment(files):
        return True, "code changed and a changelog.d/ fragment was added."
    return False, (
        "This PR touches src/, public/, or modules/ code but neither CHANGELOG.md nor a "
        "changelog.d/ fragment changed. Preferred: add a fragment file under changelog.d/ (see "
        "CONTRIBUTING.md) named <issue>-<slug>.md, containing the `### ...` block that would have "
        "gone under the current release heading. CHANGELOG.md itself is still accepted during the "
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
