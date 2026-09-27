#!/usr/bin/env bash
# Zero-spend existence check for the RunPod public-endpoint slugs this repo actually hardcodes.
#
# cf#934 (the check), cf#921 (the door that motivated it), cf#267 + docs/runpod-public-endpoint-slugs.md
# (the 401/404 contract this relies on).
#
# THE PROBE. GET /v2/<slug>/health with NO auth and NO /run:
#   401 + "no token provided"  => the endpoint EXISTS (auth required; no job started, no spend)
#   404 + "endpoint not found" => the endpoint does NOT exist
# anything else                => UNEXPECTED; the instrument is unreliable, so the run fails.
#
# THE POPULATION IS modules/ ON THIS CHECKOUT, NEVER A LIST IN THIS FILE. Until cf#934 this script
# carried its own hardcoded DEFAULT_SLUGS array, which is the defect the sibling gate's header names:
# a checker carrying its own copy of the population it checks cannot detect that population changing.
# That array had also gone stale in both directions -- it still listed kling-v2-1-i2v-pro and had
# never gained infinitetalk or kling-video-o1-r2v. The slugs are now derived from the modules.
#
# WHAT IT CAN AND CANNOT SEE, stated here because a check that looks total is worse than one with a
# declared edge.
#   CAN: whether a slug this repo dispatches to still resolves at RunPod.
#   CANNOT: whether the UPSTREAM MODEL behind that slug still exists. A 401 proves a RunPod endpoint
#   OBJECT is there, not that the vendor still serves it. Measured 2026-09-27: sora-2-i2v and
#   sora-2-pro-i2v answer 401 and are listed isLive with full price tables, while OpenAI's own model
#   page states the Sora 2 models and Videos API "were shut down on September 24, 2026 and are no
#   longer available". So green here means the slug resolves. It does not mean a render will succeed,
#   and it is not vendor liveness. That question is deliberately out of scope (cf#934).
#   ALSO CANNOT: anything about the doors that have no slug. They are named in the output, not hidden.
#
# NOT A CI GATE, AND MUST NEVER BECOME ONE (ruled on cf#934). This depends on a third party being
# reachable, so as a required check a RunPod outage would become a merge freeze on unrelated work --
# the same shape as a filter that can ban its own ingress path. It runs on a SCHEDULE and reports by
# opening an issue, which degrades into "we learn a day late". That is the correct failure mode for a
# property that is not a property of the diff.
#
# CREDENTIAL-FREE BY CONSTRUCTION. No token is read and none is needed; /health is unauthenticated.
#
# FAILURE DIRECTION, DECIDED HERE RATHER THAN DISCOVERED LATER. It never degrades to a skip.
#   exit 1  a slug this repo dispatches to is MISSING  (the finding)
#   exit 2  an UNEXPECTED http code                    (instrument unreliable, verdict withheld)
#   exit 3  the negative control did NOT fire          (a clean sweep is not believable)
#           and exit 2 also covers: the POSITIVE control not reading EXISTS, or every probed
#           slug reading MISSING at once. Both mean the probe, not the estate, is what broke.
#   exit 4  the population could not be accounted for  (parse failure, or the counts do not sum)
#
# Usage:  scripts/probe-runpod-public-slugs.sh              # derive the population from modules/
#         scripts/probe-runpod-public-slugs.sh --classify-only   # census only, NO network calls
#         scripts/probe-runpod-public-slugs.sh slug ...     # ad-hoc: probe exactly these, no census
# Env:    RUNPOD_API_BASE               override the API base (the resolved value is printed)
#         RUNPOD_PROBE_CONTROL_SLUG    override the negative control (testing the control only)
#         RUNPOD_PROBE_POSITIVE_SLUG   override the positive control (testing the control only)
set -euo pipefail

BASE="${RUNPOD_API_BASE:-https://api.runpod.ai/v2}"
# The control slug is overridable ONLY so the control's own failure path (exit 3) can be exercised;
# a control that cannot be observed failing is decoration. The slug actually used is printed every
# run, which is the discriminator if anyone ever points this at something real.
CONTROL_SLUG="${RUNPOD_PROBE_CONTROL_SLUG:-definitely-not-a-slug-xyz}"

# A POSITIVE control, and it is not optional. The negative control alone is ONE-SIDED: it proves a
# bogus slug is not reported as existing, which stays true when the base URL is wrong and EVERY path
# 404s. Found while exercising this script's own guards (RUNPOD_API_BASE=https://example.com made all
# ten real slugs read MISSING and the run reported a catastrophic FINDING instead of a broken
# instrument, with the negative control still apparently healthy). So a slug known to exist, and
# deliberately NOT one this repo dispatches to, must come back EXISTS or no verdict is issued.
POSITIVE_CONTROL_SLUG="${RUNPOD_PROBE_POSITIVE_SLUG:-black-forest-labs-flux-1-dev}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------------------------------------------------------------------------
# probe one slug -> prints "<http> <verdict>"
# ---------------------------------------------------------------------------
probe() {
  local slug="$1" body_file code body
  body_file="$(mktemp)"
  code="$(curl -sS -o "$body_file" -w '%{http_code}' --max-time 15 \
    "${BASE}/${slug}/health" || echo "000")"
  body="$(tr -d '\n' <"$body_file" | head -c 120)"
  rm -f "$body_file"
  case "$code" in
    401) echo "$code EXISTS" ;;
    404) echo "$code MISSING" ;;
    *)   echo "$code UNEXPECTED|$body" ;;
  esac
}

exists=0
missing=0
unexpected=0
missing_slugs=""

report_row() {
  local label="$1" slug="$2" result http verdict
  result="$(probe "$slug")"
  http="${result%% *}"
  verdict="${result#* }"
  case "$verdict" in
    EXISTS)  exists=$((exists + 1)) ;;
    MISSING)
      missing=$((missing + 1))
      missing_slugs="${missing_slugs}${label}:${slug} "
      ;;
    *) unexpected=$((unexpected + 1)) ;;
  esac
  printf '  %-22s %-30s %-5s %s\n' "$label" "$slug" "$http" "${verdict//|/ }"
}

CLASSIFY_ONLY=0
if [[ "${1:-}" == "--classify-only" ]]; then
  # Census and classification with NO network calls. Exists so the population arithmetic and the
  # ENDPOINT_ID parsing are testable offline and deterministically (tests/probe-runpod-slugs.test.sh);
  # a guard that can only be exercised against a live third party is a guard nobody re-checks.
  CLASSIFY_ONLY=1
  shift
fi

echo "probe-runpod-public-slugs: base = ${BASE}"

# ---------------------------------------------------------------------------
# AD-HOC MODE: exactly the slugs asked for. No census, so no denominator claim.
# ---------------------------------------------------------------------------
if [[ $# -gt 0 ]]; then
  echo "mode = ad-hoc (the slugs given on the command line; NOT a census of modules/)"
  echo
  printf '  %-22s %-30s %-5s %s\n' "source" "slug" "http" "verdict"
  for slug in "$@"; do report_row "argv" "$slug"; done
  echo
  echo "summary: exists=${exists} missing=${missing} unexpected=${unexpected}"
  echo "note: ad-hoc mode runs no negative control and makes no claim about coverage."
  [[ "$unexpected" -gt 0 ]] && exit 2
  [[ "$missing" -gt 0 ]] && exit 1
  exit 0
fi

# ---------------------------------------------------------------------------
# CENSUS MODE: derive the population from modules/ on this checkout.
#
# Three classes, and every module lands in exactly one. The arithmetic is asserted at the end,
# because a module that silently falls out of all three classes is the narrow-instrument failure
# this check exists to avoid: a sweep that reports on a smaller population than the reader believes.
#   1 PROBED         -- const ENDPOINT_ID = "<slug>"  (a public slug, resolvable indirection allowed)
#   2 OWN-ENDPOINT   -- RUNPOD_ENDPOINT_ID binding: OUR serverless endpoint, id supplied per install
#   3 NO-ENDPOINT    -- no RunPod endpoint at all (Cloudflare / Workers AI / local routed)
# ---------------------------------------------------------------------------
echo "mode = census (population = modules/ on this checkout, never a list in this script)"

probed_pairs=""
own_endpoint=""
no_endpoint=""
total=0

for dir in "${REPO_ROOT}"/modules/*/; do
  module="$(basename "$dir")"
  [[ "$module" == "_shared" ]] && continue
  total=$((total + 1))
  index="${dir}src/index.ts"

  if [[ ! -f "$index" ]]; then
    echo "probe-runpod-public-slugs: FAIL -- ${module} has no src/index.ts, so it cannot be classified" >&2
    exit 4
  fi

  # A literal slug.
  slug="$(sed -nE 's/^const ENDPOINT_ID = "([a-z0-9][a-z0-9-]*)".*/\1/p' "$index" | head -n1)"

  if [[ -z "$slug" ]]; then
    # An indirection: const ENDPOINT_ID = SOME_IDENT;  Resolve it within the module's own src/.
    ident="$(sed -nE 's/^const ENDPOINT_ID = ([A-Za-z_][A-Za-z0-9_]*);.*/\1/p' "$index" | head -n1)"
    if [[ -n "$ident" ]]; then
      slug="$(sed -nE "s/^(export )?const ${ident} = \"([a-z0-9][a-z0-9-]*)\".*/\2/p" "${dir}"src/*.ts \
        | head -n1)"
      if [[ -z "$slug" ]]; then
        # Refuse to guess. An unresolvable declaration is a parse failure, never a silent skip:
        # dropping it would shrink the population and still print OK.
        echo "probe-runpod-public-slugs: FAIL -- ${module} declares ENDPOINT_ID = ${ident} and that" >&2
        echo "  identifier's literal was not found in ${module}/src/*.ts. Resolve it or classify it" >&2
        echo "  explicitly; this check will not drop a module it cannot parse." >&2
        exit 4
      fi
    fi
  fi

  if [[ -n "$slug" ]]; then
    probed_pairs="${probed_pairs}${module}=${slug} "
  elif grep -q 'RUNPOD_ENDPOINT_ID' "$index"; then
    own_endpoint="${own_endpoint}${module} "
  else
    no_endpoint="${no_endpoint}${module} "
  fi
done

n_probed=$(printf '%s' "$probed_pairs" | wc -w | tr -d ' ')
n_own=$(printf '%s' "$own_endpoint" | wc -w | tr -d ' ')
n_none=$(printf '%s' "$no_endpoint" | wc -w | tr -d ' ')

echo
echo "PROBED -- a public slug this repo dispatches to (${n_probed} modules):"
if [[ "$CLASSIFY_ONLY" -eq 1 ]]; then
  printf '  %-22s %s\n' "module" "slug"
  for pair in $probed_pairs; do
    printf '  %-22s %s\n' "${pair%%=*}" "${pair#*=}"
  done
else
  printf '  %-22s %-30s %-5s %s\n' "module" "slug" "http" "verdict"
  for pair in $probed_pairs; do
    report_row "${pair%%=*}" "${pair#*=}"
  done
fi

if [[ "$CLASSIFY_ONLY" -eq 0 ]]; then
echo
echo "CONTROLS, both in this same invocation. One alone cannot separate a dead slug from a dead probe:"
printf '  %-22s %-30s %-5s %s\n' "control" "slug" "http" "verdict"
control_result="$(probe "$CONTROL_SLUG")"
control_http="${control_result%% *}"
control_verdict="${control_result#* }"
printf '  %-22s %-30s %-5s %s\n' "negative (want 404)" "$CONTROL_SLUG" "$control_http" "${control_verdict//|/ }"
pos_result="$(probe "$POSITIVE_CONTROL_SLUG")"
pos_http="${pos_result%% *}"
pos_verdict="${pos_result#* }"
printf '  %-22s %-30s %-5s %s\n' "positive (want 401)" "$POSITIVE_CONTROL_SLUG" "$pos_http" "${pos_verdict//|/ }"
fi

echo
echo "NOT COVERED, and why. These are OUTSIDE the probed population, named rather than left to"
echo "subtraction, because a sweep that hides its own edges reports on a population the reader"
echo "believes is larger than it is."
echo "  own-endpoint, id supplied per install via a RUNPOD_ENDPOINT_ID binding (${n_own}):"
echo "    ${own_endpoint:-(none)}"
echo "  no RunPod endpoint at all, routed elsewhere e.g. Cloudflare (${n_none}):"
echo "    ${no_endpoint:-(none)}"

echo
echo "denominator: ${n_probed} probed + ${n_own} own-endpoint + ${n_none} no-endpoint = $((n_probed + n_own + n_none)) of ${total} modules on disk"
if [[ "$CLASSIFY_ONLY" -eq 1 ]]; then
  # Deliberately NO summary and NO fingerprint line here. Nothing was probed, so "missing=0" and
  # "fingerprint: none" would read exactly like a clean sweep, and the scheduled workflow greps for
  # that fingerprint line. A mode that cannot find anything must not be able to report all-clear.
  echo "summary: nothing probed (--classify-only); no liveness verdict is available from this run"
else
  echo "summary: exists=${exists} missing=${missing} unexpected=${unexpected}"
  if [[ -n "$missing_slugs" ]]; then
    echo "missing: ${missing_slugs}"
  fi
  echo "liveness-fingerprint: ${missing_slugs:-none}"
fi

# ---------------------------------------------------------------------------
# Verdicts. Order matters: an unusable instrument outranks any finding it produced.
# ---------------------------------------------------------------------------
if [[ $((n_probed + n_own + n_none)) -ne "$total" ]]; then
  echo "probe-runpod-public-slugs: FAIL -- classes sum to $((n_probed + n_own + n_none)), not ${total}." >&2
  echo "  A module fell out of every class, so this sweep covered an unknown population." >&2
  exit 4
fi

if [[ "$CLASSIFY_ONLY" -eq 1 ]]; then
  echo "probe-runpod-public-slugs: classify-only OK -- ${total} modules, all accounted for, nothing probed."
  exit 0
fi

if [[ "$unexpected" -gt 0 ]]; then
  echo "probe-runpod-public-slugs: FAIL -- ${unexpected} slug(s) returned an UNEXPECTED code." >&2
  echo "  Withholding a verdict: neither EXISTS nor MISSING was established for those." >&2
  exit 2
fi

if [[ "$pos_verdict" != "EXISTS" ]]; then
  echo "probe-runpod-public-slugs: FAIL -- positive control ${POSITIVE_CONTROL_SLUG} returned ${pos_http}," >&2
  echo "  not 401. A slug known to exist did not read as existing, so this probe is not measuring what" >&2
  echo "  it claims and every MISSING above is unsafe to believe. No verdict this run." >&2
  exit 2
fi

if [[ "$control_verdict" != "MISSING" ]]; then
  echo "probe-runpod-public-slugs: FAIL -- negative control ${CONTROL_SLUG} returned ${control_http}," >&2
  echo "  not 404. The instrument cannot currently distinguish a dead slug from a reachable one, so" >&2
  echo "  a clean sweep would be meaningless. No verdict on the real slugs this run." >&2
  exit 3
fi

if [[ "$exists" -eq 0 && "$n_probed" -gt 0 ]]; then
  echo "probe-runpod-public-slugs: FAIL -- every one of ${n_probed} probed slugs read MISSING." >&2
  echo "  A whole-population disappearance is not a credible finding; it is an instrument or network" >&2
  echo "  failure. Backstop for the case both named controls somehow pass. No verdict this run." >&2
  exit 2
fi

if [[ "$missing" -gt 0 ]]; then
  echo "probe-runpod-public-slugs: FINDING -- ${missing} slug(s) this repo dispatches to are GONE." >&2
  echo "  Any render routed to them fails at submit. See cf#921 for the first instance." >&2
  exit 1
fi

echo "probe-runpod-public-slugs: OK -- every slug this repo dispatches to still resolves."
echo "  (Slug resolution only. Not vendor liveness; see the header.)"
exit 0
