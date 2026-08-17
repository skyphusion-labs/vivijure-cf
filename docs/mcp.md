# Vivijure Studio MCP (deploy)

The Studio MCP server is **`@skyphusion-labs/vivijure-mcp`** on npm.
Full operator doc: [vivijure-mcp `docs/mcp.md`](https://github.com/skyphusion-labs/vivijure-mcp/blob/main/docs/mcp.md).

## Quick pointer

| What | Where |
|------|--------|
| Package | `@skyphusion-labs/vivijure-mcp` |
| Wrangler config | `wrangler.mcp.toml.example` |
| Worker entry | `node_modules/@skyphusion-labs/vivijure-mcp/dist/mcp.js` |
| Local dev | `npm run dev:mcp` |

## Deploy (CF host -- production door)

```sh
cp wrangler.mcp.toml.example wrangler.mcp.toml   # set STUDIO_URL + route host
wrangler secret put STUDIO_API_TOKEN -c wrangler.mcp.toml
wrangler secret put MCP_TOKEN         -c wrangler.mcp.toml
npm run deploy:mcp
```

CI deploys the **production** door when `MCP_HOST` and `MCP_STUDIO_URL` are set (see
`.github/workflows/ci.yml`). That job deploys `vivijure-studio-mcp` only.

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
