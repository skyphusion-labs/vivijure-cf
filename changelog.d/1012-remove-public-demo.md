### feat(demo)!: the public demo door is removed entirely

The public demo is gone, not deprecated, and it went in two steps: the `demo.vivijure.com` custom domain was removed on 2026-10-08, and the deployment was deleted on 2026-10-19 (the D1 database, the R2 bucket, both Worker scripts and the AI Gateway). No demo DNS record, worker route or custom domain remains on any zone, so every demo binding in this panel addressed something that no longer exists.

Removed: the four `/api/demo/*` routes and their handlers, the seeded demo render and the capped open-weights assistant, the `AUTH_MODE=demo` gate branch, the eight `DEMO_*` vars in the `Env` interface and in the orchestrator var contract, the demo page CSP, the `host.readonly` / `host.render` / `host.assistant` fields on `GET /api/modules`, the demo-only remap of `/` to the planner, the two demo frontend shims with their styles, the demo D1 migrations, both demo wrangler templates, and `docs/demo-studio.md`.

`AUTH_MODE` now accepts `token`, `access` and unset. A deploy that still sets it to `demo` is denied, which is the fail-closed path.

The route table is 89 entries over 71 path patterns, down from 93 over 75. The published parity and contract numbers are re-measured from the table, not adjusted by hand.

The `local-gpu` module stays. It is a live deployed worker that the ordinary render path reaches through the registry; only the demo-scoped door was dead.
