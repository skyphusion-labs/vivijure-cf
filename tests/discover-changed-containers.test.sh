#!/bin/sh
# discover-changed-containers.test.sh -- the control on scripts/discover-changed-containers.sh
# (cf#914).
#
# cf#914 is about a job that could not tell "nothing to build here, legitimately" apart from
# "the trigger fired and nothing resolved" -- it refused BOTH, which was correct for the second and
# a false red on every recurring instance of the first (a `containers/compose.yaml`-only PR).
# This is the control: it drives the extracted selection logic against a synthetic containers/
# tree and asserts the THREE states stay three states, not two.
#
#   per-service change            -> state=build, count=1   case 1, unaffected by this fix
#   repo-level file only (compose)-> state=skip,  count=0   case 2, the false red this fixes
#   both together                 -> state=build, count=1   compose.yaml riding with a real change
#                                                            must not mask it as skip
#   unmapped containers/<x>/ path -> exit 1                 case 3, MUST still fail loud
#   workflow file, no container   -> state=build, count=ALL the existing self-test widen, unaffected
#   empty containers/ denominator -> exit 1                 the pre-existing structural guard
#   missing containers root       -> exit 2                 an instrument failure, not a skip
#
# EXIT CODES AND STATE ARE ASSERTED EXACTLY. A check that accepts "any non-zero" cannot tell a
# working three-way split from one that collapsed back to two in a new place.
#
# Run: sh tests/discover-changed-containers.test.sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
GATE="${ROOT}/scripts/discover-changed-containers.sh"
[ -f "$GATE" ] || { echo "::error::missing ${GATE}: a wrong cwd must fail loudly, not match nothing and pass"; exit 1; }

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

WF=".github/workflows/container-pr-build.yml"

ran=0
failed=0

# $1 name, $2 want exit, $3 want stdout/stderr text (grep -q, "" to skip), $4 changed-paths
# (newline separated, fed on stdin), $5.. extra args after the fixed containers-root arg (unused
# today, kept for the missing-root case which passes its own root).
check() {
  name="$1"; want="$2"; want_text="$3"; changed="$4"; croot="${5:-containers}"
  ran=$((ran + 1))
  out="$(printf '%s\n' "${changed}" | sh "$GATE" "$croot" "$WF" 2>&1)" && got=0 || got=$?
  ok=1
  [ "$got" = "$want" ] || ok=0
  if [ -n "$want_text" ]; then
    printf '%s' "$out" | grep -q "$want_text" || ok=0
  fi
  if [ "$ok" = "1" ]; then
    printf '  ok    %-28s exit %s\n' "$name" "$got"
  else
    failed=$((failed + 1))
    printf '  FAIL  %-28s wanted exit %s' "$name" "$want"
    [ -n "$want_text" ] && printf ' with /%s/' "$want_text"
    printf ', got exit %s\n' "$got"
    printf '%s\n' "$out" | sed 's/^/        /'
  fi
}

# ------------------------------------------------------------------ the fixture tree
mkdir -p "$WORK/containers/audio-mix" "$WORK/containers/video-finish"
: > "$WORK/containers/audio-mix/Dockerfile"
: > "$WORK/containers/video-finish/Dockerfile"
: > "$WORK/containers/compose.yaml"
cd "$WORK"

echo "driving the shipped gate against fixtures (2 known containers: audio-mix, video-finish):"

check per-service-change    0 "state=build
count=1
matrix=\[\"audio-mix\"\]" "containers/audio-mix/Dockerfile"

# THE CASE THIS ISSUE IS ABOUT. A compose.yaml-only change must read as skip, not as the case-3
# refusal, and must not exit non-zero.
check repo-level-file-only  0 "state=skip
count=0
matrix=\[\]" "containers/compose.yaml"

# compose.yaml riding alongside a real per-service change must not get masked into a skip: the
# service still resolves and the matrix still reflects it.
check repo-level-plus-real  0 "state=build
count=1" "containers/compose.yaml
containers/video-finish/Dockerfile"

# CASE 3, THE HARD CONSTRAINT. A subdirectory under containers/ that does not map to any known
# service must keep failing loud, exactly as before this fix.
check unmapped-subdir       1 "not one of the 2 known containers" "containers/nope-not-real/Dockerfile"

# The pre-existing self-test widen: the workflow file itself changed and no container did, so
# every known container is selected. Unaffected by this fix; asserted so a future edit cannot
# quietly break it while fixing case 2.
check workflow-file-widen   0 "state=build
count=2" "$WF"

# The pre-existing structural guard: an empty containers/ population is refused, not passed.
mkdir -p "$WORK/empty-containers"
check empty-denominator     1 "matched ZERO paths" "containers/compose.yaml" "empty-containers"

# The instrument case: a containers root that does not exist is a failure, never a skip.
check missing-root          2 "does not exist" "containers/compose.yaml" "no-such-containers-root"

echo "ran ${ran} cases, ${failed} failed"
[ "$ran" -eq 7 ] || { echo "::error::expected 7 control cases, ran ${ran}"; exit 1; }
[ "$failed" -eq 0 ] || { echo "::error::${failed} control case(s) failed: scripts/discover-changed-containers.sh does not behave as claimed, so any green it reports on a real PR is worthless"; exit 1; }
echo "control OK: a per-service change builds, a repo-level-only change SKIPS instead of failing, a repo-level change riding with a real one still builds, and an unmapped subdirectory still fails loud."
