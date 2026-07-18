#!/usr/bin/env bash
# dev-modbound.sh -- stand up a MODULE-BOUND local vivijure studio dev env (issue #411 dev-parity fix).
#
# WHY: a stripped `wrangler dev --local` drops every MODULE_* service binding, so GET /api/modules
# returns modules:[] and no render/audio/module-dependent flow can be driven. This runs the core +
# every in-tree module worker together as ONE multi-worker local dev, so the registry discovers the
# REAL catalog from each module static GET /module.json manifest.
#
# SAFETY (by construction):
#   - Fully LOCAL: local D1 + local R2, zero remote bindings. Prod D1/R2 are NOT reachable.
#   - ZERO GPU / provider spend: module dev configs are binding-FREE, so a module serves its real
#     manifest (real config_schema -> full projection) but has NO RunPod key / AI / R2. Any accidental
#     POST /invoke is inert and fails safe. No job can reach a GPU from here.
#
# STUBBED (intentional): AI binding (plan-validator LLM re-prompt -- Workers AI is remote-only and the
#   crew token cannot edge-preview); module invoke backends; the 4 VPC finish services; tail consumer;
#   ratelimits; crons; MODULE_DISPATCH.
#
# SCENARIOS (cf#62): the planning-model catalog is PROJECTED from installed plan.enhance modules, so
# the interesting states are states of the INSTALLED SET. Pick one with SCENARIO=<name>:
#
#   default     (unset) every in-tree module. plan-enhance serves the planning catalog.
#   empty       plan-enhance NOT bound -> GET /api/storyboard/models serves []. Exercises the
#               authored empty state against a genuinely empty catalog, not a stubbed one.
#   thirdparty  in-tree modules + acme-planner (declares its own enum) + bespoke-planner (declares
#               NO model enum, so its MODULE NAME is the model id). Exercises third-party listing,
#               third-party routing, and the byName branch through the real UI.
#   staleid     thirdparty + legacy-planner, whose ids vanish in every other scenario. Save a
#               project pref on a legacy/* id here, restart into `default`, and the saved id is
#               REALLY gone -- the un-stubbable stale-id case.
#
# Switching scenario = restart. That is deliberate: a restart is a fresh isolate, which also clears
# the core's per-isolate module-discovery cache (60s TTL), so the catalog change is immediate rather
# than something you wait out and misread as a bug.
#
# USAGE:  SCENARIO=thirdparty bash .dev-modbound/dev-modbound.sh [PORT]   (default 8790)
#         run from repo root, needs npx+python3.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
PORT="${1:-8790}"
SCENARIO="${SCENARIO:-default}"
case "$SCENARIO" in default|empty|thirdparty|staleid) ;; *)
  echo "unknown SCENARIO '$SCENARIO' (default|empty|thirdparty|staleid)" >&2; exit 2 ;; esac
D="$(pwd)/.dev-modbound"; mkdir -p "$D/mods"
rm -f "$D"/mods/*.toml            # scenarios differ by which modules exist; never inherit a stale set
echo "scenario: $SCENARIO"

python3 - "$SCENARIO" <<PY
import pathlib, sys
scenario = sys.argv[1]
src = pathlib.Path("wrangler.toml.example").read_text().splitlines()
drop = {"[[ratelimits]]","[triggers]","[[vpc_services]]","[[routes]]","[[migrations]]","[ai]"}
out, skip = [], False
for ln in src:
    s = ln.strip()
    if s.startswith("tail_consumers"): continue
    if s in drop: skip = True; continue
    if skip:
        if s == "" or (s.startswith("[") and s not in drop):
            skip = False
            if not (s.startswith("[") and s not in drop): continue
        else: continue
    out.append(ln)
t = "\n".join(out)
t = t.replace("\${D1_DATABASE_ID}","dev-local-modbound")
t = t.replace("\${AUTH_MODE}","").replace("\${ACCESS_TEAM_DOMAIN}","").replace("\${ACCESS_AUD}","")
t = t.replace("[vars]\n","[vars]\nALLOW_UNAUTHENTICATED = \"true\"\nPLANNER_AI_MOCK = \"true\"\n",1)

# The planning catalog is projected from the INSTALLED plan.enhance modules, so each scenario is
# expressed as which module service bindings exist -- not as a flag the studio reads. That keeps the
# harness honest: the studio behaves exactly as it would with these modules really installed.
if scenario == "empty":
    # Drop the MODULE_PLANENHANCE service binding entirely -> nothing serves plan.enhance.
    lines, out2, i = t.splitlines(), [], 0
    while i < len(lines):
        if lines[i].strip() == "[[services]]" and i + 1 < len(lines) and 'MODULE_PLANENHANCE"' in lines[i+1]:
            i += 2
            while i < len(lines) and lines[i].strip() != "" and not lines[i].strip().startswith("["):
                i += 1
            continue
        out2.append(lines[i]); i += 1
    t = "\n".join(out2)

FIXTURES = {
    "thirdparty": [("MODULE_ACMEPLANNER", "acme-planner"), ("MODULE_BESPOKEPLANNER", "bespoke-planner")],
    "staleid":    [("MODULE_ACMEPLANNER", "acme-planner"), ("MODULE_BESPOKEPLANNER", "bespoke-planner"),
                   ("MODULE_LEGACYPLANNER", "legacy-planner")],
}
extra = "".join(
    '\n[[services]]\nbinding = "%s"\nservice = "%s"\n' % (b, svc)
    for b, svc in FIXTURES.get(scenario, [])
)
if extra:
    t = t.rstrip() + "\n" + extra

pathlib.Path("wrangler.toml").write_text(t); print("rendered ./wrangler.toml (scenario: %s)" % scenario)
PY

python3 - "$D" "$SCENARIO" <<PY
import pathlib, re, sys
D = pathlib.Path(sys.argv[1]); scenario = sys.argv[2]
services = set(re.findall(r"^service = \"([^\"]+)\"", pathlib.Path("wrangler.toml").read_text(), re.M))
made=[]
for cfg in sorted(pathlib.Path("modules").glob("*/wrangler.toml")):
    txt=cfg.read_text()
    name=re.search(r"^name = \"([^\"]+)\"",txt,re.M); main=re.search(r"^main = \"([^\"]+)\"",txt,re.M)
    cdate=re.search(r"^compatibility_date = \"([^\"]+)\"",txt,re.M); cflags=re.search(r"^compatibility_flags = (\[[^\]]*\])",txt,re.M)
    if not (name and main) or name.group(1) not in services or main.group(1).endswith(".py"): continue
    abs_main=(cfg.parent/main.group(1)).resolve()
    lines=[f"name = \"{name.group(1)}\"", f"main = \"{abs_main}\""]
    if cdate: lines.append(f"compatibility_date = \"{cdate.group(1)}\"")
    if cflags: lines.append(f"compatibility_flags = {cflags.group(1)}")
    lines.append("workers_dev = false")
    # PLANNER_AI_MOCK moved from the CORE to the MODULE in cf#62: once the planner became a module
    # invoker, every model call lives behind the module boundary, so the core's copy of this var no
    # longer reaches any code path. Setting it on the core alone would leave #411's dev-parity flow
    # silently dead -- the module would try a real AI call, and this fleet has no AI binding by
    # design, so plan/refine would honest-degrade instead of driving the validator state machine.
    # Still binding-free: a var is not a service/GPU/R2 binding, so the safety property holds.
    lines.append('[vars]')
    lines.append('PLANNER_AI_MOCK = "true"')
    (D/"mods"/(name.group(1)+".toml")).write_text("\n".join(lines)+"\n"); made.append(name.group(1))

# Fixture planning modules (dev-only third parties). Same treatment: real manifest, real /invoke.
FIXTURES = {
    "thirdparty": ["acme-planner", "bespoke-planner"],
    "staleid":    ["acme-planner", "bespoke-planner", "legacy-planner"],
}
for fx in FIXTURES.get(scenario, []):
    main = (D/"fixtures"/(fx+".mjs")).resolve()
    if not main.exists():
        raise SystemExit(f"fixture worker missing: {main}")
    (D/"mods"/(fx+".toml")).write_text(
        f'name = "{fx}"\nmain = "{main}"\n'
        'compatibility_date = "2026-06-01"\nworkers_dev = false\n'
    )
    made.append(fx)
print(f"generated {len(made)} module dev configs")
PY

# DRY_RUN=1 renders the configs and stops. Lets you verify WHICH modules a scenario actually binds
# before spending a fleet boot on it -- the scenario is the whole experiment, so a silent mis-render
# would invalidate the run it is meant to support.
if [ "${DRY_RUN:-}" = "1" ]; then
  echo "DRY_RUN: rendered configs only, not launching."
  echo "core plan.enhance service bindings:"
  grep -B1 'service = "\(vivijure-module-plan-enhance\|acme-planner\|bespoke-planner\|legacy-planner\)"' wrangler.toml || echo "  (none)"
  echo "module dev configs:"
  for f in "$D"/mods/*.toml; do [ -e "$f" ] && echo "  $(basename "$f")"; done
  exit 0
fi

npx wrangler d1 migrations apply DB --local >/dev/null 2>&1 || true
FLAGS=""; for f in "$D"/mods/*.toml; do FLAGS="$FLAGS -c $f"; done
echo "launching module-bound dev on http://127.0.0.1:$PORT ..."
exec npx wrangler dev -c wrangler.toml $FLAGS --port "$PORT" --ip 127.0.0.1
