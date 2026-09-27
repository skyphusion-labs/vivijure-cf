# The Containers control plane: what it can prove, and what it cannot

Measured 2026-09-27 against the live account for cf#844, which was filed because an empty instances
list was briefly treated as proof that nothing was running (and therefore nothing was billing) at
rest. **It is not proof of that, and this document exists so nobody has to re-derive why.**

Read this before quoting either endpoint in a report about capacity, billing or what is running.

## The two endpoints, and their disagreement

```
GET /accounts/{a}/containers/applications
GET /accounts/{a}/containers/applications/{id}/instances
```

Read 678 ms apart with one credential, 2026-09-27T09:22:29Z and 09:22:30Z:

| reading | value |
|---|---|
| `application.instances` | **3** |
| `application.max_instances` | **3** |
| rows returned by `/instances` | **10** |
| rows whose `status.state` is anything but `inactive` | **0** |

**Those are not two views of one number.** At 09:23:15Z, `by_state` across all ten rows was
`{"inactive": 10}`.

## `application.instances` is not an observed count

It read **3** while **zero** instances were active and **ten** were listed, and it equals
`max_instances` exactly. Treat it as configured or desired capacity, **never as "how many are running
now"**. This is the shape that matters: it does not error, it does not read as unavailable, it returns
a small plausible integer. A reader asking "how many are up?" gets a confident wrong answer.

`max_instances = 3` also does not bound the number of instance RECORDS: there were ten.

## An instance row is a record, not a running container

The complete shape, verbatim from the first row, and the union of keys across all ten rows was exactly
`application_id`, `id`, `image`, `name`, `status`:

```json
{
  "id": "16ad15de42a083b3d24dc856016423063d31bd8650fccb5410361658a3a27401",
  "application_id": "a03d937f-cf39-467e-9874-40aaf58b5e23",
  "status": { "state": "inactive", "updated_at": "2026-09-27T06:16:53Z" },
  "image": "registry.cloudflare.com/<account>/vivijure-studio-finishcontainer@sha256:6a94c612...",
  "name": "768f0441c2a54e62999b0ec34e41642c"
}
```

**There is no `started_at` field.** Not null, absent, on every row. cf#844 recorded `started_at`
appearing on one instance and then reading `null` minutes later, and suspected it was not a container
start time. It is no longer in the shape at all, so **nothing in this response can carry a billing
claim about duration.**

`status.updated_at` is the last time the record changed state, and across the ten rows it spanned
04:52:54Z to 08:48:53Z.

## So what can it prove?

**It answers: which instance records exist, and what state each was last seen in.** That is a real and
useful question. It is not the question cf#844 asked it.

| claim | can this endpoint support it? |
|---|---|
| "these instance records exist" | **yes** |
| "this record was last seen inactive at 06:16:53Z" | **yes** |
| "nothing is running right now" | **no.** An empty list means the endpoint returned no records, which is not the same as no containers. cf#844 saw an empty list at 04:49:33Z and a record at 04:52:33Z claiming a 04:01:50Z start; both can be true OF THE RECORD while neither speaks to what was running |
| "something IS running right now" | **no.** Ten rows, all inactive |
| "nothing billed during this window" | **no.** That needs metering data, which is NOT measured here |

## The second instrument, which is the transferable part

cf#844's own complaint was that two people checking the same endpoint with different credentials
treated their agreement as independent confirmation. **Two credentials against one endpoint is one
instrument**, and it cannot test itself.

Here is a check that does not trust the endpoint's claims at all. `src/video-finish-binding.ts` has
`SYNC_POOL_SIZE = 1` and `poolIndex: () => Math.floor(Math.random() * SYNC_POOL_SIZE)`, so the only
pool name current code can mint is `sync-0`. The live list contains **`sync-0`, `sync-1`, `sync-2` and
`sync-3`**, all inactive.

Since `sync-3` requires `SYNC_POOL_SIZE >= 4` to have ever been minted, and cf#810 dropped the pool to
1, those names are older than the current configuration. **That proves the list is historical and that
records survive a config change, using only arithmetic about how names are generated.** The endpoint is
not consulted about its own reliability. Reach for this shape whenever an instrument's own output is
the only evidence available: find a fact the output must have if the mechanism you believe in is true,
and check that instead.

## Why there is no gate enforcing any of this

No source file, script, workflow or doc in this repo reads `containers/applications` or an instances
list (`grep -rniE 'containers/applications|/instances'` over `*.ts`, `*.sh`, `*.py`, `*.yml`, `*.md`
excluding `node_modules` and `CHANGELOG.md`, 2026-09-27: the only hit is the word "instances" in an
unrelated comment in `src/index.ts`). So there is no consumer to guard.

A gate that text-matched for a future misreading would be a control with no subject, and reading
intent out of source text is not something a grep can do. **When a consumer appears, it should be
guarded then.** Until it does, this document is the artifact, and the standing rule is the last line
of cf#844: say "the endpoint reported nothing" and not "nothing is running", in any report that
depends on the difference.

## Related

- cf#844, which this closes.
- cf#843: six of the ten rows are 32-hex names, which is the per-attempt `routingKey()` shape. That
  issue is about the leak; this one is about what the list can be used to prove.
- `src/video-finish-binding.ts` for the pool arithmetic and the `max_instances` inequality.
