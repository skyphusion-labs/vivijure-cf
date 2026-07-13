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

## Deploy (CF host)

```sh
cp wrangler.mcp.toml.example wrangler.mcp.toml   # set STUDIO_URL + route host
wrangler secret put STUDIO_API_TOKEN -c wrangler.mcp.toml
wrangler secret put MCP_TOKEN         -c wrangler.mcp.toml
npm run deploy:mcp
```

CI deploys when `MCP_HOST` and `MCP_STUDIO_URL` are set (see `.github/workflows/ci.yml`).
