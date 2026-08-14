#!/usr/bin/env python3
"""
Drives scripts/changelog-entry-required.py against a SYNTHETIC repository shaped exactly like the
false-pass class this guard exists to catch (ported from vivijure-control-plane's #242 fixture).

THE FIXTURE IS THE POINT. If it cannot reproduce the old bug, the fix is unproven, so this asserts
BOTH directions on the same repository: two-dot passes (the bug) and three-dot refuses (the fix).

cf#539: also proves the changelog.d/ fragment form is accepted exactly like a direct CHANGELOG.md
edit during the migration window, and that neither form being present is still refused.
"""
import os
import subprocess
import sys
import tempfile
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[0] / ".." / "scripts"))
import importlib.util

spec = importlib.util.spec_from_file_location(
    "cer", str(pathlib.Path(__file__).resolve().parents[1] / "scripts" / "changelog-entry-required.py")
)
cer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cer)

failures = []
passes = []


def check(name, cond):
    (passes if cond else failures).append(name)
    print(("  ok   " if cond else "  FAIL ") + name)


def git(root, *args):
    return subprocess.run(["git", "-C", root, *args], capture_output=True, text=True, check=True)


def build_repo(root):
    """main advances with SOMEBODY ELSE's PR touching CHANGELOG.md; our branch touches src/ only."""
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.email", "t@example.com")
    git(root, "config", "user.name", "t")
    (pathlib.Path(root) / "CHANGELOG.md").write_text("# Changelog\n\n## v1.0.0 -- 2026-01-01\n")
    os.makedirs(os.path.join(root, "src"), exist_ok=True)
    (pathlib.Path(root) / "src" / "a.ts").write_text("export const a = 1;\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "base")

    # OUR branch: touches src/ and NOTHING else.
    git(root, "checkout", "-qb", "pr")
    (pathlib.Path(root) / "src" / "a.ts").write_text("export const a = 2;\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "pr: src only, no changelog entry")
    head = git(root, "rev-parse", "HEAD").stdout.strip()

    # MAIN moves: somebody else PR lands and touches CHANGELOG.md.
    git(root, "checkout", "-q", "main")
    (pathlib.Path(root) / "CHANGELOG.md").write_text("# Changelog\n\n## v1.0.0 -- 2026-01-01\n\n### someone else\n")
    (pathlib.Path(root) / "src" / "b.ts").write_text("export const b = 1;\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "other PR: touches CHANGELOG.md")
    moved_base = git(root, "rev-parse", "HEAD").stdout.strip()
    return head, moved_base


print("changelog-entry-required:")
with tempfile.TemporaryDirectory() as root:
    head, moved_base = build_repo(root)

    # CONTROL: the fixture must REPRODUCE the false pass, or the fix below proves nothing.
    two_dot = cer.changed_files(root, moved_base, head, two_dot=True)
    ok_two, _ = cer.verdict(two_dot)
    check(
        "CONTROL: the fixture reproduces the bug (two-dot against a MOVED base passes vacuously)",
        ok_two and "CHANGELOG.md" in two_dot and "src/a.ts" in two_dot,
    )

    # THE FIX: three-dot sees only what this PR did, so the missing entry is caught.
    three_dot = cer.changed_files(root, moved_base, head)
    ok_three, msg = cer.verdict(three_dot)
    check(
        "three-dot REFUSES a src-only PR whose base merely happens to carry a changelog change",
        (not ok_three) and "CHANGELOG.md" not in three_dot and "src/a.ts" in three_dot,
    )
    check("and the refusal explains itself", "neither CHANGELOG.md nor a changelog.d/ fragment" in msg)

    # A PR that DOES carry its own entry still passes, so the fix is not simply "always refuse".
    git(root, "checkout", "-q", "pr")
    (pathlib.Path(root) / "CHANGELOG.md").write_text("# Changelog\n\n## v1.0.0 -- 2026-01-01\n\n### ours\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "pr: add our own entry")
    head2 = git(root, "rev-parse", "HEAD").stdout.strip()
    ok_own, _ = cer.verdict(cer.changed_files(root, moved_base, head2))
    check("a PR carrying its OWN entry still passes", ok_own)

# The pure decision, with no repository at all.
check("a docs-only PR needs no entry", cer.verdict(["docs/x.md", "tests/y.ts"])[0])
check("the no-changelog label is still a loud escape hatch",
      cer.verdict(["src/a.ts"], ["no-changelog"])[0])
check("CONTROL: without the label that same PR is refused",
      not cer.verdict(["src/a.ts"])[0])

# ---------------------------------------------------------------------------------------------
# cf#539: fragment-per-PR is a SECOND way to satisfy the same requirement, not a replacement.
# ---------------------------------------------------------------------------------------------

ok_neither, msg_neither = cer.verdict(["src/a.ts"])
check("(a) PROOF: src/ change with NEITHER CHANGELOG.md NOR a changelog.d/ fragment is refused",
      not ok_neither)
check("(a) and the refusal names both accepted forms",
      "changelog.d/" in msg_neither and "CHANGELOG.md" in msg_neither)

ok_fragment, _ = cer.verdict(["src/a.ts", "changelog.d/539-fragment-format.md"])
check("(b) PROOF: src/ change with a changelog.d/ fragment ONLY is accepted", ok_fragment)

ok_changelog_only, _ = cer.verdict(["src/a.ts", "CHANGELOG.md"])
check("(b) PROOF: src/ change with a CHANGELOG.md edit ONLY is still accepted (migration window)",
      ok_changelog_only)

ok_gitkeep, _ = cer.verdict(["src/a.ts", "changelog.d/.gitkeep"])
check("CONTROL: touching changelog.d/.gitkeep alone does NOT satisfy the guard",
      not ok_gitkeep)

# ---------------------------------------------------------------------------------------------
# cf-specific scope: modules/ is shipped code here (control-plane has no such directory), and
# modules/<name>/README.md and wrangler.toml are deliberately EXCLUDED -- docs/config, not
# behaviour. Both directions asserted so the scope is neither too wide nor too narrow.
# ---------------------------------------------------------------------------------------------
check("modules/<name>/src/*.ts is in scope (module worker source)",
      not cer.verdict(["modules/keyframe/src/index.ts"])[0])
check("modules/_shared/*.ts is in scope (shared module code, no nested src/)",
      not cer.verdict(["modules/_shared/runpod-route.ts"])[0])
check("CONTROL: modules/<name>/README.md is NOT in scope (docs, not behaviour)",
      cer.verdict(["modules/keyframe/README.md"])[0])
check("CONTROL: modules/<name>/wrangler.toml is NOT in scope (config, not behaviour)",
      cer.verdict(["modules/keyframe/wrangler.toml"])[0])
check("public/ is in scope, same as control-plane",
      not cer.verdict(["public/planner.js"])[0])

print("")
print("  %d passed, %d failed" % (len(passes), len(failures)))
sys.exit(1 if failures else 0)
