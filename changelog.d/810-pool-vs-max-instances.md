### fix(finish): the stateless pool could exceed the container application cap on its own (cf#810)

`SYNC_POOL_SIZE` was **4** against `max_instances = 3`. The stateless pool alone could address more
container instances than the application permits, before a single encode ran.

This is not a throughput nicety. `wrangler.toml.example`'s own comment records that **a request
exceeding `max_instances` ERRORS rather than queueing**, and the pool is the cheap consumer while the
per-job instance is the load-bearing one. So the failure lands on the finish job -- the one thing the
tier exists to do -- while the `/inspect` call that ate the budget succeeds.

The invariant, now stated once and enforced:

```
SYNC_POOL_SIZE  +  concurrent finish jobs  <=  max_instances
        1       +            2             <=        3
```

`SYNC_POOL_SIZE` drops to 1. **The cost is named rather than hidden:** a burst of per-clip `/inspect`
calls now serialises behind one container. That is worse than a wider pool and still correct here,
because the alternative is not a slower sync call but a refused container start on an encode. A sync
call waiting is latency; a job instance refused is a film that does not get made.

`max_instances` is deliberately low as a spend and blast-radius knob and is NOT raised here -- that is
a spend decision, and widening the pool requires raising it first.

`tests/video-finish-pool-ceiling-cf810.test.ts` parses `max_instances` out of the committed
`wrangler.toml.example` rather than a transcribed copy, so the two numbers cannot drift apart again,
and asserts the file exists so a wrong cwd fails loudly instead of matching nothing and passing
vacuously. Watched red against the real config (ceiling dropped to 2), then restored.

**How it was missed:** I chose 4 as "a pool, not a tuned number" without reading the platform ceiling,
because I wrongly believed I held no Cloudflare credential and therefore never queried the live
application. The number came from the API once that was corrected.
