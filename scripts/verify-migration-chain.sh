#!/usr/bin/env bash
# Apply the WHOLE auto-applied migration chain into a scratch sqlite db and assert the schema it
# builds. Complements scripts/verify-migration-squash.sh, which proves the squashed fresh-install
# path converges with prod history but stops at 0006 and says nothing about anything added since.
#
# WHY THIS EXISTS. `migrations/` has no gate in CI (no workflow references it, and the squash script
# is not wired to one either), so a migration is currently proved only by `wrangler d1 migrations
# apply` at deploy time -- i.e. in prod, after merge. A migration that does not apply, or that adds a
# column twice, is discovered by the deploy failing. This script runs the same chain locally in a
# second, with controls, and refuses by name.
#
# WHY IT CARRIES A NEGATIVE CONTROL. "renders.output_ms exists" proves nothing on its own: a broken
# introspection, a mistyped table name or a chain that silently failed to apply all read the same as
# a pass would if the assertion were only ever run one way. So every column assertion is run TWICE --
# once against the full chain (must be PRESENT) and once against the chain with the introducing
# migration excluded (must be ABSENT). A check that cannot produce the disconfirming result is not
# evidence.
#
# Requires: sqlite3 and bash 4+ (mapfile). Nothing else -- no python, no node, no deps.
#
# NOT WIRED TO CI, DELIBERATELY AND SAY SO. This ships as a hand-run instrument, not a gate.
# CI runs on ubuntu-latest, which does carry sqlite3, so wiring it is possible -- but a guard
# nobody has watched fail on a real defect is not a guard, and arming it belongs in the change
# that also decides what happens to scripts/verify-migration-squash.sh (equally unwired, and
# covering only 0001..0006). Until then: `migrations/` has NO automated gate. Do not read the
# presence of this file as coverage.
# Exit 0 = the chain applies and the schema is as declared below.
set -euo pipefail
cd "$(dirname "$0")/.."

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

# The numbered chain, in the order wrangler applies it. `migrations/manual/` is DELIBERATELY excluded:
# those are supervised out-of-band steps and are not part of what a fresh install builds.
mapfile -t CHAIN < <(find migrations -maxdepth 1 -name '[0-9]*.sql' | sort)
if [ "${#CHAIN[@]}" -lt 10 ]; then
  echo "REFUSE: found ${#CHAIN[@]} migrations, expected at least 10 -- the glob is wrong, not the repo" >&2
  exit 1
fi

apply_chain() {  # $1 = db path, $2 = basename to SKIP (empty = skip nothing)
  local db="$1" skip="$2" f
  for f in "${CHAIN[@]}"; do
    [ -n "$skip" ] && [ "$(basename "$f")" = "$skip" ] && continue
    if ! sqlite3 -bail "$db" < "$f" 2>"$T/err"; then
      echo "REFUSE: $f failed to apply: $(cat "$T/err")" >&2
      exit 1
    fi
  done
}

has_column() {  # $1 = db, $2 = table, $3 = column -> prints "yes"/"no"
  local n
  n="$(sqlite3 "$1" "SELECT COUNT(*) FROM pragma_table_info('$2') WHERE name='$3';")"
  [ "$n" -ge 1 ] && echo yes || echo no
}

apply_chain "$T/full.db" ""
echo "applied ${#CHAIN[@]} migrations (denominator, so an empty or truncated glob cannot read as a pass)"

fail=0
assert() {  # $1 = table, $2 = column, $3 = migration that introduces it ("" = 0001, no negative run)
  local table="$1" col="$2" introducer="$3" got want_absent db2
  got="$(has_column "$T/full.db" "$table" "$col")"
  if [ "$got" != "yes" ]; then
    echo "FAIL: $table.$col ABSENT after the full chain" >&2
    fail=1
    return
  fi
  if [ -z "$introducer" ]; then
    echo "ok   $table.$col present (positive control: predates the chain tail)"
    return
  fi
  # NEGATIVE CONTROL: rebuild without the introducing migration; the column must vanish. If it does
  # not, this assertion is incapable of failing and its PASS above meant nothing.
  db2="$T/without-$col.db"
  apply_chain "$db2" "$introducer"
  want_absent="$(has_column "$db2" "$table" "$col")"
  if [ "$want_absent" != "no" ]; then
    echo "FAIL: $table.$col still present with $introducer excluded -- this check cannot fail, so its pass is not evidence" >&2
    fail=1
    return
  fi
  echo "ok   $table.$col present, and ABSENT without $introducer (negative control fired)"
}

# POSITIVE CONTROLS: columns from 0001 that must always be there. If these go missing the chain did
# not really apply and every assertion below is meaningless.
assert renders execution_time_ms ""
assert renders delay_time_ms ""

# The columns this chain adds after 0001, each with its introducing migration named.
assert runpod_job_log error_type 0015_runpod_job_log_error_type.sql
assert renders          output_ms 0016_render_output_ms.sql
assert renders          motion_backend 0018_render_motion_backend.sql
assert renders          keyframe_backend 0018_render_motion_backend.sql

if [ "$fail" -ne 0 ]; then
  echo "MIGRATION CHAIN VERIFY: FAILED" >&2
  exit 1
fi
echo "MIGRATION CHAIN VERIFY: OK"
