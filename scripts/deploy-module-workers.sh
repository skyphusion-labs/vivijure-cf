#!/bin/sh
# deploy-module-workers.sh -- wrangler deploy for module workers (tag release path).
#
# FINISH_SATELLITES_ONLY=1 (cf#197): deploy only modules listed in finish-satellite-modules.txt.
# Used when CORE_ONLY_DEPLOY=1 so finish RunPod proxy workers cannot drift from the studio tag.
#
# Requires: SECRETS_STORE_ID, D1_DATABASE_ID, VPC_VIDEO_FINISH_ID, VPC_AUDIO_BEAT_SYNC_ID,
# VPC_AUDIO_MASTER_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (wrangler).
#
# OPTIONAL (cf#482): VPC_FINISH_UPSCALE_ID, VPC_SPEECH_UPSCALE_ID, and their cf#507 second-door
# siblings VPC_FINISH_UPSCALE_PROPAGANDHI_ID / VPC_SPEECH_UPSCALE_PROPAGANDHI_ID. Unset is the NORMAL state and
# deploys unchanged -- the module keeps its RunPod path and its [[vpc_services]] block is stripped.
# Set one only when the matching connectivity-directory service exists (cf#480).
#
# Placeholder filling lives in scripts/fill-module-placeholders.sh so it is reachable by
# tests/deploy-placeholders-cf482.test.ts. This script runs ONLY on a tag deploy, which is the
# worst possible moment to discover a defect in it.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -z "${SECRETS_STORE_ID:-}" ]; then
  echo "::error::SECRETS_STORE_ID repo variable is unset -- refusing to deploy modules with an unfilled store_id placeholder"
  exit 1
fi
# cf#279: the 6 RunPod-polling modules bind the studio D1 as TELEMETRY_DB. Same repo SECRET the core
# render already uses, so this adds no new deploy configuration -- but an unset value would leave the
# placeholder in place, and a dangling binding fails the deploy anyway. Fail here with the reason.
if [ -z "${D1_DATABASE_ID:-}" ]; then
  echo "::error::D1_DATABASE_ID is unset -- refusing to deploy a module with an unfilled TELEMETRY_DB database_id (cf#279)"
  exit 1
fi
for v in VPC_VIDEO_FINISH_ID VPC_AUDIO_BEAT_SYNC_ID VPC_AUDIO_MASTER_ID; do
  eval "vv=\${$v:-}"
  if [ -z "$vv" ]; then
    echo "::error::$v repo secret is unset -- refusing to deploy a module with an unfilled VPC service_id (#520)"
    exit 1
  fi
done

finish_satellite() {
  grep -qxF "$1" scripts/finish-satellite-modules.txt
}

EXCLUDE="${EXCLUDE:-}"
deployed=0
found=0
for toml in modules/*/wrangler.toml; do
  [ -f "$toml" ] || continue
  found=$((found + 1))
  module=$(basename "$(dirname "$toml")")
  skip=0
  if [ "${FINISH_SATELLITES_ONLY:-0}" = "1" ]; then
    finish_satellite "$module" || skip=1
  fi
  for ex in $EXCLUDE; do
    [ "$module" = "$ex" ] && skip=1
  done
  if [ "$skip" -eq 1 ]; then
    echo "Skipping vivijure-module-${module}"
    continue
  fi
  echo "Deploying vivijure-module-${module}..."
  # cf#482: one seam for every placeholder, required and optional, plus a COMMENT-AWARE survivor
  # check that names what survived and where. The old inline version used a bare
  # `grep -q "REPLACE_WITH_"`, which matches inside a `#` comment and `exit 1`s the whole loop, so
  # a single commented-out example block in one module toml failed the deploy for every module
  # after it -- and its message said "store_id placeholder survived" while guarding five families.
  sh "$ROOT/scripts/fill-module-placeholders.sh" "$toml"
  n=0
  until npx wrangler deploy -c "$toml"; do
    n=$((n + 1))
    [ "$n" -ge 3 ] && { echo "::error::module ${module} failed to deploy after 3 attempts"; exit 1; }
    echo "  transient deploy failure for ${module} -- retry ${n}/3"
    sleep 3
  done
  deployed=$((deployed + 1))
done
if [ "$found" -eq 0 ]; then
  echo "::error::no modules/*/wrangler.toml found"
  exit 1
fi
echo "Deployed ${deployed} module worker(s) of ${found} module dir(s)."
