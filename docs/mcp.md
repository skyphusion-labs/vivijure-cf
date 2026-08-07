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

## Second door: propagandhi / local studio (cf#328)

There is a deliberate second MCP Worker for the propagandhi local-GPU studio:

| | Production | Propagandhi (local) |
|--|------------|---------------------|
| Config | `wrangler.mcp.toml.example` (rendered in CI) | `wrangler.mcp.propagandhi.toml` (tracked) |
| Script name | `vivijure-studio-mcp` | `vivijure-studio-mcp-flatliners` (historical name) |
| Hostname | `MCP_HOST` (e.g. studio-mcp.vivijure.com) | `studio-mcp-propagandhi.skyphusion.org` |
| `STUDIO_URL` | flagship / hosted studio | `https://vivijure-local.skyphusion.org` |
| Deploy path | tag CI when vars set | **hand deploy** (fleet secrets) |

**Disposition:** needed, not a leftover. The script name still says "flatliners" because renaming
creates a second Worker; the flatliners *host* is gone. Hand deployment is intentional: the door
needs `STUDIO_API_TOKEN` for vivijure-local and its own `MCP_TOKEN`, neither of which belongs in
GitHub Actions. Do not fold it into the production MCP CI job -- a shared job would either
overwrite production or point this door at the wrong studio.

**Redeploy after a `vivijure-mcp` pin bump** (or whenever `serverInfo.version` on the live door
lags the installed package):

```sh
npm ci
wrangler secret put STUDIO_API_TOKEN -c wrangler.mcp.propagandhi.toml   # once, or after rotate
wrangler secret put MCP_TOKEN         -c wrangler.mcp.propagandhi.toml
wrangler deploy -c wrangler.mcp.propagandhi.toml
```

**Drift detector:** `tests/mcp-doors-328.test.ts` asserts both wrangler configs point at the same
`@skyphusion-labs/vivijure-mcp` entry, and that the installed package's `serverInfo.version`
matches its `package.json` version (the wire-version defect that left the door reporting `0.1.0`).
It cannot see the *live* Cloudflare bundle without fleet API access; after a pin bump, redeploy
the propagandhi door by hand using the steps above.
