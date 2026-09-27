"""Control for scripts/changelog-fragments-consumed.py. No network, no git.

A gate whose failing state has never been observed is decoration, and this whole sprint was a
catalogue of controls that could not act. So the first thing asserted here is that the gate CAN
refuse, against a planted unconsumed fragment, before anything asserts that it passes.

The self-disarm case is the one that matters most. cp#245's regression was a waiver living in the
content, so a section merely DOCUMENTING the mechanism disarmed itself. This gate pins its marker
to the FIRST line for that reason, and there is a case below proving a fragment that discusses
`<!-- HELD: ... -->` in its prose is still refused.

    python3 tests/changelog-fragments-consumed.test.py
"""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRIPT = os.path.join(ROOT, "scripts", "changelog-fragments-consumed.py")

passes = []
failures = []


def check(name, cond):
    (passes if cond else failures).append(name)
    print(("[PASS] " if cond else "[FAIL] ") + name)


def build(tmp, fragments=None, holds=None):
    """A minimal tree: changelog.d/ plus an optional holds file."""
    os.makedirs(os.path.join(tmp, "changelog.d"), exist_ok=True)
    os.makedirs(os.path.join(tmp, "scripts"), exist_ok=True)
    open(os.path.join(tmp, "changelog.d", ".gitkeep"), "w").close()
    for name, body in (fragments or {}).items():
        with open(os.path.join(tmp, "changelog.d", name), "w", encoding="utf-8") as fh:
            fh.write(body)
    if holds is not None:
        with open(os.path.join(tmp, "scripts", "changelog-holds.txt"), "w", encoding="utf-8") as fh:
            fh.write(holds)


def run(tmp):
    p = subprocess.run([sys.executable, SCRIPT, tmp], capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def case(label, fragments, holds, expect_ok):
    tmp = tempfile.mkdtemp(prefix="frag-gate-")
    try:
        build(tmp, fragments, holds)
        code, out = run(tmp)
        got_ok = (code == 0)
        check("%s -> %s" % (label, "accepted" if expect_ok else "REFUSED"), got_ok == expect_ok)
        return out
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


REASON = "belongs to v1.34.1, folded in as a post-publication correction"
HELD_BODY = "<!-- HELD: %s -->\n### fix(x): something\n\nbody\n" % REASON
PLAIN_BODY = "### fix(x): something\n\nbody\n"

# 1. THE CONTROL FIRST: the gate must be able to refuse at all.
out = case("an unconsumed fragment", {"901-thing.md": PLAIN_BODY}, None, False)
check("the refusal names the fragment", "901-thing.md" in out)
check("the refusal says UNCONSUMED", "UNCONSUMED" in out)

# 2. The ordinary clean state.
case("an empty changelog.d", {}, None, True)

# 3. Both halves present -> a legitimate hold.
case("marked AND listed", {"804-x.md": HELD_BODY}, "804-x.md  %s\n" % REASON, True)

# 4. Each half alone must NOT waive. This is the cp#245 property.
case("marked but NOT listed", {"804-x.md": HELD_BODY}, "", False)
case("listed but NOT marked", {"804-x.md": PLAIN_BODY}, "804-x.md  %s\n" % REASON, False)

# 5. A reason has to be a reason.
case("marked with a stub reason", {"804-x.md": "<!-- HELD: wip -->\nbody\n"},
     "804-x.md  wip\n", False)

# 6. A hold for a fragment that no longer exists is stale bookkeeping, not a pass.
case("listed with no such fragment", {}, "804-gone.md  %s\n" % REASON, False)

# 7. THE SELF-DISARM CONTROL. A fragment that merely TALKS about the marker, with the marker text
#    anywhere but the first line, must still be refused -- otherwise documenting the mechanism
#    disables it, which is exactly the cp#245 defect this design is shaped against.
disarm = (
    "### docs(changelog): explain how holds work\n\n"
    "A fragment is held by putting `<!-- HELD: reason -->` on its first line.\n"
    "<!-- HELD: this line is NOT first and must not count -->\n"
)
out = case("a fragment quoting the marker below line 1", {"902-doc.md": disarm}, None, False)
check("the self-disarm attempt is reported as UNCONSUMED, not as a hold", "UNCONSUMED" in out)

# 8. Comments and blank lines in the holds file do not accidentally grant a hold.
case("holds file with only comments", {"804-x.md": HELD_BODY}, "# 804-x.md  nope\n\n", False)

print("\n%d passed, %d failed" % (len(passes), len(failures)))
for f in failures:
    print("  " + f)
sys.exit(1 if failures else 0)
