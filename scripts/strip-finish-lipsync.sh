#!/bin/sh
# strip-finish-lipsync.sh -- remove the SATELLITE: finish-lipsync block from a HOSTED studio config.
#
# MuseTalk is homelab / self-host only. Hosted talking films keep native AV from our
# keyframes. Same shape as strip-local-gpu.sh: one script, every hosted render path.
#
# usage: scripts/strip-finish-lipsync.sh <in-config> <out-config>
#
# POSIX sh: ci.yml is node:22-alpine (ash), studio-release.yml is ubuntu-latest.

set -eu

if [ $# -ne 2 ]; then
  echo "usage: $0 <in-config> <out-config>" >&2
  exit 2
fi

IN="$1"
OUT="$2"

if [ ! -r "$IN" ]; then
  echo "::error::strip-finish-lipsync.sh cannot read '$IN'" >&2
  exit 1
fi
if [ ! -s "$IN" ]; then
  echo "::error::strip-finish-lipsync.sh was handed an EMPTY '$IN'" >&2
  exit 1
fi

before_mod=$(grep -c 'MODULE_' "$IN" || true)
if [ "$before_mod" -eq 0 ]; then
  echo "::error::'$IN' carries ZERO MODULE_ lines -- not a studio config" >&2
  exit 1
fi

awk '
  /^# >>> SATELLITE: finish-lipsync/ { skip=1; next }
  /^# <<< SATELLITE: finish-lipsync/ { skip=0; next }
  !skip { print }
' "$IN" > "$OUT"

if [ ! -s "$OUT" ]; then
  echo "::error::the finish-lipsync strip produced an EMPTY '$OUT'" >&2
  exit 1
fi

after_mod=$(grep -c 'MODULE_' "$OUT" || true)
if grep -q 'MODULE_LIPSYNC' "$OUT"; then
  echo "::error::finish-lipsync block survived the strip -- refusing to deploy hosted MuseTalk" >&2
  exit 1
fi

delta=$((before_mod - after_mod))
if [ "$delta" -eq 0 ]; then
  if grep -q 'MODULE_LIPSYNC' "$IN"; then
    echo "::error::MODULE_LIPSYNC was in the input but the strip removed 0 MODULE_ lines" >&2
    exit 1
  fi
  echo "finish-lipsync already absent: MODULE_ lines ${before_mod} (delta 0)"
  exit 0
fi
if [ "$delta" -ne 1 ]; then
  echo "::error::the finish-lipsync strip removed $delta MODULE_ lines, expected 0 or 1 (before=$before_mod after=$after_mod)" >&2
  exit 1
fi

echo "finish-lipsync stripped: MODULE_ lines ${before_mod} -> ${after_mod} (delta 1, as required)"
