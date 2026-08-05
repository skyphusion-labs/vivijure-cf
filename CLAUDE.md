# CLAUDE.md

Guidance for Claude Code (and the crew) working in this repo.

## What this is

**Vivijure Studio (CF panel): the Cloudflare module host for AI film production.** A single
Cloudflare Worker (no framework, no build step beyond TypeScript) that hosts project / storyboard /
cast / render orchestration via **`@skyphusion-labs/vivijure-core`** and a **module registry**.
Every capability beyond the core is an opt-in module worker plugged in through a typed hook contract.

Read **`@skyphusion-labs/vivijure-core` module types** first (package path `modules/types`;
`vivijure-module/2`). Host `docs/module-api.md` is the prose contract; **types do not live in
`src/modules/types.ts` after core extraction.**

Version: see root `package.json` / latest `v*` tag / `CHANGELOG.md` (do not freeze a number here).

GPU render backend: `vivijure-backend` (RunPod serverless). Production panel UI:
**vivijure.skyphusion.org**. Local-GPU door for this panel's fleet wiring: fatmike CF door (operator
pin; not frozen here). Demo: **demo.vivijure.com** (`AUTH_MODE=demo`; `DEMO_RENDER_ENABLED=false`
is intentional zero-spend).

## TWO panels (honesty)

| Panel | Repo | Runtime |
|-------|------|---------|
| CF (this repo) | `vivijure-cf` | Workers, D1, R2 |
| LOCAL | `vivijure-local` | Node, SQLite, MinIO; fleet box propagandhi |

**Dual-panel product parity** is required for product-facing features (same-time releases, no
community edition). **Dependency pins may lag** between cf and local; check each `package.json`.
Neither pin is "wrong" solely for lagging; ship the dual-panel wave deliberately.

## TWO version lines (do not conflate)

- **`v*`** on this repo = panel / studio Worker deploy (tag-gated).
- **`backend-v*`** (or image tags on `vivijure-backend` / satellites) = RunPod GPU images.

## The Vivijure constellation

```
   friends + Slate (Discord)     vivijure-mcp (agent door)
            |                           |
            v                           v
        slate  -->  vivijure-cf (THIS REPO)  /  vivijure-local
                        |  orchestration: vivijure-core
                        v
                  vivijure-backend (GPU: keyframes -> i2v -> assemble)
                        |
     +----------+----------+----------------+------------------+
     |          |          |                |                  |
  musetalk   upscale  audio-upscale   wan-train          local-12/16gb
  (lipsync)  (video)  (speech)        (cast LoRA)        (homelab i2v)

  vivijure-control-plane = hosted multi-tenant provisioner (not this UI)
  hub vivijure = docs/legal history only; issues for the live studio go HERE
```

## Documentation map

Deep docs live in `docs/`; this file is the working method and conventions. When a change touches one
of these areas, update the matching doc.

- `docs/module-api.md` -- prose for the typed hook contract (`vivijure-module/2`); **SoT types in vivijure-core**.
- `docs/module-authoring.md` -- how to author a new module worker against the contract.
- `docs/api-config-conventions.md` -- the four studio HTTP config-passing shapes (flat / nested / `config` / top-level camelCase); wrong shape fails silently (cf#390).
- `docs/CONTRACT.md` -- the core <-> backend render contract (bundle in, artifacts out).
- `docs/mcp.md` -- MCP deploy pointer; package + canon in **vivijure-mcp** / core docs.
- `docs/observability.md` -- the structured event/tail channel for tracing a render.
- `docs/DEPLOYMENT.md` + `docs/deploy-runbook.md` + `docs/deploy-config-injection.md` -- deploy, env, `account_id` injection.
- `docs/demo-studio.md` -- public demo (`demo.vivijure.com`, `AUTH_MODE=demo`, `DEMO_RENDER_ENABLED=false` intentional).
- `docs/dev-modbound.md` -- run host + every module worker as one local dev so `/api/modules` returns the REAL catalog.
- Hosted tier: [vivijure-control-plane](https://github.com/skyphusion-labs/vivijure-control-plane) (own repo). This repo is the self-hostable studio panel.
- `docs/SECURITY.md` + `docs/legal/` -- security posture and public legal/AUP framing.
- `docs/real-run-confirmations.md` -- phase-2 standing list: properties only a real run can confirm (#369).
- `docs/runpod-public-endpoint-slugs.md` -- free slug existence probe + measured rates for cloud i2v (#267).
- `docs/vendor-runpod-badge.md` -- RunPod badge API 500 on Hub-manifest repos; vendor disposition (#249).

## Commands

```bash
npm run typecheck   # tsc --noEmit && tsc -p tsconfig.scripts.json -- the CI gate; run before pushing
npm test            # vitest run (1200+ tests)
npm run conformance # the module conformance suites (a module must pass these to be installable)
npm run dev         # wrangler dev
npm run deploy      # wrangler deploy
```

### Verifying changes

Vitest is the suite (`npm test`), and every hook ships a **conformance** test (`npm run conformance`)
that a module must pass to be installable -- a module that implements the interface but fails
conformance is not done. For end-to-end render behavior, verify against a live `wrangler dev` and
assert on the structured event channel (`docs/observability.md`), not prose. Always `npm run typecheck`
first, green, before considering a change done.

**R2 same-key A/B (cf#300):** never prove an overwrite from the CF API object-GET alone -- it can
serve a stale body while listing shows the new etag/size. Listing is identity authority; body GET is
for eyeballing. Full rule: `docs/r2-verification.md` (also `harness/cf278/README.md`).

## Architecture

- **Thin host + published core.** Orchestration lives in `@skyphusion-labs/vivijure-core`. This repo
  is the CF host (routes, auth, bindings, modules under `modules/`, UI). Do not reintroduce a
  parallel copy of core types under `src/modules/types.ts`.
- **The module contract is sacred.** SoT is **`@skyphusion-labs/vivijure-core`** (`modules/types`,
  epoch `vivijure-module/2`). Breaking change bumps the api version with a coordinated release.
  One typed input/output per hook; modules declare knobs in `config_schema`; core clamps against it.
- **The frontend is a projection of the registry.** The UI renders from `GET /api/modules`; never
  hardcode a per-feature section. If a feature needs the UI to know about it, it is a module.
- **Honest failures.** A finish/polish step that genuinely fails (after bounded retry + R2 reclaim)
  fails the render with the real per-shot error; it never silently advances to done and ships a
  raw/unfinished clip with `applied=[]`. A degrade is never silent.

## Conventions

- **No em-dashes (U+2014) or en-dashes (U+2013) anywhere.** Use commas, semicolons, parentheses, or `--`.
- **No framework, no build step, no CSS preprocessor.** Vanilla JS/HTML/CSS frontend is deliberate.
- **Minimal runtime deps.** Justify any new one.
- **Mirror every binding** in `wrangler.toml` and the hand-authored `Env` (`src/env.ts`). The committed
  config is `wrangler.toml.example`; `account_id` is never hardcoded (injected via `CLOUDFLARE_ACCOUNT_ID`).
- **`npm run typecheck` is the gate.** `tsc` is not part of vitest, so type errors pass tests silently.
- **Ignore Cursor `AGENTS.md`** if present; this file is the agent contract.
- **CSAM bright-line (NON-NEGOTIABLE):** zero tolerance including synthetic.
- **Clean room** for GPU engines; **FLUX self-host OUT** of the CF cost-door thesis unless a
  deliberate product decision lands elsewhere.
- **Verify the artifact** (deployed Worker `modified_on` / behavior), never only the pipeline.
- **Never freeze open sprint boards or specific RunPod endpoint IDs** in this file.

## Repo standard (aviation-grade governance)

**Every NEW constellation repo gets the FULL standard applied AT CREATION, never backfilled.** All 8
existing repos were brought to this standard 2026-07-01; a new repo is not "done" until it meets it. This
is the definition of done for a new repo, run it like adding a `.gitignore`:

1. **Default branch `main`** (never `master`).
2. **`ci` workflow** for the language (TS: `tsc --noEmit` + vitest; Python: pytest), on GitHub-hosted
   `ubuntu-latest` (fork-safe) for public repos, `permissions: contents: read`.
3. **`coverage` workflow** if there is testable code. For a thin wrapper with nothing meaningfully
   coverable (e.g. a single RunPod `handler.py` with heavy top-level GPU imports), do NOT fabricate
   coverage; substitute a minimal `ci` gate = `ruff check --select E9,F .` + `python -m py_compile handler.py`.
4. **CodeQL** default setup enabled.
5. **Branch protection on `main`:** PR required; `required_status_checks.contexts` = the repo's real
   `ci` + `coverage` (+ the `CodeQL` umbrella, never a sub-job like `Analyze (python)`); `strict: true`;
   `enforce_admins: false` (admin override); no force-push, no deletion.
6. **Discovery:** homepage -> the main `vivijure` repo (the studio -> its welcome page); topics set.
   **License** AGPL-3.0 unless it is an explicit public-docs/CC0 case.

Two hard constraints, learned the hard way:
- **Verify-before-require ordering:** a status check can only be made REQUIRED after it exists and has
  posted GREEN on a real run, else every merge blocks forever (phantom block). Land the workflow ->
  confirm it runs green -> then add its exact context to `required_status_checks`. A repo with
  `required_status_checks:null` needs a full protection PUT (a surgical PATCH 404s), preserving other settings.
- **Branch protection MUST be in place BEFORE flipping a repo public** (plus a grep-zero
  secrets/topology scan). The checklist above satisfies the protection half.

Full rationale + the closing 8/8 state live in the project memory (`vivijure-new-repo-standard`,
`vivijure-repo-governance-ci-sprint`).

## Roadmap (phases)

0. Module host + registry + self-assembling UI. (**done**, v0.1.0)
1. Render routes behind hooks; reference modules; shared D1 + R2. (**done**, v0.2.0)
2. Production DNS on `vivijure.skyphusion.org`; render + planner split out of `prism`
   (formerly `skyphusion-llm-public`). (**done**)
3. **Workers for Platforms / dynamic dispatch** -- install a module without redeploying the core.
   (**unblocked**: WfP is enabled account-wide as of 2026-06-30; module = user Worker in a dispatch
   namespace, vivijure = the dynamic-dispatch/outbound Worker for auth/routing/quota.)

## Crew + identity

- Crew members work as their own Unix + gh identity. The FIRST command in any op is the member's own
  login shell: `sudo -u <member> bash -lc '<ops>'` (loads their `$HOME`, their `~/dev/vivijure` clone,
  their gh/CF/RunPod creds). Commits/PRs land under the member's `skyphusion-<member>` identity, not Conrad's.
- Operating memory for this repo lives in the per-project memory (`MEMORY.md` + `seg-*`/`crew-*` under
  `~/.claude/projects/-home-conrad-dev-vivijure/memory/`); load it before acting.
- **HARD AUP line:** the CSAM bright line is absolute (see the vivijure project memory). Non-negotiable.

## Commits & versioning

Conventional Commits (`feat(scope):`, `fix(scope):`, `docs:`); body explains the why. SemVer on the
**1.x** line (`1.MINOR.PATCH`): PATCH for fixes/backend tweaks, MINOR for features. A release PR
bumps root `package.json` `version` and adds a top-of-file `CHANGELOG.md` entry (`## vX.Y.Z`).

## Release / tagging

**TAG-GATED deploy.** `.github/workflows/ci.yml` deploys the studio Worker **only** on a pushed
`v*` tag. A bare merge to `main` runs CI only and does **not** redeploy production.

`studio-release.yml` also runs on `v*` and builds the studio release asset; it asserts
`vX.Y.Z` == `package.json` version.

### Dependency order

1. If this release needs a new **`@skyphusion-labs/vivijure-core`**, release and publish **core
   first** (`vivijure-core` tag `vivijure-core-v*`). See that repo's `CLAUDE.md` / `RELEASES.md`.
2. Bump the core pin in this repo's `package.json` on `main` (release PR).
3. Tag this repo only after the pin is on `main`.

Ship **vivijure-local** in the same dual-panel wave when the change is product-facing (same-time
releases; see vivijure-local CLAUDE.md).

### Cut a release

1. **Release PR on `main`:** bump `package.json` version, add `CHANGELOG.md` `## vX.Y.Z`, install
   lockfile if deps changed, land the PR.
2. **Tag** (must match `package.json`; studio-release refuses a mismatch):

```bash
git fetch origin main && git checkout main && git pull --ff-only
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

3. Confirm CI deploy job green on the tag run. Verify the live Worker (artifact / behavior), not only
   a green check.

Merge alone is never a ship.
