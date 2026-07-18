# vivijure-cf

**Cloudflare Workers control panel for [Vivijure Studio](https://vivijure.com).** Run the
self-hosted AGPL AI film studio on the Workers free tier: storyboard, cast, module registry,
render orchestration, and the studio UI.

Orchestration (film pipeline, module registry, bundle assembly, D1 helpers) lives in
[`@skyphusion-labs/vivijure-core`](https://github.com/skyphusion-labs/vivijure-core). This repo
is the **CF-native host**: Worker entry, wrangler bindings, D1/R2, service-bound module workers,
planner AI, auth, presign, and `public/`. Prefer a home PC or any cloud VM instead? Use
[`vivijure-local`](https://github.com/skyphusion-labs/vivijure-local). Drive either host from an
agent with [`vivijure-mcp`](https://github.com/skyphusion-labs/vivijure-mcp).

The constellation map is [`skyphusion-labs/vivijure`](https://github.com/skyphusion-labs/vivijure).

**This repo is the studio, and only the studio.** You self-host it; nothing here asks you to run a
service for anyone else. The hosted door (accounts, signup, tenancy, the hosted AUP, provisioning)
is a separate product in its own repo,
[`vivijure-control-plane`](https://github.com/skyphusion-labs/vivijure-control-plane). It installs
this studio's published release unmodified, so hosted and self-hosted never drift apart.

**Vivijure Studio:** https://vivijure.com · **Live demo:** https://demo.vivijure.com · **Skyphusion Labs:** https://skyphusion.org

## Layout

| Path | Role |
|------|------|
| `src/index.ts` | Worker `fetch` + `scheduled()` |
| `src/platform/` | Platform ICD adapter (`cfPlatformFromEnv`) |
| `src/env.ts` | Hand-authored `Env` (mirror `wrangler.toml`) |
| `modules/` | Opt-in module workers (`MODULE_*` bindings) |
| `public/` | Studio UI (Workers Assets) |
| `migrations/` | D1 schema |

Host `src/` imports orchestration directly from `@skyphusion-labs/vivijure-core/*` (same pattern as `vivijure-local`).

## Local dev

Sibling checkout (recommended):

```
~/Documents/GitHub/
  vivijure-core/
  vivijure-cf/
```

```bash
cd vivijure-cf
cp wrangler.toml.example wrangler.toml   # fill bindings
npm ci
npm run typecheck
npm test
npm run dev
```

## Related repos

- **vivijure-core** -- shared orchestration package
- **vivijure-local** -- Node/MinIO homelab host (same core, different platform adapter)
- **vivijure** -- original CF monolith (frozen reference; not modified by this split)
- **vivijure-control-plane** -- the hosted door in front of this studio (optional; not needed to self-host)
