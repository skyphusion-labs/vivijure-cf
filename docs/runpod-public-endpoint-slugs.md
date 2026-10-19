# RunPod public-endpoint slugs (cloud i2v cost door)

Issue: [#267](https://github.com/skyphusion-labs/vivijure-cf/issues/267).

Cloud motion modules hardcode public-endpoint slugs as `ENDPOINT_ID` and call
`https://api.runpod.ai/v2/<slug>/...`. Two of them (`minimax-hailuo-2-3-fast`,
`google-veo3-1-fast-i2v`) were absent from RunPod's published model reference and AI-SDK table as of
2026-07-27, while still present in our code. Before tenant-facing pricing (cp#173 / cost-basis), slug
existence and published rates needed a live confirm.

**This file records measured status.** It is not a pricing product and does not replace
control-plane `docs/cost-basis.md`.

## Zero-spend existence probe

Unauthenticated `GET https://api.runpod.ai/v2/<slug>/health`:

| HTTP | Meaning |
| --- | --- |
| **401** body `no token provided` | Endpoint **exists** (auth required; no job started, no spend) |
| **404** body `endpoint not found` | Endpoint does **not** exist |

Never `POST .../run` for this check. Script:

```bash
./scripts/probe-runpod-public-slugs.sh            # census: every slug modules/ declares
./scripts/probe-runpod-public-slugs.sh some-slug  # ad-hoc: exactly these, no census
```

### What the script does now (cf#934), and what it refuses to do

**The population is `modules/` on the checkout, never a list inside the script.** It used to carry a
hardcoded `DEFAULT_SLUGS` array, which is the defect the sibling capability-matrix gate's header names:
a checker holding its own copy of the population cannot detect that population changing. That array had
also gone stale in both directions, still listing `kling-v2-1-i2v-pro` and never gaining `infinitetalk`
or `kling-video-o1-r2v`. The slugs are now read from each module's `ENDPOINT_ID`, including one
indirection (`narration-gen` declares `ENDPOINT_ID = MODEL`, resolved from its own `src/`).

**Every module lands in exactly one of three classes, and the arithmetic is asserted.** A module that
fell out of all three would mean the sweep covered an unknown population, so that is a hard failure
rather than a smaller table:

| class | meaning | probed? |
| --- | --- | --- |
| `PROBED` | `const ENDPOINT_ID = "<slug>"`, a public slug this repo dispatches to | yes |
| `OWN-ENDPOINT` | a `RUNPOD_ENDPOINT_ID` binding: our serverless endpoint, id supplied per install | no |
| `NO-ENDPOINT` | no RunPod endpoint at all, routed elsewhere (Cloudflare, Workers AI, local) | no |

The not-probed doors are **named** in the output, not left to subtraction, because a sweep that hides
its own edges reports on a population the reader believes is larger than it is.

**Two controls, in the same invocation, because one is not enough.** A negative control (a bogus slug,
which must read 404) and a positive control (a slug known to exist and deliberately not one we
dispatch to, which must read 401). The negative control alone is one-sided: it stays healthy when the
base URL is wrong and *every* path 404s, which made an early version of this script report ten
simultaneous dead doors as a FINDING instead of a broken probe. There is also a backstop: if every
probed slug reads MISSING at once, that is an instrument failure, not a credible finding.

**Exit codes, decided rather than discovered.** It never degrades to a skip:

| exit | meaning |
| --- | --- |
| 0 | every slug this repo dispatches to still resolves |
| 1 | **a slug is GONE.** Renders routed to that door fail at submit |
| 2 | unusable instrument: unexpected HTTP, positive control failed, or everything read MISSING |
| 3 | the negative control did not fire, so a clean sweep would not be believable |
| 4 | the population could not be accounted for (unparseable `ENDPOINT_ID`, or the classes do not sum) |

**It runs on a schedule, and it is NOT a CI gate.** `.github/workflows/endpoint-liveness.yml` runs the
census daily and opens or updates ONE tracking issue on a finding; a clean run closes that issue. It
must never become a required check: this depends on a third party being reachable, so as a gate a
RunPod outage would freeze merges on unrelated work. Ruled on cf#934.

**What it still cannot tell you: vendor liveness.** A 401 proves a RunPod endpoint *object* exists, not
that the upstream model does. See the section below.

### Measured 2026-08-05 (this doc; free health probe)

| Module | `ENDPOINT_ID` in code | `/health` | Status |
| --- | --- | --- | --- |
| `minimax-hailuo` | `minimax-hailuo-2-3-fast` | 401 | **exists** |
| `google-veo` | `google-veo3-1-fast-i2v` | 401 | **exists** |
| `seedance` | `seedance-v1-5-pro-i2v` | 401 | exists (control) |
| `kling` | `kling-v2-1-i2v-pro` | 401 | exists (control) |
| `vidu-q3` | `vidu-q3-i2v` | 401 | exists (control) |
| `alibaba-wan` | `wan-2-6-i2v` | 401 | exists (control) |
| `alibaba-wan-lora` | `wan-2-2-t2v-720-lora` | 401 | exists (control) |
| *(negative)* | `definitely-not-a-slug-xyz` | 404 | not found (control) |

Scope: the table and the probe's `DEFAULT_SLUGS` cover the #267 **motion** cost-door set only. Two
other modules also call RunPod public-endpoint slugs and are not probed by default (pass them as
arguments to check them): `kling-o1-r2v` (`ENDPOINT_ID = "kling-video-o1-r2v"`) and `narration-gen`
(`ENDPOINT_ID = MODEL = "minimax-speech-02-hd"`).

## These readings have a shelf life

**A dated probe proves the endpoint existed on that date, and nothing more.** RunPod deletes public
endpoints, so re-run the probe before relying on any row above rather than reading a past 401 as current.
Since cf#934 the daily `endpoint-liveness` workflow does that re-running, so the tables below are
history and the workflow is the current answer.

Measured 2026-09-27, same free `/health` probe, with the negative control in the same run:

| Module | `ENDPOINT_ID` in code | `/health` | Status |
| --- | --- | --- | --- |
| `kling` | `kling-v2-1-i2v-pro` | **404** | **GONE** (was 401, exists, on 2026-08-05 above) |
| `infinitetalk` | `infinitetalk` | 401 | exists |
| `alibaba-wan` | `wan-2-6-i2v` | 401 | exists (control) |
| `google-veo` | `google-veo3-1-fast-i2v` | 401 | exists (control) |
| *(negative)* | `definitely-not-a-slug-xyz` | 404 | not found (control) |

The `kling` door is tracked in [#921](https://github.com/skyphusion-labs/vivijure-cf/issues/921).

**And a 401 proves a RunPod endpoint object exists, not that the upstream model does.** Two cases
measured 2026-09-27 while building the audio-driven provider matrix
([vivijure#826](https://github.com/skyphusion-labs/vivijure/issues/826)):

- `sora-2-i2v` and `sora-2-pro-i2v` answer 401 and are listed `isLive` with full price tables, while
  OpenAI's own model page states the Sora 2 models and Videos API "were shut down on September 24, 2026
  and are no longer available".
- `minimax-hailuo-2-3-fast` is live on the shelf, while MiniMax's own API reference no longer lists
  Hailuo 02 or 2.3 at all, superseded by `MiniMax-H3`.

So slug existence is a necessary check, never a sufficient one; vendor liveness is a separate question
and this file does not answer it.

## Rates (Conrad, 2026-08-03; cf#267 comment)

Slugs are not stale. Published rates reported on the issue:

| Endpoint | Rate note |
| --- | --- |
| `POST .../v2/google-veo3-1-fast-i2v/run` | **$0.15/sec with audio**, **$0.10/sec without** |
| `POST .../v2/minimax-hailuo-2-3-fast/run` | **$0.19/sec** |

**Veo audio is a billing dimension nothing else in the eight cost-door set has:** a 50% swing on a
boolean request flag. A per-second figure for this model is wrong by 50% unless audio state is
specified. Module default in this repo: `generate_audio` defaults **ON** (the `google-veo` manifest
`config_schema.generate_audio` default is `true`, "keep the model's talking audio"; `veo.ts` sends
`generate_audio: cfg.generate_audio !== false`), so an unconfigured Veo render bills at the
**$0.15/sec with-audio** rate. Set `generate_audio: false` in `motion_config` for the $0.10/sec silent
tier. (The Phase 1 header comments in `modules/google-veo/src/index.ts` and `veo.ts` that still say
"defaults false" are stale; tracked in #764 RS-1.)

Full eight-model rate table and remaining probes: control-plane cp#284 / `docs/cost-basis.md`
(may still show the pre-confirm "NOT AVAILABLE" rows until that doc is refreshed there).

## Still unconfirmed / out of scope here

- **Per-slug billing breakdown from RunPod account totals:** still unavailable (account-level public
  endpoint spend only). Attribution remains call-time metering, not vendor invoices.
- **Tenant-facing rate card product work:** not this issue; do not invent pricing UI here.
- **A paid `/run` smoke** that proves a successful COMPLETED job for each slug: optional, spends
  money, not required to close "slug exists".

## Disposition for #267

Substance answered: both slugs resolve (401 on free `/health`) and have published rates (Conrad
2026-08-03). Remaining pricing work lives on the control-plane cost basis, not a blocked slug.
