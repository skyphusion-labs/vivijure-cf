import { defineConfig, type Plugin } from "vitest/config";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

// Mirror of the wrangler [[rules]] Text modules: a .sql import resolves to the file text. Without
// this, anything importing src/control-plane/studio-migrations.ts is untestable under vitest.
const sqlText: Plugin = {
  name: "sql-text",
  transform(_code, id) {
    if (!id.endsWith(".sql")) return null;
    return { code: `export default ${JSON.stringify(readFileSync(id, "utf8"))};`, map: null };
  },
};

export default defineConfig({
  plugins: [sqlText],
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./tests/shims/cloudflare-workers.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    server: {
      deps: {
        // npm-installed core uses internal relative imports; inline so vi.mock on
        // @skyphusion-labs/vivijure-core/* applies inside scatter-orchestrator etc.
        inline: ["@skyphusion-labs/vivijure-core"],
      },
    },
  },
});
