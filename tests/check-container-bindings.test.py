#!/usr/bin/env python3
"""Control for scripts/check-container-bindings.py.

The failure that matters is an interpreter that cannot parse TOML exiting
non-zero and naming the version it found plus the 3.11 minimum. On an
interpreter that can parse, the same script must pass the real
wrangler.toml.example and fail a renamed container class and a removed
migration. A green result that has never been shown to fail is not evidence.

    python3 tests/check-container-bindings.test.py

When /usr/bin/python3 is older than 3.11 (Apple's 3.9 on this laptop), this
also drives the script with that interpreter. A runner that has no such
interpreter does not claim that direction; say so in the output.
"""

import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRIPT = os.path.join(ROOT, "scripts", "check-container-bindings.py")
REAL = os.path.join(ROOT, "wrangler.toml.example")

passes = []
failures = []


def check(name, cond):
    (passes if cond else failures).append(name)
    print(("[PASS] " if cond else "[FAIL] ") + name)


def run(py, path):
    proc = subprocess.run([py, SCRIPT, path], capture_output=True)
    out = proc.stdout.decode("utf-8", "replace") + proc.stderr.decode("utf-8", "replace")
    return proc.returncode, out


def version_of(py):
    proc = subprocess.run(
        [py, "-c", "import sys; sys.stdout.write('%d.%d.%d' % sys.version_info[:3])"],
        capture_output=True,
    )
    text = proc.stdout.decode("utf-8", "replace").strip()
    if proc.returncode != 0 or not text:
        return None
    try:
        return tuple(int(part) for part in text.split("."))
    except ValueError:
        return None


def assert_fatal(py, label):
    ver = version_of(py)
    code, out = run(py, REAL)
    rendered = "%d.%d.%d" % ver if ver else ""
    check("%s exits non-zero" % label, code != 0)
    check("%s names the version it found" % label, bool(rendered) and ("Found python %s" % rendered) in out)
    check("%s names the minimum" % label, "minimum python >= 3.11" in out)
    check("%s does not report the contract ok" % label, "CONTRACT OK" not in out)
    return out


def write_copy(text):
    tmp = tempfile.mkdtemp(prefix="container-bindings-")
    path = os.path.join(tmp, "wrangler.toml")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
    return tmp, path


CONTAINERS_ANCHOR = '[[containers]]\nclass_name = "FinishContainer"\n'
MIGRATION_ANCHOR = (
    '[[migrations]]\ntag = "v3-finish-container"\n'
    'new_sqlite_classes = ["FinishContainer"]\n'
)


def main():
    if not os.path.isfile(SCRIPT) or not os.path.isfile(REAL):
        print("::error::missing script or wrangler.toml.example")
        return 1

    this = sys.version_info[:3]
    if this < (3, 11):
        print("this interpreter is %d.%d.%d; asserting the fatal path only" % this)
        assert_fatal(sys.executable, "this interpreter")
    else:
        real = open(REAL, encoding="utf-8").read()
        code, out = run(sys.executable, REAL)
        check("real file passes", code == 0 and "CONTRACT OK" in out and out.count("CONTRACT OK") == 2)

        if real.count(CONTAINERS_ANCHOR) != 1:
            check("renamed-class anchor is unique", False)
        else:
            check("renamed-class anchor is unique", True)
            tmp, path = write_copy(real.replace(
                CONTAINERS_ANCHOR,
                '[[containers]]\nclass_name = "TypoContainer"\n',
                1,
            ))
            try:
                code, out = run(sys.executable, path)
                check("renamed class is refused", code != 0 and "no matching DO binding" in out)
                check("renamed class does not report ok", "CONTRACT OK" not in out)
            finally:
                shutil.rmtree(tmp, ignore_errors=True)

        if real.count(MIGRATION_ANCHOR) != 1:
            check("removed-migration anchor is unique", False)
        else:
            check("removed-migration anchor is unique", True)
            tmp, path = write_copy(real.replace(MIGRATION_ANCHOR, "", 1))
            try:
                code, out = run(sys.executable, path)
                check(
                    "removed migration is refused",
                    code != 0 and "not declared by a migration" in out,
                )
                check("removed migration does not report ok", "CONTRACT OK" not in out)
            finally:
                shutil.rmtree(tmp, ignore_errors=True)

        # Deleting the block must not read as "every class matched", which is
        # what a vacuous pass over zero containers would say.
        if real.count(CONTAINERS_ANCHOR) == 1:
            block = (
                '[[containers]]\nclass_name = "FinishContainer"\n'
                'image = "./containers/video-finish/Dockerfile"\n'
                'instance_type = "standard-4"\n'
                'max_instances = 20\n'
            )
            if real.count(block) != 1:
                check("empty-set anchor is unique", False)
            else:
                check("empty-set anchor is unique", True)
                tmp, path = write_copy(real.replace(block, "", 1))
                try:
                    code, out = run(sys.executable, path)
                    check(
                        "no containers block is refused",
                        code != 0 and "no [[containers]] block" in out,
                    )
                finally:
                    shutil.rmtree(tmp, ignore_errors=True)

    apple = "/usr/bin/python3"
    if os.path.isfile(apple) and os.access(apple, os.X_OK):
        old = version_of(apple)
        same = old == tuple(this)
        if old is not None and old < (3, 11) and not same:
            print("also driving %s (%d.%d.%d)" % (apple, old[0], old[1], old[2]))
            assert_fatal(apple, apple)
        elif old is not None and old < (3, 11) and same:
            print("%s is the interpreter already asserted above" % apple)
        else:
            shown = "%d.%d.%d" % old if old else "unreadable"
            print("no interpreter older than 3.11 at %s (it is %s); that direction is not claimed here" % (apple, shown))
    else:
        print("no /usr/bin/python3; an older interpreter was not available to drive")

    print("\n%d passed, %d failed" % (len(passes), len(failures)))
    for name in failures:
        print("  " + name)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
