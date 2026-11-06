#!/bin/sh
# deploy-plan.sh -- the parts of deploy.sh that decide WHAT to deploy, with no network and no wrangler.
#
# cf#880 (DP-3). deploy.sh said "a binding can never dangle" and kept a hand list of modules to
# deploy. The list drifted from the core template both ways: it named a module that no longer exists
# (kling, so step 3 died on the missing toml), and it left out eight modules the core binds
# (infinitetalk, chatterbox, cf-hailuo, cf-veo, cf-p-video-avatar, cf-kling-v4, cf-minimax-h3,
# alibaba-wan-lora), so the core deploy could not bind them on a fresh account. A list that has to be
# kept equal to another file by hand is a list that will not be. So the module set is DERIVED here from
# the template, after the same strip the core render uses, and a module the core binds is a module this
# deploy ships, by construction.
#
# Split out of deploy.sh for one reason: deploy.sh needs a Cloudflare account to run at all, so nothing
# in it is exercised before a self-host tries it. Everything here is pure text in, text out, and
# tests/deploy-plan-cf880.test.ts drives THIS script.
#
#   strip   TEMPLATE SAT LGPU BLENDER   the template with the unwanted blocks removed (stdout)
#   modules TEMPLATE SAT LGPU BLENDER   the module names the stripped template binds, one per line
#   secrets TOML...                     "<secret_name> <toml>" for every live secrets store binding
#   missing LIST TOML...                the bound secret names absent from LIST (a store listing)
#
# SAT / LGPU / BLENDER are 1 to keep that block and 0 to strip it:
#   SELFHOST-SKIP   our-fleet-only blocks, always stripped here
#   SATELLITE       the opt-in GPU finish satellites (VIVIJURE_PROFILE=satellites)
#   LOCAL-GPU       the local-GPU door (INSTALL_LOCAL_GPU=1)
#   BLENDER         finish-blender (BLENDER_RUNPOD_ENDPOINT_ID set)
#
# `missing` exits 0 when nothing is missing, 3 when something is, and 2 when LIST is empty: an empty
# listing means the store could not be read, which proves nothing about what it holds.
set -eu

cmd="${1:?usage: deploy-plan.sh strip|modules|secrets|missing ...}"
shift

strip_template() {
  awk -v sat="$2" -v lgpu="$3" -v blender="$4" '
    /^# >>> SELFHOST-SKIP:/ { skip=1; next }
    /^# <<< SELFHOST-SKIP:/ { skip=0; next }
    /^# >>> SATELLITE:/      { skip=(sat==1?0:1); next }
    /^# <<< SATELLITE:/      { skip=0; next }
    /^# >>> LOCAL-GPU:/      { skip=(lgpu==1?0:1); next }
    /^# <<< LOCAL-GPU:/      { skip=0; next }
    /^# >>> BLENDER:/        { skip=(blender==1?0:1); next }
    /^# <<< BLENDER:/        { skip=0; next }
    !skip { print }
  ' "$1"
}

# Live lines only: a commented example of a binding binds nothing.
live() { grep -vE '^[[:space:]]*#' "$1" || true; }

case "$cmd" in
  strip)
    [ "$#" -eq 4 ] || { echo "usage: deploy-plan.sh strip TEMPLATE SAT LGPU BLENDER" >&2; exit 1; }
    strip_template "$@"
    ;;
  modules)
    [ "$#" -eq 4 ] || { echo "usage: deploy-plan.sh modules TEMPLATE SAT LGPU BLENDER" >&2; exit 1; }
    strip_template "$@" | grep -vE '^[[:space:]]*#' \
      | sed -n -E 's/^service[[:space:]]*=[[:space:]]*"vivijure-module-([a-z0-9-]+)".*/\1/p' | sort -u
    ;;
  secrets)
    for toml in "$@"; do
      [ -f "$toml" ] || { echo "no such toml: $toml" >&2; exit 1; }
      live "$toml" | sed -n -E 's/^secret_name[[:space:]]*=[[:space:]]*"([A-Za-z0-9_]+)".*/\1/p' \
        | sort -u | while read -r name; do printf '%s %s\n' "$name" "$toml"; done
    done
    ;;
  missing)
    list="${1:?usage: deploy-plan.sh missing LIST TOML...}"
    shift
    [ -s "$list" ] || { echo "the store listing is empty, so it cannot show what is missing" >&2; exit 2; }
    out=""
    for name in $(sh "$0" secrets "$@" | cut -d' ' -f1 | sort -u); do
      # Word-exact, so CF_AIG_TOKEN is not found inside PLAN_ENHANCE_CF_AIG_TOKEN.
      if ! grep -qw -- "$name" "$list"; then out="$out $name"; fi
    done
    [ -z "$out" ] && exit 0
    for name in $out; do echo "$name"; done
    exit 3
    ;;
  *)
    echo "deploy-plan.sh: unknown command $cmd" >&2
    exit 1
    ;;
esac
