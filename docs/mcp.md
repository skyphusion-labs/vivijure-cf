# Vivijure Studio MCP (deploy)

The Studio MCP server lives in **`@skyphusion-labs/vivijure-core`** (`docs/mcp.md` in that repo).
It is host-agnostic: the same package serves `vivijure-cf` and `vivijure-local`. This repo only
ships **deploy wiring** for the optional separate Worker.

## Quick pointer

| What | Where |
|------|--------|
| Tool catalog, security model, agent setup | [vivijure-core `docs/mcp.md`](https://github.com/skyphusion-labs/vivijure-core/blob/main/docs/mcp.md) |
| Wrangler config | `wrangler.mcp.toml.example` (render to `wrangler.mcp.toml`) |
| Worker entry | `node_modules/@skyphusion-labs/vivijure-core/dist/mcp.js` |
| Local dev | `npm run dev:mcp` |

## Deploy (CF host)

```sh
cp wrangler.mcp.toml.example wrangler.mcp.toml   # set STUDIO_URL + route host
wrangler secret put STUDIO_API_TOKEN -c wrangler.mcp.toml
wrangler secret put MCP_TOKEN         -c wrangler.mcp.toml
npm run deploy:mcp
```

CI deploys when `MCP_HOST` and `MCP_STUDIO_URL` are set (see `.github/workflows/ci.yml`).
