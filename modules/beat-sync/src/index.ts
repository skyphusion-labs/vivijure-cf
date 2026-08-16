// beat-sync: a `score` module worker (vivijure-module/2). Runs librosa beat analysis on the
// always-on audio-beat-sync container over Workers VPC (Hetzner fleet; issue #83).
//
// SYNC: analysis completes in one invoke (no /poll). The core presigns the audio bed and passes
// `audio_url` + `audio_key` in config at invoke time (runtime fields, not in config_schema).
// When invoked without audio_url (e.g. film score chain), the module passthroughs the film_key.

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type ScoreInput,
  type BeatSyncOutput,
} from "./contract";
import {
  MODES,
  appliedTags,
  buildAnalyzeBody,
  normalizeConfig,
  parseContainerResponse,
} from "./beat-sync";
import { timedVpcFetch, withVpcElapsedApplied } from "../../_shared/vpc-call-log";
import { mediaFinishHeaders } from "../../_shared/media-finish-auth";

interface Env {
  AUDIO_BEAT_SYNC_VPC: Fetcher;
  MEDIA_FINISH_TOKEN?: { get(): Promise<string> } | string;
}

const MANIFEST: ModuleManifest = {
  name: "beat-sync",
  version: "0.1.2",
  api: MODULE_API,
  hooks: ["score"],
  provides: [{ id: "librosa-beat-sync", label: "Beat sync (librosa, fleet VPC)" }],
  config_schema: {
    clip_seconds: {
      type: "float",
      default: 8,
      min: 0.5,
      max: 60,
      label: "target seconds per shot",
    },
    mode: {
      type: "enum",
      values: [...MODES],
      default: "beat",
      label: "timing mode",
    },
    min_scene_s: {
      type: "float",
      default: 2.5,
      min: 0.5,
      max: 30,
      label: "minimum shot length (beat mode)",
    },
    max_scene_s: {
      type: "float",
      default: 12,
      min: 1,
      max: 60,
      label: "maximum shot length (beat mode)",
    },
    force_shots: {
      type: "int",
      default: 0,
      min: 0,
      max: 50,
      label: "force shot count (duration mode; 0 = auto)",
    },
  },
  ui: { section: "score", order: 30 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function runAnalyze(
  env: Env,
  req: InvokeRequest<ScoreInput>,
): Promise<InvokeResponse<BeatSyncOutput>> {
  const filmKey = typeof req.input?.film_key === "string" ? req.input.film_key.trim() : "";
  if (!filmKey) return { ok: false, error: "score: input.film_key required" };

  const audioUrl = typeof req.config?.audio_url === "string" ? req.config.audio_url.trim() : "";
  if (!audioUrl) {
    return { ok: true, output: { film_key: filmKey, applied: ["beat-sync:skipped"] } };
  }

  const audioKey = typeof req.config?.audio_key === "string" ? req.config.audio_key.trim() : "";
  const config = normalizeConfig(req.config);
  const body = buildAnalyzeBody(config, audioUrl, audioKey);

  // cf#396: wall-clock start + duration on every fleet VPC hop (structured log + applied tag).
  const timed = await timedVpcFetch(
    (url, init) => env.AUDIO_BEAT_SYNC_VPC.fetch(url, init),
    {
      method: "POST",
      headers: await mediaFinishHeaders(env.MEDIA_FINISH_TOKEN),
      body: JSON.stringify(body),
    },
    {
      module: MANIFEST.name,
      service: "audio-beat-sync",
      binding: "AUDIO_BEAT_SYNC_VPC",
      url: "http://audio-beat-sync/analyze",
      mode: "sync",
      filmKey: filmKey,
      project: req.context?.project,
      contextJobId: req.context?.job_id,
    },
  );
  if (timed.err || !timed.resp) {
    const msg = timed.err instanceof Error ? timed.err.message : String(timed.err ?? "unreachable");
    return { ok: false, error: "score: beat-sync VPC fetch failed: " + msg.slice(0, 200) };
  }
  const resp = timed.resp;

  let raw: unknown;
  try {
    raw = await resp.json();
  } catch {
    return { ok: false, error: "score: beat-sync container returned non-JSON" };
  }

  const parsed = parseContainerResponse(raw);
  if (!parsed.ok) {
    return { ok: false, error: "score: " + parsed.error };
  }

  return {
    ok: true,
    output: {
      film_key: filmKey,
      applied: withVpcElapsedApplied(appliedTags(config.mode), timed.elapsedMs),
      beat_plan: parsed.plan,
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/module.json") return json(MANIFEST);

    // GET /ready (cf#295): binding-visibility probe, the same discipline as credential readiness
    // (docs/module-api.md "Credential readiness") applied to a service binding instead of a secret.
    // Booleans only, in a `bindings` field kept separate from `credentials`. Unlike audio-master's
    // soft degrade, a missing AUDIO_BEAT_SYNC_VPC binding hard-fails runAnalyze() (the bare property
    // access throws inside the try/catch and returns ok:false), so this is a genuine ready/not-ready
    // signal, not merely informational.
    if (request.method === "GET" && url.pathname === "/ready") {
      return json({
        ok: Boolean(env.AUDIO_BEAT_SYNC_VPC),
        module: MANIFEST.name,
        bindings: { audio_beat_sync_vpc: Boolean(env.AUDIO_BEAT_SYNC_VPC) },
      });
    }

    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<ScoreInput>;
      try {
        req = (await request.json()) as InvokeRequest<ScoreInput>;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as InvokeResponse);
      }
      if (req.hook !== "score") {
        return json({ ok: false, error: "unsupported hook " + String(req.hook) } as InvokeResponse);
      }
      return json(await runAnalyze(env, req));
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
