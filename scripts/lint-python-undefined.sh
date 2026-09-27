#!/bin/sh
# lint-python-undefined.sh [file.py ...]
#
# Fail on an UNDEFINED NAME in any tracked Python file. Report everything else pyflakes finds as a
# warning without failing. With no arguments the population is `git ls-files '*.py'`.
#
# WHY (cf#874). There was no Python linter in CI at all, and it cost two live outages in one night.
# `containers/video-finish/app.py` called `_parse_partial_urls(raw)` inside `_finish_work(body)` where
# `raw` was never bound, so every non-remux finish raised NameError. `py_compile` passes on that file,
# because a NameError is a runtime event and not a syntax one, so "it imports" was never evidence.
# The unit suite covered `_finish_chunked` (5 call sites) and `_parse_partial_urls` (4), and
# `_finish_work` (0): both components tested, the line joining them untested, and no realistic unit
# test would have covered it without standing up the whole handler. That is the gap a linter fills,
# and it is why a linter is not redundant with tests.
#
# UNDEFINED NAMES FAIL, STYLE DOES NOT. pyflakes also reports unused imports, f-strings without
# placeholders and unused locals. Those are real but they are not outages, and a gate that fails a
# release over an unused import is a gate someone will route around or delete. Nine such findings
# existed when this landed; they are printed as warnings so they are visible and cleanable, and they
# do not block. The failing class is exactly the one that shipped: a name that does not exist.
#
# THE POSITIVE CONTROL RUNS FIRST, AND IT IS NOT DECORATION. This gate decides by MATCHING TEXT in
# pyflakes output, so a version whose wording changes would silently stop failing and the gate would
# read green forever. So before judging anything, it plants a file with a known undefined name and
# refuses to continue unless pyflakes reports it. If the instrument cannot produce the positive
# result, this exits non-zero as "could not measure" rather than passing.
#
# pyflakes rather than ruff, deliberately: no configuration, no opinions about style, and one
# question asked well. ruff --select F is the same ruleset plus a large surface that would need
# configuring to stay quiet; if the repo ever wants that, this script is the thing it replaces.
set -eu

PYFLAKES="${PYFLAKES:-pyflakes}"
command -v "$PYFLAKES" >/dev/null 2>&1 || { echo "::error::lint-python-undefined: ${PYFLAKES} not found. This gate cannot make its claim, which is a FAILURE and not a skip."; exit 2; }

# ------------------------------------------------------------------ the control
ctrl_dir="$(mktemp -d)"
ctrl="${ctrl_dir}/control_undefined_name.py"
cat > "$ctrl" <<'PY'
def f():
    return definitely_not_a_defined_name_cf874
PY
ctrl_out="$("$PYFLAKES" "$ctrl" 2>&1 || true)"
rm -rf "$ctrl_dir"
case "$ctrl_out" in
  *"undefined name"*)
    echo "control: a planted undefined name IS reported by ${PYFLAKES} ($("$PYFLAKES" --version 2>&1 | head -1))"
    ;;
  *)
    echo "::error::lint-python-undefined: the CONTROL failed. ${PYFLAKES} did not report a planted undefined name, so a clean result below would mean nothing. Its output was:"
    printf '%s\n' "$ctrl_out" | sed 's/^/    /'
    exit 2
    ;;
esac

# ------------------------------------------------------------------ the population
if [ "$#" -gt 0 ]; then
  files="$*"
else
  files="$(git ls-files '*.py')"
fi
count="$(printf '%s\n' $files | grep -c '\.py$' || true)"
if [ "${count:-0}" -eq 0 ]; then
  echo "::error::lint-python-undefined: ZERO python files in the population. A wrong cwd or a moved tree must fail loudly rather than report a pass over an empty set."
  exit 1
fi
echo "linting ${count} python file(s)"

# ------------------------------------------------------------------ the verdict
# shellcheck disable=SC2086
out="$("$PYFLAKES" $files 2>&1 || true)"

undefined="$(printf '%s\n' "$out" | grep 'undefined name' || true)"
other="$(printf '%s\n' "$out" | grep -v 'undefined name' | grep -v '^$' || true)"

if [ -n "$other" ]; then
  printf '%s\n' "$other" | while IFS= read -r line; do
    [ -n "$line" ] || continue
    echo "::warning::pyflakes (non-blocking): ${line}"
  done
  echo "lint: $(printf '%s\n' "$other" | grep -c . ) non-blocking finding(s) above (unused imports, unused locals, f-strings without placeholders)."
else
  echo "lint: no non-blocking pyflakes findings."
fi

if [ -n "$undefined" ]; then
  printf '%s\n' "$undefined" | while IFS= read -r line; do
    [ -n "$line" ] || continue
    echo "::error::undefined name: ${line}"
  done
  echo "::error::lint-python-undefined: $(printf '%s\n' "$undefined" | grep -c . ) undefined name(s). This is the cf#874 class: py_compile passes, the import succeeds, and the name fails at runtime on the first request down that path."
  exit 1
fi

echo "lint: no undefined names in ${count} file(s)."
