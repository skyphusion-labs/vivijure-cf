#!/usr/bin/env bash
# Render door guard-coverage sweep (cf#334).
#
# WHY THIS EXISTS. The shared pre-flight in src/render-door.ts holds one copy of guards that eight
# doors used to duplicate. That is the point of the extraction and it is also its risk: ONE bug now
# breaks EVERY door, where before it broke one. So each guard must have at least one test that goes
# RED when the guard is removed. A guard the suite cannot notice missing is strictly worse after the
# extraction than before it.
#
# HOW TO READ IT. Each row removes one guard, runs the suite, and restores.
#   COVERED   -- the suite went red. The guard has real coverage.
#   UNCOVERED -- the suite stayed green without it. Add a test before shipping.
#   BROKEN    -- the mutation did not COMPILE, so its result is not evidence at all.
#   SKIP      -- the mutation anchor no longer matches the source. Fix the anchor, never the reporting.
#
# THE BROKEN BAND IS NOT DECORATION. Before it existed, one row read COVERED for three slices because
# its mutation left dangling syntax: the suite failed to PARSE rather than failing the guard, and a
# parse error, an import error and a real assertion failure all present as the same non-zero exit.
# Typechecking the mutated tree first is what separates "red because the guard fired" from "red for
# any other reason". Prefer mutations that cannot change type narrowing: remove a REFUSAL rather than
# a branch, since `if (false)` around a `const` can alter inference and fail to compile.
set -uo pipefail
cd "$(dirname "$0")/.."
F=src/render-door.ts
cp "$F" /tmp/render-door-sweep-door.bak
restore() { cp /tmp/render-door-sweep-door.bak "$F"; }
trap restore EXIT

probe() { # name  python-mutation
  python3 - "$2" <<'PY'
import sys, pathlib
p = pathlib.Path("src/render-door.ts")
s = p.read_text()
old, new = sys.argv[1].split("||||")
if s.count(old) != 1:
    sys.exit(f"MUTATION ANCHOR FAIL: {s.count(old)} occurrences of {old[:60]}")
p.write_text(s.replace(old, new))
PY
  if [ $? -ne 0 ]; then printf 'SKIP  %-42s mutation could not be applied\n' "$1"; restore; return; fi
  # A mutation that does not COMPILE tells us nothing: a parse error and a failing assertion are the
  # same exit status. Typecheck first, and report BROKEN rather than letting a syntax error read as
  # coverage. This is the defect that made the local-gpu pairing row a false positive for three slices.
  if ! npx tsc --noEmit >/tmp/render-door-sweep-tc.log 2>&1; then
    printf 'BROKEN    %-40s mutation does not compile, NOT evidence\n' "$1"
    restore
    return
  fi
  npm test >/tmp/render-door-sweep-cov.log 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf 'COVERED   %-40s suite went RED\n' "$1"
  else
    printf 'UNCOVERED %-40s suite stayed GREEN with the guard removed\n' "$1"
  fi
  restore
}

echo "=== baseline (must be green, or every row below is meaningless) ==="
npm test >/tmp/render-door-sweep-cov.log 2>&1 && echo "baseline GREEN" || echo "baseline RED -- STOP"

probe "bundle key required" 'if (!shape.bundleKey || typeof shape.bundleKey !== "string") {||||if (false) {'
probe "unsafe bundle key" 'if (!isSafeBundleKey(shape.bundleKey)) {||||if (false) {'
probe "#696 config map shape" 'const err = moduleConfigMapError(m.label, m.value, m.deep);||||const err = null as string | null; void m;'
probe "scenes required" 'if (profile.scenesInBody && (!Array.isArray(shape.scenes) || shape.scenes.length < (profile.minSceneCount ?? 1))) {||||if (false) {'
probe "scatter minSceneCount >= 2" 'shape.scenes.length < (profile.minSceneCount ?? 1)||||shape.scenes.length < 0'
probe "keyframe module 503" 'if (profile.requireKeyframeModule && servingForHook(input.modules, "keyframe").length === 0) {||||if (false) {'
probe "#500 motion backend preflight" 'const backendErr = motionBackendPreflightError(input.modules, input.motionBackend);||||const backendErr = null as string | null;'
probe "requireExplicitMotionBackend gate" 'if (profile.requireExplicitMotionBackend) {||||if (true) {'
probe "scenesInBody gate" 'if (profile.scenesInBody && (!Array||||if (true && (!Array'
probe "#577 motion config preflight" 'const cfgErr = motionConfigPreflightError(input.modules, effective, input.motionConfig);||||const cfgErr = null as string | null;'
probe "local-gpu keyframe pairing" '      if (pairErr) return bad(pairErr);||||      if (pairErr) { /* guard removed by mutation */ }'
probe "checkLocalGpuPairing gate" 'if (profile.checkLocalGpuPairing) {||||if (true) {'
probe "#738 untrained cast hard-fail" 'if (cast.skipped.length) return bad(untrainedCastMessage(cast.skippedDetail));||||void untrainedCastMessage;'
