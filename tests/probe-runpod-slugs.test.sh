#!/bin/sh
# cf#934: the census and parse guards of scripts/probe-runpod-public-slugs.sh.
#
# OFFLINE AND DETERMINISTIC BY CONSTRUCTION. Every case here runs --classify-only, which makes no
# network calls, so this test cannot flake on RunPod's availability and never costs anything. The
# live half of that script (the 401/404 probe and its two controls) is deliberately NOT tested here:
# it depends on a third party, and a test that needs one is a test that gets skipped.
#
# What this pins, all of which are ways the sweep could silently cover a smaller population than the
# reader believes:
#   1 an unresolvable ENDPOINT_ID indirection FAILS rather than dropping the module
#   2 a module with no src/index.ts FAILS rather than being skipped
#   3 a resolvable indirection (ENDPOINT_ID = SOME_IDENT) is followed into the module's own src/
#   4 all three classes are counted and the arithmetic covers every module on disk
#   5 --classify-only emits NO liveness-fingerprint, so it can never be read as a clean sweep
#
# Usage: sh tests/probe-runpod-slugs.test.sh
set -eu

SCRIPT_UNDER_TEST="$(cd "$(dirname "$0")/.." && pwd)/scripts/probe-runpod-public-slugs.sh"
[ -x "$SCRIPT_UNDER_TEST" ] || { echo "FAIL: $SCRIPT_UNDER_TEST is not executable"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

pass=0
fail=0

ok() { echo "  ok: $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL: $1"; fail=$((fail + 1)); }

# Build a fixture tree: $1 = name. Returns the root on stdout.
new_fixture() {
  root="$WORK/$1"
  mkdir -p "$root/scripts"
  cp "$SCRIPT_UNDER_TEST" "$root/scripts/probe-runpod-public-slugs.sh"
  chmod +x "$root/scripts/probe-runpod-public-slugs.sh"
  mkdir -p "$root/modules"
  echo "$root"
}

add_module() { # root name filecontent
  mkdir -p "$1/modules/$2/src"
  printf '%s\n' "$3" > "$1/modules/$2/src/index.ts"
}

run_fixture() { # root -> writes $out, returns exit code
  out="$WORK/out.txt"
  set +e
  "$1/scripts/probe-runpod-public-slugs.sh" --classify-only >"$out" 2>&1
  code=$?
  set -e
  return $code
}

echo "1. an unresolvable ENDPOINT_ID indirection must FAIL, not silently drop the module"
root="$(new_fixture unresolvable)"
add_module "$root" good 'const ENDPOINT_ID = "infinitetalk";'
add_module "$root" broken 'const ENDPOINT_ID = MYSTERY_IDENT;'
if run_fixture "$root"; then
  bad "expected a non-zero exit, got 0"
else
  code=$?
  [ "$code" -eq 4 ] && ok "exit 4" || bad "expected exit 4, got $code"
  grep -q 'broken' "$WORK/out.txt" && ok "names the offending module" || bad "does not name the module"
  grep -q 'MYSTERY_IDENT' "$WORK/out.txt" && ok "names the unresolved identifier" \
    || bad "does not name the identifier"
fi

echo "2. a module with no src/index.ts must FAIL, not be skipped"
root="$(new_fixture nosrc)"
add_module "$root" good 'const ENDPOINT_ID = "infinitetalk";'
mkdir -p "$root/modules/hollow"
if run_fixture "$root"; then
  bad "expected a non-zero exit, got 0"
else
  code=$?
  [ "$code" -eq 4 ] && ok "exit 4" || bad "expected exit 4, got $code"
  grep -q 'hollow' "$WORK/out.txt" && ok "names the unclassifiable module" || bad "does not name it"
fi

echo "3. a RESOLVABLE indirection is followed into the module's own src/"
root="$(new_fixture indirect)"
add_module "$root" narrator 'const ENDPOINT_ID = MODEL;'
printf '%s\n' 'export const MODEL = "minimax-speech-02-hd";' > "$root/modules/narrator/src/narrator.ts"
if run_fixture "$root"; then
  ok "exit 0"
  grep -q 'minimax-speech-02-hd' "$WORK/out.txt" && ok "resolved the slug through the identifier" \
    || bad "did not resolve the slug"
else
  bad "expected exit 0, got $?"
fi

echo "4. all three classes are counted and every module on disk is accounted for"
root="$(new_fixture classes)"
add_module "$root" pubslug 'const ENDPOINT_ID = "infinitetalk";'
add_module "$root" ourown 'interface Env { RUNPOD_ENDPOINT_ID: SecretsStoreSecret; }'
add_module "$root" elsewhere 'const MODEL = "@cf/some/model";'
if run_fixture "$root"; then
  ok "exit 0"
  grep -q '1 probed + 1 own-endpoint + 1 no-endpoint = 3 of 3 modules on disk' "$WORK/out.txt" \
    && ok "denominator sums and covers every module" || {
      bad "denominator wrong or missing"
      grep 'denominator' "$WORK/out.txt" || true
    }
  grep -q 'ourown' "$WORK/out.txt" && ok "names the own-endpoint door" || bad "own-endpoint door not named"
  grep -q 'elsewhere' "$WORK/out.txt" && ok "names the no-endpoint door" || bad "no-endpoint door not named"
else
  bad "expected exit 0, got $?"
fi

echo "5. --classify-only must NOT emit a liveness verdict it did not measure"
root="$(new_fixture noverdict)"
add_module "$root" pubslug 'const ENDPOINT_ID = "infinitetalk";'
if run_fixture "$root"; then
  if grep -q '^liveness-fingerprint:' "$WORK/out.txt"; then
    bad "emitted a liveness-fingerprint without probing; the workflow greps that line"
  else
    ok "no liveness-fingerprint line"
  fi
  grep -q 'nothing probed' "$WORK/out.txt" && ok "says plainly that nothing was probed" \
    || bad "does not say nothing was probed"
else
  bad "expected exit 0, got $?"
fi

echo
echo "probe-runpod-slugs.test.sh: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ] || exit 1
