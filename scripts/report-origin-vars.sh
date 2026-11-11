#!/bin/sh
# report-origin-vars.sh <rendered-wrangler.toml>
#
# Say which media-door origins the render actually BOUND, and refuse the one combination that is a
# contradiction rather than a choice. cf#850, the core-render half of cf#840.
#
# THE DEFECT THIS CLOSES. The render step's fail-closed check is `grep -qF '${'` over non-comment
# lines. That catches a var MISSING from the envsubst SHELL-FORMAT list, because the literal `${FOO}`
# survives. It cannot catch a var that is LISTED AND EMPTY: envsubst substitutes it to "", the config
# reads `FINISH_UPSCALE_DOORS = ""`, every guard in the step passes, and the deploy is green with the
# door off. That is cf#489's failure mode on the one path cf#840 did not cover, and a deliberate
# opt-out renders BYTE-IDENTICALLY to a forgotten variable, so nothing downstream can tell them apart.
#
# WHY THIS IS A REPORT AND NOT A HARD FAIL ON EMPTY. The template documents empty as meaningful:
# "Empty = that service is off", and the three door-list modules read an empty list as "use RunPod".
# A self-host legitimately ships most of these empty. A gate that failed on any empty var would be
# wrong about the ordinary case, and a gate that is wrong about the ordinary case gets routed around,
# which is worse than no gate. So: every door is named, an empty one is a ::warning:: the log carries,
# and exit status is unchanged.
#
# THE ONE HARD FAIL, and it is a contradiction inside one config rather than an opinion about which
# tiers we run. If the config declares a [[containers]] block, the finish container IS the door
# (cf#810: MEDIA_DOOR_FETCHERS is keyed by the var NAME and synthesised from the FINISH_CONTAINER
# binding, so the value is never fetched). But src/video-finish-availability.ts reads a NON-EMPTY
# VIDEO_FINISH_URL as "the tier is installed". So containers-bound plus VIDEO_FINISH_URL empty is a
# deploy where a working door sits bound while the studio degrades the assemble phase as though no
# tier existed. The two halves of the same file disagree; that is not a configuration an operator
# chooses, it is one they arrive at by accident.
#
# WHAT THIS DOES NOT DO, stated because the issue was filed partly to record it: it says nothing
# about whether a bound origin is REACHABLE. Measured 2026-09-27, eleven of the thirteen hostnames
# across these seven vars were NXDOMAIN while every var was non-empty, so a report of BOUND is a
# report about the CONFIG and not about the world. A reachability probe in a deploy gate is a design
# decision with a network dependency, priced in cf#850, not smuggled in here.
#
# NAMES ONLY, never values. These are repo variables rather than secrets, but an origin list is
# deploy topology and SET-vs-EMPTY is the entire question this answers.
set -eu

toml="${1:?usage: report-origin-vars.sh <rendered-wrangler.toml>}"
[ -f "$toml" ] || { echo "::error::report-origin-vars: no such file: $toml (a wrong path must fail, not report a pass over nothing)"; exit 1; }

# THE POPULATION IS DERIVED FROM THE RENDERED FILE, by SHAPE, so a new door var is covered the day it
# is added rather than the day someone remembers to add it to a list here. `_URL` / `_DOORS` is the
# naming this repo already uses for every media origin (7 of them at cf#850).
doors="$(grep -E '^[A-Z0-9_]+(_URL|_DOORS)[[:space:]]*=' "$toml" || true)"
if [ -z "$doors" ]; then
  echo "::error::report-origin-vars: found ZERO *_URL / *_DOORS lines in ${toml}. Either the render produced no [vars] block or the naming changed; refusing to report a pass over an empty set."
  exit 1
fi

total=0
empty=0
bound=0
empty_names=""
# Read the NAME and whether the quoted value is empty. The value itself never leaves this loop.
for line in $(printf '%s\n' "$doors" | tr -d ' \t' | tr '\n' ' '); do
  name="${line%%=*}"
  value="${line#*=}"
  total=$((total + 1))
  case "$value" in
    '""'|'') empty=$((empty + 1)); empty_names="${empty_names} ${name}" ;;
    *) bound=$((bound + 1)); echo "origin-vars: BOUND    ${name}" ;;
  esac
done

for name in $empty_names; do
  echo "::warning::origin-vars: EMPTY    ${name} -- that service is OFF in this deploy (degrade or RunPod path) and the deploy still succeeds. A forgotten variable and a deliberate opt-out render identically, so confirm this was intended (cf#489/cf#840/cf#850)."
done

echo "origin-vars: ${total} media-door var(s) in ${toml}: ${bound} bound, ${empty} empty."

# The contradiction. Checked LAST so the report above is printed even when this refuses.
if grep -q '^\[\[containers\]\]' "$toml"; then
  if grep -Eq '^VIDEO_FINISH_URL[[:space:]]*=[[:space:]]*""[[:space:]]*$' "$toml"; then
    echo "::error::report-origin-vars: this config binds a [[containers]] block AND renders VIDEO_FINISH_URL empty. The container is the door (cf#810), but src/video-finish-availability.ts reads a non-empty VIDEO_FINISH_URL as 'the tier is installed', so this deploy would degrade the assemble phase while a working door sits bound. Set the var (its VALUE is never fetched on this path, only its presence is read) or remove the [[containers]] block."
    exit 1
  fi
  echo "origin-vars: [[containers]] is bound and VIDEO_FINISH_URL is non-empty, so the finish tier reads as installed."
else
  echo "origin-vars: no [[containers]] block in this render, so VIDEO_FINISH_URL empty would be an ordinary off-state rather than a contradiction."
fi
