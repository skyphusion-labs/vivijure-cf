#!/bin/sh
# strip-local-gpu.sh -- remove the LOCAL-GPU block from a HOSTED studio wrangler config, and REFUSE
# if the removal did not do exactly what it claims (cf#560).
#
# ONE DEFINITION, INVOKED BY EVERY HOSTED PATH. Same reason scripts/advance-studio-pin.sh exists as a
# script rather than as inline workflow YAML: a second copy is what lets the two drift. cf#560 is that
# drift already having happened once -- ci.yml carried a correct, passing, refusing gate while
# studio-release.yml rendered the same template with a bare envsubst and no strip at all, so a green
# gate on one path read as coverage of the invariant. ci.yml's own comment at the site of that fix
# says "The control existed and was on the wrong path"; the remedy for a control that can sit on the
# wrong path is not a better copy, it is not having copies.
#
# THE INVARIANT: the HOSTED studio never binds local-gpu. The door's own manifest blurb says
# "Self-host only ... Commercial use of Vivijure is supported via vivijure-cf (Cloudflare partner
# channels), not this door" -- and vivijure-cf IS the hosted studio, so binding it there contradicts
# the door's own licence text. Ruled three times.
#
# NOT EVERY RENDER OF wrangler.toml.example IS A HOSTED RENDER, and this script must not be bolted
# onto the ones that are not. deploy.sh is SELF-HOST, where local-gpu is ALLOWED, and it already
# strips the same block unless INSTALL_LOCAL_GPU=1. That inversion is the shape of the original
# defect: the path that PERMITS the door defaulted it off, and the path that FORBIDS it had no switch.
#
# usage: scripts/strip-local-gpu.sh <in-config> <out-config>
#
# POSIX sh on purpose: ci.yml runs this on node:22-alpine (busybox ash), studio-release.yml on
# ubuntu-latest. No bashisms, so the two cannot diverge on interpreter.

set -eu

if [ $# -ne 2 ]; then
  echo "usage: $0 <in-config> <out-config>" >&2
  exit 2
fi

IN="$1"
OUT="$2"

if [ ! -r "$IN" ]; then
  echo "::error::cf#560: strip-local-gpu.sh cannot read '$IN' -- refusing (an unreadable input is not an empty one)" >&2
  exit 1
fi
if [ ! -s "$IN" ]; then
  echo "::error::cf#560: strip-local-gpu.sh was handed an EMPTY '$IN' -- refusing (nothing to strip is a harness failure, not a clean pass)" >&2
  exit 1
fi

before_mod=$(grep -c 'MODULE_' "$IN" || true)

# IMPOSSIBLE-UNDER-ALL-HYPOTHESES FLOOR. A hosted studio template carries dozens of MODULE_ service
# bindings. Zero means we are reading the wrong file, or a caller handed us an already-mangled one --
# and every check below would then PASS vacuously, because absence is satisfied and the delta would
# merely be wrong. Refuse before measuring anything else.
if [ "$before_mod" -eq 0 ]; then
  echo "::error::cf#560: '$IN' carries ZERO MODULE_ lines -- refusing to strip a file that cannot be a studio config" >&2
  exit 1
fi

awk '
  /^# >>> LOCAL-GPU:/ { skip=1; next }
  /^# <<< LOCAL-GPU:/ { skip=0; next }
  !skip { print }
' "$IN" > "$OUT"

if [ ! -s "$OUT" ]; then
  echo "::error::cf#560: the LOCAL-GPU strip produced an EMPTY '$OUT' -- refusing" >&2
  exit 1
fi

after_mod=$(grep -c 'MODULE_' "$OUT" || true)

# TWO-SIDED GUARD. Absence alone is not enough, and the direction it cannot see is SILENT TRUNCATION.
#
# `skip` is set on the OPENING marker and cleared only on the CLOSING one, so a removed or renamed
# CLOSING marker leaves skip=1 to EOF. Driven: 481 lines -> 240, MODULE_ lines 41 -> 4, and the
# absence check PASSES -- because MODULE_LOCAL_GPU really is gone, eaten along with 37 other binding
# lines. Nothing downstream catches it either: every downstream-guarded key (AUTH_MODE, ACCESS_AUD,
# R2_S3_*, the secrets-store placeholder) lives BEFORE line 241, so all of them survive and all of
# them pass, and the placeholder check cannot fire because truncation REMOVES placeholders rather
# than adding them.
#
# The OTHER side is a VACUOUS strip: rename or delete the OPENING marker and the awk copies the file
# through untouched. The absence check catches that one, but only because the block is still there --
# so state the delta requirement explicitly rather than leaning on absence to imply it.
#
# So assert the DELTA, not the absence. Exactly one MODULE_ line may disappear.
if grep -q 'MODULE_LOCAL_GPU' "$OUT"; then
  echo "::error::cf#560: LOCAL-GPU block survived the strip -- refusing to deploy the hosted studio with local-gpu bound" >&2
  exit 1
fi
if [ "$((before_mod - after_mod))" -ne 1 ]; then
  echo "::error::cf#560: the LOCAL-GPU strip removed $((before_mod - after_mod)) MODULE_ lines, expected exactly 1 (before=$before_mod after=$after_mod) -- a marker is probably malformed and the strip ran past the block" >&2
  exit 1
fi

# The denominator sits in the SAME output as the verdict, deliberately: a bare "stripped ok" line
# cannot tell a reader whether the strip removed one binding or thirty-eight.
echo "LOCAL-GPU stripped: MODULE_ lines ${before_mod} -> ${after_mod} (delta 1, as required)"
