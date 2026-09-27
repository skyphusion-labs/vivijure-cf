### fix(config): retire a dead shim, delete an unimplemented promised key, and document two live vars

Three findings from the cf#839 census, each verified with a positive control before being acted on.

**`src/shard-count.ts` is retired.** It had no production importer, and its own header named its
sunset condition: "keep in sync with vivijure-core until the host pins a core that exports it
(1.19.0)". Core is pinned at **1.24.0** and does export `resolveShardCount`, so the condition fired
four minors ago. Retired only after enumerating **every** invocation path rather than on one
zero-reference count: static import, dynamic import, all **four** exported symbols by name, the route
table, the `scheduled` cron handler, the one Durable Object class, and the fact that this Worker
declares no `queue`, `email` or `tail` handler at all. `RENDER_SHARD_MAX` went with it, having
appeared exactly once in the tree: its own declaration.

The census had said the file held two exports. It holds four; `scatterViewAsFilmSummary` was missed,
and scatter is retired behind a 410, so it had no live subject either.

**`XAI_API_KEY` is deleted.** It was declared in `Env` and documented to operators in three places,
one of them a literal `wrangler secret put` recipe, and **read by no code**. An operator who followed
the instruction set a secret, got no error, and gained nothing. A documented instruction for a
capability that does not exist is worse than an undocumented one, because it terminates the reader's
search. xAI **is** reachable and always was, by this estate's normal route: the AI Gateway on Unified
Billing, keyless, which is exactly why no per-provider key is needed.

**Two live vars now appear in the file an operator edits.** `ALLOW_UNAUTHENTICATED` is read by live
code and is in the canonical var contract (`src/platform/orchestrator-vars.ts`, which flows to the
release manifest), so the hosted control plane knew about it while it appeared in **none** of the five
committed wrangler examples. `VIDEO_FINISH_TIER_STATE` is read by the host, written by the control
plane, and is not in that canonical list at all. A var that is live and undocumented is worse than a
documented dead one: the dead one wastes a reader's time, the undocumented live one means a deploy
silently lacks a capability with nothing saying so.

**And the denominator is now asserted, so it cannot drift back.**
`tests/orchestrator-vars-documented-cf839.test.ts` derives the population from
`ORCHESTRATOR_VAR_KEYS` and requires every entry to be visible in some example or carry a declared
reason for its absence (two do: a dev-only mock gate and a control-plane-owned URL). Measured: 27
canonical vars, 11 absent from the main example, 8 of those living in the demo example, leaving
exactly three with no home anywhere.
