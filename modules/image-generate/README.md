# image-generate

A first-class **`image.generate`**-hook module (vivijure-module/2). Prompt in, one generated image
out. It is where the studio's image **model names** live: the core hardcodes none, so
`GET /api/models` projects its image rows from this module's manifest (cf#129 phase 2).

Install it and the studio offers image generation. Do not, and the image catalog is honestly empty
and the picker offers nothing -- no hardcoded fallback, no invented default.

## Where it fits

```mermaid
flowchart LR
  prompt["prompt (+ optional refs)"]
  core["studio core<br/>POST /api/chat"]
  mod["image.generate<br/>(this module)"]
  store["core writes the artifact<br/>to the SERVED bucket"]
  panel["preview / cast portrait"]

  prompt --> core --> mod
  mod -- "image BYTES" --> core --> store --> panel

  style mod fill:#dff,stroke:#0aa,stroke-width:2px
```

## It returns bytes, not a storage key -- deliberately

This module holds **no bucket binding** and never writes storage. The core persists what it returns.

That is [cf#140](https://github.com/skyphusion-labs/vivijure-cf/issues/140) made structural: chat
image artifacts were written to one bucket and served from another, so every preview 404'd in
production while every gate stayed green. A module that cannot write cannot reintroduce that split,
and a third-party image module cannot invent its own key namespace.

It differs from `cast-image`, which does write its own artifacts and return keys. That inconsistency
is **known and deliberate**: `cast-image` produces a *set* of LoRA training references destined for
training rather than a single artifact to serve back. Do not "fix" this module into that shape --
the base64 hop is the point, and it is cheap at image sizes.

## Failure posture: FAIL LOUD

Image generation has no honest passthrough. There is no previous artifact to return and no such
thing as a partially-generated picture, so a provider refusal, an empty result, or zero bytes
returns `ok:false` **naming the model**, never a fake success. An unknown model id is clamped to the
declared default rather than passed upstream, where it would surface as an opaque provider error.

## Config

| knob | type | notes |
|---|---|---|
| `model` | enum | The declared image models. **This is what the studio catalog projects.** Add a model here and the studio offers it with no core deploy. |

## Bindings

| binding | required | why |
|---|---|---|
| `AI` | yes | Workers AI. FLUX 2 runs direct (multipart, gateway-incompatible); proxied and plain `@cf` models ride the gateway when `GATEWAY_ID` is set. |
| `GATEWAY_ID` | no | AI Gateway slug, from the Secrets Store. Without it models still run, ungatewayed. |
| `OPENAI_API_KEY` | no | Operator / self-host BYOK only. Enables the only path to a **transparent PNG** on `openai/gpt-image-1.5` -- the Unified Billing proxy 7003-rejects `background`/`output_format`. Absent, that model returns an opaque image: an honest degradation, not a failure. **Ignored when `TENANT_ID` is set** (cf#401). |
| `TENANT_ID` | no | Hosted attribution (plain text, plane-bound). Presence forces the AI Gateway path for `openai/*` and suppresses direct `api.openai.com`. Absent on self-host. |

No R2 bucket, by design (see above).

## Third-party outbound (cf#401)

This module is one of a small **third-party class**: it can call an external vendor HTTPS endpoint
with its own auth shape (`https://api.openai.com/v1/images/generations`), not RunPod and not our
finishing swarm. The plane's RunPod proxy (`modules/_shared/runpod-route.ts`) has **no vocabulary**
for that class; inventing a full OpenAI proxy is out of scope here.

| path | when | destination | metering |
|---|---|---|---|
| AI Gateway / Workers AI binding | always for `@cf/*`, `google/*`, `recraft/*`; for `openai/*` when no BYOK **or** when `TENANT_ID` is set | CF AI / Unified Billing | plane-bound `AI` + optional `GATEWAY_ID` / `CF_AIG_TOKEN` |
| Direct OpenAI BYOK | operator / self-host only: `OPENAI_API_KEY` set **and** `TENANT_ID` absent | `api.openai.com` | the operator's own key |

**Hosted tenants** must never leave on the operator OpenAI key. The module enforces that in code
(`mayUseOpenAIDirectByok`): even if `OPENAI_API_KEY` is wrongly bound into a tenant namespace, the
direct path stays off and `openai/*` rides the gateway (opaque PNG). Transparent PNG remains an
operator / self-host capability only until a mediated third-party path exists.

**Catalog vs publish.** This module is published as a tenant bundle (`scripts/tenant-release-modules.txt`)
so the plane can add a catalog row without a studio release first. Publishing is **not** provisioning:
it is still absent from `TENANT_MODULE_CATALOG` until the plane is ready. The tenant-safety gate above
is what makes a future catalog row not place unmediated OpenAI spend on our key.

The durable half of cf#401 (correlating the plane catalog with unmediated outbound) is guarded in
this repo by `tests/module-credential-classes-cf394.test.ts` (`OPENAI_API_KEY` = `operator-only`)
and by the `TENANT_ID` branch in `image-gen.ts`.

## Adding a model

Append its id to `MODELS` in `src/index.ts` and confirm `src/image-gen.ts` can dispatch it. Every id
in that list must be executable -- a row the module cannot run is a lie in the studio picker, which
is the defect class cf#129 exists to remove.
