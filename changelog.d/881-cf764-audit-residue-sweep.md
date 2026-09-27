### fix(cf): nine small residue items from the cf#764 doc audit (CB-9, MD-6, AC-9, SC-15, CX-3, CX-4, CX-6, CX-7, CX-8, cf#881)

A maintenance sweep over the small items cf#764's audit left behind. Six landed as code/comment
fixes, three were checked against the running code and reported without a change:

- **CB-9**: `POST /api/cast/import` read the whole body with `arrayBuffer()` before the 80MB cap in
  `importCastBundle` ever ran. Added a `Content-Length` precheck ahead of the read; the existing
  post-read cap stays as the backstop (Content-Length can be absent or wrong under chunked
  transfer).
- **AC-9**: removed `assertConfigMapShape` / `assertModuleConfigMap` (and the `describeJsonType`
  helper they alone used) from `src/index.ts` -- genuinely dead since `checkRenderRequestShape`
  (src/render-door.ts) took over config-map shape checking; nothing else called them.
- **CX-3**: `scripts/studio-consumer-token.sh mint` did a plain `INSERT`, but `name` is the
  `api_tokens` primary key and `revoke` only sets `revoked_at` -- so a properly revoked name could
  never be re-minted. Now clears the row first, but only when it was revoked, so a still-live name
  still refuses (loud) instead of being silently overwritten.
- **CX-4**: `scripts/install-module.ts` only ever sent CF Access service-token headers, so it could
  not authenticate against a token-mode core (`AUTH_MODE=token`). Added an optional
  `STUDIO_API_TOKEN` env var that sends `Authorization: Bearer`. Also fixed the usage comment's
  `--hook-name` flag, which the arg parser never reads -- the real optional flag is `--name`.
- **SC-15**: checked live; already fixed on `main` (8c12476d, PR #791/cf#790, landed after the audit
  ran) -- `enforceSpendLimit`'s posture comment now correctly says fail-CLOSED. No change needed.
- **CX-6**: checked live; `resolvePlanningTarget`'s sole-installed-module fallback already returns
  the module's own declared id (or its name) as `config.model`, never the caller's unmatched string
  -- covered by `tests/planning-models.test.ts` ("falls back to the sole installed module for an
  unknown id"). No change needed.
- **CX-7**: confirmed real (`servingForHook(preModules, "dialogue")[0]` with `config: {}`,
  film-orchestrator.js), but the invoking code lives in the published `@skyphusion-labs/vivijure-core`
  package, not in this repo's own `src/`. Out of scope for a vivijure-cf-only change; needs its own
  vivijure-core issue.
- **CX-8** (hygiene, comments only):
  - `wrangler.toml.example`'s `MEDIA_FINISH_TOKEN` comment said "unset is fail-open"; an unseeded
    store secret hard-fails `wrangler deploy` with CF error 10182, same as any other declared
    `secrets_store_secrets` entry. Corrected.
  - `containers/compose.yaml`'s header described routing over Workers VPC / a "VPC Service" per
    container. `scripts/setup-media-vpc.py`'s own docstring says the opposite ("HOSTED DOES NOT USE
    WORKERS VPC FOR MEDIA... This script does NOT create those VPC services"); the real path is a
    Cloudflare Tunnel to Traefik over public HTTPS plus `MEDIA_FINISH_TOKEN`. Corrected throughout
    the file.
  - `withFilmDownloadUrl`'s comment said the presigned URL TTL is 24h; `FILM_DOWNLOAD_TTL_SECONDS`
    is 6h. Corrected.
  - `wrangler.demo.toml.example` and `migrations/demo/0001_demo_seed.sql` said the base schema was
    `migrations/0001..0010`; it is 21 files now (and will drift again), so both now say "every
    migrations/*.sql file" instead of a number range.
  - `modules/google-veo`'s header comments said `generate_audio` defaults false; its `config_schema`
    default is `true` and `cfg.generate_audio !== false` matches. Corrected in both `index.ts` and
    `veo.ts`.
  - `ci.yml`'s `VPC_VIDEO_FINISH_ID` / `VPC_AUDIO_BEAT_SYNC_ID` / `VPC_AUDIO_MASTER_ID` comment still
    claimed they were "filled per-module below" and functional; per cf#840 (documented two lines
    below in the same file) they substitute nothing. Added the same "no consumer" correction already
    applied to the other VPC_* entries in that block. The secrets and env wiring themselves are left
    in place, matching the same file's own precedent that removing them is "a separate deliberate
    change", not a comment fix.
  - `containers/compose.yaml`'s VPC routing description not covered above (not part of this sweep;
    verified NOT stale -- `deploy.sh` still calls `scripts/setup-media-vpc.py` and `docker compose`).

**Not fixed, reported instead**: **MD-6** (`scripts/install-module.ts` has no `uninstall` mode at
all -- the CLI can install/rollback but never evicts a resident WfP script; `installed-modules.ts`'s
own comment already describes the intended two-step design). Implementing an uninstall CLI mode is
a real feature addition (new argument mode, core-route + WfP-eviction orchestration), not a small
correctness fix, so it stays open on cf#881/a follow-up rather than being forced into this sweep.

Gate: `npm run typecheck` exit 0; `npm test` exit 0 (3704 passed, 3 skipped); `npm run guard:resolve`,
`npm run check:catalog`, `npm run check:matrix` all exit 0.
