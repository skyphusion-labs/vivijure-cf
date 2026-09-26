# Writing a Vivijure module

> The SDK story. Vivijure is a **host, not a monolith**: the core owns only what is always true
> (project, storyboard, cast, bundle, the render spine, and a module registry). Every *capability*
> beyond that is an opt-in **module worker** that plugs into the pipeline through one typed contract.
> Install a module and its stage lights up, bringing its own settings; install none and you get a
> clean, honest, empty studio. This guide shows you how to write one.

See also [`module-api.md`](./module-api.md) for the contract design, and the reference module
[`modules/plan-enhance/`](../modules/plan-enhance) which this guide walks through.

## The shape of a module

A module is a standalone Cloudflare Worker. A synchronous module serves two contract endpoints
(plus the `GET /ready` probe); an async or cancelable one serves up to four:

| Endpoint | Required | Purpose |
|---|---|---|
| `GET /module.json` | always | the module's **manifest** (which hooks it serves, its config, how it surfaces in the UI) |
| `POST /invoke` | always | run one hook: `{ hook, input, config, context }` in, an `InvokeResponse` out |
| `POST /poll` | **async modules** | when `/invoke` returns `{ ok: true, pending: true, poll }`, the core polls here with `{ poll }` (`PollRequest`) until the job is terminal, answering a `PollResponse` (a long RunPod render must be async so no Worker holds a request open) |
| `POST /cancel` | **`cancelable` modules** | stop an in-flight async job by its poll token (`CancelRequest` `{ poll }` in, `CancelResponse` out), so a cancelled render or an adopted phase does not orphan GPU and bleed spend (#327/#328); best-effort + idempotent. Advertise it with `cancelable: true` in the manifest |
| `GET /ready` | **in-repo modules** (optional for an external module) | credential-visibility probe: `{ ok, module, credentials: { <name>: boolean } }`, booleans only, never values (cf#114/cf#295; see [`module-api.md`](./module-api.md) "Credential readiness"). Every worker under `modules/` must serve it: `tests/module-ready-coverage-291.test.ts` fails otherwise |

The core discovers your module from a `MODULE_<NAME>` service binding, reads your manifest, indexes
you by hook, and renders your stage in the studio UI from your `config_schema`. It invokes you when a
render reaches your hook. **The core never knows who answers** -- it just asks the hook.

### The trust boundary: your module is reachable ONLY through the core (HARD RULE)

The `MODULE_<NAME>` **service binding IS the authentication.** Service-binding calls are
worker-to-worker and never traverse the public internet, so your `/invoke` never needs (and must not
add) its own auth check -- the core is the only caller, and the core sits behind the studio auth gate.

That guarantee holds ONLY while your module has **no public surface.** In your `wrangler.toml` set
`workers_dev = false` and declare **no `route`** (every first-party module does). A module that
publishes a `workers.dev` host or a custom route exposes `/invoke` to the open internet with **zero
authentication** -- and modules wrap real spend (a public `motion.backend`/`keyframe` module is an
unauthenticated RunPod GPU-spend trigger; a public `notify` module is an open mail relay). Keep the
surface internal: the service binding is the boundary, do not punch a hole in it.

## The hooks (vivijure-module/2)

| Hook | Purpose | Cardinality |
|---|---|---|
| `keyframe` | storyboard -> start keyframes (SDXL on GPU) | **pick one** |
| `motion.backend` | keyframe (+ motion prompt) -> shot clip (GPU or cloud) | **pick one** per shot |
| `finish` | post-process a clip: interpolation / lip-sync / upscale / face restore | **chain** |
| `score` | add audio to a film: music / narration / beat-sync | **chain** |
| `dialogue` | per-shot dialogue lines -> speech audio (TTS); feeds the lip-sync finish module | **pick one** |
| `speech` | per-shot dialogue audio -> cleaned/enhanced audio (post-dialogue, pre-finish) | **chain** |
| `plan.enhance` | expand a storyboard before render (LLM auto-direction) | **chain** |
| `image.generate` | prompt -> a generated image | **pick one** |
| `cast.image` | portrait + bible -> LoRA training reference images | **pick one** |
| `notify` | render-complete notification (email / webhook) | **chain** |
| `master` | assembled film's audio bed -> mastered audio (music upscale + loudness), pre-mux; fail-safe | **chain** |
| `film.finish` | assembled + muxed film -> title / credit cards (post-mux; runs on the single-film path AND the scatter finalize, #602) | **chain** |

`pick_one` resolves to a single module. The user picks; for most hooks an omitted choice defaults
to the `ui.order`-first serving module, EXCEPT `motion.backend` on a full render, where the choice
is REQUIRED -- an omitted or non-serving backend is rejected at submit with the installed list
(#500/#504), so a non-operational door can never be silently defaulted into. `chain` folds every
installed module in `ui.order`, each consuming the previous one's output.

## The 4-file template

A module is small. The minimal shape is four files:

```
modules/<your-module>/
  wrangler.toml        # name, compat date, and the bindings your /invoke needs
  src/contract.ts      # VENDORED copy of the contract shapes you use
  src/<logic>.ts       # your pure logic (so it unit-tests without the runtime)
  src/index.ts         # the worker: GET /module.json + POST /invoke (+ GET /ready)
```

The reference `plan-enhance` module has grown past that minimum to seven files: `wrangler.toml`,
`README.md`, `src/contract.ts`, `src/index.ts`, and its logic split three ways (`src/enhance.ts`,
`src/provider.ts` for the Opus-vs-Workers-AI choice, `src/mock.ts` for the dev-only planner mock).

### 1. Vendor the contract

A module **vendors** the contract shapes it uses (copy them into `src/contract.ts`) so it stays
independent of the core's repo -- a module in another repo ships its own copy. Copy only what you
need from `@skyphusion-labs/vivijure-core` (`modules/types`): `MODULE_API`, the manifest types, the
`InvokeRequest`/`InvokeResponse` shapes (plus `PollRequest`/`PollResponse` for an async module and
`CancelRequest`/`CancelResponse` for a cancelable one), and your hook's payload types (e.g.
`PlanEnhanceInput` / `PlanEnhanceOutput`).

### 2. Declare your manifest

Abridged from `modules/plan-enhance/src/index.ts` (the real `model` enum lists more ids, and the
version moves with the module):

```ts
const MANIFEST: ModuleManifest = {
  name: "plan-enhance",
  version: "0.2.1",
  api: MODULE_API,                       // "vivijure-module/2"
  hooks: ["plan.enhance"],
  provides: [{ id: "auto-direction", label: "Opus auto-direction" }],
  config_schema: {                       // the UI renders a control per field
    model: {
      type: "enum",
      values: ["anthropic/claude-opus-4-8", "anthropic/claude-sonnet-5" /* ... */],
      default: "anthropic/claude-opus-4-8",
      label: "model",
    },
    intensity: { type: "enum", values: ["light", "medium", "bold"], default: "medium", label: "direction intensity" },
  },
  ui: { section: "plan", order: 10 },
};
```

`config_schema` fields (`int` / `float` / `bool` / `enum` / `string`, each with a `default`, and
`min`/`max` for numbers) are the single source of truth: the studio renders the control from them,
the core clamps the user's value against them before calling you, so your `/invoke` never has to
defend against junk. Each field may also carry an optional `label` (the control's text),
`enum_labels` (`int`/`float` only: display text per value), and `scope`: `"render"` (the default when
omitted; a per-render knob) or `"install"` (operator-set once, stored in the operator-config store,
surfaced on the studio settings page, and injected at invoke time). The core's `validateConfig`
**drops every key your schema does not declare**, fills missing keys with the field `default`,
clamps numbers to `[min, max]`, and replaces an out-of-set enum value with its default -- so a knob
you read in `/invoke` but forgot to declare always arrives absent.

**Fields conformance requires for some hooks.** `validateManifest` still LOADS a manifest without
these, but `checkManifest` (the conformance harness) FAILS it:

- a module serving `finish` (the `SELECTABLE_HOOKS`) must declare `participation: "default" | "opt_in"`
  (cf#537): `"default"` runs when a render carries no explicit selection for the hook, `"opt_in"`
  runs only when the render's selection names it;
- a module serving `finish` or `speech` (the `CEILING_DERIVED_HOOKS`) must declare
  `max_invocation_seconds` (core#223): the wall-clock ceiling your module ACTUALLY enforces on one
  invocation, which the core sizes its phase stall ceiling against. Declare only a guard you have.

**Optional, additive manifest fields** (no `MODULE_API` bump; see the doc comments on
`ModuleManifest` in `@skyphusion-labs/vivijure-core/modules/types`): `cancelable`, `ui.locality`
(`"local" | "byo" | "cloud"`; every `motion.backend` should set it, since an undeclared locality
classifies as cloud) plus the display-only `ui.cost` / `ui.blurb` / `ui.limits`, `finish_artifacts`
(a finish module's output-key + `applied` conventions for R2 mid-chain recovery),
`finish_consumes_audio` (a lip-sync finish module; runs first on the native-fps clip),
`duration_grid` and `usage` (a motion backend's fixed frame grid and duration/voice envelope),
`keyframe_label`, and `needs_tenant_r2`.

**`needs_tenant_r2`** is for a module that submits to a RunPod endpoint that may be pooled across
hosted tenants (today `keyframe` and `own-gpu`): only a module declaring it receives the tenant's
per-job R2 credential as `InvokeRequest.r2` (cp#270), and never a dispatch (community) module. A
receiver must call `takeTenantR2(req)` (`@skyphusion-labs/vivijure-core/modules/tenant-r2`) at the
top of its handler, which reads and strips the block in one step. Leave the flag absent unless your
module needs it.

### 3. Serve the two endpoints

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/module.json") {
      return json(MANIFEST);
    }
    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<MyInput>;
      try {
        req = (await request.json()) as InvokeRequest<MyInput>;
      } catch {
        return json({ ok: false, error: "invalid JSON body" }); // garbage is DATA: HTTP 200, not a 500
      }
      if (req.hook !== "plan.enhance") {
        return json({ ok: false, error: `unsupported hook ${req.hook}` });
      }
      return json(await run(env, req)); // your work -> InvokeResponse
    }
    return json({ ok: false, error: "not found" }, 404);
  },
};
```

### 4. Failures are DATA, never an exception

The single most important rule. A module failure must be a value, not a thrown error across the
wire, so the core degrades instead of crashing. Always return HTTP 200 with an `InvokeResponse`:

```ts
type InvokeResponse<O> =
  | { ok: true; output: O }
  | { ok: true; pending: true; poll: string; jobId?: string }   // async: the core polls /poll with { poll }
  | { ok: false; error: string };

type PollResponse<O> =
  | { ok: true; pending: true; wait?: "accepted" | "running" }
  | { ok: true; output: O }
  | { ok: false; error: string; outcome?: "backend-error" | "failed" | "gone" | "cancelled";
      runpodStatus?: string; errorType?: string };

type CancelResponse = { ok: true } | { ok: false; error: string };
```

For a chain hook, prefer a **soft degrade** where it makes sense: if your work cannot run (an
upstream model is down, a reply is unparseable), return `{ ok: true, output: <input passed through>, ... }`
with a note, so the chain continues from a good value. A hard `{ ok: false }` is for "I cannot honor
this request at all" (malformed I/O, a missing credential). **Do not assume the core shrugs it off.**
On `finish`, an `ok: false` from `/invoke` or `/poll` is retried only when classified transient (a
bounded retry, vivijure-core film-orchestrator `failOrRetry`); otherwise it FAILS the render with the
real per-shot error, by design, so a render never ships an unfinished clip as done. A finish module
that merely could not polish a clip (no face in the frame, a wall-clock guard expired, a model would
not load) must therefore answer `ok: true` with the input clip passed through, `applied` tagged, and
`degraded: "<reason>"` (`FinishOutput.degraded`). The first-party finish modules share that
classification in `modules/_shared/finish-soft-degrade.ts` (cf#594).

## Wrapping a RunPod (or any cloud) worker

The template generalizes to any off-GPU or cloud capability: keep the same four files and make
`/invoke` proxy your backend instead of doing the work in the Worker.

**Never build the RunPod URL or the bearer yourself.** Both come from the route helpers in
`@skyphusion-labs/vivijure-core/runpod-route` (moved into core by cp#321). An in-repo module imports
them through `modules/_shared/runpod-route.ts`, which is a pure re-export kept so existing import
paths work (it must declare nothing of its own; `tests/runpod-route-reexport-cp321.test.ts`); an
external module imports core directly. A module that hard-codes either is unreachable for a shared
hosted tenant (cf#394, cp#288). The reason is an invariant, not a style preference: on the hosted
tier no tenant-namespace script may hold a RunPod credential at all, so the control plane stands a
proxy in front of RunPod and binds `RUNPOD_PROXY_BASE` to it. A module with a literal
`https://api.runpod.ai` in it ignores that binding at that one call site and reaches RunPod directly
with a credential a tenant must never have.

```ts
import {
  runpodRoute, runpodEndpointUrl, runpodHeaders, runpodCredentialName,
  planeRefusalReason, planeRefusalError, type RunpodRoute,
} from "../../_shared/runpod-route";   // external module: "@skyphusion-labs/vivijure-core/runpod-route"
import { secretValue } from "@skyphusion-labs/vivijure-core/secret-store";

async function run(env: Env, req: InvokeRequest<MotionInput>): Promise<InvokeResponse<MotionOutput>> {
  // 0. resolve the route. Proxied when the plane bound RUNPOD_PROXY_BASE, direct otherwise.
  const route = await runpodRoute(env);
  if (!route.credential) {
    // Name the binding that is actually missing ON THIS ROUTE. Telling an operator to look for
    // RUNPOD_API_KEY on a proxied worker sends them after a binding that must not exist there.
    return { ok: false, error: `my-module: ${runpodCredentialName(route)} not configured` };
  }
  // RUNPOD_ENDPOINT_ID is a Secrets Store binding (or a plain_text string on a hosted upload):
  // resolve it to a string before building the URL, never interpolate the binding object.
  const endpointId = await secretValue(env.RUNPOD_ENDPOINT_ID);
  if (!endpointId) return { ok: false, error: "my-module: RUNPOD_ENDPOINT_ID not configured" };
  // 1. submit. The suffixes are RunPod's own on both routes, so this line does not branch.
  const sub = await fetch(runpodEndpointUrl(route, endpointId) + "/run", {
    method: "POST",
    headers: { ...runpodHeaders(route, MANIFEST.name), "content-type": "application/json" },
    body: JSON.stringify({ input: toBackendInput(req.input, req.config) }),
  });
  // 2. poll /status until COMPLETED (or stream). On EVERY poll, before the body is read:
  //      const refusal = planeRefusalReason(route, resp);
  //      if (refusal) return { ok: false, error: planeRefusalError(MANIFEST.name, refusal) };
  // 3. map the result to your hook's output type
  // 4. on any failure return { ok: false, error } (or a soft passthrough for a chain hook)
}
```

Declare both proxy bindings as OPTIONAL in your `Env`, because everything except a shared hosted
tenant leaves them unbound:

```ts
interface Env {
  RUNPOD_ENDPOINT_ID: SecretsStoreSecret;      // resolve with secretValue() before use
  RUNPOD_API_KEY: SecretsStoreSecret;          // the DIRECT route's bearer
  RUNPOD_PROXY_BASE?: string;                  // plain_text, shared hosted tenants only
  RUNPOD_PROXY_TOKEN?: SecretsStoreSecret | string;  // the PROXIED route's bearer
}
```

Three rules that are not obvious from the code:

- **The branch is whether `RUNPOD_PROXY_BASE` is bound. It is never a failover.** A proxied module
  whose token is missing REFUSES; it must not reach for the direct key, because a shared tenant that
  can fall back to a RunPod credential is a shared tenant holding one.
- **The unbound path is the self-host product, not a transitional one.** vivijure-cf ships to
  individual self-hosters on their own Workers with their own RunPod account, as well as to shared
  hosted tenants. Both branches are permanent; neither is scaffolding to be removed later.
- **A plane refusal on the POLL path must never read as pending (cf#398).** Your poll almost
  certainly returns `{ ok: true, pending: true }` when it cannot read the upstream, which was
  right when the upstream was RunPod. It is not right when the upstream is ours: a plane that is
  degraded, mid-deploy or refusing this tenant then produces a render that never completes and
  never errors. Call `planeRefusalReason(route, resp)` on the response BEFORE interpreting it and
  return an error when it is non-null. It answers null on the direct route, on a normal response,
  and on a proxy 502 that could not reach RunPod, so a RunPod blip keeps its retry and only OUR
  refusal is terminal. Do not widen this to "any poll failure": that makes a vendor hiccup look
  like our outage, which is a different wrong answer rather than a fix.
- **Only `/run`, `/status/<id>`, `/cancel/<id>` and `/health` exist on the proxy.** Anything else is
  a 404 there, deliberately: `purge-queue` wipes an endpoint's queue for every tenant on it, and
  RunPod's per-endpoint scoping has no operation axis that could refuse it.
- **The RunPod MANAGEMENT API (`rest.runpod.io`) is not proxied and never will be.** Endpoint
  capacity is an operator property. If your module calls something like
  `reconcileRunpodEndpointWorkersMax`, gate it on `!route.proxied`.

`tests/runpod-proxy-base-cf394.test.ts` enforces the first rule across the whole module namespace: it
counts every module reaching RunPod and fails if one of them is not routing through the helper.
`tests/plane-refusal-poll-cf398.test.ts` does the same for the poll rule, and drives every module in
its `CASES` table over their real `/invoke` then `/poll` with one stub in three configurations, so a
module that reads the header, one that ignores it, and one that treats every failure as a refusal
are three distinguishable outcomes rather than one. Its census derives the RunPod-reaching
population from source and asserts only a floor (at least 14), so **a new RunPod module must be added
to `CASES` in the same change** (or to `RUNSYNC_ONLY` if it never polls); a RunPod-reaching module in
neither list fails the suite.

### Cross-repo wire name: `x-vivijure-plane-refusal` (cf#403)

The plane emits, and every module reads, the header name held in `PLANE_REFUSAL_HEADER`
(`@skyphusion-labs/vivijure-core/runpod-route`, re-exported by `modules/_shared/runpod-route.ts`). The control plane defines the same constant in
`vivijure-control-plane/src/runpod-proxy-poll.ts`. There is no shared package; both repos pin the
literal `"x-vivijure-plane-refusal"` in `tests/plane-refusal-header-contract.test.ts` (mirrored on
the plane). Renaming the header requires updating **both** pins and both source constants in the
same change wave. A one-sided rename is a silent restore of the forever-pend cf#398 closed.

That is the whole "community becomes the roadmap" play: the RunPod ready-to-deploy hub
(Wan2.2/SDXL/ComfyUI as `motion.backend`, Whisper STT as `score`, vLLM as a self-hosted
`plan.enhance`) is a catalog of modules waiting to be wrapped, each one the same four files.

## Where your change actually goes: TWO delivery paths, different mechanisms, different timing

**The same module source reaches the operator panel and a hosted tenant by two different routes.**
Neither is a fallback for the other, and a change can be live on one while absent from the other for
days. Not knowing this produces "it works on the panel but not for tenants" and sends people hunting
a code difference that does not exist.

**Merging to `main` reaches NEITHER.** Both paths are tag-gated. A merge is CI only.

### Path 1 -- the operator panel: independent Workers, bound by service name

On a SemVer tag, `scripts/deploy-module-workers.sh` runs `wrangler deploy` for each
`modules/*/wrangler.toml`. Each module is its own live Worker, and the core reaches it through the
`[[services]]` binding list. There is no bundle and no artifact hop.

Two gates on that, both worth knowing before you conclude your module did not deploy:

- `CORE_ONLY_DEPLOY` (repo variable) set to `1` deploys the core plus the finish satellites only,
  skipping every other module. Read as `0` on 2026-08-03, so the full set deploys today, but it is a
  mutable variable and the behaviour is a property of its value, not of this sentence.
- `FINISH_SATELLITES_ONLY` narrows to `scripts/finish-satellite-modules.txt`
  (`finish-rife`, `finish-upscale`, `finish-lipsync`, `speech-upscale`).
- `local-gpu` is ALWAYS skipped on this deploy: `ci.yml` exports `EXCLUDE="... local-gpu"` (cf#560),
  because that door belongs on vivijure-local, and the core's `wrangler.toml.example` does not bind it.

Before each `wrangler deploy`, `scripts/fill-module-placeholders.sh` fills the module toml's
`REPLACE_WITH_*` placeholders (`REPLACE_WITH_VIVIJURE_SECRETS_STORE_ID`, `REPLACE_WITH_D1_DATABASE_ID`,
the R2 S3 identifiers) from env and REFUSES the deploy if any survive outside a comment; media URL
vars written as `${VIDEO_FINISH_URL}` etc. become empty (honest off) when unset. A new module toml
should use the same placeholder names for those ids, never a literal account-specific value.

**Do not confuse that file with `scripts/tenant-release-modules.txt` (cf#394).** They overlap and
they answer different questions. `finish-satellite-modules.txt` narrows an OPERATOR deploy;
`tenant-release-modules.txt` is the canonical list of what a studio release PUBLISHES as a tenant
bundle. The satellites are a strict subset of the tenant list, and
`tests/tenant-release-modules-cf394.test.ts` holds that invariant so the two cannot drift.

### Path 2 -- a hosted tenant: a published bundle, fetched by (tag, module)

The control plane is a Worker and cannot bundle at provision time, so each module must arrive as a
single-file, integrity-checked artifact. On a `v*` tag, `ci.yml`'s `studio-release` job (which
`needs: [ci, container-tests, migrations-gate, assert-on-main]`) calls
`.github/workflows/studio-release.yml`, a `workflow_call`-only workflow with no trigger of its own
(cf#562), and `scripts/build-module-release.ts` writes:

```
studio-releases/<tag>/modules/<module>/manifest.json
studio-releases/<tag>/modules/<module>/worker.js
```

The bundle is **not** built by a parallel bundler: it comes from `wrangler deploy --dry-run --outdir`
against the module's own `wrangler.toml`, so the artifact is the deploy shape and cannot drift from
it. The plane then fetches by `(tag, module)` and uploads into the tenant dispatch namespace.

**Which modules take this path is `scripts/tenant-release-modules.txt`, and that is the whole
answer** (cf#394). Adding a module to it publishes a bundle; it does NOT provision anything, because
provisioning is a row in the control plane's `TENANT_MODULE_CATALOG` (mirrored here at
`scripts/tenant-module-catalog.txt`; the required `ci` job's `npm run check:catalog` step fetches the
plane's catalog and fails on drift, cf#470, so a catalog change on the plane turns this repo red
until the mirror is updated). **The two are deliberately allowed to differ:** a published bundle with no catalog row uploads to nobody and costs nothing,
which is what lets the plane add a row whenever it is ready instead of the two repos taking turns.
Until cf#394 the publish set was three names inline in the workflow plus the satellites file, so it
could not be read in one place -- and on 2026-08-03 that cost a lane its direction when the catalog
silently grew to equal it.

Three things about this path that are easy to get wrong:

- **The GitHub release asset is authoritative; our R2 is a cache/mirror only.** That is a parity
  ruling, not an implementation detail: an artifact living only in our private R2 would leave the
  AGPL hosted door open source but structurally unrunnable by anyone else. If R2 and the release
  asset ever disagree, R2 is the one that is wrong -- and a verification that walks only R2 cannot
  tell you that, because it is measuring the mirror.
- **Reaching a tenant needs more than the tag.** The tag builds the artifact; a tenant runs it only
  once `STUDIO_RELEASE` points at that release AND the tenant is provisioned or upgraded onto it.
- **The studio/module coupling is a default, not a law.** A module's `worker.sha256` is deliberately
  NOT chained into the top-level studio pin digest, and the plane re-verifies each module hash at
  provision, so tenants MAY pin modules to a different release than the studio (cf#103).

### The practical consequence

A module change is live for the operator panel one tag after merge, and live for a tenant only after
that tag is built, `STUDIO_RELEASE` is repointed, and the tenant is provisioned or upgraded. **If
your change works in one place and not the other, check which of those steps has happened before you
look for a code difference.**

## Bind it to the core

Deploy your module worker, then add a service binding to the core's deploy config (your
`wrangler.toml`, rendered from the committed `wrangler.toml.example`; a first-party module adds the
block to `wrangler.toml.example` itself). No `src/env.ts` edit is needed: `Env` already carries a
`MODULE_${string}` index signature, and the registry discovers any `MODULE_*` Fetcher binding:

> This is **path 1 only** -- how the operator panel reaches your module. A hosted tenant
> reaches it as a published bundle instead, with different timing and different gates. See
> "Where your change actually goes" above before concluding a deploy did or did not land.

```toml
[[services]]
binding = "MODULE_<NAME>"            # the registry discovers any MODULE_* binding
service = "vivijure-module-<name>"   # your deployed worker's name
```

Redeploy the core. `GET /api/modules` now lists your module, the studio UI renders its stage, and
the core invokes it through your hook. Nothing else is hardcoded.

**Or install without a core redeploy (Workers for Platforms dispatch).** On a host with the
`MODULE_DISPATCH` namespace bound, `scripts/install-module.ts` uploads your Worker into the dispatch
namespace and then calls the operator-scoped `POST /api/modules/install` with `{ "script_name": "<script>" }`.
The core reads the resident script's manifest, runs `runLiveConformance` over that same dispatch
transport, and inserts the registry row only on a green suite (`201 { ok: true, module, script_name, checks }`;
`422 { ok: false, error: "conformance failed", checks }` otherwise). See
[`module-dispatch.md`](./module-dispatch.md).

## Prove it conforms

Before you bind a module, run the **conformance harness** against it to confirm it honors the
contract -- a valid manifest, a well-formed `InvokeResponse`, and graceful degradation on a bad
request. The harness is published as `@skyphusion-labs/vivijure-core/modules/conformance`
(`checkManifest`, `checkInvokeResponse`, `checkHookOutput`, `runLiveConformance`); its source is
[`src/modules/conformance.ts` in vivijure-core](https://github.com/skyphusion-labs/vivijure-core/blob/main/src/modules/conformance.ts).
This repo's `tests/conformance.live.test.ts` drives it against a live module URL.

Run your module **locally** and point the harness at it. Never enable `workers_dev` (or add a route)
to test: that is the public surface the hard rule above forbids.

```
npx wrangler dev -c modules/<name>/wrangler.toml     # an external module: wrangler dev in its own repo
MODULE_URL=http://localhost:8787 npm run conformance # in a second shell, from this repo
```

(`npm run conformance` runs `tests/conformance.test.ts` plus `tests/conformance.live.test.ts`; the live
suite is skipped unless `MODULE_URL` is set. Pass `--port` to `wrangler dev` and adjust the URL if
8787 is taken.) If that is green, your module will plug into the core cleanly. A module installed
through the dispatch route above is gated again: `POST /api/modules/install` runs
`runLiveConformance` over the real dispatch transport before the module is registered.

## Checklist

- [ ] `GET /module.json` returns a manifest with `api: "vivijure-module/2"` (the `/1` window is
      CLOSED as of v0.12.0 -- a `/1` manifest is rejected at registration), a `name`, a `version`,
      and only known `hooks`.
- [ ] A `finish` module declares `participation: "default" | "opt_in"` (cf#537); a `finish` or
      `speech` module declares `max_invocation_seconds` (core#223). Conformance fails without them.
- [ ] `config_schema` fields each have a valid `type` and a `default` consistent with it, and every
      knob `/invoke` reads is declared (undeclared keys are dropped before you are called).
- [ ] `POST /invoke` returns HTTP 200 with a well-formed `InvokeResponse` for every input, including
      garbage (no thrown errors across the wire; guard `request.json()`).
- [ ] A `finish` module answers a polish miss with `ok: true` + passthrough + `degraded`, reserving
      `ok: false` for malformed I/O (an `ok: false` fails the render).
- [ ] `GET /ready` reports credential visibility as booleans (required for a module in this repo).
- [ ] A RunPod-reaching module routes through the core runpod-route helpers, checks
      `planeRefusalReason` on every poll, and is added to `CASES` in `tests/plane-refusal-poll-cf398.test.ts`.
- [ ] Pure logic is split out and unit-tested; the worker is thin glue.
- [ ] Conformance harness is green against the module running locally (`wrangler dev`), with
      `workers_dev = false` and no route.
- [ ] A `[[services]]` binding named `MODULE_<NAME>` is added to the core and the core redeployed.

## Writing a module in Python (second on-ramp)

The contract is **language-agnostic** -- it is a typed JSON exchange over a service binding, so the
core does not care what language answers a hook. A module can be **TypeScript OR Python**. Python is a
good fit for **light control-plane logic** (`plan.enhance`, `score`, orchestration glue).

> Cloudflare Python Workers run on Pyodide and have **no torch/CUDA**, so a Python module **cannot**
> run the GPU render -- the heavy path stays on RunPod. CF Python Workers is currently **open beta**;
> treat Python modules as experimental and keep critical paths off them until GA.

The shape is identical: serve `GET /module.json` and `POST /invoke`. A minimal entrypoint:

```python
import json
from workers import Response, WorkerEntrypoint

MANIFEST = {"name": "my-module", "version": "0.1.0", "api": "vivijure-module/2", "hooks": ["plan.enhance"]}

def _json(body, status=200):
    return Response(json.dumps(body), status=status, headers={"content-type": "application/json"})

class Default(WorkerEntrypoint):
    async def fetch(self, request):
        url, method = str(request.url), str(request.method)
        if method == "GET" and url.endswith("/module.json"):
            return _json(MANIFEST)
        if method == "POST" and url.endswith("/invoke"):
            try:
                req = (await request.json()).to_py()
            except Exception:
                return _json({"ok": False, "error": "invalid JSON body"})  # garbage is DATA, HTTP 200
            # ... run the hook; failure is DATA: return _json({"ok": False, "error": ...})
            return _json({"ok": True, "output": {}})
        return _json({"ok": False, "error": "not found"}, status=404)
```

Tooling is [pywrangler](https://github.com/cloudflare/workers-py) (the Python Workers CLI, needs
[`uv`](https://docs.astral.sh/uv/)): `uvx --from workers-py pywrangler dev` / `... deploy`. Declare
deps in `pyproject.toml` (bundled into `python_modules/` on deploy). `wrangler.toml` needs
`main = "src/entry.py"` and `compatibility_flags = ["python_workers"]`. The same conformance harness
applies -- run it under `pywrangler dev` and a Python module passes
`MODULE_URL=http://localhost:8787 npm run conformance` exactly like a TS one. This on-ramp was proven end-to-end by the now-retired `plan-enhance-py`
proof module (the deterministic Python sibling of the TS `plan-enhance`); see it in the git
history if you need a full worked example.
