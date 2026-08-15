#!/usr/bin/env bash
# Advance vivijure-control-plane's STUDIO_RELEASE variable to the studio release just published
# (cf#372). Called from .github/workflows/studio-release.yml; ONE definition, so the workflow never
# inlines a second copy that can drift from this one.
#
# WHY THIS EXISTS. STUDIO_RELEASE is the single value deciding which studio code a hosted tenant
# runs, and self-host pulls the same tag straight from the GitHub release. When the pin trails,
# hosted and self-host run DIFFERENT code from the same nominal tag, against the absolute
# hosted/self-host parity invariant. The pin has gone stale three times and twice been "fixed" by
# bumping it, so the advance belongs on the release path rather than in anyone's memory.
#
# WHAT THIS IS NOT. Setting the variable is NOT deploying it: vivijure-control-plane's
# render-wrangler.sh interpolates it into [vars] at ITS deploy time, so a tenant provisioned before
# that deploy still receives the old pin. This stages a value. cp#393's studio-pin-drift.yml reads
# the LIVE Worker binding and is what observes that gap.
#
# CREDENTIAL. Least privilege for this job is a fine-grained PAT carrying the vivijure-control-plane
# repository permission "Variables: read and write" and nothing else -- strictly NARROWER than the
# "Contents: write" a repository_dispatch would require. GITHUB_TOKEN cannot do it at all; its
# permissions are limited to the repository containing the workflow.
#
# Exit 0 = advanced, already current, or deliberately declined (backwards move, absent credential).
# Exit 1 = the advance was attempted and FAILED, or the state could not be read.
set -euo pipefail

TAG="${1:?usage: advance-studio-pin.sh <vX.Y.Z>}"
CP="${STUDIO_PIN_TARGET_REPO:-skyphusion-labs/vivijure-control-plane}"
# Overridable ONLY so the test suite can drive every refusal path against a local server without a
# credential. Announced on every such run, so a redirected run can never be mistaken for a real one.
API_BASE="${STUDIO_PIN_API_BASE:-https://api.github.com}"
API="${API_BASE}/repos/${CP}/actions/variables/STUDIO_RELEASE"
[ -n "${STUDIO_PIN_API_BASE:-}" ] && echo "NOTE: API base OVERRIDDEN (${API_BASE}); this run is NOT a live write."

case "$TAG" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "::error::${TAG} is not a vX.Y.Z tag -- refusing to pin hosted tenants to it"; exit 1 ;;
esac

# MODE. Default advances the pin; --assert only READS and asserts, so the release path can check
# the outcome even on a run where no write happened. That separation is the cf#372 fix: the old
# shape let a skip and a success share exit 0, so a release that never touched the pin reported
# exactly what a release that advanced it reported.
MODE=advance
case "${2:-}" in
  --assert) MODE=assert ;;
  "") ;;
  *) echo "::error::unknown argument ${2} (expected --assert or nothing)"; exit 1 ;;
esac

# CREDENTIAL, AND THE BRANCH THAT USED TO BE THE BUG.
#
# This check used to warn and exit 0 unconditionally when the token was absent. It ran that way on
# the v1.27.0 and v1.28.0 tags, reported SUCCESS both times, and never attempted a read or a write:
# the secret had never been provisioned at all. An annotation is not a gate. A ::warning renders a
# yellow badge, a zero exit and a green check, obliges nobody, and rendered on both run summaries
# where it was seen by nobody. Meanwhile the deployed studio reached v1.28.0 while hosted stayed
# pinned at v1.26.0, so hosted and self-host ran different code from the same nominal release,
# against the parity invariant, and the gap grew by one every ship.
#
# So the skip is now SCOPED to the only case where it is legitimate: a fork or a self-hoster, who
# has no business writing our control plane and for whom the secret correctly does not exist. On
# the canonical repository the absent credential is a FAILURE, because a release that silently
# does not advance the pin is a parity violation and must not be reported as a release.
#
# AMBIGUITY FAILS CLOSED. An unset GITHUB_REPOSITORY cannot be read as "probably a fork": that is
# the same reasoning that produced the original defect, where an absent thing was treated as a
# benign one. GitHub Actions always sets it, so unset means somebody is running this by hand.
CANONICAL="${STUDIO_PIN_CANONICAL_REPO:-skyphusion-labs/vivijure-cf}"
HERE="${GITHUB_REPOSITORY:-}"
if [ -z "${STUDIO_PIN_VARIABLE_TOKEN:+SET}" ]; then
  if [ -n "$HERE" ] && [ "$HERE" != "$CANONICAL" ]; then
    echo "::warning::STUDIO_PIN_VARIABLE_TOKEN is unset and this is ${HERE}, not ${CANONICAL}."
    echo "Skipping: a fork or self-host deployment does not pin our hosted control plane."
    exit 0
  fi
  echo "::error::STUDIO_PIN_VARIABLE_TOKEN is unset on ${HERE:-an unidentified repository}."
  echo "::error::Refusing to report a release that did not advance the hosted pin to ${TAG}."
  echo "  The hosted pin decides which studio code a hosted tenant runs; self-host takes the same"
  echo "  tag straight from the release. A release that moves one and not the other ships"
  echo "  different code to the two doors under one version number."
  echo "  FIX: provision a fine-grained PAT on ${CANONICAL} as the repository secret"
  echo "  STUDIO_PIN_VARIABLE_TOKEN, carrying ONLY the ${CP} permission Variables: read and write."
  echo "  This step previously WARNED here and exited 0; that is what let the pin trail six"
  echo "  releases while every run reported success (cf#372)."
  exit 1
fi

auth=(-H "Accept: application/vnd.github+json"
      -H "Authorization: Bearer ${STUDIO_PIN_VARIABLE_TOKEN}"
      -H "X-GitHub-Api-Version: 2022-11-28")

# READ FIRST. A write with no prior read is a write whose effect nobody can state, and the
# backwards-move refusal below has nothing to compare against.
cur_body="$(curl -sS "${auth[@]}" "$API")"
# has()-style: a MISSING key must never be coerced into a value. "absent" and "set to something
# old" are different findings and only one of them is a pin this job may move.
cur="$(printf '%s' "$cur_body" | jq -r 'if has("value") then .value else "ABSENT" end')"
if [ "$cur" = "ABSENT" ]; then
  echo "::error::could not read STUDIO_RELEASE on ${CP} -- the response carries no value field."
  printf '%s' "$cur_body" | jq -r '.message // "no message field either"'
  exit 1
fi
echo "current hosted pin: ${cur}; this release: ${TAG}"

# ASSERT MODE ends here, and this is the assertion that runs even when no write happened.
#
# The invariant after a release run is NOT pin == tag, it is pin NOT BEHIND tag. Re-running an
# older tag CI run is the sanctioned way to rebuild that tag artifact, and on such a run the
# advance correctly declines a backwards move; demanding equality would paint that red for doing
# the right thing. Trailing is the actual defect, and this is red exactly then.
if [ "$MODE" = assert ]; then
  behind="$(printf %s\\n%s\\n "${cur#v}" "${TAG#v}" | sort -V | head -1)"
  if [ "$cur" != "$TAG" ] && [ "$behind" = "${cur#v}" ]; then
    echo "::error::hosted pin is BEHIND the release: pin ${cur}, release ${TAG}."
    echo "  Both numbers are printed so this reads as a comparison rather than a bare failure."
    echo "  Hosted tenants would run ${cur} while self-host takes ${TAG} from the same release."
    exit 1
  fi
  echo "assert OK: hosted pin ${cur} is not behind release ${TAG}."
  exit 0
fi

if [ "$cur" = "$TAG" ]; then
  echo "hosted pin is already ${TAG}; nothing to advance."
  exit 0
fi

# NEVER BACKWARDS. studio-release.yml is dispatchable for artifact rebuilds of OLDER tags, and
# advancing on one of those would repoint every future tenant at older code -- the same parity
# violation this script exists to prevent, caused by the fix. `sort -V` puts the older first.
older="$(printf '%s\n%s\n' "${cur#v}" "${TAG#v}" | sort -V | head -1)"
if [ "$older" = "${TAG#v}" ]; then
  echo "::warning::hosted pin ${cur} is NEWER than ${TAG}; refusing to move the pin backwards."
  exit 0
fi

# The response body goes to a PRIVATE temp file, never a fixed shared name.
#
# It used to be a hardcoded path under the shared temp directory. The first user to run this owns
# that file; every later user gets `curl: (23) Failure writing output to destination` on the `-o`.
# The failure is silent in the direction that matters: curl still PERFORMS the PATCH and only fails
# writing the body, so the pin ADVANCES while this script reports FAILURE -- a real state change
# reported as a no-op, which is the worst possible pairing for a value deciding what code a tenant
# runs.
#
# Observed live, not theorised: one run left the file owned by another user, and five of this
# script's own tests then failed with rc=23 for a different user on the same box.
#
# A private per-run file plus a trap, so concurrent runs cannot collide and nothing is left behind.
resp="$(mktemp "${TMPDIR:-/tmp}/advance-studio-pin-resp.XXXXXX")"
trap 'rm -f "$resp"' EXIT

# The curl EXIT STATUS is checked separately from the HTTP code. A write error must never be
# mistaken for a transport success, which is exactly how the old form hid a completed PATCH.
if ! code="$(curl -sS -o "$resp" -w '%{http_code}' -X PATCH "${auth[@]}" "$API" \
  -d "$(jq -nc --arg v "$TAG" '{name:"STUDIO_RELEASE",value:$v}')")"; then
  echo "::error::the PATCH could not be completed locally (curl failed). The pin may or may not have"
  echo "::error::been changed remotely -- re-run the drift check before assuming either way."
  exit 1
fi
echo "PATCH STUDIO_RELEASE -> HTTP ${code}"
if [ "$code" != "204" ]; then
  echo "::error::advancing the hosted pin to ${TAG} failed (HTTP ${code})."
  cat "$resp" 2>/dev/null || true
  exit 1
fi

# READ BACK. A 204 reports that the call was ACCEPTED, never that the stored value is what you
# asked for.
got="$(curl -sS "${auth[@]}" "$API" | jq -r 'if has("value") then .value else "ABSENT" end')"
if [ "$got" != "$TAG" ]; then
  echo "::error::read-back says STUDIO_RELEASE is ${got}, not ${TAG}."
  exit 1
fi
echo "hosted pin advanced ${cur} -> ${got} (read back, not assumed)."
