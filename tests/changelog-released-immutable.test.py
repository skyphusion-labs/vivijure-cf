#!/usr/bin/env python3
"""
Drives scripts/changelog-released-immutable.py against synthetic fixtures (cf#551 piece 2). Ported
in mechanism from the CHANGELOG IMMUTABILITY block of tests/render-wrangler.test.sh in
vivijure-control-plane (cp#219, cp#245), rewritten as a standalone Python file matching the
changelog test idiom already used here (tests/changelog-entry-required.test.py,
tests/changelog-assemble.test.py) instead of living inside a shell suite named for something else.

INVOKED VIA SUBPROCESS, NOT IMPORTED. The script under test executes at MODULE LEVEL and calls
sys.exit() directly, the same shape as the original in vivijure-control-plane, ported unchanged (see
the docstring of that script for why), so importing it here would exit this test process on the
first import. Every check below runs the real script as a subprocess against a synthetic git
repository built in a tempdir, the same way ci.yml and .github/workflows/changelog.yml run it.

THE FIXTURE IS THE POINT, same discipline as the two files named above. build_repo() constructs a
repository with two released, tagged sections and an empty Unreleased heading, then each check makes
its own throwaway copy (a fresh .git plus a hand-edited CHANGELOG.md and corrections file) so a
mutation in one check cannot leak into another.

THE LAST SECTION is not a synthetic fixture: it runs the shipped guard against vivijure-cf as
actually checked out, and cross-checks the result against an independently written re-derivation of
the same "does a released section still match its tag" question, so this is not the script grading
its own homework. It is a self-consistency check, not a hardcoded violation count, so it stays valid
whether main currently has known drift (cf#551 piece 1, true as of this port) or has since been
cleaned up.
"""
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

repo_root = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = repo_root / "scripts" / "changelog-released-immutable.py"

failures = []
passes = []


def check(name, cond):
    (passes if cond else failures).append(name)
    print(("  ok   " if cond else "  FAIL ") + name)


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=True)


def run_guard(root):
    r = subprocess.run(
        [sys.executable, str(SCRIPT), str(root)], capture_output=True, text=True, check=False
    )
    return r.returncode, r.stdout + r.stderr


BASE_CHANGELOG = """# Changelog

## Unreleased

## v1.0.0 -- 2026-02-01

### feat: shipped in v1.0.0

## v0.9.0 -- 2026-01-01

### feat: shipped in v0.9.0
"""

CORRECTIONS = """# test fixture corrections file
v0.9.0  fixture: pre-declared correction slot for the positive control
"""


def build_repo(root):
    """A clean two-release repo, v1.0.0 and v0.9.0 both tagged at the same commit that already
    carries their final content, so both sections start byte-identical to their tag by
    construction. v0.9.0 is pre-listed in the corrections file so it can serve as the hatch;
    v1.0.0 is not, so it serves as every refusal control."""
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.email", "t@example.com")
    git(root, "config", "user.name", "t")
    (root / "CHANGELOG.md").write_text(BASE_CHANGELOG)
    (root / "scripts").mkdir(parents=True, exist_ok=True)
    (root / "scripts" / "changelog-corrections.txt").write_text(CORRECTIONS)
    git(root, "add", "-A")
    git(root, "commit", "-qm", "base")
    git(root, "tag", "v1.0.0")
    git(root, "tag", "v0.9.0")


def copy_repo(src, dst):
    shutil.copytree(src / ".git", dst / ".git")
    shutil.copy(src / "CHANGELOG.md", dst / "CHANGELOG.md")
    (dst / "scripts").mkdir(parents=True, exist_ok=True)
    shutil.copy(
        src / "scripts" / "changelog-corrections.txt",
        dst / "scripts" / "changelog-corrections.txt",
    )


def plant_entry(changelog_path, heading_prefix):
    lines = changelog_path.read_text().split("\n")
    i = next(n for n, l in enumerate(lines) if l.startswith(heading_prefix))
    lines.insert(i + 2, "### feat(planted): an entry that landed under a released heading\n")
    changelog_path.write_text("\n".join(lines))


def prepend_line(changelog_path, heading_prefix, new_line):
    lines = changelog_path.read_text().split("\n")
    i = next(n for n, l in enumerate(lines) if l.startswith(heading_prefix))
    lines.insert(i + 2, new_line)
    changelog_path.write_text("\n".join(lines))


print("changelog-released-immutable:")

with tempfile.TemporaryDirectory() as base_dir:
    base = pathlib.Path(base_dir)
    build_repo(base)

    # BASELINE: an untouched repo passes clean, and prints nothing (the contract stated in the
    # scripts own docstring: "exit 0 and print nothing when every released section is untouched").
    with tempfile.TemporaryDirectory() as d:
        clean = pathlib.Path(d)
        copy_repo(base, clean)
        rc, out = run_guard(clean)
        check("BASELINE: an untouched two-release repo passes clean", rc == 0)
        check("BASELINE: a clean pass prints nothing", out.strip() == "")

    # CONTROL: an entry planted under an UNDECLARED released heading (v1.0.0) is refused, by name.
    with tempfile.TemporaryDirectory() as d:
        tmp = pathlib.Path(d)
        copy_repo(base, tmp)
        plant_entry(tmp / "CHANGELOG.md", "## v1.0.0")
        rc, out = run_guard(tmp)
        check(
            "CONTROL: an entry planted under a released heading is refused, by name",
            rc != 0 and "the v1.0.0 section has CHANGED" in out,
        )

    # CONTROL (cp#245 regression, reproduced here rather than assumed absent): a section that only
    # MENTIONS the marker in prose (indented, backticked) must still be checked as drift.
    with tempfile.TemporaryDirectory() as d:
        tmp = pathlib.Path(d)
        copy_repo(base, tmp)
        prepend_line(
            tmp / "CHANGELOG.md", "## v1.0.0",
            "  `**CORRECTED AFTER PUBLICATION`. Declared, never inferred.\n",
        )
        plant_entry(tmp / "CHANGELOG.md", "## v1.0.0")
        rc, out = run_guard(tmp)
        check(
            "CONTROL: a section that MENTIONS the marker in prose is still checked (cp#245)",
            rc != 0 and "the v1.0.0 section has CHANGED" in out,
        )

    # CONTROL: a correctly-anchored declaration ALONE, with no allowlist row, still waives nothing.
    with tempfile.TemporaryDirectory() as d:
        tmp = pathlib.Path(d)
        copy_repo(base, tmp)
        prepend_line(
            tmp / "CHANGELOG.md", "## v1.0.0",
            "**CORRECTED AFTER PUBLICATION (planted).** A declaration with no allowlist row.\n",
        )
        rc, out = run_guard(tmp)
        check(
            "CONTROL: a declaration with no allowlist row does not waive on its own",
            rc != 0 and "does not list it" in out,
        )

    # POSITIVE CONTROL: the hatch OPENS. v0.9.0 is pre-listed in the corrections file; planting a
    # declared correction there must be PERMITTED, or a legitimate in-place correction becomes
    # impossible and the guard degenerates into refusing everything.
    with tempfile.TemporaryDirectory() as d:
        tmp = pathlib.Path(d)
        copy_repo(base, tmp)
        prepend_line(
            tmp / "CHANGELOG.md", "## v0.9.0",
            "**CORRECTED AFTER PUBLICATION.** Fixture correction, allowlisted and declared.\n",
        )
        rc, out = run_guard(tmp)
        check(
            "POSITIVE CONTROL: an allowlisted, declared correction is permitted (hatch opens)",
            rc == 0 and "v0.9.0 is an allowlisted post-publication correction" in out,
        )

    # CONTROL: the other half of the hatch. Allowlisted (v0.9.0) but the reader-facing marker is
    # ABSENT: refused, because the allowlist is for this script and the marker is for the reader.
    with tempfile.TemporaryDirectory() as d:
        tmp = pathlib.Path(d)
        copy_repo(base, tmp)
        plant_entry(tmp / "CHANGELOG.md", "## v0.9.0")
        rc, out = run_guard(tmp)
        check(
            "CONTROL: allowlisted but undeclared is refused (silent correction)",
            rc != 0 and "carries no line BEGINNING" in out,
        )

    # CONTROL: a missing corrections file is an EMPTY allowlist, not a free pass; fails closed.
    with tempfile.TemporaryDirectory() as d:
        tmp = pathlib.Path(d)
        copy_repo(base, tmp)
        (tmp / "scripts" / "changelog-corrections.txt").unlink()
        prepend_line(
            tmp / "CHANGELOG.md", "## v0.9.0",
            "**CORRECTED AFTER PUBLICATION.** Declared, but the allowlist file is gone.\n",
        )
        rc, out = run_guard(tmp)
        check(
            "CONTROL: a MISSING corrections file fails closed, not open",
            rc != 0 and "MISSING entirely" in out,
        )

    # CONTROL: a tagless checkout (shallow clone with no tags) is a REFUSAL, never a silent pass.
    with tempfile.TemporaryDirectory() as d:
        tmp = pathlib.Path(d)
        tmp.mkdir(exist_ok=True)
        git(tmp, "init", "-q", "-b", "main")
        git(tmp, "config", "user.email", "t@example.com")
        git(tmp, "config", "user.name", "t")
        shutil.copy(base / "CHANGELOG.md", tmp / "CHANGELOG.md")
        rc, out = run_guard(tmp)
        check(
            "CONTROL: a tagless checkout is refused, not reported as a pass",
            rc != 0 and "compared ZERO released sections" in out,
        )

    # CONTROL: a duplicated released heading is refused, not silently half-checked.
    with tempfile.TemporaryDirectory() as d:
        tmp = pathlib.Path(d)
        copy_repo(base, tmp)
        text = (tmp / "CHANGELOG.md").read_text()
        i = text.index("## v1.0.0")
        stray = "## v1.0.0 -- 2026-02-01\n\n### a stray section from a bad merge\n\n"
        (tmp / "CHANGELOG.md").write_text(text[:i] + stray + text[i:])
        rc, out = run_guard(tmp)
        check(
            "CONTROL: a duplicated released heading is refused, not half-checked",
            rc != 0 and "MORE THAN ONCE" in out,
        )

    # CONTROL: no `## Unreleased` heading at all is refused, the exact precondition of the incident
    # this guard exists for: a promotion that left nowhere for the next merge to land.
    with tempfile.TemporaryDirectory() as d:
        tmp = pathlib.Path(d)
        copy_repo(base, tmp)
        text = (tmp / "CHANGELOG.md").read_text().replace("## Unreleased\n\n", "")
        (tmp / "CHANGELOG.md").write_text(text)
        rc, out = run_guard(tmp)
        check(
            "CONTROL: no Unreleased heading at all is refused",
            rc != 0 and "no `## Unreleased` heading" in out,
        )

# -----------------------------------------------------------------------------------------------
# REAL DEFECT, THIS REPO OWN LIVE STATE (cf#551). Not a synthetic fixture: an independent
# re-derivation, written separately here rather than reusing anything from the script under test,
# run against vivijure-cf exactly as checked out. Requires a full checkout (fetch-depth 0 /
# fetch-tags true); with no tags fetched BOTH sides degrade to "nothing to compare" and still
# agree, so this check cannot false-fail on a shallow clone, only go uninformative on one.
# -----------------------------------------------------------------------------------------------


def independent_drift_scan(root):
    """Reimplemented separately from scripts/changelog-released-immutable.py on purpose (see
    header above). Returns the sorted list of released, tagged versions whose CHANGELOG.md section
    differs from the same section at their own tag."""
    heading_re = re.compile(r"^## (v\d+\.\d+\.\d+)\b")

    def section_map(text):
        lines = text.split("\n")
        starts = [(i, m.group(1)) for i, l in enumerate(lines) for m in [heading_re.match(l)] if m]
        out = {}
        for i, version in starts:
            end = len(lines)
            for j in range(i + 1, len(lines)):
                if lines[j].startswith("## "):
                    end = j
                    break
            out[version] = "\n".join(lines[i:end]).rstrip()
        return out

    text = (root / "CHANGELOG.md").read_text()
    head = section_map(text)
    tags = set(
        subprocess.run(
            ["git", "-C", str(root), "tag", "--list", "v*"],
            capture_output=True, text=True, check=True,
        ).stdout.split()
    )
    drifted = []
    for version, body in head.items():
        if version not in tags:
            continue
        shown = subprocess.run(
            ["git", "-C", str(root), "show", version + ":CHANGELOG.md"],
            capture_output=True, text=True, check=False,
        )
        if shown.returncode != 0:
            continue
        at_tag = section_map(shown.stdout).get(version)
        if at_tag is None:
            continue
        if at_tag != body:
            drifted.append(version)
    return sorted(drifted)


live_drift = independent_drift_scan(repo_root)
live_rc, live_out = run_guard(repo_root)
live_sha = subprocess.run(
    ["git", "-C", str(repo_root), "rev-parse", "HEAD"], capture_output=True, text=True, check=True
).stdout.strip()
print("")
print("live repo state at " + live_sha + ":")
print("  independently-derived drifted versions: " + (", ".join(live_drift) if live_drift else "(none)"))
check(
    "REAL DEFECT: the shipped guard agrees with an independent re-derivation on the live state "
    "of this repo",
    (live_rc != 0) == (bool(live_drift)),
)
if live_drift:
    check(
        "REAL DEFECT: every independently-found drifted version is named in the output of the "
        "guard itself",
        all(("the " + v + " section has CHANGED") in live_out for v in live_drift),
    )

print("")
print("  %d passed, %d failed" % (len(passes), len(failures)))
sys.exit(1 if failures else 0)
