### fix(config): stop asserting a Hetzner-era topology in operator-facing config (cf#837)

Three artifacts encoded a topology that cannot work, and the worst of them sat in the file operators
render their own config from.

**1. `wrangler.toml.example` told operators a Worker route fronts the finish container.** It does not,
and it cannot: `src/video-finish-binding.ts:3-13` records the cf#810 measurement that killed cf#797's
premise. Core is a LIBRARY running inside this Worker, so a route on this Worker means the Worker
fetches itself, and Cloudflare documents that same-zone Worker-to-Worker global `fetch()` fails. The
comment now says what the var IS in each of the two deploys that exist: with `FINISH_CONTAINER` bound
the door is the BINDING and the var NAME is only the lookup key core reads
(`MEDIA_DOOR_FETCHERS.VIDEO_FINISH_URL`, synthesised in `src/orchestrator-env.ts`), so the VALUE is
never fetched though it must stay non-empty for `src/video-finish-availability.ts` to call the tier
installed; without the binding the value IS the origin, exactly as before.

**Measured while correcting it, and this part is new:** the hosted deploy injects
`VIDEO_FINISH_URL=https://video-finish.skyphusion.org` from a repo Actions variable and that hostname
is **NXDOMAIN**. The hosted core is masked from it because the binding wins first; the two module
workers that reach the same door over plain HTTPS (`modules/film-titles`, `modules/subtitle`) are not
masked. Eleven of the thirteen media-door hostnames in those variables are NXDOMAIN. That is live
deploy state, it is tracked in cf#780 / cf#746, and it is deliberately not changed from a repo PR:
cf#746 records that emptying `FINISH_BLENDER_DOORS` un-parks a parked GPU endpoint, which is a spend
decision.

**2. `modules/_shared/video-finish-404.ts` derived a live retry policy from a deleted VIP.** Its
`P(miss) = 2/3` came from three cloudflared connectors in front of a 3-replica swarm service at
`10.0.1.90`. The measurement is kept and now labelled HISTORICAL rather than presented as the current
basis, because it is still the right arithmetic for any door that fans out across replicas (a
self-hoster with three containers behind a load balancer reproduces the ambiguity exactly) and only
the ownership of that topology changed. The header now states who the callers actually are, that they
were NOT migrated to the cf#810 binding, and that against a single-instance door the same streak is
restart and registration-race tolerance rather than peer arithmetic. `CONTAINER_NOTFOUND_STREAK`
is deliberately UNCHANGED: the suite already pins that it cannot increment in production shape, so the
real terminal is the 90-minute `submittedAt` backstop, and re-deriving a number with no live subject
would be arithmetic about nothing.

**3. `build-media-images.yml` described its output as feeding the decommissioned fleet swarm stack.**
Corrected to the live self-host path (`containers/compose.yaml`, the GHCR names published in
`containers/README.md`), with the distinction cf#838 drew kept intact: these images are real
operator-facing artifacts, and what died is the hosted consumer of the pushed images, not the images.

**The comment is a rule, so it gets a mechanism.** `tests/video-finish-not-a-route-cf837.test.ts`
asserts against the REAL exported `API_ROUTES` table that no route serves an `async` path, and that
`studioEnv` synthesises the bound door even when `VIDEO_FINISH_URL` is deliberately set to a
route-shaped URL on this Worker's own host, which is the deploy that would silently fetch itself.
Both carry positive controls, because both load-bearing assertions are negatives and a negative over
an empty collection observes nothing. **Watched red:** inserting `POST /async/finish` into
`API_ROUTES` fails the first with `expected [ 'POST /async/finish' ] to deeply equal []`, and
disabling the door synthesis fails the second with `expected null not to be null`, vitest exit 1,
while the negative control keeps passing so neither failure is a blanket one.

**Fix-forward, found by accident and worth naming.** Adding the corrected comment to
`build-media-images.yml` turned `tests/local-gpu-strip-cf560.test.ts` RED. That guard DERIVES the
population of hosted render paths from the workflows, and it enrolled a workflow on a PROSE MENTION of
`wrangler.toml.example`: build-media-images renders no config at all. The file already states the
right rule in its own words for the other half of the matcher, "A MENTION IS NOT A CALLER... anchor on
a line that RUNS it"; it was never applied to the population side. `rendersHostedConfig()` now drops
comment lines before matching, in both directions, because a `#` line cannot render anything in YAML
or in a `run:` block. A control that fires on a comment punishes documentation, and the next author's
cheapest fix is to delete the sentence instead of looking.

The union that made that matcher robust is untouched and was re-proven, not assumed. Two mutations,
both RED, both restored: deleting the strip from `studio-release.yml` and rendering the template
directly (the literal historical cf#560 defect) fails 2 of 21 with `expected false to be true`; and
the vanish shape, where the strip is gone AND the template is named zero times in the whole file
(`grep -c` = 0), still keeps the path in the population through the `> wrangler.toml` signal and still
fails. An assertion that can vanish is worse than one that can be wrong, and it still cannot vanish.

Not fixed here: `HOSTED_FINISH_POLL_BOXES = ["jello", "descendents", "badbrains"]` lives in
`@skyphusion-labs/vivijure-core`, not in this repo, so it is filed there and lands here as a pin bump
when core is next cut. It is dead code rather than a live defect: `pollVideoFinishAsync`
short-circuits when the `MEDIA_DOOR_FETCHERS` binding is present.
