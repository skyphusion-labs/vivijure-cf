# Module tenant-reachability audit (cf#394 item 3)

Measured 2026-08-03 against `vivijure-cf@6730296` (`origin/main`) and
`vivijure-control-plane@6730793`. Refs #394, cp#288.

cf#394 item 3: *"Audit every other module for the same class. `own-gpu` is the one that surfaced, but
any module reading an operator-scoped credential or an operator-only route is equally unreachable
for a tenant. This audit is part of the build, not the rerun."*

## Bottom line

**Every module currently provisioned to a shared hosted tenant reads zero operator-only bindings.**
The RunPod credential class, which is what `own-gpu` surfaced, is closed in this repo: all 14
RunPod-reaching modules route through `modules/_shared/runpod-route.ts`, and none builds the RunPod
base itself. Nothing in vivijure-cf now blocks a shared tenant.

The remaining tenant-reachability limits are **not cf-side code defects**. They are the plane's
catalog (which provisions 6 of 26 modules) and the plane binding `RUNPOD_PROXY_BASE` /
`RUNPOD_PROXY_TOKEN`, which it does not yet do. Ordering is intact and unreversed: this repo teaches
the proxy base with the direct-key branch preserved, and the plane has not yet stopped installing the
key.

One genuine instance of the `own-gpu` class remains, latent rather than live: see finding 3.

## Method, denominators, and what could have gone wrong

**Population, counted mechanically.** `ls modules/*/` returns 27 entries; `_shared` carries no
`wrangler.toml` and no `src/index.ts`, so the module denominator is **26**. Verified the other way
too: 26 of 26 counted modules have a `wrangler.toml`.

**Denominators are not interchangeable, and the important one is not 26.**

| denominator | value | source |
| --- | --- | --- |
| modules in this repo | 26 | `modules/*/wrangler.toml` |
| RunPod-reaching modules | 14 | source reaches `api.runpod.ai/v2` or imports the shared route helper |
| modules provisioned to a shared tenant | **6** | `TENANT_MODULE_CATALOG`, vivijure-control-plane `src/tenant-modules.ts` |

cf#394's rerun criterion says "all 26 modules in exactly one bucket." Twenty of those 26 are not
provisioned to tenants at all, so for phase 1b their honest bucket is *not offered on this door*,
which is a product scope statement rather than a test result. That is flagged as finding 1 because it
changes what 1b can measure, not because anything is broken.

**Enumeration, not pattern-matching.** Every module was enumerated from the directory listing and
from `TENANT_MODULE_CATALOG`; the per-module binding set was derived by extracting every `env.X` read
from each module's own source. No module list was hand-written anywhere in this audit.

**Controls, because a clean zero is the most convincing wrong answer available.**

- Population control: the glob that excludes `_shared` was shown to exclude exactly it.
- Extractor positive control: it returns `RUNPOD_ENDPOINT_ID` from `own-gpu`.
- Extractor negative control: it does not return a binding that does not exist.
- **Gap-predicate mutation control.** The headline "zero RunPod-reaching modules bypass the shared
  seam" is a zero, so the predicate was proved capable of the other answer: breaking one module's
  seam import in a scratch copy moved the result from `<empty>` to `finish-upscale`, and restoring it
  moved it back.

**A correction to the premise this audit was dispatched on.** The dispatch stated that
`RUNPOD_PROXY_BASE` appears in zero files in vivijure-cf and that `own-gpu` reads `RUNPOD_API_KEY`
directly. Both were true of an earlier epoch and are false at `origin/main`: `RUNPOD_PROXY_BASE`
appears in 20 files, and `own-gpu` has routed through the shared helper since #395 merged at 06:15
on 2026-08-03. Item 1 of the ruling was already delivered before this audit began.

## The census

| module | reaches RunPod | on shared route seam | provisioned to tenants | operator-only bindings read |
| --- | --- | --- | --- | --- |
| `alibaba-wan` | yes | yes | no | R2_RENDERS |
| `alibaba-wan-lora` | yes | yes | no | R2_RENDERS |
| `audio-master` | no | n/a | no | AUDIO_MASTER_VPC |
| `beat-sync` | no | n/a | no | AUDIO_BEAT_SYNC_VPC |
| `cast-image` | no | n/a | no | R2_RENDERS IMAGES |
| `cloud-keyframe` | no | n/a | no | R2_RENDERS IMAGES |
| `dialogue-gen` | no | n/a | no | R2_RENDERS DIALOGUE_WORKFLOW |
| `film-titles` | no | n/a | no | VIDEO_FINISH_VPC |
| `finish-lipsync` | yes | yes | YES | none |
| `finish-rife` | yes | yes | no | none |
| `finish-upscale` | yes | yes | YES | none |
| `google-veo` | yes | yes | no | R2_RENDERS |
| `image-generate` | no | n/a | no | OPENAI_API_KEY |
| `keyframe` | yes | yes | YES | none |
| `kling` | yes | yes | no | R2_RENDERS |
| `local-gpu` | no | n/a | no | LOCAL_BACKEND_URL LOCAL_BACKEND_TOKEN |
| `minimax-hailuo` | yes | yes | no | R2_RENDERS |
| `music-gen` | no | n/a | no | R2_RENDERS SCORE_WORKFLOW |
| `narration-gen` | yes | yes | no | R2_RENDERS |
| `notify-email` | no | n/a | no | EMAIL |
| `own-gpu` | yes | yes | YES | none |
| `plan-enhance` | no | n/a | YES | none |
| `seedance` | yes | yes | no | R2_RENDERS |
| `speech-upscale` | yes | yes | YES | none |
| `subtitle` | no | n/a | no | VIDEO_FINISH_VPC |
| `vidu-q3` | yes | yes | no | R2_RENDERS |

## Findings

**1. The tenant catalog is 6 modules, not 26, and that is the real limit on 1b coverage.**
`TENANT_MODULE_CATALOG` provisions `keyframe`, `own-gpu`, `finish-upscale`, `finish-lipsync`,
`speech-upscale` and `plan-enhance`. The other 20 are never uploaded into a tenant's module
namespace, so a tenant studio's registry cannot project them. Phase 1b can therefore exercise 6
modules as a shared client; the remaining 20 are *not offered on this door*, and recording them any
other way would round an unmeasured state to the nearest available label. Whether the catalog should
grow is a product question and is deliberately not settled here.

**2. Every catalog module's bindings are satisfied by the plane, except the proxy pair.**
Measured against the plane's `modules_upload`, which binds `RUNPOD_ENDPOINT_ID`, `TELEMETRY_DB`,
`AI`, `TENANT_ID`, `TENANT_SLUG`, `GATEWAY_ID` and `CF_AIG_TOKEN`. Cross-checking each of the 6
catalog modules against the bindings it actually reads leaves exactly one hole: the plane binds
neither `RUNPOD_PROXY_BASE` nor `RUNPOD_PROXY_TOKEN`, so all five RunPod-backed catalog modules still
take the unbound branch and still require `RUNPOD_API_KEY`. That is the pending plane-side half of
cp#288 and it is the correct state under the ordering rule, not a defect in this repo.

**3. `image-generate` holds an operator vendor key with no mediated tenant path. This is the
`own-gpu` class, still open, and it is the one this audit was for.**
It reads `OPENAI_API_KEY` (secret `IMAGE_GENERATE_OPENAI_API_KEY`), an operator-held third-party
credential. There is no proxy in front of it as there now is for RunPod. It is **not currently
exposed**, because `image-generate` is not in the tenant catalog. The hazard is ordering: adding it
to the catalog as it stands would place our OpenAI key on a tenant-namespace script, which is the
same shape as the pre-cf394 RunPod key and violates the same invariant for the same reason (a
credential against our account, on our budget). It needs a mediated path before it is catalogued, not
after.

**4. `R2_RENDERS` is bound to the operator bucket in 13 modules, and this is coherent rather than a
defect.** The plane binds no R2 at all, and no catalog module reads `R2_RENDERS`. The two catalog
modules that need tenant storage (`keyframe`, `own-gpu`) declare `needs_tenant_r2: true` and receive
a per-job tenant R2 credential on the invoke envelope (cp#270). The 13 modules holding an operator
bucket binding are all outside the catalog. Any future catalog addition among them needs the cp#270
envelope path rather than the binding.

**5. `local-gpu` is not a gap.** `LOCAL_BACKEND_URL` / `LOCAL_BACKEND_TOKEN` point at the deploying
operator's own GPU box. It is the self-host door, which is a first-class product under
hosted/self-host parity, and it is structurally not a shared-tenant capability. Recording it as a
tenant-reachability failure would repeat the framing error the cf#394 ruling identified in the
original `own-gpu` bucket, in the opposite direction.

**6. `finish-rife` is built and published as a tenant bundle but provisioned by nothing.** It reads
no operator-only binding and sits on the shared route seam, so it is the one module that is
technically tenant-ready and simply absent from the catalog. Noted because a reader counting
RunPod-recording modules will find six upstream and five in the catalog; the plane's own source
records the same discrepancy.

## What is NOT measured here

- **Live behaviour.** This is a source-level audit. It proves what each module reads and where the
  plane binds it; it does not prove a tenant render succeeds. Only phase 1b does that.
- **The plane's runtime binding set.** Read from `src/tenant-modules.ts` at a pinned sha, not from a
  provisioned tenant. A plane change lands without this document noticing.
- **Anything about vivijure-local or the MCP surface.** Out of scope.

## What keeps this from rotting

`tests/module-credential-classes-cf394.test.ts` carries the classification as a guard: every `env.X`
a module reads must have a written answer to "where would a tenant get this", and the table may not
carry an entry no module reads. A new module introducing an unclassified operator-scoped binding
fails CI and names the binding, rather than being discovered when a hosted render fails, which is
what the ruling asked for. The guard was proved by mutation: planting an unclassified credential in a
shipped module, planting a dead table entry, and blinding the extractor each produce the specific red
they are meant to, and a blinded extractor fails loudly rather than sweeping clean.
