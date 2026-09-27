### infra(finish): reach video-finish through the container binding, not a hostname (cf#810)

cf#797 specified `VIDEO_FINISH_URL` pointing at a Worker ROUTE on `vivijure-studio`, on the reasoning
that core's contract would then be untouched. **That premise is false, and it was measured rather
than argued.** `@skyphusion-labs/vivijure-core` is a LIBRARY that runs inside `vivijure-studio`, and
its `mediaDoorFetch` was a plain global `fetch(url + path)`, so that config makes the Worker fetch its
own route. Cloudflare documents that this fails: *"Using global `fetch()` to call another Worker on
the same zone without service bindings fails"*, and *"On the same zone, the only way for a Worker to
communicate with another Worker running on a route, or on a `workers.dev` subdomain, is via service
bindings."* A Custom Domain lifts the limitation for ANOTHER Worker; ours is the same one.

So the door is the BINDING. `src/video-finish-binding.ts` builds a fetcher over the
`FINISH_CONTAINER` Durable Object namespace, and `studioEnv()` attaches it as
`MEDIA_DOOR_FETCHERS.VIDEO_FINISH_URL` at the same seam that already attaches `PRESIGNER`. No
hostname, no DNS, no edge hop, no bearer required, and the container stays unreachable from the
internet -- the property cf#797 itself called not tradeable. `src/render-frames.ts` moves onto the
door too; it already called `http://video-finish/frames` through a `FetcherLike`, which is exactly the
door's shape, so it passes straight through with no adapter.

**REQUIRES core >= 1.23.0, and is INERT below it.** The seam is `MEDIA_DOOR_FETCHERS` on the env core
receives, keyed by the door's URL var so there is one door vocabulary across the two repos. A core
below 1.23.0 does not read that field: the door is constructed, ignored, and the public-origin path
runs unchanged. **Do not downgrade this pin to resolve an unrelated conflict** -- nothing would fail,
the finish door would simply switch off and films would go back to shipping as per-shot clips.

`VIDEO_FINISH_URL` does not need to be set at all on the bound path, because core's
`mediaDoorReachable` counts the binding from 1.23.0. If a stale value IS left set, the binding wins,
so a leftover var cannot quietly push traffic back over the edge mid-rollout.

**`HOSTED_FINISH_POLL_BOXES` is dead on this path by construction, not by configuration.** The
fan-out existed to spray three fleet replicas and only ever fired on the literal hostname
`video-finish.skyphusion.org`. A binding has no hostname and exactly one addressable target, so the
fan-out is never consulted. There is nothing to repoint, and nobody should later "fix" it.

**Per-job addressing, because a poll landing on the wrong instance is not an error -- it is a lie.**
Job state is per-instance RAM (`JOBS` in `app.py`), so a poll on another instance 404s, and core reads
a 404 as "job gone": a running job is reported as finished-and-vanished while a container is still
burning CPU. Same defect class as the GPU door pool in cf#507. The container keeps minting its own
`uuid4().hex`; the submit response is rewritten to a compound `<routingKey>.<containerJobId>` and the
poll splits it back. Safe only because core treats the job id as fully opaque, which was checked and
not assumed. An id with no routing key is answered 404 with nothing dispatched, because guessing an
instance is worse than admitting the id is unroutable.

This does NOT make a job survive a restart. Container job state is still process memory (cf#784 item
2 is open), so an eviction still loses a running job; reaching the right box and the job surviving are
different problems. Core keeps its not-found streak on the bound path for exactly that reason.

Stateless routes (`/finish`, `/inspect`, `/frames`, `/film-titles`, `/subtitle`, `/health`) carry no
cross-call state and go to a bounded pool of four, rather than one shared instance (which would
serialise a burst of per-clip `/inspect` calls) or a fresh instance per call (billed per wake).
