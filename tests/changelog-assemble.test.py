#!/usr/bin/env python3
"""
Drives scripts/changelog-assemble.py against synthetic fixtures (cf#539).

THE FIXTURE IS THE POINT, same discipline as tests/changelog-entry-required.test.py. Asserts the
assembler's output BYTE-FOR-BYTE against a written expectation, including the migration case where
a fragment and a hand-edited direct CHANGELOG.md body are BOTH populated at once (the guard in
scripts/changelog-entry-required.py accepts either form, so a release can genuinely see both).

Ported from vivijure-control-plane's tests/changelog-assemble.test.py (cp#358), adapted for this
repo's shape: no separate "## Unreleased" heading to promote -- the top "## vX.Y.Z" heading IS the
in-progress section, so the assembler appends into it rather than renaming it, and the version
argument is a SAFETY ASSERTION (does the top heading match what the caller thinks they are
assembling into) rather than the name of a heading to create.
"""
import pathlib
import subprocess
import sys
import tempfile

repo_root = pathlib.Path(__file__).resolve().parents[1]


def load(name):
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        name.replace("-", "_"), str(repo_root / "scripts" / (name + ".py"))
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ca = load("changelog-assemble")

failures = []
passes = []


def check(name, cond):
    (passes if cond else failures).append(name)
    print(("  ok   " if cond else "  FAIL ") + name)


print("changelog-assemble:")

# -------------------------------------------------------------------------------------------
# PROOF: pure assemble() output, byte-for-byte, against a written expectation.
# -------------------------------------------------------------------------------------------

BASE = (
    "# Changelog\n\n"
    "Notable changes per release.\n\n"
    "## v1.26.0 -- 2026-08-14\n\n"
    "MINOR. Some intro prose for this release.\n\n"
    "## v1.25.0 -- 2026-08-07\n\n"
    "### old release\n"
)

# Fragment-only case: no direct-edit content beyond the release's own intro prose, two fragments.
ok, out = ca.assemble(
    BASE,
    ["100-a.md", "200-b.md"],
    ["### feat(x): a (cf#100)\n\nbody a.", "### fix(y): b (cf#200)\n\nbody b."],
    "v1.26.0",
)
expected_fragment_only = (
    "# Changelog\n\n"
    "Notable changes per release.\n\n"
    "## v1.26.0 -- 2026-08-14\n\n"
    "MINOR. Some intro prose for this release.\n\n"
    "### feat(x): a (cf#100)\n\nbody a.\n\n### fix(y): b (cf#200)\n\nbody b.\n\n"
    "## v1.25.0 -- 2026-08-07\n\n"
    "### old release\n"
)
check("PROOF: fragment-only assembly is byte-correct against a written fixture, appended at the "
      "END of the top section",
      ok and out == expected_fragment_only)

# No-fragments case: assembling with an empty changelog.d/ is a no-op on content (this is what a
# second run, or a release with zero fragment PRs, looks like).
ok, out = ca.assemble(BASE, [], [], "v1.26.0")
check("PROOF: no fragments -> output is byte-identical to the input (true no-op)",
      ok and out == BASE)

# THE MIGRATION CASE: a direct-edit PR already appended its own "### ..." entry to the top
# section, AND a fragment PR merged too -- both sources populated in the same release. Direct-edit
# content stays where it was (it predates fragments), fragment appended after.
base_with_direct_edit = (
    "# Changelog\n\n"
    "## v1.26.0 -- 2026-08-14\n\n"
    "MINOR. Intro.\n\n"
    "### direct edit, no fragment\n\nprose.\n\n"
    "## v1.25.0 -- 2026-08-07\n\n### old\n"
)
ok, out = ca.assemble(
    base_with_direct_edit,
    ["050-earlier-issue.md"],
    ["### feat(z): fragment entry (cf#50)\n\nfragment prose."],
    "v1.26.0",
)
expected_both = (
    "# Changelog\n\n"
    "## v1.26.0 -- 2026-08-14\n\n"
    "MINOR. Intro.\n\n"
    "### direct edit, no fragment\n\nprose.\n\n"
    "### feat(z): fragment entry (cf#50)\n\nfragment prose.\n\n"
    "## v1.25.0 -- 2026-08-07\n\n### old\n"
)
check("PROOF: BOTH-SOURCES-POPULATED migration case is byte-correct (direct-edit content first, "
      "fragment appended after)",
      ok and out == expected_both)

# -------------------------------------------------------------------------------------------
# SAFETY: refuses rather than guessing when the version does not match the top heading.
# -------------------------------------------------------------------------------------------
ok, msg = ca.assemble(BASE, ["100-a.md"], ["### new"], "v1.27.0")
check("REFUSES when the requested version does not match the top heading (wrong branch / stale "
      "checkout / release-prep not merged yet)",
      not ok and "top CHANGELOG.md heading is 'v1.26.0'" in msg and "v1.27.0" in msg)

# Un-prefixed spelling normalizes before the comparison, so the guard cannot be dodged by
# spelling the version differently.
ok, out = ca.assemble(BASE, [], [], "1.26.0")
check("ACCEPTS the un-prefixed spelling too ('1.26.0' normalizes to 'v1.26.0')", ok)

# No '## v...' heading at all: refuse rather than guess where to insert.
no_heading = "# Changelog\n\nNothing here yet.\n"
ok, msg = ca.assemble(no_heading, [], [], "v1.26.0")
check("REFUSES when CHANGELOG.md has no '## vX.Y.Z' heading at all",
      not ok and "no '## vX.Y.Z' heading" in msg)

# -------------------------------------------------------------------------------------------
# Filesystem-level: fragments are read sorted by filename and DELETED on success; a failed
# (refused) run touches nothing on disk.
# -------------------------------------------------------------------------------------------
with tempfile.TemporaryDirectory() as root:
    root = pathlib.Path(root)
    (root / "CHANGELOG.md").write_text(BASE)
    d = root / "changelog.d"
    d.mkdir()
    (d / ".gitkeep").write_text("")
    (d / "200-later.md").write_text("### later\n\nlater body.")
    (d / "050-earlier.md").write_text("### earlier\n\nearlier body.")

    proc = subprocess.run(
        [sys.executable, str(repo_root / "scripts" / "changelog-assemble.py"), "v1.26.0"],
        cwd=root, capture_output=True, text=True,
    )
    check("main(): exits 0 on a real fixture directory", proc.returncode == 0)

    remaining = sorted(p.name for p in d.iterdir())
    check("main(): consumed fragments are DELETED from changelog.d/, .gitkeep survives",
          remaining == [".gitkeep"])

    written = (root / "CHANGELOG.md").read_text()
    check("main(): fragments were read in FILENAME-sorted order (050 before 200), not directory order",
          written.index("earlier body") < written.index("later body"))

    # A second run against the file main() already wrote is a genuine no-op: no fragments left,
    # same version, same top heading -- exits 0 and changes nothing.
    before = (root / "CHANGELOG.md").read_text()
    proc2 = subprocess.run(
        [sys.executable, str(repo_root / "scripts" / "changelog-assemble.py"), "v1.26.0"],
        cwd=root, capture_output=True, text=True,
    )
    after = (root / "CHANGELOG.md").read_text()
    check("main(): a second run is idempotent-safe by construction (nothing left to consume, "
          "exits 0, file unchanged)",
          proc2.returncode == 0 and before == after)

    # And a WRONG version on that same second run refuses, proving the safety check runs even
    # when there is nothing to assemble.
    proc3 = subprocess.run(
        [sys.executable, str(repo_root / "scripts" / "changelog-assemble.py"), "v9.9.9"],
        cwd=root, capture_output=True, text=True,
    )
    check("main(): a wrong version still refuses even with zero fragments pending",
          proc3.returncode == 1 and "top CHANGELOG.md heading is 'v1.26.0'" in proc3.stderr)

print("")
print("  %d passed, %d failed" % (len(passes), len(failures)))
sys.exit(1 if failures else 0)
