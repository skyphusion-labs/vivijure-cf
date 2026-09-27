### test(fixtures): model the container's R2 write, so the film key can be absent then present (cf#833)

Test-only. No behaviour change, no dependency move: this lands on the current core pin and is green
against it.

`cf#833` made the film key one whose presence **changes during a single advance**:

- **before** assemble it must be ABSENT, or the self-heal short-circuit fires and the real assemble
  path never runs, which several fixtures deliberately arrange;
- **after** assemble it must be PRESENT, because core now heads it before calling a film
  deliverable.

A static `head: async () => null` cannot be both. The WORKER never performs that PUT either -- the
container writes the film straight to R2 through a presigned URL -- so no Worker-side mock can
observe it through `put`, and every fixture modelled an R2 in which the film never landed. That was
harmless only while nothing looked.

`tests/install-vf-fetch.ts` now owns the transition instead of each fixture guessing at it. The door
records the key it was ASKED to write (from the request, since core content-hashes the mux output
and a fixture cannot name `film-audio-<hash>.mp4`), a per-test registry cleared in `afterEach` holds
it, and `vfHead()` reads it. `recordContainerWrite` does the same for a module, called from inside
the `/invoke` and `/poll` mocks.

**Reaching the mock is the write; declaring a response is not.** That distinction is the whole
design: `#600`'s in-flight guard supplies an invoke response precisely to assert the module was
NEVER dispatched, so recording from the response object would assert an artifact that fixture says
does not exist.

Two things were tried and backed out for that reason, and both looked like write records:

- the job's declared output keys -- asserts presence for the entire test, so the key is never absent;
- the module invoke response's echoed `film_key` -- intent, not execution.

Each broke exactly one fixture whose premise is absence. Two sources survive: explicit `presentKeys`
for artifacts that existed BEFORE a test, and the time-modelled registry for what was written DURING
it. A failed job and a refused submit record nothing, so the gate's refusal arm stays reachable.

Sizes sit above the 2048-byte floor deliberately: ABSENT and TRUNCATED are different refusals, and a
1-byte stub trips the second while reading like the first.

Three fixtures keep a per-fixture rule instead, each stating its scenario at the site: `masterEnv`
declares the shape of the content-hashed mux output it expects, and `degradeEnv` declares the silent
cut present (it was assembled in an earlier phase) while leaving the mux output absent.

**Verified by diffing failing-test NAMES against the pre-change baseline, not counts.** The count was
12 both times a backed-out attempt was measured; a count would have reported "no change" while one
fixture had been silently traded for another.
