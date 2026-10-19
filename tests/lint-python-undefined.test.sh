#!/bin/sh
# lint-python-undefined.test.sh -- the control on scripts/lint-python-undefined.sh (cf#874).
#
# cf#874 exists because a defect class had NO gate at all, so a gate arriving without a proof that it
# can fail would be the same hole in a new shape. Every case asserts the EXACT exit status and, where
# it matters, the text: "it failed" and "it failed for the reason I think" are different claims.
#
#   undefined name            -> 1   the class that shipped two outages tonight
#   clean file                -> 0   the POSITIVE control; without it the gate might always fail
#   unused import only        -> 0   style is REPORTED, never blocking -- a gate that fails a release
#                                    over an unused import is one somebody deletes
#   no .py in the population  -> 1   could-not-measure is not a pass
#   linter missing            -> 2   an unavailable instrument is a FAILURE, not a skip
#   linter reports NOTHING    -> 2   the gate decides by matching text, so a silent or reworded linter
#                                    must refuse rather than read green forever
#
# Run: sh tests/lint-python-undefined.test.sh   (needs pyflakes on PATH, or $PYFLAKES set)
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
GATE="${ROOT}/scripts/lint-python-undefined.sh"
[ -f "$GATE" ] || { echo "::error::missing ${GATE}: a wrong cwd must fail loudly, not match nothing and pass"; exit 1; }

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

ran=0
failed=0

check() {
  name="$1"; want="$2"; want_text="$3"; shift 3
  ran=$((ran + 1))
  out="$("$@" 2>&1)" && got=0 || got=$?
  ok=1
  [ "$got" = "$want" ] || ok=0
  if [ -n "$want_text" ]; then
    printf '%s' "$out" | grep -q "$want_text" || ok=0
  fi
  if [ "$ok" = "1" ]; then
    printf '  ok    %-26s exit %s\n' "$name" "$got"
  else
    failed=$((failed + 1))
    printf '  FAIL  %-26s wanted exit %s' "$name" "$want"
    [ -n "$want_text" ] && printf ' with /%s/' "$want_text"
    printf ', got exit %s\n' "$got"
    printf '%s\n' "$out" | sed 's/^/        /'
  fi
}

cat > "$WORK/broken.py" <<'PY'
def handler(body):
    # the cf#851 follow-on shape: a name that was never bound on this path
    return parse(raw)
PY
cat > "$WORK/clean.py" <<'PY'
import json


def handler(body):
    return json.dumps(body)
PY
cat > "$WORK/style.py" <<'PY'
import json
import os


def handler(body):
    return json.dumps(body)
PY
: > "$WORK/notpython.txt"

# A linter that runs, accepts any arguments and reports NOTHING. Written here rather than reaching for
# /bin/true, which does not exist on macOS (only /usr/bin/true does) -- the first version of this case
# asserted exit 2 and got exit 2 for the WRONG REASON, "not found" instead of "the control failed",
# and only the reason assertion caught it. An exit-code-only check would have called that a pass.
cat > "$WORK/silent-linter" <<'SH'
#!/bin/sh
exit 0
SH
chmod +x "$WORK/silent-linter"

echo "driving the shipped gate against fixtures:"
check undefined-name     1 "undefined name"                sh "$GATE" "$WORK/broken.py"
check clean-file         0 "no undefined names"            sh "$GATE" "$WORK/clean.py"
check unused-import-only 0 "non-blocking"                  sh "$GATE" "$WORK/style.py"
check no-python-files    1 "ZERO python files"             sh "$GATE" "$WORK/notpython.txt"

# The instrument cases. `env` sets PYFLAKES for one invocation without leaking it.
check linter-missing     2 "cannot make its claim"         env PYFLAKES=/nonexistent/pyflakes sh "$GATE" "$WORK/clean.py"
# A linter that reports no findings ever. The gate must REFUSE rather than report a pass, because a
# clean result from a silent instrument is indistinguishable from a clean tree, which is the whole
# failure family this repo keeps closing.
check linter-says-nothing 2 "the CONTROL failed"           env PYFLAKES="$WORK/silent-linter" sh "$GATE" "$WORK/clean.py"

echo "ran ${ran} cases, ${failed} failed"
[ "$ran" -eq 6 ] || { echo "::error::expected 6 control cases, ran ${ran}"; exit 1; }
[ "$failed" -eq 0 ] || { echo "::error::${failed} control case(s) failed: the gate does not behave as claimed, so any green it reports on the real tree is worthless"; exit 1; }
echo "control OK: the gate fails an undefined name, passes clean code, reports style without blocking, and REFUSES when its instrument is missing or silent."
