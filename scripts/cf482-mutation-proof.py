#!/usr/bin/env python3
"""cf#482 mutation proof -- sibling of scripts/cf480-mutation-proof.py, same discipline.

Reintroduce each defect this change fixes and prove a test goes RED FOR ITS NAMED REASON. Asserts
the mutation applied (a str.replace matching nothing is silent, and a mutation that never landed
gives a GREEN run reading exactly like a working guard), checks for the NAMED victim rather than
for red, and prints a denominator so an empty loop cannot report a clean sweep.

Restores with `git checkout --`, which is safe ONLY on a clean committed tree -- asserted below."""
import subprocess, sys, os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILL = "scripts/fill-module-placeholders.sh"
AWK = "scripts/strip-vpc-block.awk"
SUITE = "tests/deploy-placeholders-cf482.test.ts"

MUTATIONS = [
    dict(
        id="A1-survivor-comment-blind",
        why="the survivor check stops ignoring comments -- the original defect",
        f=FILL,
        old="""survivors="$(grep -vE '^[[:space:]]*#' "$toml" | grep -oE 'REPLACE_WITH_[A-Z0-9_]+' | sort -u || true)\"""",
        new="""survivors="$(grep -oE 'REPLACE_WITH_[A-Z0-9_]+' "$toml" | sort -u || true)\"""",
        victims=["a COMMENTED placeholder does not fail the deploy"],
    ),
    dict(
        id="A2-required-blanks-instead-of-refusing",
        why="an unset REQUIRED id substitutes empty, deleting the evidence the survivor check reads",
        f=FILL,
        old="""  if [ -z "$val" ]; then
    echo "::error::${toml} needs ${v} and it is unset -- ${placeholder} is a REQUIRED binding (this module has no path without it), refusing" >&2
    exit 1
  fi
  sed -i "s/${placeholder}/${val}/g" "$toml\"""",
        new="""  sed -i "s/${placeholder}/${val}/g" "$toml\"""",
        victims=["an unset REQUIRED VPC id still fails the deploy"],
    ),
    dict(
        id="A3-strip-keyed-on-block-type",
        why="the stripper drops only [[vpc_services]], leaving the bearer's Secrets Store block",
        f=AWK,
        old="  if (!first && marked) {",
        new="  if (!first && marked && lines[1] ~ /^\\[\\[vpc_services\\]\\]/) {",
        victims=["UNSET strips BOTH of its blocks and deploys"],
    ),
    dict(
        id="A4-no-op-strip-reads-as-success",
        why="the stripper exits 0 having dropped nothing, so a renamed marker deploys silently",
        f=AWK,
        old="  if (dropped == 0) exit 3;",
        new="  if (dropped == 0) exit 0;",
        victims=["REFUSES when the marker is present but no block carries it"],
    ),
    dict(
        id="A7-marker-matched-anywhere-in-block",
        why="cf#484: the marker arms on a PROSE mention, so a sentence above the block deletes the block before it",
        f=AWK,
        old="  if ($0 ~ marker_line) marked = 1;",
        new="  if (index($0, MARKER) > 0) marked = 1;",
        victims=[
            "loses EXACTLY its door bindings and nothing else",
            "PROSE mentioning a marker does not arm the strip",
        ],
    ),
    dict(
        id="A5-preamble-guard-removed",
        why="a marker in a header comment deletes the file's name/main/compatibility_date",
        f=AWK,
        old="  if (!first && marked) {",
        new="  if (marked) {",
        victims=["never drops the PREAMBLE"],
    ),
    dict(
        id="A6-diagnostic-blames-store_id",
        why="the error names the wrong subsystem, sending an operator to the Secrets Store",
        f=FILL,
        old="""  echo "::error::unfilled placeholder(s) in ${toml}: $(echo "$survivors" | tr '\\n' ' ')" >&2""",
        new="""  echo "::error::store_id placeholder survived in ${toml}" >&2""",
        victims=["names WHAT survived and WHERE"],
    ),
]


def sh(cmd):
    return subprocess.run(cmd, cwd=REPO, shell=True, capture_output=True, text=True)


def clean():
    return sh("git status --porcelain").stdout.strip() == ""


if not clean():
    sys.exit("REFUSING: tree is not clean; this restores with `git checkout --`. Commit first.")

base = sh("npx vitest run " + SUITE)
if base.returncode != 0:
    sys.exit("REFUSING: baseline already red\n" + base.stdout[-2000:])
print("BASELINE GREEN\n")

passed, report = 0, []
for m in MUTATIONS:
    path = os.path.join(REPO, m["f"])
    src = open(path).read()
    n = src.count(m["old"])
    if n != 1:
        sys.exit("MUTATION %s: anchor matched %d times, expected 1" % (m["id"], n))
    open(path, "w").write(src.replace(m["old"], m["new"]))
    try:
        r = sh("npx vitest run " + SUITE)
        out = r.stdout + r.stderr
        red = r.returncode != 0
        named = [v for v in m["victims"] if v in out]
        if red and named:
            passed += 1
        report.append((m["id"], m["why"], red, named))
        print("%-38s red=%-5s named=%d/%d" % (m["id"], red, len(named), len(m["victims"])))
    finally:
        sh("git checkout -- " + m["f"])
        if not clean():
            sys.exit("RESTORE FAILED after %s" % m["id"])

print("\nmutations proven: %d of %d" % (passed, len(MUTATIONS)))
for mid, why, red, named in report:
    print("  %s: %s" % (mid, why))
    print("      red=%s named=%s" % (red, named or "NONE -- red for an UNNAMED reason"))
if passed != len(MUTATIONS):
    sys.exit("NOT ALL GUARDS PROVEN")
