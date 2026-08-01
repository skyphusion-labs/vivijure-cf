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
