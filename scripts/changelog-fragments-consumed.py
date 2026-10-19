#!/usr/bin/env python3
"""Refuse a release whose `changelog.d/` still holds an unconsumed fragment.

WHY THIS EXISTS. Three times in one night a change shipped inside a tag with no changelog entry,
and nothing anywhere refused:

  1. v1.34.1 was HAND-WRITTEN instead of assembled, so `810-pool-vs-max-instances.md` and
     `804-storage-posture-comment.md` were never consumed. 810 survived only by the accident of
     the author writing the same content twice; 804 was simply lost and had to be folded back in
     afterwards as a post-publication correction.
  2. v1.34.2 was assembled correctly and then TWO more PRs merged before the tag, so cf#858 (a
     child-safety fix) and cf#859 rode the tag undescribed.
  3. The same again with cf#862 and cf#863.

**Instance 2 is why this runs at TAG time and not only at cut time.** A cut-time check would have
caught 1 and sailed straight past 2 and 3, because those fragments did not exist when the
assembler ran. The tag is the last boundary the artifact crosses, so it is the one that has to
ask.

WHAT COUNTS AS DELIBERATE. A fragment may legitimately be held back -- 804 was, on purpose, for
several hours, because its change belonged to an earlier release. So "non-empty" cannot simply be
a refusal. But a hold has to be distinguishable from an oversight, and by exactly the mechanism
this repo already proved in scripts/changelog-corrections.txt (cp#245):

  BOTH HALVES ARE REQUIRED, and each catches what the other cannot.
    - the fragment listed in scripts/changelog-holds.txt, reviewable as its own line in a diff;
    - a FIRST-LINE `<!-- HELD: reason -->` marker in the fragment itself, which tells anyone
      reading the fragment why it is sitting there.
  Listed but unmarked is refused. Marked but unlisted is refused. Neither waives anything alone.

The marker is pinned to the FIRST line on purpose. cp#245's own regression was a waiver that
lived in the content, so a section merely DOCUMENTING the mechanism disarmed itself. A fragment
discussing holds in its prose cannot trip this one.

    python3 scripts/changelog-fragments-consumed.py [repo_root]

Exit 0 when every fragment is accounted for, 1 when any is not. It does not print fragment bodies,
only names, so its output is safe in a public log.
"""
import os
import re
import sys

FRAGMENT_DIR = "changelog.d"
HOLDS_FILE = os.path.join("scripts", "changelog-holds.txt")
MARKER = re.compile(r"^<!--\s*HELD:\s*(\S.*?)\s*-->\s*$")
MIN_REASON = 12


def fragments(root):
    d = os.path.join(root, FRAGMENT_DIR)
    if not os.path.isdir(d):
        return []
    return sorted(f for f in os.listdir(d) if f != ".gitkeep" and not f.startswith("."))


def listed_holds(root):
    """{name: reason} from the holds file. Absent file means no holds, which is the normal state."""
    p = os.path.join(root, HOLDS_FILE)
    out = {}
    if not os.path.isfile(p):
        return out
    with open(p, encoding="utf-8") as fh:
        for line in fh:
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            parts = line.split(None, 1)
            out[parts[0]] = (parts[1].strip() if len(parts) > 1 else "")
    return out


def marker_reason(root, name):
    """The FIRST line's HELD reason, or None. First line only, deliberately."""
    p = os.path.join(root, FRAGMENT_DIR, name)
    try:
        with open(p, encoding="utf-8") as fh:
            first = fh.readline()
    except OSError:
        return None
    m = MARKER.match(first.rstrip("\n"))
    return m.group(1) if m else None


def verdict(present, holds, markers):
    """(ok, problems). Pure, so the decision is testable without a repository at all."""
    problems = []
    for name in present:
        listed = name in holds
        reason = markers.get(name)
        if listed and reason:
            if len(reason) < MIN_REASON:
                problems.append(
                    "%s: HELD reason is too short to be a reason (%d chars, need %d)"
                    % (name, len(reason), MIN_REASON))
            continue
        if listed and not reason:
            problems.append(
                "%s: listed in %s but carries no first-line `<!-- HELD: ... -->` marker"
                % (name, HOLDS_FILE))
        elif reason and not listed:
            problems.append(
                "%s: marked HELD but not listed in %s" % (name, HOLDS_FILE))
        else:
            problems.append(
                "%s: UNCONSUMED. It describes a change that is about to ship undescribed. "
                "Run scripts/changelog-assemble.py, or hold it deliberately (both halves)."
                % name)
    for name in sorted(holds):
        if name not in present:
            problems.append(
                "%s: listed in %s but no such fragment exists (stale hold)" % (name, HOLDS_FILE))
    return (not problems), problems


def main(argv):
    root = argv[1] if len(argv) > 1 else "."
    present = fragments(root)
    holds = listed_holds(root)
    markers = {n: marker_reason(root, n) for n in present}
    ok, problems = verdict(present, holds, markers)

    print("changelog-fragments-consumed: %d fragment(s) in %s/, %d declared hold(s)"
          % (len(present), FRAGMENT_DIR, len(holds)))
    for name in present:
        state = "HELD" if (name in holds and markers.get(name)) else "unconsumed"
        print("  %-46s %s" % (name, state))
    if ok:
        print("changelog-fragments-consumed: OK")
        return 0
    for p in problems:
        print("::error::changelog-fragments-consumed: " + p)
    print("changelog-fragments-consumed: REFUSED (%d problem(s))" % len(problems))
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
