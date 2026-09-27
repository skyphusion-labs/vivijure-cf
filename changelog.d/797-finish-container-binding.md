### infra(finish): bind video-finish to Cloudflare Containers, under a fresh Durable Object class (cf#797)

`video-finish` is the stage that concatenates per-shot clips into a film, and it had no reachable
host. Assemble is gated on `VIDEO_FINISH_URL`; every hostname it was coded against is dead Hetzner
NXDOMAIN, so core called `degradeAssembleUnavailable`, set `phase=done`, and shipped per-shot clips.
**It reported success and there was no film.** This is the platform half of putting it back: the
`[[containers]]` block, the Durable Object that fronts it, and the `Env` mirror. The container logic
(chunked assemble, R2 partials, work-dir lifecycle, the activity hook, externalised job state) is
cf#784.

**A NEW Durable Object class name, deliberately.** `v1-video-finish` created `VideoFinishContainer`
and `v2-drop-cpu-containers` deleted it when the CPU stages moved to always-on fleet iron. The
current Durable Objects docs state a tombstone delete is permanent with no trash, so re-declaring
that name may be refused outright. Measured on the account: 8 Durable Object namespaces, zero
belonging to vivijure and zero Finish/Container classes, so this is a clean create either way. A
fresh name cannot collide with a tombstone and costs nothing, because the class name is internal and
nothing outside the config references it. The config says not to tidy it back, since that is exactly
the edit the next reader is tempted to make.

**`standard-4` is chosen for MEMORY, not disk**, which corrects the earlier analysis. That analysis
concluded disk was the binding limit (3-4x peak against a 20 GB ephemeral ceiling). Streaming concat
was then measured on real ffmpeg at **peak RSS 43 MB over 1.1 GB of input across 4 partials, lower
than a local-disk join**, output byte-identical, using range requests rather than sequential
downloads. So partials never land on disk at the final join and memory is the real ceiling.
Containers have no swap, an OOM restarts the instance, and 12 GiB is the top of the published range,
so there is nothing bigger to escape to.

**Per-job Durable Object addressing is load-bearing.** `/async/finish` submits and
`GET /async/status/{jobId}` polls, and every container instance sits behind its OWN Durable Object,
so a poll that lands on a different instance than the encode does not find the job at all. The id is
derived from the job id, never `getRandom()`. That is not a substitute for externalised job state:
state surviving a restart and the poll reaching the right box are different problems and both are
required.

**`VIDEO_FINISH_URL` keeps its HTTP shape on purpose.** A Worker route fronts the container through
the binding and the var points at that route, so core's contract is untouched and the
`HOSTED_FINISH_POLL_BOXES` swap stays a one-line change rather than a protocol change. It is NOT
repointed here: these are URL vars, so typecheck cannot catch a dangling target and a deploy will
happily succeed against nothing.

**`sleepAfter` is a contract, not a free knob**, and it is set on the class with the arithmetic
beside it. Short values break this stage: no request is in flight during an async encode, so the
idle timer runs against a working container, and ephemeral disk is reset on wake, so a sleep
mid-encode destroys the work dir and the next poll finds nothing. Long values are not free either,
because memory bills on PROVISIONED size while awake and `standard-4` provisions 12 GiB, making a
10 minute idle tail roughly USD 0.019 per wake, already the same order as the active cost of a 300
second assemble. The class therefore states the requirement it implies: the job loop must renew more
often than 10 minutes, and renew inside a batch if a batch can run longer than that.

**A gate that could not run when a human was looking.** The first revision of this change declared
the Durable Object binding while nothing exported the class, and it was green on 13 checks.
`wrangler` rejects that, so it would have failed at the next `v*` tag in the release bundle step,
taking the whole studio release down and landing on whoever tagged next for an unrelated reason. The
only gate that can see it, `wrangler deploy --dry-run`, lives in a tag-gated workflow and read
SKIPPED. **An absent check reads exactly like a passed one.** It now runs on every pull request as
`bundle-gate`, credential-free and fork-safe, with `--containers-rollout=none` so it validates the
config, the bindings and the bundle without needing the Docker CLI, which `wrangler` otherwise
requires to build a local Dockerfile image even in dry-run mode. Both directions were verified
before landing: deleting the export makes the step exit 1 with "depends on the following Durable
Objects, which are not exported in your entrypoint file", and restoring it makes it pass.

Also: `DurableObject` is added to the `cloudflare:workers` test shim. `@cloudflare/containers` builds
`Container` on it, so exporting a container class from the entrypoint made every node-environment
test that imports `src/index.ts` die at import time with "Class extends value undefined", in tests
with nothing to do with containers. The shim stays minimal and constructible, like the
`WorkflowEntrypoint` shim beside it; container behaviour is exercised in the Workers runtime and by
the bundle gate.

Two corrections to the above, both found by running things rather than reasoning about them. The
shim needed **`WorkerEntrypoint` as well as `DurableObject`** -- `@cloudflare/containers` imports
both and evaluates `class ContainerProxy extends WorkerEntrypoint` at module load, so shimming only
`DurableObject` failed with the identical message and looked like the fix had not worked. Note
`WorkerEntrypoint` is not `WorkflowEntrypoint`, which was already in the shim; three letters apart
and different base classes. And a `server.deps.inline` entry for the package, which a plausible
reading of the failure said was required, turned out **not** to be needed: tests pass without it, so
it was dropped rather than shipped with a confident comment explaining a requirement that does not
exist.

**The cf#560 strip guard was weakened by this change and is fixed here, scoped rather than
patched.** Adding a second hosted render path to `ci.yml` broke its negative control two ways. Its
mutation used `String.replace`, which touches only the first occurrence, so with two render lines the
control could no longer reach `consumed === 0`; it now uses `replaceAll`. More seriously, its `feeds`
check scanned to END OF FILE, so one job's strip invocation could be satisfied by a DIFFERENT job's
render line: with the bundle gate's own `envsubst` deliberately broken, the suite stayed **green**
while that job rendered from the unstripped template. That was measured, not theorised. The scan is
now bounded to the invoking step, and it was verified to go red for EACH job's data path
independently and green on the real file. With only one render path the weakness was unreachable,
which is why it survived until now.
