#!/bin/sh
# discover-changed-containers.sh <containers-root> <workflow-path>
#
# Extracted from container-pr-build.yml's `discover` job (cf#914), so the exact selection logic
# can be driven red AND green from a workstation -- the same shape as
# scripts/lint-python-undefined.sh and scripts/container-smoke.sh already use in this repo.
# POSIX /bin/sh only, no bash arrays: this is invoked as `sh scripts/...sh`, and on the runner
# (ubuntu-latest) `/bin/sh` is dash, not bash. A bash array here would pass locally on macOS
# (where `/bin/sh` is bash) and fail only on the runner -- exactly the kind of divergence a
# "driven from a workstation" script exists to rule out.
#
# Reads the CHANGED paths (repo-root-relative, one per line) on stdin. Emits, on STDOUT ONLY,
# exactly the lines the caller appends to $GITHUB_OUTPUT:
#   state=build|skip
#   count=<N>
#   matrix=<json array of selected service names>
# Everything a human needs to read goes to STDERR, so stdout stays a pure, assertable contract.
#
# WHY THREE STATES, NOT TWO (cf#914). A change to a repo-level file directly under
# <containers-root>/ (compose.yaml being the one that exists today) matches the path filter that
# triggers this workflow but selects no service. That is legitimately nothing to build, not a
# failure -- reporting it as one made every future compose.yaml-only change a false red on a
# recurring, non-required check, which is how a reviewer learns to stop reading that check at all.
# A change under <containers-root>/<svc>/ that does not match any known service (a typo, a rename,
# a Dockerfile missing from a freshly added directory) is a DIFFERENT empty result: the filter
# fired on what LOOKS like a per-service change and nothing resolved. That is exactly the
# silent-empty-matrix shape this job exists to refuse, and collapsing the two into one exit code is
# how the second stops getting noticed once the first becomes routine. Case 3 keeps failing loud,
# unconditionally.
#
# Exit codes: 0 on state=build or state=skip. 1 on a structural failure (empty denominator, or an
# unmapped <containers-root>/<x>/ change: case 3). 2 if the containers root does not exist.
set -eu

ROOT="${1:?usage: discover-changed-containers.sh <containers-root> <workflow-path>}"
WORKFLOW_PATH="${2:?usage: discover-changed-containers.sh <containers-root> <workflow-path>}"

[ -d "$ROOT" ] || { echo "::error::discover-changed-containers: ${ROOT} does not exist. Cannot make any claim about a container that lives under it." >&2; exit 2; }

CHANGED="$(cat)"

# THE STRUCTURAL DENOMINATOR AND THE SELECTION, in one pass over the same glob. Every container
# that exists (ALL), and which of those has a changed path under it (SELECTED) -- built together
# so there is only one definition of "the containers that exist" to drift out of sync. Portable on
# purpose: a plain glob for-loop, no `find -printf`, no `mapfile`, no bash arrays.
ALL=""
all_count=0
SELECTED=""
selected_count=0
for d in "$ROOT"/*/; do
  [ -f "${d}Dockerfile" ] || continue
  svc="$(basename "$d")"
  ALL="${ALL}${svc}
"
  all_count=$((all_count + 1))
  if printf '%s\n' "${CHANGED}" | grep -qE "^${ROOT}/${svc}/"; then
    SELECTED="${SELECTED}${svc}
"
    selected_count=$((selected_count + 1))
  fi
done
echo "containers discovered: ${all_count} -> $(printf %s "${ALL}" | tr '\n' ' ')" >&2
if [ "${all_count}" -eq 0 ]; then
  echo "::error::the ${ROOT}/*/Dockerfile glob matched ZERO paths. Either the tree moved or this is looking in the wrong place; refusing to report a pass over an empty set." >&2
  exit 1
fi

echo "changed paths:" >&2
printf '%s\n' "${CHANGED}" | sed 's/^/  /' >&2

# A change to the workflow itself with no container touched builds everything, so a change to the
# gate is tested by the gate rather than merged on the claim that it still works.
if [ "${selected_count}" -eq 0 ] && printf '%s\n' "${CHANGED}" | grep -qxF "${WORKFLOW_PATH}"; then
  echo "the workflow file changed and no container did: building all ${all_count} as a self-test" >&2
  SELECTED="${ALL}"
  selected_count="${all_count}"
fi

if [ "${selected_count}" -eq 0 ]; then
  # Two different empty-matrix causes, and they get different verdicts.
  #
  # If something DID change under ${ROOT}/<x>/ for some <x>, the filter fired on what looks like a
  # per-service change and it resolved to nothing: <x> is not in the structural denominator. That
  # is case 3, refused, unconditionally.
  #
  # Otherwise every changed path either is not under ${ROOT} at all, or sits DIRECTLY in ${ROOT}
  # with no service subdirectory (compose.yaml). There was never a per-service change to select.
  # That is case 2: legitimately nothing to build.
  if printf '%s\n' "${CHANGED}" | grep -qE "^${ROOT}/[^/]+/"; then
    echo "::error::a change matched ${ROOT}/<dir>/ but <dir> is not one of the ${all_count} known containers ($(printf '%s' "${ALL}" | tr '\n' ' ')). The trigger and the matrix mapping disagree; refusing to pass on an empty matrix." >&2
    exit 1
  fi
  echo "only repo-level ${ROOT}/* file(s) changed (no service subdirectory touched): nothing to build" >&2
  echo "state=skip"
  echo "count=0"
  echo "matrix=[]"
  exit 0
fi

echo "selected: ${selected_count} of ${all_count} -> $(printf '%s' "${SELECTED}" | tr '\n' ' ')" >&2
MATRIX="$(printf '%s\n' "${SELECTED}" | grep -v '^$' | jq -R . | jq -sc .)"
echo "state=build"
echo "count=${selected_count}"
echo "matrix=${MATRIX}"
