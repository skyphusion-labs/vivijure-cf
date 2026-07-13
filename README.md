# vivijure-cf

Cloudflare Workers host for [Vivijure Studio](https://vivijure.com).

Orchestration (film pipeline, module registry, bundle assembly, D1 helpers) lives in
[`@skyphusion-labs/vivijure-core`](https://github.com/skyphusion-labs/vivijure-core).
This repo is the **CF-native control plane**: Worker entry, wrangler bindings, D1/R2,
service-bound module workers, planner AI, auth, presign, and the studio UI (`public/`).

The upstream monolith [`skyphusion-labs/vivijure`](https://github.com/skyphusion-labs/vivijure)
remains unchanged; new host work lands here.

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
