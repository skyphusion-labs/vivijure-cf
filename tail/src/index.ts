// vivijure-tail: a Cloudflare Tail Worker for the vivijure-studio core.
//
// The core logs render state via console.log/warn ("film <id>: ..." convention) and surfaces
// uncaught exceptions. This worker receives those as tail events and pushes them to a Loki the
// OPERATOR runs, reached over a Workers VPC service, shaped into Loki streams. It NEVER throws back
// into the producer and NEVER adds render latency (all sink I/O via ctx.waitUntil).
//
// STATUS, measured 2026-09-27 (cf#838): there is NO Loki behind the reference instance any more. The
// host that ran it is deleted, so every push from a deploy still carrying the old service id fails,
// and the root wrangler.toml.example no longer binds this worker as a tail consumer. The code stays
// because the tier is an operator-facing opt-in (docs/observability.md, docs/opt-in-tiers.md): point
// LOKI_PUSH_URL at your own Loki behind your own Workers VPC service and it works. What was removed
// is OUR sink, not the shipper.
//
// DROPS ARE REPORTED, they are not swallowed (cf#838). Three failure modes used to be silent and
// therefore indistinguishable from delivery: no LOKI_VPC binding, a throwing/timing-out fetch, and a
// non-2xx response from Loki. Each now emits ONE structured console.warn line per invocation
// ({"ev":"tail.sink.drop"}), which lands in THIS worker's own Workers Logs ([observability.logs] in
// tail/wrangler.toml.example) -- a different surface from the one it feeds, which is the only reason
// it can report its own sink being down. No loop is possible: nothing declares tail_consumers
// against vivijure-tail, so this worker is not a tail producer for itself.
//
// Label design (Loki cardinality): stream labels are the LOW-cardinality set {worker,level,phase,
// module}. job_id is HIGH-cardinality (one per render) so it lives in the log LINE as a JSON field,
// queryable via LogQL `| json | job_id="film-..."`, never a label.

// Event shaping and the drop report live in ./shape (vivijure-cf#1308): a Worker entry may export
// only its handler and classes (cf#1244), and the tests import these helpers directly.
import { type LokiStream, type TailItem, reportSinkDrop, shapeEventsToLoki } from "./shape";

export interface Env {
  LOKI_VPC?: Fetcher;
  /** Override the Loki push endpoint reached THROUGH the LOKI_VPC service (optional var, mirrored as
   *  a commented line in tail/wrangler.toml.example). The default is the docker-compose service name
   *  the reference instance used; an operator whose Loki answers on another name or port sets this
   *  instead of editing source. */
  LOKI_PUSH_URL?: string;
}

/** Where the reference instance pushed. Kept as the default so an existing deploy is unchanged. */
const DEFAULT_LOKI_PUSH_URL = "http://loki:3100/loki/api/v1/push";

async function pushToLoki(streams: LokiStream[], env: Env): Promise<void> {
  if (!streams.length) return;
  // An UNBOUND sink is the case that read as success for a whole quarter: `return` here with no word
  // spoken is a tail consumer that reports "logging is on" while delivering nothing.
  if (!env.LOKI_VPC) { reportSinkDrop("sink_unbound", streams); return; }
  const url = env.LOKI_PUSH_URL || DEFAULT_LOKI_PUSH_URL;
  try {
    const res = await env.LOKI_VPC.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ streams }),
    });
    // Loki answers 204 on accept. A 4xx/5xx was ALSO silent before: a rejected batch and an
    // accepted one produced the same nothing.
    if (!res.ok) reportSinkDrop("sink_rejected", streams, "HTTP " + res.status);
  } catch (e) {
    // A sink outage must never affect a render, so this still does not rethrow. It does now say so.
    reportSinkDrop("sink_unreachable", streams, e instanceof Error ? e.message : e);
  }
}

export default {
  async tail(events: TailItem[], env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      const streams = shapeEventsToLoki(events);
      if (streams.length) ctx.waitUntil(pushToLoki(streams, env));
    } catch (e) {
      // Never throw back into the producer. A shaping bug used to vanish here too, which made a
      // malformed-event crash look exactly like an idle pipeline.
      reportSinkDrop("shape_failed", [], e instanceof Error ? e.message : e);
    }
  },
};
