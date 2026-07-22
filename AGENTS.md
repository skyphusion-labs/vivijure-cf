# AGENTS.md

## Cursor Cloud specific instructions

Standard scripts are in `package.json` (and `CLAUDE.md`). Non-obvious VM gotchas:

- **Run the JS toolchain under Node 24.** The VM's default `node` is a wrapper
  (`/exec-daemon/node`, v22.14) that shadows nvm. `tests/release-builder-runs.test.ts`
  executes `scripts/build-studio-release.ts` under bare `node`; Node < 22.18 cannot
  type-strip `.ts`, so that test fails spuriously on the default node. Use Node 24
  (installed via nvm by the environment update script):
  `export PATH="$HOME/.nvm/versions/node/v24"*"/bin:$PATH"`.
- **Install deps with the default Node 22 `npm` (v10), not Node 24's `npm` (v11).**
  npm 11 blocks the `esbuild`/`workerd` postinstall (native binaries wrangler and
  vitest need) behind an interactive allow-scripts prompt. Run `npm ci` on the
  default PATH, then run typecheck/test under Node 24.
- `npm run dev` starts `wrangler dev`; deploy/live-conformance need Cloudflare creds
  that are not present here.

Verified in this environment (Node 24): `npm ci`, `npm run typecheck`,
`npm test` (1799 passed, 3 skipped) all pass.
