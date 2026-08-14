#!/usr/bin/env bash
# Zero-spend existence check for RunPod public-endpoint slugs.
#
# GET /v2/<slug>/health with NO auth and NO /run:
#   401 + "no token provided"  => endpoint exists (auth required; no job, no spend)
#   404 + "endpoint not found" => endpoint does not exist
# anything else                => print and leave exit non-zero so CI/humans notice
#
# Docs: docs/runpod-public-endpoint-slugs.md  (cf#267)
set -euo pipefail

BASE="${RUNPOD_API_BASE:-https://api.runpod.ai/v2}"

# Default: cloud cost-door motion slugs hardcoded in modules/*/src/index.ts
DEFAULT_SLUGS=(
  minimax-hailuo-2-3-fast
  google-veo3-1-fast-i2v
  seedance-v1-5-pro-i2v
  kling-v2-1-i2v-pro
  vidu-q3-i2v
  wan-2-6-i2v
  wan-2-2-t2v-720-lora
)

if [[ $# -gt 0 ]]; then
  SLUGS=("$@")
else
  SLUGS=("${DEFAULT_SLUGS[@]}")
  # Negative control so a global 401 outage cannot look like "all exist"
  SLUGS+=("definitely-not-a-slug-xyz")
fi

exists=0
missing=0
weird=0

printf '%-36s %-6s %s\n' "slug" "http" "verdict"
printf '%-36s %-6s %s\n' "----" "----" "-------"

for slug in "${SLUGS[@]}"; do
  # shellcheck disable=SC2086
  body_file=$(mktemp)
  code=$(curl -sS -o "$body_file" -w '%{http_code}' --max-time 15 \
    "${BASE}/${slug}/health" || echo "000")
  body=$(tr -d '\n' <"$body_file" | head -c 200)
  rm -f "$body_file"

  case "$code" in
    401)
      verdict="EXISTS (auth required; no spend)"
      exists=$((exists + 1))
      ;;
    404)
      verdict="MISSING"
      missing=$((missing + 1))
      ;;
    *)
      verdict="UNEXPECTED ($body)"
      weird=$((weird + 1))
      ;;
  esac
  printf '%-36s %-6s %s\n' "$slug" "$code" "$verdict"
done

echo
echo "summary: exists=$exists missing=$missing unexpected=$weird"
echo "note: this does not POST /run and does not confirm pricing or COMPLETED payload shape."

if [[ "$weird" -gt 0 ]]; then
  exit 2
fi
# Negative control must be missing when using defaults
if [[ $# -eq 0 && "$missing" -lt 1 ]]; then
  echo "error: expected negative-control slug to be MISSING; refusing a false all-green" >&2
  exit 3
fi
exit 0
