#!/usr/bin/env python3
"""Every local module an image's entry script imports must actually be COPIED into the image (cf#857).

WHY, AND IT IS NOT HYPOTHETICAL. cf#851: `containers/video-finish/app.py` imports `concat_guard` at
column 0, `concat_guard.py` sits right next to it in the repo, and the Dockerfile's COPY line does not
name it. So `python app.py` dies at import inside the image, the port is never bound, and Cloudflare
reports "Container crashed while checking for ports". It shipped through a fully green tag run,
because `container-tests` runs those scripts from the REPO CHECKOUT (where the file is present) and
`container-deploy-shape` proves an image was BUILT, never that it RUNS.

`tests/container-smoke.test.sh` + the `container-smoke` job are the end-to-end answer: they start the
image. This file is the FAST, DOCKER-FREE half, and it earns its place on three counts:
  1. It runs on every PR with no daemon, no pull and no build, so it cannot be skipped by the plane
     the docker gate depends on being available.
  2. It NAMES THE MISSING FILE. A smoke failure says "it died at startup"; this says "app.py imports
     concat_guard and the Dockerfile never copies it", which is the difference between a red gate and
     a red gate you can act on.
  3. It is the cheapest satisfaction that is also CORRECT. A guard whose easiest escape is deleting
     the check is worthless; here the easiest escape is adding the file to the COPY line, which is
     the fix.

SCOPE, stated rather than discovered later. Reachability starts at the entry script named by CMD or
ENTRYPOINT and follows only LOCAL sibling modules (a name that resolves to `<dir>/<name>.py`).
Third-party packages are requirements.txt's problem and pip's, not this file's. Test scripts never
enter the graph unless the entry script imports them, which is why `test_local_concat_guard.py`
importing `concat_guard` does not make this pass vacuously.

IMPORTS AT ANY SCOPE COUNT, not only module level. A function-scope import of a sibling the image
lacks is a landmine that fires on the first request down that path instead of at boot, which is
strictly worse to debug, and there is no case where shipping the module is wrong.

Run: python3 tests/container-image-file-set.test.py
"""
import ast
import json
import os
import re
import shlex
import sys
import tempfile

ROOT = os.path.dirname(os.path.abspath(os.path.join(__file__, "..")))
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

failures = []
notes = []


def join_continuations(text):
    """Fold `\\`-continued Dockerfile lines into single logical lines."""
    return re.sub(r"\\\s*\n\s*", " ", text)


def copied_sources(dockerfile_text):
    """Source operands of every COPY/ADD in the file, plus a flag for a whole-context copy.

    A `COPY . .` copies every sibling, so the check passes for a real reason rather than being
    skipped. The distinction matters: a skip would read like a pass.
    """
    sources = set()
    whole_context = False
    for line in join_continuations(dockerfile_text).splitlines():
        s = line.strip()
        if not re.match(r"(?i)^(copy|add)\s", s):
            continue
        try:
            parts = shlex.split(s)
        except ValueError:
            parts = s.split()
        parts = [p for p in parts[1:] if not p.startswith("--")]
        if len(parts) < 2:
            continue
        for src in parts[:-1]:  # last operand is the destination
            if src in (".", "./", "*"):
                whole_context = True
            sources.add(os.path.normpath(src))
    return sources, whole_context


def entry_script(dockerfile_text):
    """The .py file CMD/ENTRYPOINT actually runs, or None."""
    found = None
    for line in join_continuations(dockerfile_text).splitlines():
        s = line.strip()
        m = re.match(r"(?i)^(cmd|entrypoint)\s+(.*)$", s)
        if not m:
            continue
        rest = m.group(2).strip()
        args = []
        if rest.startswith("["):
            try:
                args = [str(a) for a in json.loads(rest)]
            except ValueError:
                args = []
        if not args:
            try:
                args = shlex.split(rest)
            except ValueError:
                args = rest.split()
        for a in args:
            if a.endswith(".py"):
                found = os.path.normpath(a)
    return found


def local_imports(path):
    """Imported names at ANY scope in one file (see the header on why scope does not matter)."""
    with open(path, encoding="utf-8") as fh:
        tree = ast.parse(fh.read(), filename=path)
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                names.add(a.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module:
                names.add(node.module.split(".")[0])
    return names


def reachable_local_modules(directory, entry):
    """Transitive closure of sibling .py modules reachable from the entry script."""
    seen = set()
    stack = [entry]
    edges = []
    while stack:
        cur = stack.pop()
        cur_path = os.path.join(directory, cur)
        if not os.path.isfile(cur_path):
            continue
        for name in sorted(local_imports(cur_path)):
            candidate = name + ".py"
            if not os.path.isfile(os.path.join(directory, candidate)):
                continue  # third-party or stdlib: not this file's business
            edges.append((cur, candidate))
            if candidate not in seen:
                seen.add(candidate)
                stack.append(candidate)
    return seen, edges


def audit(directory):
    """Returns (missing, checked_count, entry, whole_context). missing: [(importer, module)]."""
    dockerfile = os.path.join(directory, "Dockerfile")
    with open(dockerfile, encoding="utf-8") as fh:
        text = fh.read()
    entry = entry_script(text)
    if entry is None:
        return None, 0, None, False
    sources, whole_context = copied_sources(text)
    modules, edges = reachable_local_modules(directory, entry)
    if whole_context:
        return [], len(modules), entry, True
    missing = [(imp, mod) for imp, mod in edges if mod not in sources]
    # the entry script itself must be copied too, which is the same class of omission
    if entry not in sources:
        missing.append(("Dockerfile CMD", entry))
    return sorted(set(missing)), len(modules), entry, False


# --------------------------------------------------------------------------- the controls run FIRST
# Every refusal below is uninterpretable unless the instrument has been shown producing BOTH answers
# against subjects whose truth is known by construction.
def control():
    with tempfile.TemporaryDirectory() as tmp:
        good = os.path.join(tmp, "good")
        os.makedirs(good)
        with open(os.path.join(good, "helper.py"), "w") as fh:
            fh.write("X = 1\n")
        with open(os.path.join(good, "app.py"), "w") as fh:
            fh.write("import os\nfrom helper import X\n")
        with open(os.path.join(good, "Dockerfile"), "w") as fh:
            fh.write('FROM python:3.11-slim\nCOPY helper.py app.py .\nCMD ["python", "app.py"]\n')
        missing, n, entry, _ = audit(good)
        if missing != [] or n != 1 or entry != "app.py":
            failures.append("CONTROL (negative) FAILED: a correctly-copied image reported %r (n=%s entry=%s); the check cries wolf" % (missing, n, entry))
        else:
            print("  ok    control: a fully-copied image reports nothing missing (1 local module seen)")

        bad = os.path.join(tmp, "bad")
        os.makedirs(bad)
        with open(os.path.join(bad, "helper.py"), "w") as fh:
            fh.write("X = 1\n")
        with open(os.path.join(bad, "app.py"), "w") as fh:
            fh.write("import os\nfrom helper import X\n")
        with open(os.path.join(bad, "Dockerfile"), "w") as fh:
            fh.write('FROM python:3.11-slim\nCOPY app.py .\nCMD ["python", "app.py"]\n')
        missing, _, _, _ = audit(bad)
        if missing != [("app.py", "helper.py")]:
            failures.append("CONTROL (positive) FAILED: the PLANTED missing module was not reported; got %r. A clean result on the real repo would mean nothing." % (missing,))
        else:
            print("  ok    control: the PLANTED missing module is reported as app.py -> helper.py")

        deep = os.path.join(tmp, "deep")
        os.makedirs(deep)
        with open(os.path.join(deep, "app.py"), "w") as fh:
            fh.write("import mid\n")
        with open(os.path.join(deep, "mid.py"), "w") as fh:
            fh.write("def f():\n    import leaf\n    return leaf\n")
        with open(os.path.join(deep, "leaf.py"), "w") as fh:
            fh.write("Y = 2\n")
        with open(os.path.join(deep, "Dockerfile"), "w") as fh:
            fh.write('FROM python:3.11-slim\nCOPY app.py mid.py .\nCMD ["python", "app.py"]\n')
        missing, _, _, _ = audit(deep)
        if missing != [("mid.py", "leaf.py")]:
            failures.append("CONTROL (transitive) FAILED: a function-scope import two hops from the entry was not reported; got %r" % (missing,))
        else:
            print("  ok    control: a function-scope import two hops deep is still reported (mid.py -> leaf.py)")


print("controls:")
control()

# --------------------------------------------------------------------------- the real subject
# DENOMINATOR: every containers/*/Dockerfile on disk, not a hand-kept list. A list is the artifact
# whose drift causes this class of bug in the first place.
dirs = sorted(
    os.path.join(REPO, "containers", d)
    for d in os.listdir(os.path.join(REPO, "containers"))
    if os.path.isfile(os.path.join(REPO, "containers", d, "Dockerfile"))
)
print("\nauditing %d container image(s):" % len(dirs))
if len(dirs) < 2:
    failures.append("only %d containers/*/Dockerfile found: a wrong cwd or a moved tree must fail loudly rather than pass over an empty set" % len(dirs))

total_modules = 0
for d in dirs:
    rel = os.path.relpath(d, REPO)
    missing, n, entry, whole = audit(d)
    total_modules += n
    if missing is None:
        failures.append("%s: could not determine an entry .py from CMD/ENTRYPOINT, so nothing can be claimed about this image" % rel)
        print("  FAIL  %-34s no entry script found in CMD/ENTRYPOINT" % rel)
        continue
    how = "whole build context copied" if whole else "%d local module(s) reachable from %s" % (n, entry)
    if missing:
        for imp, mod in missing:
            failures.append(
                "%s: %s imports %s but the Dockerfile never COPYs it, so `python %s` dies at import "
                "inside the image and the port is never bound" % (rel, imp, mod[:-3], entry)
            )
        print("  FAIL  %-34s %s; MISSING: %s" % (rel, how, ", ".join(m for _, m in missing)))
    else:
        print("  ok    %-34s %s" % (rel, how))

# A run that resolved zero local modules anywhere proved nothing about anything.
if total_modules == 0:
    failures.append("zero local modules resolved across every image: the import graph is empty, so a green result here is vacuous")

print("")
if failures:
    for f in failures:
        print("::error::container image file set: %s" % f)
    print("FAILED: %d finding(s)" % len(failures))
    sys.exit(1)
print("OK: every local module reachable from each image's entry script is copied into that image (%d module edges resolved)" % total_modules)
