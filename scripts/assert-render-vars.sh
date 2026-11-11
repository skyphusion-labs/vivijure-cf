#!/bin/sh
# cf#1382: refuse a hosted render when a variable it USES would render empty.
#
# Usage: sh scripts/assert-render-vars.sh <template> "<VARS shell-format list>"
# Env:   RENDER_EMPTY_ALLOW  space-separated names that are allowed to be empty.
#
# WHY. envsubst turns an UNSET variable into "", not into a leftover ${NAME}, so the render's
# placeholder grep passes and the deploy ships an empty value. On 2026-11-09 three live values
# (VIDEO_FINISH_URL, KEYFRAME_PARALLEL, PANEL_HOME) were not repo variables, and a tag deploy would
# have shipped them empty or defaulted. cf#850's report-origin-vars.sh REPORTS an empty door and
# fails only one contradiction, by ruling, because a self-host ships most doors empty. This script
# is for the HOSTED tag deploy only, where the live state is known and every empty is either on the
# allow-list or a forgotten variable.
#
# WHAT COUNTS AS USED. A name in the list whose ${NAME} appears on a non-comment line of the
# template. A listed name the template never reads (the VPC_* ids, cf#840) cannot reach the
# config, so its emptiness is not checked.
#
# It prints NAMES only, never a value: several of these come from repo secrets.
set -u

template="${1:-}"
list="${2:-}"
if [ -z "$template" ] || [ ! -f "$template" ]; then
  echo "::error::assert-render-vars: template not found: ${template:-<none>}"
  exit 2
fi
if [ -z "$list" ]; then
  echo "::error::assert-render-vars: empty VARS list"
  exit 2
fi

allow=" ${RENDER_EMPTY_ALLOW:-} "
used=$(grep -v '^[[:space:]]*#' "$template" | grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*\}' | sed 's/^\${//; s/}$//' | sort -u)

checked=0
allowed=""
missing=""
for raw in $list; do
  name="${raw#\$}"
  case "$name" in
    ''|*[!A-Za-z0-9_]*) echo "::error::assert-render-vars: bad name in VARS: $raw"; exit 2 ;;
  esac
  printf '%s\n' "$used" | grep -qx "$name" || continue
  checked=$((checked + 1))
  eval "value=\${$name-}"
  if [ -n "$value" ]; then continue; fi
  case "$allow" in
    *" $name "*) allowed="$allowed $name" ;;
    *) missing="$missing $name" ;;
  esac
done

if [ "$checked" -eq 0 ]; then
  echo "::error::assert-render-vars: no listed name is used by $template, so nothing was measured"
  exit 2
fi
echo "assert-render-vars: $checked used, empty by allow-list:${allowed:- none}"
if [ -n "$missing" ]; then
  for n in $missing; do echo "::error::$n would render EMPTY and is not on the allow-list (cf#1382)"; done
  exit 1
fi
exit 0
