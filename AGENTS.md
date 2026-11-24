# Vivijure Studio

This file is the guide for any coding agent and any contributor. Follow it.

## What this project is

This repo is the Cloudflare panel for Vivijure Studio. One Worker hosts projects, storyboards, cast, and renders.

The Worker uses `@skyphusion-labs/vivijure-core` and a module registry. Every capability past the core is an opt-in module worker. The hook contract is typed.

Read module types from `@skyphusion-labs/vivijure-core` first (`modules/types`, epoch `vivijure-module/2`). Prose is [docs/module-api.md](docs/module-api.md). Types do not live in `src/modules/types.ts`.

See root `package.json`, the latest `v*` tag, and [CHANGELOG.md](CHANGELOG.md). Do not freeze a number here.

The operated RunPod path makes SDXL keyframes (`vivijure-backend`) and upscale. Motion comes from a cloud motion door, or from a GPU the operator runs. Local GPU is opt-in and stays on that box.

The production studio is `app.studio.vivijure.com`. The project site is `https://vivijure.dev`.

The public demo is removed. `AUTH_MODE=demo` is not a mode this panel accepts. Do not add it back. The `demo.vivijure.com` custom domain was removed on 2026-10-08. The demo deployment was deleted on 2026-10-19.

## Two panels

| Panel | Repo | Runtime |
|-------|------|---------|
| CF (this repo) | `vivijure-cf` | Workers, D1, R2 |
| Local | `vivijure-local` | Node, SQLite, MinIO; the operator self-hosts it |

Product-facing features ship on both panels at the same time. There is no community edition. Pins may lag. Check each `package.json`. Lag alone is not a defect. Ship the pair on purpose.

## Two version lines

A `v*` tag on this repo deploys the studio Worker. A `backend-v*` tag is a RunPod GPU image. Name the line you mean.

## Docs

Deep docs live in `docs/`. Update the matching doc when you change that area.

- [docs/module-api.md](docs/module-api.md) -- hook contract prose. Types live in vivijure-core.
- [docs/module-authoring.md](docs/module-authoring.md) -- how to write a module worker.
- [docs/module-dispatch.md](docs/module-dispatch.md) -- Workers for Platforms transport.
- [docs/api-config-conventions.md](docs/api-config-conventions.md) -- four HTTP config shapes.
- [docs/CONTRACT.md](docs/CONTRACT.md) -- studio HTTP routes and the render contract.
- [docs/CAST-BUNDLE.md](docs/CAST-BUNDLE.md) -- the `.vvcast` bundle.
- [docs/mcp.md](docs/mcp.md) -- MCP deploy pointer. The package lives in vivijure-mcp.
- [docs/observability.md](docs/observability.md) -- structured events for a render.
- [docs/finish-capacity.md](docs/finish-capacity.md) -- finish queue and retry.
- [docs/make-a-video.md](docs/make-a-video.md) -- the Make a video page.
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [docs/deploy-runbook.md](docs/deploy-runbook.md), [docs/deploy-config-injection.md](docs/deploy-config-injection.md) -- deploy and env.
- [docs/dev-modbound.md](docs/dev-modbound.md) -- local host plus module workers.
- [docs/SECURITY.md](docs/SECURITY.md) and [docs/legal/](docs/legal/) -- security and public legal text.
- [docs/r2-verification.md](docs/r2-verification.md) -- how to prove an R2 overwrite.
- [CONTRIBUTING.md](CONTRIBUTING.md) -- pull request flow.

[vivijure-control-plane](https://github.com/skyphusion-labs/vivijure-control-plane) is a reference multi-tenant control plane. It is maintained. It is not operated as the Skyphusion studio. This repo is the self-hostable studio panel.

Do not prove an R2 overwrite from object GET alone. Listing is the identity check. See [docs/r2-verification.md](docs/r2-verification.md).

## Commands

```bash
npm run typecheck   # CI gate; run before you push
npm test            # vitest
npm run conformance # a module must pass this to be installable
npm run dev         # wrangler dev
npm run deploy      # wrangler deploy
```

Run `npm run typecheck` and see it green before you call a change done. `tsc` does not run inside vitest.

A module that implements the interface and fails conformance is not done. For a real render, use `wrangler dev` and the event channel in [docs/observability.md](docs/observability.md).

## Architecture

Orchestration lives in `@skyphusion-labs/vivijure-core`. This repo is the host: routes, auth, bindings, `modules/`, and the UI. Do not copy core types back into `src/modules/types.ts`.

The module contract is the source of truth. A breaking change bumps the epoch with a coordinated release. One typed input and one typed output per hook. Modules declare knobs in `config_schema`. Core clamps against that schema.

The UI renders from `GET /api/modules`. Do not hardcode a feature section. If the UI must know a feature, that feature is a module.

A finish step that fails after retry and R2 reclaim fails the render. It reports the real per-shot error. It does not mark the render done. It does not ship a raw clip with `applied=[]`. A degrade is never silent.

Dynamic dispatch installs a module without a core redeploy. See [docs/module-dispatch.md](docs/module-dispatch.md).

## Conventions

Write Simplified Technical English. Use short sentences. Put one idea in each sentence. Use the active present tense. Use plain words. Use the same word every time.

Do not use an em dash (U+2014). Do not use an en dash (U+2013). Use a comma, a semicolon, parentheses, or two hyphens (`--`).

State the limit next to the capability. Do not turn a measured result into a promise.

The frontend is vanilla JS, HTML, and CSS. There is no framework and no build step. Justify a new runtime dependency.

Mirror every binding in `wrangler.toml` and the hand-authored `Env` in `src/env.ts`. The committed sample is `wrangler.toml.example`. Do not hardcode `account_id`. Inject `CLOUDFLARE_ACCOUNT_ID`.

The CSAM ban includes synthetic images. Do not weaken that check.

GPU engines stay clean-room. FLUX self-host is out of the default hosted path unless a product change says otherwise.

Verify the deployed Worker (`modified_on` or behavior). Do not trust the pipeline alone. Do not freeze an endpoint id in this file.

## Release

A version moves only in a release pull request. Bump the version, then update the changelog. A feature pull request does not bump. A fix pull request does not bump.

The version of record is `package.json` (and the lockfile). The tag shape is `v*`.

Before a release pull request, check tags. If the current manifest version already has a tag, the cycle is closed, so the release pull request bumps. If it has no tag, stop. Read why before you bump again.

An org admin tags the merge commit of that pull request. The tag must match `package.json`.

`.github/workflows/ci.yml` deploys the studio Worker only on a pushed `v*` tag. A merge to `main` runs CI only.

`studio-release.yml` is a reusable workflow. The `v*` CI run calls it from the `studio-release` job. It builds the release asset. It checks that the tag matches `package.json`. It advances the hosted studio pin only after that deploy.

Dependency order:

1. If you need a new `@skyphusion-labs/vivijure-core`, release core first (tag `vivijure-core-v*`).
2. Bump the core pin here on `main`.
3. Tag this repo only after that pin is on `main`.

Ship [vivijure-local](https://github.com/skyphusion-labs/vivijure-local) in the same wave when the change is product-facing.

Tag the release pull request merge commit:

```bash
git fetch origin main --tags
sha="$(gh pr view <release-pr> --json mergeCommit -q .mergeCommit.oid)"
git tag -a vX.Y.Z -m "vX.Y.Z" "$sha"
git push origin vX.Y.Z
```

Confirm the deploy job is green. Then verify the live Worker. A merge alone is not a ship.

SemVer on this line: PATCH for fixes, MINOR for features. See `package.json` for the current version.
