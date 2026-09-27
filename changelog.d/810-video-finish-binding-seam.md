### infra(finish): reach video-finish through the container binding, not a hostname (cf#810)

cf#797 specified `VIDEO_FINISH_URL` pointing at a Worker ROUTE on `vivijure-studio`, on the reasoning
that core's contract would then be untouched. **That premise is false, and it was measured rather
than argued.** `@skyphusion-labs/vivijure-core` is a LIBRARY that runs inside `vivijure-studio`, and
its `mediaDoorFetch` is a plain global `fetch(url + path)` with no fetcher seam, so that config makes
the Worker fetch its own route. Cloudflare documents that this fails: *"Using global `fetch()` to call
another Worker on the same zone without service bindings fails"*, and *"On the same zone, the only
way for a Worker to communicate with another Worker running on a route, or on a `workers.dev`
subdomain, is via service bindings."* A Custom Domain lifts the limitation for ANOTHER Worker; ours
is the same one.

So the door is the BINDING. `src/video-finish-binding.ts` builds a `MediaDoorFetcher` over the
`FINISH_CONTAINER` Durable Object namespace, and `studioEnv()` attaches it as `VIDEO_FINISH_DOOR` at
the same seam that already attaches `PRESIGNER`. No hostname, no DNS, no edge hop, no bearer on this
path, and the container stays unreachable from the internet -- the property cf#797 itself called not
tradeable. `src/render-frames.ts` moves onto the door too, preferring it over `VIDEO_FINISH_URL`;
it was already written against a `FetcherLike`, so this is wiring, not a rewrite.

**Per-job addressing, because a poll that lands on the wrong instance is not an error -- it is a
lie.** Job state is per-instance RAM (`JOBS` in `app.py`), so a poll on another instance 404s, and
core reads a 404 as terminal "job gone": a running job is reported as finished-and-vanished while a
container is still burning CPU on it. Same defect class as the GPU door pool in cf#507. The container
keeps minting its own `uuid4().hex`; the submit response is rewritten to a compound
`<routingKey>.<containerJobId>` and the poll splits it back. That is safe only because core treats
the job id as fully opaque, which was checked and not assumed: `submitAsync` accepts any non-empty
string and `pollOne` merely `encodeURIComponent`s it. An id carrying no routing key is answered 404
with nothing dispatched, because guessing an instance is worse than admitting the id is unroutable.

Stateless routes (`/finish`, `/inspect`, `/frames`, `/film-titles`, `/subtitle`, `/health`) carry no
cross-call state and go to a bounded pool of four, rather than one shared instance (which would
serialise a burst of per-clip `/inspect` calls) or a fresh instance per call (billed per wake).

**Inert until the core seam lands.** A core that does not read `VIDEO_FINISH_DOOR` ignores it, and
`VIDEO_FINISH_URL` is unchanged, so behaviour is byte-for-byte the current degrade. A self-host with
no `FINISH_CONTAINER` binding gets no door at all and keeps the URL path.
