# Vivijure Studio MCP (deploy)

The Studio MCP server is **`@skyphusion-labs/vivijure-mcp`** on npm.
Full operator doc: [vivijure-mcp `docs/mcp.md`](https://github.com/skyphusion-labs/vivijure-mcp/blob/main/docs/mcp.md).

## Quick pointer

| What | Where |
|------|--------|
| Package | `@skyphusion-labs/vivijure-mcp` |
| Wrangler config | `wrangler.mcp.toml.example` |
| Worker entry | `node_modules/@skyphusion-labs/vivijure-mcp/dist/mcp.js` |
| Local dev | `npm run dev:mcp` (needs a rendered `wrangler.mcp.toml`, see below) |

`npm run dev:mcp` and `npm run deploy:mcp` both run against `wrangler.mcp.toml`, which is gitignored
and does not exist in a fresh clone: render it from `wrangler.mcp.toml.example` first (the copy step
below), filling the `${MCP_STUDIO_URL}` and `${MCP_HOST}` placeholders.

## Deploy (CF host -- production door)

```sh
cp wrangler.mcp.toml.example wrangler.mcp.toml   # set STUDIO_URL + route host
wrangler secret put STUDIO_API_TOKEN -c wrangler.mcp.toml
wrangler secret put MCP_TOKEN         -c wrangler.mcp.toml
npm run deploy:mcp
```

**Optional control-plane admin door.** `wrangler.mcp.toml.example` documents `CONTROL_PLANE_URL`
(`[vars]`) + a `CONTROL_PLANE_ADMIN_TOKEN` secret for the hosted control-plane `cp_*` tools. Those
need `@skyphusion-labs/vivijure-mcp` 1.3+; this repo pins `^1.2.1` and the lockfile resolves 1.2.1,
so setting them has no effect until the pin is bumped. Omit both for self-host / local-only MCP.

CI deploys the **production** door only on a pushed `v*` tag (the `deploy` job, "Deploy Studio MCP
Worker" step in `.github/workflows/ci.yml`), and only when BOTH `MCP_HOST` and `MCP_STUDIO_URL` are
set as GitHub repository **variables** (`vars.*`, not secrets); either unset skips the step. A merge
to `main` never deploys MCP. That job deploys `vivijure-studio-mcp` only; its two secrets are seeded
out of band as above, never in CI.

**Drift detector:** `tests/mcp-doors-328.test.ts` asserts the production wrangler template
points at `@skyphusion-labs/vivijure-mcp`, that the installed package's `serverInfo.version`
matches its `package.json` version (the wire-version defect that used to report `0.1.0`), and
that the retired propagandhi config is not reintroduced.

## Retired: propagandhi / local studio door (cf#328)

Conrad ruling 2026-08-17: delete the second door. Applied the same day.

| What | Was | Now |
|------|-----|-----|
| Worker | `vivijure-studio-mcp-flatliners` | deleted |
| Hostname | `studio-mcp-propagandhi.skyphusion.org` | custom domain detached, DNS record gone |
| Config | `wrangler.mcp.propagandhi.toml` | removed from this repo |

Production MCP at `studio-mcp.vivijure.com` (`vivijure-studio-mcp`) is unchanged. A local-studio
MCP door, if wanted later, is a new Worker with a new name, not a revival of this script.
