#!/usr/bin/env python3
"""
Drives scripts/changelog-assemble.py against synthetic fixtures (cf#539). Ported from
vivijure-control-plane's tests/changelog-assemble.test.py (cp#358).

THE FIXTURE IS THE POINT, same discipline as tests/changelog-entry-required.test.py. This asserts
the assembler's output BYTE-FOR-BYTE against a written expectation, including the migration case
where a fragment and a hand-edited `## Unreleased` body are BOTH populated at once (the guard in
scripts/changelog-entry-required.py accepts either form, so a release can genuinely see both).

cf#542's requirement -- the assembled section must target the VERSION BEING TAGGED, never "the
topmost heading" -- is what the version-already-present refusal and the explicit <version> argument
below exist to prove: assemble() takes version as data, never infers it from CHANGELOG.md's
existing structure.
"""
import pathlib
import subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))
import importlib.util

repo_root = pathlib.Path(__file__).resolve().parents[1]


def load(name):
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


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=True)


print("changelog-assemble:")

# -------------------------------------------------------------------------------------------
# (d) PROOF: pure assemble() output, byte-for-byte, against a written expectation.
# -------------------------------------------------------------------------------------------

BASE = (
    "# Changelog\n\n"
    "All notable changes.\n\n"
    "## Unreleased\n\n"
    "## v1.0.0 -- 2026-01-01\n\n"
    "### old release\n"
)

# Fragment-only case: no legacy Unreleased body, two fragments.
ok, out = ca.assemble(
    BASE,
    ["100-a.md", "200-b.md"],
    ["### feat(x): a (cf#100)\n\nbody a.", "### fix(y): b (cf#200)\n\nbody b."],
    "v1.1.0",
    "2026-08-14",
)
expected_fragment_only = (
    "# Changelog\n\n"
    "All notable changes.\n\n"
    "## Unreleased\n\n"
    "## v1.1.0 -- 2026-08-14\n\n"
    "### feat(x): a (cf#100)\n\nbody a.\n\n### fix(y): b (cf#200)\n\nbody b.\n\n"
    "## v1.0.0 -- 2026-01-01\n\n"
    "### old release\n"
)
check("(d) PROOF: fragment-only assembly is byte-correct against a written fixture",
      ok and out == expected_fragment_only)

# Legacy-only case (pure migration-window PR, no fragments at all): output must equal today's
# hand-promotion behaviour -- the legacy body carried through unchanged.
legacy_only_base = (
    "# Changelog\n\n"
    "## Unreleased\n\n"
    "### direct edit, no fragment\n\nprose.\n\n"
    "## v1.0.0 -- 2026-01-01\n\n### old\n"
)
ok, out = ca.assemble(legacy_only_base, [], [], "v1.1.0", "2026-08-14")
expected_legacy_only = (
    "# Changelog\n\n"
    "## Unreleased\n\n"
    "## v1.1.0 -- 2026-08-14\n\n"
    "### direct edit, no fragment\n\nprose.\n\n"
    "## v1.0.0 -- 2026-01-01\n\n### old\n"
)
check("(d) PROOF: legacy-Unreleased-only assembly is byte-correct (no fragments touched at all)",
      ok and out == expected_legacy_only)

# (d) THE MIGRATION CASE: BOTH sources populated in the same release -- a fragment PR and a
# direct-edit PR both merged before this release cut. Legacy body first (predates fragments),
# fragments after in filename-sorted order.
ok, out = ca.assemble(
    legacy_only_base,
    ["050-earlier-issue.md"],
    ["### feat(z): fragment entry (cf#50)\n\nfragment prose."],
    "v1.1.0",
    "2026-08-14",
)
expected_both = (
    "# Changelog\n\n"
    "## Unreleased\n\n"
    "## v1.1.0 -- 2026-08-14\n\n"
    "### direct edit, no fragment\n\nprose.\n\n"
    "### feat(z): fragment entry (cf#50)\n\nfragment prose.\n\n"
    "## v1.0.0 -- 2026-01-01\n\n### old\n"
)
check("(d) PROOF: BOTH-SOURCES-POPULATED migration case is byte-correct "
      "(legacy body first, fragment after)",
      ok and out == expected_both)

# Empty release: no fragments, no legacy body. Still produces a valid, minimal heading.
empty_base = "# Changelog\n\n## Unreleased\n\n## v1.0.0 -- 2026-01-01\n\n### old\n"
ok, out = ca.assemble(empty_base, [], [], "v1.1.0", "2026-08-14")
check("(d) PROOF: an empty release (nothing to assemble) still succeeds and writes a bare heading",
      ok and "## v1.1.0 -- 2026-08-14" in out and "## v1.0.0 -- 2026-01-01" in out)

# -------------------------------------------------------------------------------------------
# cf#542: the assembled section targets the VERSION BEING TAGGED, an explicit argument -- never
# "the topmost heading". Prove it by assembling a version that is NOT adjacent to the existing
# top heading and confirming it lands exactly where the argument says, not where the file's
# current top heading is.
# -------------------------------------------------------------------------------------------
non_adjacent_base = "# Changelog\n\n## Unreleased\n\n## v1.26.0 -- 2026-08-14\n\n### existing top\n"
ok, out = ca.assemble(non_adjacent_base, ["1-a.md"], ["### feat: new (cf#1)"], "v9.9.9", "2099-01-01")
check("cf#542 PROOF: the new section heading is the EXPLICIT version argument, not derived from "
      "the file's current topmost heading",
      ok and out.split("## Unreleased\n\n", 1)[1].startswith("## v9.9.9 -- 2099-01-01"))
check("cf#542 PROOF: the pre-existing topmost heading (v1.26.0) is untouched, not overwritten "
      "or relabelled",
      ok and "## v1.26.0 -- 2026-08-14\n\n### existing top" in out)

# -------------------------------------------------------------------------------------------
# IDEMPOTENT-SAFE: refuses rather than duplicating a heading that already exists.
# -------------------------------------------------------------------------------------------
already_released = "# Changelog\n\n## Unreleased\n\n## v1.1.0 -- 2026-08-01\n\n### already there\n"
ok, msg = ca.assemble(already_released, ["100-a.md"], ["### new"], "v1.1.0", "2026-08-14")
check("REFUSES when the version heading already exists (no tag needed to trigger this)",
      not ok and "already appears as a heading" in msg)

# Accepts a version passed WITHOUT the leading 'v', normalizing before the duplicate check and
# the write -- so the guard cannot be bypassed by spelling the version differently.
ok, msg = ca.assemble(already_released, [], [], "1.1.0", "2026-08-14")
check("REFUSES the un-prefixed spelling too ('1.1.0' normalizes to 'v1.1.0')",
      not ok and "v1.1.0" in msg)

# No '## Unreleased' heading at all: refuse rather than guess where to insert. This is the exact
# starting state cf#542 measured on main (0 occurrences of '## Unreleased' against 135 '## v'
# headings) -- the refusal is what forces the section to be added rather than silently proceeding
# without one.
no_unreleased = "# Changelog\n\n## v1.0.0 -- 2026-01-01\n\n### old\n"
ok, msg = ca.assemble(no_unreleased, [], [], "v1.1.0", "2026-08-14")
check("REFUSES when CHANGELOG.md has no '## Unreleased' heading to promote from (cf#542 starting state)",
      not ok and "Unreleased" in msg)

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
        [sys.executable, str(repo_root / "scripts" / "changelog-assemble.py"), "v1.1.0", "2026-08-14"],
        cwd=root, capture_output=True, text=True,
    )
    check("main(): exits 0 on a real fixture directory", proc.returncode == 0)

    remaining = sorted(p.name for p in d.iterdir())
    check("main(): consumed fragments are DELETED from changelog.d/, .gitkeep survives",
          remaining == [".gitkeep"])

    written = (root / "CHANGELOG.md").read_text()
    check("main(): fragments were read in FILENAME-sorted order (050 before 200), not directory order",
          written.index("earlier body") < written.index("later body"))

    # A second run for the SAME version, against the file main() already wrote, must refuse and
    # must not touch the tree (there is nothing left to delete anyway, but assert no traceback).
    proc2 = subprocess.run(
        [sys.executable, str(repo_root / "scripts" / "changelog-assemble.py"), "v1.1.0", "2026-08-14"],
        cwd=root, capture_output=True, text=True,
    )
    check("main(): a second run for the same version REFUSES (idempotent-safe end to end)",
          proc2.returncode == 1 and "already appears as a heading" in proc2.stderr)

print("")
print("  %d passed, %d failed" % (len(passes), len(failures)))
sys.exit(1 if failures else 0)
