#!/bin/bash
# Advance one or more film jobs and log each tick's phase. cf#278 phase 1 instrument.
#
# The studio's film endpoint is "advance + poll one tick": a film does not progress unless something
# polls it. This exists so a long render can proceed without a human driving it tick by tick.
#
# BOUNDED ON PURPOSE (MAX_TICKS): an unattended loop that runs forever is how a harness outlives the
# session that started it. It stops on its own and says so in the log.
#
# Credential comes from the environment, never from a path baked into the file.
#   VJ_STUDIO_TOKEN   required, studio API bearer
#   VJ_STUDIO_URL     optional, defaults to the public studio
#   MAX_TICKS         optional, default 60
#   TICK_SECONDS      optional, default 20
#
# Usage: VJ_STUDIO_TOKEN=... ./poll-films.sh film-<id> [film-<id> ...]
set -u

: "${VJ_STUDIO_TOKEN:?VJ_STUDIO_TOKEN must be set (studio API bearer)}"
BASE="${VJ_STUDIO_URL:-https://vivijure.skyphusion.org}"
MAX_TICKS="${MAX_TICKS:-60}"
TICK_SECONDS="${TICK_SECONDS:-20}"

if [ "$#" -eq 0 ]; then
  echo "usage: VJ_STUDIO_TOKEN=... $0 film-<id> [film-<id> ...]" >&2
  exit 2
fi

for tick in $(seq 1 "$MAX_TICKS"); do
  for f in "$@"; do
    # A transport failure must be VISIBLE and must never be mistaken for a phase. It prints
    # PARSE_FAIL rather than an empty string, because an empty phase column reads as "no news".
    ph=$(curl -sS -H "Authorization: Bearer $VJ_STUDIO_TOKEN" "$BASE/api/render/film/$f" \
      | python3 -c 'import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("PARSE_FAIL (transport or non-JSON response; NOT a phase)")
    raise SystemExit(0)
c = d.get("clips") or {}
print(d.get("phase", "?"), "clips=%s/%s failed=%s" % (c.get("done", "-"), c.get("total", "-"), c.get("failed", "-")))' 2>/dev/null)
    [ -n "$ph" ] || ph="EMPTY (curl produced nothing; state UNKNOWN)"
    echo "$(date -u +%H:%M:%S) ${f} ${ph}"
  done
  sleep "$TICK_SECONDS"
done
echo "POLLER DONE (bounded at ${MAX_TICKS} ticks)"
