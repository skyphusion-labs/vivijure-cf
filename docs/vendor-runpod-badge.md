# Vendor: RunPod badge API 500 on Hub-manifest repos

Issue: [#249](https://github.com/skyphusion-labs/vivijure-cf/issues/249).

**Disposition: external / vendor.** Not ours to fix. No badge workaround in this repo. Hand to RunPod
(console/support or Conrad's direct contact) with the repro below.

## Symptom

```
https://api.runpod.io/badge/{owner}/{repo}
```

returns **HTTP 500** `{"message":"Internal Server Error"}` for certain skyphusion-labs GPU image
repos, while ordinary repos and live Hub catalog entries return **200** SVG badges.

## Repro (unauthenticated curl, status only)

Measured originally 2026-07-25 (rollins, cf#248 stage 1). Reproduced 2026-08-01 (albini) and again
2026-08-05 (this doc):

| URL | Status |
| --- | --- |
| `.../badge/skyphusion-labs/vivijure-wan-train` | **500** |
| `.../badge/skyphusion-labs/vivijure-musetalk` | **500** |
| `.../badge/skyphusion-labs/vivijure-upscale` | **500** |
| `.../badge/skyphusion-labs/vivijure-backend` | **500** |
| `.../badge/skyphusion-labs/vivijure-audio-upscale` | **500** |
| `.../badge/skyphusion-labs/vivijure-cf` | 200 |
| `.../badge/skyphusion-labs/vivijure-control-plane` | 200 |
| `.../badge/runpod-workers/worker-vllm` | 200 |
| `.../badge/runpod-workers/worker-comfyui` | 200 |
| `.../badge/microsoft/vscode` | 200 |
| `.../badge/skyphusion-labs/definitely-not-a-repo-xyz` | 200 |

## Isolated variable

Not "the skyphusion-labs org" broadly. Correlation from the 2026-08-01 sweep (23 other org repos
clean):

| Condition | Badge result |
| --- | --- |
| Repo carries `.runpod/hub.json` and is **not** live in RunPod Hub catalog | **500** |
| Repo has no `.runpod/hub.json` | 200 |
| Live Hub-listed image repo (`runpod-workers/*`) | 200 |
| Nonexistent owner/repo | 200 ("no data" style success) |

The five (then) failing repos all carry a Hub publish manifest but returned zero hits from
`list-hub-repos` for `repoOwner=skyphusion-labs` / `searchTerm=vivijure`. So: submitted or residual
Hub publish state without a live catalog entry, and the badge path 500s instead of degrading to the
same 200 an unassociated repo gets.

## What we are not doing

- No README badge swap, no proxy, no alternate badge host. Broken public badges are cosmetic; a
  workaround would invent product surface for a vendor bug.
- No code change in vivijure-cf.

## What Conrad can hand RunPod

> Badge endpoint `GET https://api.runpod.io/badge/{owner}/{repo}` returns 500 for GitHub repos that
> carry `.runpod/hub.json` but are not currently live Hub catalog entries. Unassociated repos and
> live Hub entries return 200. Repro: any of
> `skyphusion-labs/{vivijure-wan-train,vivijure-musetalk,vivijure-upscale,vivijure-backend,vivijure-audio-upscale}`.
> Control: `skyphusion-labs/vivijure-cf` (no hub.json) and `runpod-workers/worker-vllm` (live Hub).

Optional tighten (needs Conrad's RunPod dashboard): whether those five Hub submissions are pending,
rejected, or another queue state.

## Method caveats

HTTP status only, no auth, short probe windows. Re-checked after minutes, not a multi-day soak. A
longer-timescale flap is not ruled out; the correlation with `.runpod/hub.json` held across two
independent sweeps.
