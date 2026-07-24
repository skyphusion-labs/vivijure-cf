#!/bin/sh
# deploy-module-workers.sh -- wrangler deploy for module workers (tag release path).
#
# FINISH_SATELLITES_ONLY=1 (cf#197): deploy only modules listed in finish-satellite-modules.txt.
# Used when CORE_ONLY_DEPLOY=1 so finish RunPod proxy workers cannot drift from the studio tag.
#
# Requires: SECRETS_STORE_ID, VPC_VIDEO_FINISH_ID, VPC_AUDIO_BEAT_SYNC_ID, VPC_AUDIO_MASTER_ID,
# CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (wrangler).
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -z "${SECRETS_STORE_ID:-}" ]; then
  echo "::error::SECRETS_STORE_ID repo variable is unset -- refusing to deploy modules with an unfilled store_id placeholder"
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
  sed -i "s/REPLACE_WITH_VIVIJURE_SECRETS_STORE_ID/${SECRETS_STORE_ID}/g" "$toml"
  sed -i "s/REPLACE_WITH_VPC_VIDEO_FINISH_ID/${VPC_VIDEO_FINISH_ID}/g;s/REPLACE_WITH_VPC_AUDIO_BEAT_SYNC_ID/${VPC_AUDIO_BEAT_SYNC_ID}/g;s/REPLACE_WITH_VPC_AUDIO_MASTER_ID/${VPC_AUDIO_MASTER_ID}/g" "$toml"
  if grep -q "REPLACE_WITH_" "$toml"; then
    echo "::error::store_id placeholder survived in $toml"
    exit 1
  fi
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
