#!/bin/bash
# Wait for one RunPod job to reach a terminal state. Emits every poll's status so a hang is visible.
set -u
: "${RUNPOD_API_KEY:?}"
EP="${1:?endpoint}"; JOB="${2:?job}"; MAX="${3:-180}"
for i in $(seq 1 "$MAX"); do
  s=$(curl -sS -H "Authorization: Bearer $RUNPOD_API_KEY" "https://api.runpod.ai/v2/$EP/status/$JOB" \
      | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("status","PARSE_FAIL"))
except Exception: print("PARSE_FAIL")')
  case "$s" in
    COMPLETED|FAILED|CANCELLED|TIMED_OUT) echo "TERMINAL $JOB $s"; exit 0 ;;
    PARSE_FAIL) echo "POLL_FAIL $JOB -- state UNKNOWN" ;;
  esac
  sleep 20
done
echo "WAITER BOUNDED OUT after $MAX polls; last status $s"
