### fix(tail): the tail pipeline reported success while delivering nothing (cf#838)

`vivijure-tail` shipped the studio's render logs to a self-hosted Loki over Workers VPC. That host is
deleted. The consumer stayed bound anyway, and **nothing anywhere said so**: measured on the live
account 2026-09-27, `vivijure-studio` still carried
`tail_consumers = [{ service = "vivijure-tail" }]`, `vivijure-tail` still carried its `LOKI_VPC`
binding, and the worker was invoked **549 times in the preceding six hours** (Workers observability
`/telemetry/query`, `cloudflare-workers` dataset), every one of them a drop. There is no cloudflared
tunnel left for a monitoring host; `grafana.skyphusion.org` is NXDOMAIN.

That is the worst shape a monitor can take. A tail consumer that drops every batch is
indistinguishable from one that ships, so the question "are we logging?" answered yes for a quarter.

**Three silent paths, now reported.** `pushToLoki` returned early on a missing binding, swallowed a
throwing fetch in a bare `catch {}`, and never looked at the response status, so an unbound sink, an
unreachable sink and a 413 from Loki all produced exactly the same nothing as a successful push. Each
now emits ONE structured line per invocation, `{"ev":"tail.sink.drop","reason":...,"lines":N}`, with
`reason` in `sink_unbound` / `sink_unreachable` / `sink_rejected` / `shape_failed` and `lines` as the
count that did not arrive, so an under-delivery carries its own denominator. A shaping exception was
silent too and is now `shape_failed`.

**Why that report is not circular:** it lands in `vivijure-tail`'s OWN Workers Logs
(`[observability.logs]` in `tail/wrangler.toml.example`), a different surface from the sink it feeds,
which is the only reason a shipper can report its own sink being down. No loop is possible: nothing
declares `tail_consumers` against `vivijure-tail`, so it is not a tail producer for itself. The worker
still never throws back into the producer and still does all sink I/O under `ctx.waitUntil`.

**The dark consumer comes off.** `tail_consumers` in `wrangler.toml.example` ships COMMENTED OUT, so
the next core deploy unbinds it. Same call the MuseTalk excision made about its strip gate (`ci.yml`:
a control with no subject comes off rather than staying on green). A stock deploy keeps Cloudflare
Workers Logs (`observability.logs`, live and `persist = true`, measured) plus the status routes, which
is what `docs/observability.md` already described as enough to operate a single-user studio.

**The shipper is kept, not deleted, and stops being fleet-specific.** It is a documented opt-in tier
(`docs/opt-in-tiers.md`) and the only dead part was our sink, so `biafra`, "the fleet Loki" and
"recorded in the private store" come out of `tail/wrangler.toml.example` and `scripts/deploy-tail.sh`
in favour of the operator supplying their own `LOKI_VPC_ID`. New optional `LOKI_PUSH_URL` var
(mirrored in the tail worker's hand-authored `Env`) so an operator whose Loki answers on another name
or port configures it instead of editing source; unset keeps the previous endpoint exactly.
`LOKI_VPC` is now OPTIONAL in that `Env`, because a deploy without it is a real state the code always
handled while the type claimed otherwise.

`docs/observability.md` led with a pipeline diagram and a "it looks like the log was dropped, it was
not, it is in Loki" line, both of which had become false. It now opens with the measured status and
what the 549 invocations mean, and the network-isolated-Loki section is marked as the retired
reference topology rather than deleted, because the topology generalises to any operator and only the
hostnames died.

Seven guards in `tests/tail.test.ts` drive the REAL `tail()` handler (not a stub of the push, which
would encode an assumption about which branch runs) and assert on the report: each `reason` fires with
its line count, a 204 accept stays SILENT so the drop line means something, `LOKI_PUSH_URL` is honoured
and defaults correctly, the handler resolves rather than throwing on a poisoned event, and the reporter
itself cannot throw. **Watched red:** restoring the original silent bodies fails exactly the four
reason assertions with `expected [] to have a length of 1`, vitest exit 1, while the 204-silent and
URL-default cases still pass, then restored.

**Not fixed here, and escalated instead:** `docs/legal/PRIVACY.md` section 3.4 tells a hosted user
that operational logs go to "a logging system (Grafana/Loki) that the operator runs on their own
servers, NOT a third-party log vendor". With the consumer unbound, the hosted tier's operational logs
live in Cloudflare Workers Logs with `persist = true`. That is a published privacy representation
about the hosted door, not an infra comment, so it is not edited in an infra PR.
