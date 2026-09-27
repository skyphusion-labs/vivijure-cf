### docs(containers): what the Containers control plane can prove, and what it cannot (cf#844)

cf#844 was filed because an empty instances list had been read as proof that nothing was running, and
therefore nothing billing, at rest. **Measured against the live account, it proves neither, and the
failure mode is that it answers confidently rather than erroring.**

Two endpoints read **678 ms apart with one credential**:

| reading | value |
|---|---|
| `application.instances` | **3** |
| `application.max_instances` | **3** |
| rows from `/containers/applications/{id}/instances` | **10** |
| rows whose `status.state` is anything but `inactive` | **0** |

**`application.instances` is not an observed count.** It read 3 while zero instances were active and ten
were listed, and it equals `max_instances` exactly. A reader asking "how many are up?" gets a small,
plausible, wrong integer. `max_instances = 3` also does not bound the number of instance RECORDS, of
which there were ten.

**An instance row is a record, not a running container**, and the union of keys across all ten rows is
exactly `application_id`, `id`, `image`, `name`, `status`. **There is no `started_at` field** -- not
null, absent. cf#844 saw `started_at` appear on one instance and read `null` minutes later and suspected
it was not a start time; it is no longer in the shape at all, so nothing in that response can carry a
billing claim about duration.

So the endpoint answers "which instance records exist, and what state each was last seen in", which is
useful and is not the question it was asked. The 04:49:33Z empty list and the 04:52:33Z record claiming a
04:01:50Z start can both be true OF THE RECORD while neither speaks to what was running.

## The second instrument, which is the transferable part

cf#844's methodological complaint was that two people checking the same endpoint with different
credentials treated their agreement as independent confirmation: **two credentials against one endpoint
is one instrument.** So the doc includes a check that never consults the API about its own reliability.

`SYNC_POOL_SIZE` is 1 and `poolIndex()` is `Math.floor(Math.random() * SYNC_POOL_SIZE)`, so the only
pool name current code can mint is `sync-0`. The live list contains `sync-0` through **`sync-3`**. Since
`sync-3` needs `SYNC_POOL_SIZE >= 4` to have ever been minted and cf#810 dropped the pool to 1, those
records predate the current configuration: **the list is historical, proven by arithmetic about how
names are generated.**

## The guard exists because the doc would otherwise rot into the defect it describes

That argument is only valid while `SYNC_POOL_SIZE` is actually 1. Raise the pool to 4 and `sync-3`
becomes mintable, the inference silently inverts, and the doc keeps asserting it -- which is precisely
the comment-asserting-a-property-the-code-lacks class this repo has spent a sprint clearing. Shipping the
doc ungated would have been a fresh instance of it.

`tests/containers-control-plane-doc-cf844.test.ts` DERIVES the number from `src/video-finish-binding.ts`
and fails if the doc quotes a different one, or if the `sync-N` the doc argues from becomes a name
current code can mint. **Watched red:** raising `SYNC_POOL_SIZE` to 4 fails both, with the message
telling the next author to update the doc's argument rather than the test. It is not a second definition
of `tests/video-finish-pool-ceiling-cf810.test.ts`, which pins the
`SYNC_POOL_SIZE + RESERVED_JOB_INSTANCES <= max_instances` inequality; this one pins the doc against the
source.

## No gate on the endpoint itself, deliberately

Nothing in this repo reads `containers/applications` or an instances list (`grep -rniE` over `*.ts`,
`*.sh`, `*.py`, `*.yml`, `*.md`, excluding `node_modules` and `CHANGELOG.md`: the only hit is the word
"instances" in an unrelated comment). **There is no consumer to guard**, so a gate would be a control
with no subject, and reading intent out of source text is not something a grep can do. When a consumer
appears it should be guarded then. Until then the doc is the artifact and the standing rule is cf#844's
own last line: say "the endpoint reported nothing", not "nothing is running".

Six of the ten rows are 32-hex names, the per-attempt `routingKey()` shape, which is cf#843's subject
rather than this one's.
