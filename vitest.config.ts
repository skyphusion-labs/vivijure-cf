import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
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
