#!/bin/bash
# cf#278 run 2: 10-second sampler over the four endpoints this lane owns.
# A single health read cannot tell a queue that never formed from one that formed and drained,
# so this is a TIME SERIES. Bounded on purpose: it stops on its own and says so.
set -u
: "${RUNPOD_API_KEY:?RUNPOD_API_KEY must be set}"
OUT="${1:?usage: sample-endpoints.sh <outfile> [max_samples] [interval]}"
MAX="${2:-540}"
IVL="${3:-10}"
EPS="backend:t9wcvlxh8rc5la musetalk:zw6pt4lymf69pk video-upscale:4q8idwbk6tyqbq audio-upscale:sj0btgpjdtswa7"

printf 'ts\tendpoint\tcompleted\tfailed\tretried\tinQueue\tinProgress\tready\trunning\tidle\tthrottled\tunhealthy\tinitializing\n' > "$OUT"
for i in $(seq 1 "$MAX"); do
  ts=$(date -u +%H:%M:%S)
  for pair in $EPS; do
    nm="${pair%%:*}"; id="${pair##*:}"
    body=$(curl -sS -H "Authorization: Bearer $RUNPOD_API_KEY" "https://api.runpod.ai/v2/$id/health" 2>/dev/null)
    if [ -z "$body" ]; then
      printf '%s\t%s\tPROBE_FAILED -- state UNKNOWN, NOT assumed clean\n' "$ts" "$nm" >> "$OUT"
      continue
    fi
    printf '%s\t%s\t%s\n' "$ts" "$nm" "$(printf '%s' "$body" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("PARSE_FAIL -- state UNKNOWN"); raise SystemExit(0)
j = d.get("jobs", {}); w = d.get("workers", {})
print("\t".join(str(x) for x in [
    j.get("completed","?"), j.get("failed","?"), j.get("retried","?"),
    j.get("inQueue","?"), j.get("inProgress","?"),
    w.get("ready","?"), w.get("running","?"), w.get("idle","?"),
    w.get("throttled","?"), w.get("unhealthy","?"), w.get("initializing","?")]))')" >> "$OUT"
  done
  sleep "$IVL"
done
echo "SAMPLER DONE (bounded at ${MAX} samples)" >> "$OUT"
