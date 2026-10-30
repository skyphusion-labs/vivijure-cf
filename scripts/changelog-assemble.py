#!/usr/bin/env python3
"""
Assembles changelog.d/ fragments (plus any legacy `## Unreleased` body) into a new released
section at RELEASE time (cf#539). Ported unchanged from vivijure-control-plane's
scripts/changelog-assemble.py (cp#358) so the estate has one convention, not two dialects.

WHY FRAGMENTS. Every changelog entry used to land at one shared anchor (or, per cf#542, at
whatever the most recently released heading happened to be, since main carried NO `## Unreleased`
heading at all), so the moment ANY PR merged, that anchor moved and re-conflicted every other open
PR touching it. cf#539 measured seven open PRs all appending to the same `## v1.26.0 -- 2026-08-14`
section: merging any one re-dirtied the other six. One fragment file per PR under `changelog.d/`
removes the shared anchor: two PRs adding two DIFFERENT fragment files never touch the same file, so
the conflict class disappears rather than being made cheaper. See
scripts/changelog-entry-required.py (the merge-time guard) and tests/changelog-fragment-merge.test.py
(the proof that two fragments merge clean where two `## Unreleased` edits would not).

WHAT THIS SCRIPT DOES, in order:
  1. reads every changelog.d/*.md fragment, sorted by FILENAME (deterministic; `.gitkeep` excluded)
  2. ALSO reads whatever is still sitting under `## Unreleased` -- the migration window means the
     guard accepts EITHER a fragment OR a direct edit, so both sources can be populated at once
  3. emits a `## <version> -- <date>` section, in the same heading format this CHANGELOG already
     uses (`## vX.Y.Z -- YYYY-MM-DD`), placed directly below the (now empty) `## Unreleased`
     heading -- i.e. at the top of the released body, exactly where a hand-promoted section
     already goes today
  4. deletes the consumed fragment files and leaves `## Unreleased` empty

<version> IS AN EXPLICIT ARGUMENT, ALWAYS THE VERSION BEING TAGGED -- never derived from "the
topmost heading" in CHANGELOG.md. This is the fix for cf#542 (entries landing under a stale,
already-released heading because there was no `## Unreleased` section to land under, and nothing
enforced that "the next thing written" targets the release actually being cut): the caller states
the version explicitly, at release-prep time, in the same commit as the package.json version bump,
so there is no heading to infer and no way for an assemble run to silently target the wrong one.

ORDERING, stated because nothing else in the repo can recover true merge order across two
different input channels: the legacy `## Unreleased` body (if any) comes FIRST, in whatever order
it was already in, because it predates fragments existing at all; the fragments follow, in
filename-sorted order, which is issue-number order by the naming convention in CONTRIBUTING.md.

IDEMPOTENT-SAFE. Refuses loudly, and writes nothing, when `<version>` already appears as a heading
anywhere in CHANGELOG.md -- released or not. Re-running this script for a version already promoted
would otherwise silently duplicate the heading.
"""
import importlib.util
import pathlib
import sys

FRAGMENT_DIR = "changelog.d"


def load_gate():
    """The release gate defines what a hold is. Loaded, not copied, so the two cannot disagree: the
    copy that used to be absent here is why this script consumed a held fragment (cf#1069)."""
    path = pathlib.Path(__file__).resolve().parent / "changelog-fragments-consumed.py"
    spec = importlib.util.spec_from_file_location("changelog_fragments_consumed", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def split_holds(root, names):
    """(to_consume, held, half_held). A hold needs BOTH halves, as the gate requires: the holds file
    line and the first-line marker. One half alone is a mistake to fix, not a guess to make."""
    gate = load_gate()
    listed = gate.listed_holds(str(root))
    consume, held, half = [], [], []
    for name in names:
        is_listed = name in listed
        is_marked = gate.marker_reason(str(root), name) is not None
        if is_listed and is_marked:
            held.append(name)
        elif is_listed or is_marked:
            half.append(name)
        else:
            consume.append(name)
    return consume, held, half


def normalize_version(v):
    """Accept 'v1.23.0' or '1.23.0'; the file always spells it with the leading 'v'."""
    return v if v.startswith("v") else "v" + v


def section_bounds(lines, heading_text):
    """(start, end) line indices for the FIRST `## <heading_text>` section, end exclusive at the
    next `## ` heading or EOF. None if the heading is not present at all."""
    start = None
    for i, line in enumerate(lines):
        if line == "## " + heading_text:
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


def version_heading_present(lines, version):
    """Is there already a '## <version>' heading, whether or not it carries a date suffix
    ('## v1.1.0' as written by hand, or '## v1.1.0 -- 2026-08-07' as this script writes it)?
    Prefix-matched with a word-boundary check so 'v1.1.0' cannot false-positive against a real
    heading for 'v1.1.0-rc1' or 'v1.1.01'."""
    needle = "## " + version
    for line in lines:
        if line == needle:
            return True
        if line.startswith(needle) and line[len(needle) : len(needle) + 1] in (" ", "\t"):
            return True
    return False


def read_fragments(root):
    """Fragment BODIES, sorted by filename, `.gitkeep` and non-.md files excluded. Each fragment's
    content is exactly the `### ...` block an author would have added under `## Unreleased` --
    no new syntax, so this is a plain read-and-strip, never a parse."""
    d = root / FRAGMENT_DIR
    if not d.is_dir():
        return [], []
    names = sorted(
        p.name for p in d.iterdir()
        if p.is_file() and p.name.endswith(".md") and p.name != ".gitkeep"
    )
    bodies = [(d / n).read_text().strip() for n in names]
    return names, bodies


def assemble(text, fragments_names, fragments_bodies, version, date):
    """Pure: returns (ok, new_text_or_message). Takes CHANGELOG.md's current text and the fragment
    bodies already read from disk, and returns the fully-updated text -- so this is testable
    without touching a filesystem, matching the style of verdict() in
    scripts/changelog-entry-required.py."""
    lines = text.split("\n")
    version = normalize_version(version)

    if version_heading_present(lines, version):
        return False, (
            "refusing: '## " + version + "' already appears as a heading in CHANGELOG.md. "
            "Re-running this script for a version already promoted would duplicate the heading. "
            "Nothing was written."
        )

    bounds = section_bounds(lines, "Unreleased")
    if bounds is None:
        return False, (
            "refusing: CHANGELOG.md has no '## Unreleased' heading to promote from. Add one before "
            "running this script."
        )
    start, end = bounds
    legacy_body = "\n".join(lines[start + 1 : end]).strip()

    parts = []
    if legacy_body:
        parts.append(legacy_body)
    parts.extend(fragments_bodies)
    content = "\n\n".join(parts).strip()

    new_section = ["## " + version + " -- " + date, ""]
    if content:
        new_section.append(content)
    new_section.append("")  # exactly one blank line before whatever heading follows

    new_lines = (
        lines[: start + 1]  # up to and including "## Unreleased"
        + [""]              # Unreleased left empty
        + new_section
        + lines[end:]        # the rest of the file, untouched
    )
    return True, "\n".join(new_lines)


def main(argv):
    if len(argv) != 3:
        print("usage: changelog-assemble.py <version> <date>", file=sys.stderr)
        return 2
    version, date = argv[1], argv[2]
    root = pathlib.Path(".")
    changelog_path = root / "CHANGELOG.md"
    text = changelog_path.read_text()

    all_names, all_bodies = read_fragments(root)
    consume, held, half = split_holds(root, all_names)
    if half:
        print("changelog-assemble: refusing: a hold needs both a line in scripts/changelog-holds.txt "
              "and a first-line HELD marker, and these have one: " + ", ".join(half) +
              ". Nothing was written.", file=sys.stderr)
        return 1
    names = consume
    bodies = [body for name, body in zip(all_names, all_bodies) if name in consume]
    ok, result = assemble(text, names, bodies, version, date)
    if not ok:
        print("changelog-assemble: " + result, file=sys.stderr)
        return 1

    changelog_path.write_text(result)
    for name in names:
        (root / FRAGMENT_DIR / name).unlink()

    summary = "consumed " + str(len(names)) + " fragment(s)"
    if names:
        summary += ": " + ", ".join(names)
    if held:
        summary += "; left held: " + ", ".join(held)
    print("changelog-assemble: wrote '## " + normalize_version(version) + " -- " + date + "', " + summary)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
