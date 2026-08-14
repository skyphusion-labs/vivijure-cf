#!/usr/bin/env python3
"""
Assembles changelog.d/ fragments (plus whatever is still sitting under the current top release
heading from a direct-edit PR) into that same section, at RELEASE-PREP time (cf#539).

Ported from vivijure-control-plane's scripts/changelog-assemble.py (cp#358), adapted for one real
difference in shape: control-plane promotes a separate `## Unreleased` heading into a NEW
`## vX.Y.Z` heading. This repo has no `## Unreleased` heading at all -- the CURRENT TOP heading of
CHANGELOG.md IS the in-progress section (its version already matches package.json throughout
development; see tests/changelog-version.test.ts, cf#274), and a release-prep PR bumps both
together BEFORE feature PRs start appending to it. So there is nothing to rename or create here:
this script finds the top section by its OWN heading and appends fragment bodies to the END of it,
in front of the next `## ` heading (or EOF).

WHY FRAGMENTS. Every entry appending to that one shared section makes the PR queue quadratic: the
moment ANY CHANGELOG-touching PR merges, the section moves and re-conflicts every other open PR
appending to it. Measured cf#539, 2026-08-14: 7 open PRs, all appending to `## v1.26.0`, none
touching package.json -- one file, one region, seven writers. Two PRs adding two DIFFERENT
fragment files never touch the same file, so the conflict class disappears rather than being made
cheaper. See scripts/changelog-entry-required.py (the merge-time guard, accepts either form during
the migration window) and tests/changelog-fragment-merge.test.py (the proof that two fragments
merge clean where two direct edits to the same section would not).

WHAT THIS SCRIPT DOES, in order:
  1. reads every changelog.d/*.md fragment, sorted by FILENAME (deterministic; `.gitkeep` excluded)
  2. finds the CURRENT TOP `## vX.Y.Z ...` section in CHANGELOG.md
  3. refuses, loudly, if the version passed does not match that heading's version -- the caller is
     asserting which release they think they are assembling into, and a mismatch means they ran
     this at the wrong moment (wrong branch, stale checkout, or the release-prep bump has not
     landed yet), not that the script should guess
  4. appends the fragment bodies to the END of that section, AFTER whatever a direct-edit PR
     already left there (it predates fragments existing at all, same ordering rule as
     control-plane), in filename-sorted order (issue-number order, by the naming convention in
     CONTRIBUTING.md)
  5. deletes the consumed fragment files

IDEMPOTENT-SAFE BY CONSTRUCTION, not by an extra check: once step 5 deletes the fragments, a
second run has nothing left to assemble and is a no-op (it re-writes the same section verbatim
and exits 0). Unlike control-plane's version this script never WRITES a new heading, so there is
no duplicate-heading state for a re-run to produce.
"""
import pathlib
import sys

FRAGMENT_DIR = "changelog.d"


def normalize_version(v):
    """Accept 'v1.23.0' or '1.23.0'; CHANGELOG.md always spells it with the leading 'v'."""
    return v if v.startswith("v") else "v" + v


def top_section_bounds(lines):
    """(start, end) line indices for the FIRST `## v...` heading, end exclusive at the next `## `
    heading or EOF. None if no such heading exists at all (a malformed CHANGELOG.md)."""
    start = None
    for i, line in enumerate(lines):
        if line.startswith("## v"):
            start = i
            break
    if start is None:
        return None
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if lines[j].startswith("## "):
            end = j
            break
    return start, end


def heading_version(line):
    """'## v1.26.0 -- 2026-08-14' -> 'v1.26.0'. Assumes line.startswith('## v'), per
    top_section_bounds's own match."""
    return line[len("## "):].split(" ", 1)[0]


def read_fragments(root):
    """Fragment BODIES, sorted by filename, `.gitkeep` and non-.md files excluded. Each fragment's
    content is exactly the `### ...` block an author would have appended to the current release
    section by hand -- no new syntax, so this is a plain read-and-strip, never a parse."""
    d = root / FRAGMENT_DIR
    if not d.is_dir():
        return [], []
    names = sorted(
        p.name for p in d.iterdir()
        if p.is_file() and p.name.endswith(".md") and p.name != ".gitkeep"
    )
    bodies = [(d / n).read_text().strip() for n in names]
    return names, bodies


def assemble(text, fragment_names, fragment_bodies, version):
    """Pure: returns (ok, new_text_or_message). Takes CHANGELOG.md's current text and the fragment
    bodies already read from disk, and returns the fully-updated text -- testable without touching
    a filesystem, same style as verdict() in scripts/changelog-entry-required.py."""
    lines = text.split("\n")
    version = normalize_version(version)

    bounds = top_section_bounds(lines)
    if bounds is None:
        return False, (
            "refusing: CHANGELOG.md has no '## vX.Y.Z' heading to assemble into. This file's "
            "convention has no separate 'Unreleased' heading -- the top heading IS the "
            "in-progress section."
        )
    start, end = bounds
    top_version = heading_version(lines[start])
    if top_version != version:
        return False, (
            "refusing: the top CHANGELOG.md heading is '" + top_version + "' but " + version + " "
            "was requested. This script appends into the CURRENT top section; it does not create "
            "or rename one. If a release-prep PR bumping package.json + adding the '## " + version
            + "' heading has not merged yet, merge that first. Nothing was written."
        )

    # Same join pattern as control-plane's assemble(): the direct-edit body (if any) comes FIRST,
    # since it predates fragments existing at all, and fragments follow in filename-sorted order.
    # .strip() on each side keeps internal blank lines (e.g. between two "### ..." entries already
    # in the direct-edit body) while dropping only the leading/trailing whitespace this join adds
    # back deliberately with "\n\n".
    existing_body = "\n".join(lines[start + 1 : end]).strip()
    parts = []
    if existing_body:
        parts.append(existing_body)
    parts.extend(fragment_bodies)
    content = "\n\n".join(parts).strip()

    new_section = [lines[start], ""]
    if content:
        new_section.append(content)
    new_section.append("")  # exactly one blank line before whatever heading follows (or EOF)

    new_lines = lines[:start] + new_section + lines[end:]
    return True, "\n".join(new_lines)


def main(argv):
    if len(argv) != 2:
        print("usage: changelog-assemble.py <version>", file=sys.stderr)
        return 2
    version = argv[1]
    root = pathlib.Path(".")
    changelog_path = root / "CHANGELOG.md"
    text = changelog_path.read_text()

    names, bodies = read_fragments(root)
    ok, result = assemble(text, names, bodies, version)
    if not ok:
        print("changelog-assemble: " + result, file=sys.stderr)
        return 1

    changelog_path.write_text(result)
    for name in names:
        (root / FRAGMENT_DIR / name).unlink()

    summary = "consumed " + str(len(names)) + " fragment(s)"
    if names:
        summary += ": " + ", ".join(names)
    print("changelog-assemble: appended into '" + normalize_version(version) + "' section, " + summary)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
