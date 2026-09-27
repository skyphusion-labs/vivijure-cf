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

interface TailLog { timestamp?: number; level?: string; message?: unknown[]; }
interface TailException { timestamp?: number; name?: string; message?: string; }
interface TailEvent { request?: { url?: string; method?: string; path?: string }; response?: { status?: number }; cron?: string; scheduledTime?: number; }
// Field names verified against the pinned @cloudflare/workers-types TraceItem, NOT guessed: the
// public tail-worker docs page omits the timing fields entirely, so the type definition is the
// authority here. All three are machine-generated (durations + a boolean), never user-derived.
interface TailItem {
  scriptName?: string;
  outcome?: string;
  eventTimestamp?: number;
  event?: TailEvent;
  logs?: TailLog[];
  exceptions?: TailException[];
  /** CPU milliseconds burned by the invocation. */
  cpuTime?: number;
  /** Elapsed milliseconds from invocation start until the runtime is done (incl. waitUntil). */
  wallTime?: number;
  /** True when the runtime DROPPED events from this trace. Without it an under-count reads as calm. */
  truncated?: boolean;
}

interface Labels { worker: string; level: string; phase: string; module: string; }
interface LokiStream { stream: Labels; values: [string, string][]; }

const PHASES = ["keyframe", "pre_clip_dialogue", "pre_clip_speech", "clips", "dialogue", "speech", "finish", "assemble", "master", "mux", "done", "failed"];

function mapLevel(l?: string): "info" | "warn" | "error" {
  const v = (l || "").toLowerCase();
  if (v === "error") return "error";
  if (v === "warn") return "warn";
  return "info"; // debug | log | info
}

function nanos(ms?: number): string {
  const t = typeof ms === "number" && isFinite(ms) ? Math.floor(ms) : Date.now();
  return (BigInt(t) * 1000000n).toString();
}

function flatten(message: unknown[] | undefined): string {
  if (!message || !message.length) return "";
  return message
    .map((m) => {
      if (typeof m === "string") return m;
      try { return JSON.stringify(m); } catch { return String(m); }
    })
    .join(" ");
}

interface Derived { job_id?: string; phase: string; module: string; reason?: string; }

// Best-effort parse of the core's console convention. PREFERS a structured logEvent JSON line
// ({_v:1,...}, the planned fast-follow); falls back to regex over the English line.
export function deriveFields(text: string): Derived {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      if (o && o._v === 1) {
        const phase = typeof o.phase === "string" && PHASES.includes(o.phase) ? o.phase : "unknown";
        return {
          job_id: typeof o.job_id === "string" ? o.job_id : undefined,
          phase,
          module: typeof o.module === "string" ? o.module : "none",
          reason: typeof o.reason === "string" ? o.reason : undefined,
        };
      }
    } catch { /* not our structured line; fall through to regex */ }
  }
  let job_id: string | undefined;
  const film = text.match(/\bfilm[\s_-]([A-Za-z0-9-]{4,})/);
  if (film) job_id = film[1].startsWith("film") ? film[1] : "film-" + film[1];
  if (!job_id) {
    const clips = text.match(/\b(clips-[A-Za-z0-9-]+)/);
    if (clips) job_id = clips[1];
  }
  let phase = "unknown";
  for (const p of PHASES) {
    if (new RegExp("\\b" + p + "\\b").test(text)) { phase = p; break; }
  }
  let module = "none";
  if (/film\.finish/.test(text)) {
    module = "film.finish";
  } else {
    const colon = text.match(/\b([a-z][a-z0-9-]+):\s/); // "<module>: <reason>"
    if (colon && !PHASES.includes(colon[1])) module = colon[1];
  }
  return { job_id, phase, module };
}

export function shapeEventsToLoki(events: TailItem[]): LokiStream[] {
  const map = new Map<string, LokiStream>();
  const add = (labels: Labels, ts: string, line: string) => {
    const key = labels.worker + "|" + labels.level + "|" + labels.phase + "|" + labels.module;
    let s = map.get(key);
    if (!s) { s = { stream: labels, values: [] }; map.set(key, s); }
    s.values.push([ts, line]);
  };
  for (const item of events || []) {
    const worker = item.scriptName || "unknown";
    // Invocation summary -- emitted for EVERY tail event so routine traffic + the live pipeline
    // are visible even when the request makes no console.* calls (CF's auto invocation record is
    // NOT in logs[]). Render detail (console.warn degrades/phases) still rides logs[] below.
    {
      const ev = item.event || {};
      let summary: string;
      if (ev.request) summary = (ev.request.method || "GET") + " " + (ev.request.path || ev.request.url || "/") + (ev.response && ev.response.status != null ? " " + ev.response.status : "");
      else if (ev.cron) summary = "cron " + ev.cron;
      else if (ev.scheduledTime != null) summary = "scheduled";
      else summary = "invocation";
      const oc = item.outcome || "ok";
      const ilevel: "info" | "warn" | "error" = oc === "ok" ? "info" : (oc === "exception" || oc === "exceededCpu" ? "error" : "warn");
      const idf = deriveFields(summary);
      // Timing rides the invocation LINE, never a Loki label: these are unbounded numerics and
      // would shatter stream cardinality (the same rule that keeps job_id out of the labels).
      // Query them by unwrapping instead, e.g.
      //   quantile_over_time(0.95, {worker="vivijure-studio"} | json | unwrap wall_ms [10m])
      // Conditionally included: absent stays ABSENT rather than becoming 0, so "the runtime did not
      // report it" and "it took no time" never collapse into the same value.
      add({ worker, level: ilevel, phase: idf.phase, module: idf.module }, nanos(item.eventTimestamp),
        JSON.stringify({
          msg: summary,
          kind: "invocation",
          outcome: oc,
          status: ev.response?.status,
          path: ev.request?.path,
          cpu_ms: typeof item.cpuTime === "number" ? item.cpuTime : undefined,
          wall_ms: typeof item.wallTime === "number" ? item.wallTime : undefined,
          truncated: item.truncated === true ? true : undefined,
        }));
    }
    for (const log of item.logs || []) {
      const text = flatten(log.message);
      if (!text) continue;
      const f = deriveFields(text);
      const labels: Labels = { worker, level: mapLevel(log.level), phase: f.phase, module: f.module };
      const line = JSON.stringify({ msg: text, job_id: f.job_id, reason: f.reason, outcome: item.outcome });
      add(labels, nanos(log.timestamp ?? item.eventTimestamp), line);
    }
    for (const ex of item.exceptions || []) {
      const text = (ex.name || "Error") + ": " + (ex.message || "");
      const f = deriveFields(text);
      const labels: Labels = { worker, level: "error", phase: f.phase, module: f.module };
      const line = JSON.stringify({ msg: text, name: ex.name, job_id: f.job_id, outcome: item.outcome ?? "exception" });
      add(labels, nanos(ex.timestamp ?? item.eventTimestamp), line);
    }
  }
  for (const s of map.values()) {
    s.values.sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : BigInt(a[0]) > BigInt(b[0]) ? 1 : 0));
  }
  return [...map.values()];
}

/** Report a drop on the ONE surface that is not the sink (cf#838).
 *
 *  One line per invocation, never per log line: the drop is a property of the push, and 549
 *  invocations in six hours (measured 2026-09-27) is the rate this runs at when a studio is busy.
 *  `lines` is the count that did not arrive, so an under-delivery has a denominator instead of
 *  being absent. Never throws: a reporting failure must not become a render failure. */
export function reportSinkDrop(reason: string, streams: LokiStream[], detail?: unknown): void {
  try {
    let lines = 0;
    for (const s of streams) lines += s.values.length;
    console.warn(JSON.stringify({
      ev: "tail.sink.drop",
      reason,
      streams: streams.length,
      lines,
      detail: detail === undefined ? undefined : String(detail),
    }));
  } catch { /* nothing left to do if even the report cannot be built */ }
}

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
