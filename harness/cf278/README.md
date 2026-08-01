# cf#278 phase 1 harness

**This is a phase-1 measurement instrument, not production code.** It is committed so the next person
to work cf#278 does not rebuild it, and so the mistakes already paid for are not paid for twice.

**It has NEVER been run against the hosted door.** Every result it has produced came from the prod
studio worker. Phase 1 resumes with the hosted door, and nothing here is proven there.

## Why the inventory is a UNION

`GET /api/modules` is authoritative for MODULES and is **not** authoritative for FEATURES. Cast LoRA
training is a CORE action in `@skyphusion-labs/vivijure-core`, reached through
`RUNPOD_WAN_TRAIN_ENDPOINT_ID`, and it has no registry entry. A harness enumerating only the registry
would report FULL COVERAGE while never touching the `vivijure-wan-train` endpoint, which is one of the
three endpoints cf#277 is about.

So the inventory is **registry UNION core-router actions**, and both halves are DERIVED at runtime. A
hand-maintained list silently passes on the day someone adds a feature, which is the failure this
exists to prevent.

Current inventory: 26 modules + 27 hook bindings + 5 core actions = **58 entries**.

## The controls, and why each one is there

Every one of these was watched failing. A check that cannot fail has proved nothing.

1. **Uncovered entry -> exit 2**, listing each one. This is the actual product: anything reachable that
   nothing covers.
2. **Unreachable registry / unreadable core dist -> exit 3**, printing "state UNKNOWN, NOT assumed
   clean". An empty inventory is a FAILING answer, never a passing one.
3. **Core-action matcher floor -> exit 3.** `MUST_FIND` asserts a known set is present. If the dist
   shape changes and the regexes stop matching, this fails loudly instead of returning a smaller,
   cleaner-looking inventory.

Control 3 exists because of a real bug in the first version, and the asymmetry is the lesson:

> A repo-wide grep for `action:` is not an inventory of actions. The first matcher **invented four
> actions that do not exist** (`fail`, `none`, `retry`, `restored`, from a retry-policy object) and
> **missed two that do** (`preview`, because it is set as an assignment `input.action = "preview"`
> rather than an object literal; and `render`, the default).
>
> **A SHRINKING inventory is the dangerous direction, because it makes coverage look COMPLETE.** An
> over-large inventory fails loudly on entries you cannot cover; an under-large one passes silently.

It surfaced only because the derived list is PRINTED rather than counted. Keep printing it.

`render` is ASSERTED rather than derived, and the code says so: it is the default action
(`payload.get("action", "render")` in the backend worker) and is not always written as a literal.

## Files

| file | what it does |
|---|---|
| `enumerate.mjs` | the inventory + coverage check. Exits 2 on uncovered, 3 on untrustworthy enumeration. |
| `coverage.json` | declared coverage. The ONLY hand-written list, deliberately: anything in an inventory but absent here fails loud. |
| `d1q.py` | query helper for `runpod_job_log`. Refuses to report an empty result as empty when the query itself failed. |
| `poll-films.sh` | advances film jobs, bounded by `MAX_TICKS` so it cannot outlive its session. |

## Running it

From the repo ROOT (the core dist path is resolved relative to the working directory):

```
VJ_STUDIO_TOKEN=... node harness/cf278/enumerate.mjs
```

Env: `VJ_STUDIO_TOKEN` (bearer), `VJ_STUDIO_URL` (default prod studio), `VJ_CORE_DIST`,
`VJ_REGISTRY_FILE`. Credentials come from the environment only; no path to a secret appears in any
file here.

`VJ_REGISTRY_FILE` reads the registry from disk instead of fetching it, for the case where no token
is held. **It announces itself in the output**, because a registry read from a file and one read from
a live studio are otherwise indistinguishable, and only one of them proves reachability.

## Known limitations, stated so a green run is not over-read

- **Never run against the hosted door.**
- **The registry is release-blind (cf#287).** A v1.12.0 and a v1.13.0 studio project a byte-identical
  `/api/modules`. This harness would compare two doors, find them identical, and report PARITY across
  a door that records everything and one that records nothing. **Do not use it to make a parity claim
  without an independent release check.**
- **It cannot see deployed-but-unadvertised modules.** It reads the registry projection, so a module
  deployed but not projected is invisible. The inverse blind spot to vivijure-local#293, which cannot
  see a third registration surface. Neither side has a fence.
- `coverage.json` ships EMPTY. A first run therefore reports all 58 entries uncovered, which is
  correct: coverage is a claim someone makes deliberately, not a default.
- Classification note for whoever extends this: a transport failure must NEVER become a job outcome.
  An edge 404 absorbed as "infra" inflates the exact rate cf#277 is about, invisibly.

Refs cf#277, cf#278, cf#279, cf#287, cf#288.

## Run 2 additions (cf#278 phase 1 continuation, 2026-08-01)

| file | what it does |
|---|---|
| `sample-endpoints.sh` | 10-second TIME SERIES over the four our-GPU endpoints. Bounded by a sample count. |
| `wait-job.sh` | blocks until ONE RunPod job is terminal, printing a `POLL_FAIL` line rather than looping silently. |

### Why the sampler exists, and why a single health read is not a substitute

The load evidence in this phase is a queue that formed and drained **in about twenty seconds**:

```
12:47:46   inQueue 0   inProgress 0   idle 3
12:47:57   inQueue 5   inProgress 0   idle 3     <- the whole batch lands
12:48:08   inQueue 3   inProgress 2   idle 3
12:48:18   inQueue 0   inProgress 0   running 3  completed 15 -> 20
```

A health read a minute either side shows a flat idle endpoint. **A queue that never formed and a queue
that formed and drained are the same snapshot**, and the snapshot is the reassuring one. Anything
claiming "no queueing was observed" from a point-in-time read has not measured queueing.

The sampler prints `PROBE_FAILED -- state UNKNOWN, NOT assumed clean` on a dead read rather than
skipping the row, for the same reason the other scripts here do: an absent row otherwise reads as fine.

### HARD RULE: never A/B two versions of the same R2 key through the CF API object-GET route

Measured (cf#300): `GET /accounts/{id}/r2/buckets/{b}/objects/{key}` served the **previous** body for an
overwritten key, durably (+1, +4 and +36 minutes, including with `Cache-Control: no-cache`), while
`GET .../objects?prefix={key}` on the SAME API reported the new object's etag and size. A control on a
never-overwritten key matched exactly, so the route is normally byte-correct and the comparison method
is sound.

This breaks the obvious verification pattern (render, read, change one knob, re-render to the same key,
read again, compare) in the most dangerous direction: the second read returns the first render, so the
result is always "nothing changed". In this run it briefly supported a confident and completely wrong
finding.

Do one of these instead:
- compare `etag` and `size` from the LISTING route, matching the **exact key** (a prefix query returns
  sidecars like `<key>.hash` and `<key>.prov` too, and `result[0]` is not necessarily your object);
- or write each variant to a DISTINCT key and compare bodies across keys.

### Two things a future run needs to know before it plans

- **`poll-films.sh` and `enumerate.mjs` both need a live studio bearer, and the one this lane started
  with had been REVOKED.** Symptom: 403 `bad API token` on `/api/modules`, `/api/storyboard/projects`
  and `/api/voices`, while unauthenticated `/health` returned 200. Established cause, from a read of
  the D1 `api_tokens` table rather than from the symptom: the named token `harness-cf278` was minted
  for the PREVIOUS harness lane and explicitly revoked at that lane's close; this lane picked up the
  stale file. Two things follow. **A named token belongs to the lane that minted it, so a new lane
  mints its own.** And `bad API token` is deliberately ambiguous (see `src/auth-gate.ts`): a revoked
  token, a wrong token, a stale operator token and a broken D1 read all produce that identical
  string, so the symptom alone cannot tell you which -- do not diagnose from it. The one distinction
  the message DOES carry is that an unauthenticated call returns `missing API token` instead, so
  those two states are separable and the other four are not. Films advance without any poller
  regardless, because the studio's own 1-minute cron sweep drives them.
- **`speech-upscale` is opt-in and ships `enable: false`.** A default film render therefore never puts a
  job on the audio-upscale endpoint; the module is invoked and honestly degrades with
  `applied: []`, `degraded: "disabled"`. To exercise that endpoint through the studio path, submit with
  `speech_config: {"speech-upscale": {"enable": true}}`.
