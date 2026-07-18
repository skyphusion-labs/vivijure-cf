# Module-bound local dev (the real module catalog, no GPU)

A plain `wrangler dev` for the studio core boots with `GET /api/modules` returning `modules:[]`,
because the `MODULE_*` service bindings point at module workers that are not running. With an empty
catalog the planner cannot drive any render / audio / module-dependent flow. This recipe runs the core
**and every in-tree module worker together** as one multi-worker local dev, so the registry discovers
the **real catalog** from each module static `GET /module.json` manifest.

## What you get

- `GET /api/modules` returns the real module catalog (full `config_schema` / `provides` / `ui` /
  `cancelable`), so the registry projection, render-config controls, and tier pickers render from real
  data instead of fixtures.
- Local D1 (migrated) + local R2, so history, projects, cast, prefs, persistence, uploads, and artifact
  serving work against a disposable local store. **Prod D1 / R2 are never touched.**

## Safety (by construction)

- **Fully local.** Local D1 + local R2, no remote bindings. Production is not reachable from this env.
- **Zero GPU / provider spend.** The generated module dev configs are binding-FREE: a module serves its
  real manifest but has no RunPod key / AI / R2, so any accidental `POST /invoke` is inert and fails
  safe. No job can reach a GPU from here.

## Run it

```
bash .dev-modbound/dev-modbound.sh [PORT]     # default port 8790
SCENARIO=thirdparty bash .dev-modbound/dev-modbound.sh
DRY_RUN=1 SCENARIO=empty bash .dev-modbound/dev-modbound.sh   # render + report, do not launch
```

The script (idempotent) renders the core dev config from `wrangler.toml.example`, generates a minimal
binding-free dev config per module, applies the D1 migrations to the local database, and launches the
fleet. Open `http://127.0.0.1:PORT/planner`.

## Plan-validator flow without a live model

Workers AI is remote-only and a fully-local dev fleet has no AI binding, so the script sets
`PLANNER_AI_MOCK="true"`.

**The mock lives in the MODULE now (cf#62), not the core.** Once the planner became a module invoker,
every model call moved behind the module boundary, so the core's copy of this var no longer reaches
any code path; the script therefore sets it on each generated MODULE dev config (see
`modules/plan-enhance/src/mock.ts`). Setting it only on the core would leave this flow silently dead:
the module would attempt a real AI call, this fleet has no AI binding by design, and plan/refine would
honest-degrade instead of driving the validator state machine.

With it on, plan / refine return deterministic canned completions that still run the **real** parse /
validate pipeline, so you can drive the whole submit -> validate -> re-prompt -> resubmit state
machine. Steer the branch with a sentinel in the brief or refine instruction:

- (no sentinel) -> a valid storyboard (the pass branch).
- `#mock-fail` -> a storyboard that fails validation (the reject / re-prompt branch).
- `#mock-badjson` -> non-JSON output (the "model output was not valid JSON" branch).

`PLANNER_AI_MOCK` is unset in prod; the live provider path is unchanged. This mock is dev-only and is
NOT a Workers AI stand-in.

## Catalog scenarios (`SCENARIO=`, cf#62)

The planning-model catalog is **projected from the installed plan.enhance modules**, so the states
worth testing are states of the *installed set*, not flags the studio reads. Each scenario changes
which module service bindings exist, so the studio behaves exactly as it would with those modules
really installed.

| `SCENARIO` | installed plan.enhance modules | what it exercises |
|---|---|---|
| `default` (unset) | `plan-enhance` | the normal catalog |
| `empty` | *none* | `GET /api/storyboard/models` serves `[]`; the authored empty state against a genuinely empty catalog |
| `thirdparty` | `plan-enhance`, `acme-planner`, `bespoke-planner` | third-party models listed + routed; `bespoke-planner` declares **no** model enum, so its module NAME is the model id (the `byName` branch) |
| `staleid` | above + `legacy-planner` | ids that really disappear: save a project pref on a `legacy/*` id, restart into another scenario, and the saved id is genuinely gone |

Fixture modules live in `.dev-modbound/fixtures/` and are dev-only -- never bound in a deployed
environment. They serve real `vivijure-module/2` manifests and answer `POST /invoke` over the real
hook, so only the far side of the module boundary is a stand-in; nothing about the studio is stubbed.
Their manifests are conformance-tested in `tests/dev-fixtures.test.ts`, because a fixture whose
manifest failed validation would be **skipped silently** by the registry and would look exactly like a
backend defect during a parity run.

**Switching scenario means restarting**, which is deliberate: a restart is a fresh isolate, so the
core's per-isolate module-discovery cache (60s TTL) is cleared too and the catalog change is immediate
rather than something you wait out and misread as a bug. Stop the previous fleet properly first --
see below, it is less obvious than it looks.

## Stopping the fleet (read this before switching scenario)

**A quiet port is not a stopped fleet.** `wrangler dev` runs a process TREE: the launcher, an `npm
exec` wrapper, the wrangler CLI, an esbuild service, and one or more `workerd` processes. Only the
last of those holds the port. Kill the port-holder and the port frees immediately, the fleet LOOKS
down -- and the rest of the tree is still alive. Observed while running the cf#62 parity gate: three
scenario switches, each stopping "the studio" by its port, left **24 orphaned processes**; the next
launch then collided or bound a stale isolate.

Stop it by PID, from the launch you recorded, not by the port:

```
# record the pid AT LAUNCH
nohup env SCENARIO=thirdparty bash .dev-modbound/dev-modbound.sh 8795 > dev.log 2>&1 &
echo $! > /tmp/studio.pid

# ...and stop the whole tree later
kill $(cat /tmp/studio.pid)
```

If you have lost the pid, enumerate by the worktree path and check each one before signalling it:

```
for p in $(ps -u "$USER" -o pid=); do
  # brace-group the redirect: a pid that exits between ps and the read would otherwise print
  # "/proc/<pid>/cmdline: No such file or directory" (2>/dev/null on tr alone does not catch it).
  args=$( { tr '\0' ' ' < /proc/$p/cmdline; } 2>/dev/null )
  case "$args" in *"$(pwd)"*) echo "$p: ${args:0:70}" ;; esac
done
```

Two hard rules, both learned the expensive way on a crew box:

- **Never `pkill -f`.** A crew box runs many concurrent dev servers and `sudo` wrappers; the pattern
  you think is specific to your fleet also matches other sessions' command lines, including your own
  parent shell. Enumerate, print, confirm, then kill by explicit PID.
- **Confirm ownership before signalling anything.** Check the process user and its `/proc/<pid>/cwd`
  against YOUR worktree. Another crew member's `wrangler dev` on a neighbouring port looks identical
  in `ps` output. If it is not provably yours, leave it and say something.

After stopping, verify the tree is actually gone rather than trusting the port:

```
ss -ltn | grep ":8795 "                       # expect no output
ps -u "$USER" -o pid=,args= | grep "$(pwd)"   # expect no output
```

## What is stubbed, and why

Not needed to populate the catalog; dropped from the local render: module invoke backends (RunPod GPU,
provider APIs, module R2 writes), the 4 Workers-VPC finish services (`VIDEO_FINISH` / `IMAGE_PREP` /
`AUDIO_BEAT_SYNC` / `AUDIO_MIX`), the tail consumer, ratelimits, crons, and `MODULE_DISPATCH`. A real
render / audio / finish submit is therefore inert here; run those against a properly provisioned deploy,
never from this env.

## Seeding history / artifacts

The local D1 is fresh. Seed rows with `wrangler d1 execute DB --local --file=seed.sql` and put artifacts
in the local R2 bucket `vivijure` under an `ARTIFACT_PREFIXES` key (e.g. `renders/`; the artifact handler
404s other prefixes). The renders list endpoint is single-tenant locally, so any seeded row shows.
