// Worker Env binding for the Vivijure studio core.
//
// Hand-authored interface mirroring wrangler.toml. Adding a binding: update wrangler.toml, then
// mirror it here.
//
// R2_RENDERS is the `vivijure` bucket (bundles, keyframes, clips, MP4s, cast assets). R2 is the
// chat-side bucket (`skyphusion-llm`); image chat outputs and cross-bucket audio staging still use
// it. RUNPOD_* and R2_S3_* are secrets/vars.
//
// MODULE bindings: opt-in module workers attach as service bindings named `MODULE_<NAME>` (Fetcher),
// discovered by the registry (src/modules/registry.ts). Not statically listed; a deployment installs
// only the modules it wants.

import type { RateLimitBinding } from "./rate-limit";

export interface Env {
  // Static frontend (the studio UI), served via Workers Assets.
  ASSETS: Fetcher;

  // Phase 3 (Workers for Platforms): the OUTBOUND dynamic-dispatch binding to the `vivijure-modules`
  // dispatch namespace. A module uploaded into the namespace is resolved at request time by
  // MODULE_DISPATCH.get(<script-name>) -> Fetcher, then invoked over the SAME /invoke envelope as a
  // service-bound module (registry.fetcherFor). OPTIONAL: a deploy without WfP (the standard self-host
  // path) leaves it unbound, everything falls back to `MODULE_*` service bindings, and the whole
  // dispatch layer is a no-op (registry.discoverDispatchModules short-circuits). Distinct key from the
  // `MODULE_${string}` index signature below: a DispatchNamespace has `.get()`, not `.fetch()`.
  MODULE_DISPATCH?: DispatchNamespace;

  // AI Gateway (LLM storyboard planning + image chat + cloud-animate scoring prompts).
  AI: Ai;
  GATEWAY_ID: SecretsStoreSecret | string;
  // Planner LLM auth: authenticated AI Gateway token + xAI BYOK (secrets, optional).
  CF_AIG_TOKEN?: SecretsStoreSecret | string;
  XAI_API_KEY?: string;

  // Storage. R2_RENDERS = the `vivijure` bucket (bundles, keyframes, clips, MP4s, project state).
  // R2 = the chat-side bucket; the render flow copies a staged audio bed across from it.
  R2: R2Bucket;
  R2_RENDERS: R2Bucket;
  DB: D1Database;

  // R2 S3-compatible creds for SigV4 presigning (r2-presign.ts): the CPU containers have no R2
  // binding, so the Worker presigns short-lived GET/PUT URLs. ACCESS/SECRET are secrets; ENDPOINT +
  // BUCKET are vars. Optional so a presign-free deploy still typechecks.
  R2_S3_ACCESS_KEY_ID?: SecretsStoreSecret | string;
  R2_S3_SECRET_ACCESS_KEY?: SecretsStoreSecret | string;
  R2_S3_ENDPOINT?: string;
  R2_S3_BUCKET?: string;

  // RunPod serverless render endpoint (runpod-submit.ts). Secrets.
  //
  // RUNPOD_API_KEY IS OPTIONAL AS OF cp#321, and the optionality is the product statement rather
  // than a loosened type. On a SHARED hosted tenant this binding MUST NOT EXIST: the studio reaches
  // RunPod through the control-plane proxy and holds no RunPod credential it could extract (Conrad,
  // 2026-08-03). Declaring it required said the opposite -- that every studio always holds our key.
  // Nothing in src/ dereferences it; it is read through core's `runpodRoute`, which tolerates an
  // absent binding and refuses honestly. RUNPOD_ENDPOINT_ID stays REQUIRED because the plane binds
  // endpoint ids on BOTH modes; only the credential differs between them.
  RUNPOD_API_KEY?: SecretsStoreSecret | string;
  RUNPOD_ENDPOINT_ID: SecretsStoreSecret | string;
  // The control-plane RunPod proxy pair (cp#321). Bound by the plane for `runpod_mode = 'shared'`
  // ONLY, which is why both are optional: dedicated, BYO and self-host bind neither and take the
  // direct path unchanged. BASE is plain_text (the plane's public origin + `/api/runpod/v2`), TOKEN
  // is the per-tenant `vjp1.<tenant>.<mac>` secret.
  //
  // THE BRANCH IS ON BASE BEING BOUND AND IS NEVER A FAILOVER. A studio with the base bound and the
  // token missing REFUSES; it does not reach for RUNPOD_API_KEY. Resolution lives in core
  // (`runpodRoute`), reached here through modules/_shared/runpod-route.ts, so there is exactly one
  // implementation of that rule in the estate.
  RUNPOD_PROXY_BASE?: SecretsStoreSecret | string;
  RUNPOD_PROXY_TOKEN?: SecretsStoreSecret | string;
  // Dedicated Wan 2.2 A14B LoRA-training endpoint (runpod-submit submitTrainWanLoraJob, cf#29). Optional
  // so a deploy without Wan training still typechecks; handleCastTrainWanLora fails loud if it is unset.
  RUNPOD_WAN_TRAIN_ENDPOINT_ID?: SecretsStoreSecret | string;

  // CPU container Durable Objects (off-GPU beat-sync, portrait prep, ffmpeg finish).
  VIDEO_FINISH_VPC: Fetcher; // Workers VPC -> always-on fleet video-finish (issue #83)
  // OPTIONAL var (cf#240 lane D), NOT a binding: which absent-state this studio is in when
  // VIDEO_FINISH_VPC is unbound. "unprovisionable" = provisioned before the tier existed, with no
  // operator action that can reach it (the cp#112 population). Absent -> the conservative default,
  // "provisionable". Nothing sets this today; the plane-side half is a control-plane decision.
  // A bound tier always wins over this var: see videoFinishState (an observation beats a label).
  VIDEO_FINISH_TIER_STATE?: string;

  // OPTIONAL var (control-plane#130), NOT a binding: where a reporter should be sent to report
  // abuse of THIS studio. The hosted plane sets it on tenant studios; a self-host install leaves it
  // unset and the panel then advertises nothing at all, which is correct, because we are not the
  // provider for a self-hosted studio and cannot act on its content. A self-hoster who wants their
  // own contact published sets this to their own URL. See src/abuse-contact.ts.
  ABUSE_REPORT_URL?: string;
  IMAGE_PREP_VPC: Fetcher; // Workers VPC -> always-on fleet image-prep (issue #83)
  AUDIO_BEAT_SYNC_VPC: Fetcher; // Workers VPC -> always-on fleet audio-beat-sync (issue #83)
  // OPTIONAL (#231): Workers VPC -> always-on fleet audio-mix container (/mix: multi-track duck +
  // loudnorm). Optional so the Worker deploys before the VPC service is provisioned; the mux phase
  // degrades to the single-track remux when it is absent. Provisioned + bound by infra (Strummer).
  AUDIO_MIX_VPC?: Fetcher;

  // CF Access JWT verification (F2, src/access-auth.ts): fail-CLOSED in-Worker backstop so the data
  // plane never depends solely on the edge Access app. Deploy-specific, NOT secrets -> wrangler.toml
  // [vars]. ACCESS_TEAM_DOMAIN = the Zero Trust team hostname (e.g. "skyphusion.cloudflareaccess.com");
  // ACCESS_AUD = the Access application AUD tag. When BOTH are set, /api/* requires a valid Access JWT
  // (fail closed). When unset, the backstop is not armed: /api/* is allowed with a loud one-time warning
  // and the app relies solely on the edge Access gate. Production MUST set both. See docs/SECURITY.md.
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  // Conscious opt-out (dev/local/test or a deployer fronting their own auth proxy): when neither
  // ACCESS_TEAM_DOMAIN nor ACCESS_AUD is set, /api/* is DENIED by default unless this is "true".
  ALLOW_UNAUTHENTICATED?: string;
  // #423 built-in token auth (src/auth-gate.ts). AUTH_MODE selects the /api/* gate: "token" ->
  // Authorization: Bearer checked against STUDIO_API_TOKEN with a constant-time compare (no Zero
  // Trust needed); "access" or unset -> the CF Access path above (unset keeps the legacy
  // resolution, so pre-#423 deploys are untouched); "demo" (#625) -> the public demo studio
  // (GET/HEAD open to everyone, every mutation 403, no credential honored). Any other value
  // denies everything (fail closed). AUTH_MODE is a [vars] entry; STUDIO_API_TOKEN is a worker SECRET deploy.sh mints
  // (openssl rand -hex 32 | wrangler secret put STUDIO_API_TOKEN). See docs/SECURITY.md.
  AUTH_MODE?: string;
  STUDIO_API_TOKEN?: string;

  // #631 Phase B public demo render + assistant (demo deploys ONLY; UNBOUND/absent on prod + self-host,
  // so no code path here can reach the box or the model off-demo). DEMO_RENDER_ENABLED "true" arms the
  // seeded click-to-render menu (also needs MODULE_LOCAL_GPU bound to the demo-scoped local-gpu door);
  // unset/"false" => renders paused (the swappable-backend HORIZON state, box dies ~2026-08-04).
  DEMO_RENDER_ENABLED?: string;
  // The isolated demo R2 PUBLIC origin the box writes rendered clips under; the demo builds the artifact
  // URL as <origin>/<clip_key> (the demo worker binds NO R2). Enumerated in the demo media CSP (no wildcard).
  DEMO_ARTIFACT_ORIGIN?: string;
  // The OSS assistant model id (Workers AI llama-3.3-70b class) + optional cap overrides. Numeric strings
  // parsed with the shipped defaults (demo-render.ts / demo-chat.ts) when unset/garbage.
  DEMO_ASSISTANT_MODEL?: string;
  DEMO_RENDER_PER_IP_DAILY?: string;
  DEMO_RENDER_GLOBAL_DAILY?: string;
  DEMO_RENDER_QUEUE_DEPTH?: string;
  DEMO_CHAT_PER_IP_DAILY?: string;
  DEMO_CHAT_GLOBAL_DAILY?: string;

  // Dev-only planner AI mock (#411 dev-parity). When "1"/"true", planStoryboard/refineStoryboard
  // return deterministic canned completions instead of a live model call, so the planner re-prompt
  // flow is drivable in the fully-local module-bound dev env (no AI binding). UNSET in prod; the
  // live provider path is unchanged. See src/planner-ai-mock.ts.
  PLANNER_AI_MOCK?: string;

  // Rate limiting for GPU/spend endpoints (F3, src/rate-limit.ts). The Cloudflare native Rate
  // Limiting binding; added to wrangler.toml [[ratelimits]] by infra (Strummer). Optional: when
  // Default: fail CLOSED when unbound/broken (spend routes 503). Opt out with
  // SPEND_LIMIT_FAIL_CLOSED="false" for the old allow+warn posture. See src/rate-limit.ts + docs/SECURITY.md.
  SPEND_RATE_LIMITER?: RateLimitBinding;

  // S4 spend-posture knobs ([vars]; src/rate-limit.ts):
  // Default fail-closed. Only the literal "false" opts into fail-open (allow + warn when the check
  // is broken/unbound). Prefer blocked renders over unmetered spend.
  SPEND_LIMIT_FAIL_CLOSED?: string;
  // Positive integer: max spend-route submissions per UTC day, counted atomically in D1
  // (spend_counter, migration 0008). Over the ceiling denies 429, Retry-After = UTC midnight.
  SPEND_DAILY_CEILING?: string;
  // core#52 storage ceiling, in BYTES. Unset / "0" / non-integer = OFF. Set = enforced at submit with
  // an honest 507 deny carrying used-vs-limit; 503 (fail closed) when the quota is set but its own
  // check cannot run. Usage is accounted at write time in D1 (migration 0013), never read from the R2
  // usage API -- that read is CF-specific and would break the Node/MinIO host. See docs/STORAGE-QUOTA.md
  // in vivijure-core.
  R2_STORAGE_QUOTA_BYTES?: string;

  // #697 per-shot duration honesty gate floor: the fraction of a shot`s planned seconds an assembled
  // clip must reach before the render fails loud (a truncated clip, not a beat-trim). [vars] entry,
  // parsed + clamped to [0,1] (resolveClipDurationFloor); unset defaults to 0.5, 0 disables the gate.
  FILM_CLIP_DURATION_FLOOR?: string;

  // cf#287: studio release / build identity projected on GET /api/modules as top-level
  // `studio_release` (+ optional `git_sha`). Unset => the baked package.json version is projected
  // so two tag deploys are still distinguishable. The control plane may bind STUDIO_RELEASE to the
  // tenant's live tag (the value it already stores as tenants.studio_release); self-host can leave
  // both unset. See src/studio-release.ts.
  STUDIO_RELEASE?: string;
  STUDIO_GIT_SHA?: string;

  // BYOK OpenAI image gen (transparent PNG for gpt-image-1.5). Optional.
  OPENAI_API_KEY?: string;

  // Opt-in module workers: `MODULE_<NAME>` service bindings (Fetcher), discovered by the registry.
  // The value type also admits DispatchNamespace so the one dispatch binding in this prefix
  // (MODULE_DISPATCH, above) satisfies this index signature; the registry's `isFetcher` guard keeps a
  // service-binding access from ever being handed the namespace (it has `.get()`, not `.fetch()`).
  [key: `MODULE_${string}`]: Fetcher | DispatchNamespace | undefined;
}
