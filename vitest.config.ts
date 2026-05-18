import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@deepthonk/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@deepthonk/providers": fileURLToPath(new URL("./packages/providers/src/index.ts", import.meta.url)),
      "@deepthonk/mcp": fileURLToPath(new URL("./packages/mcp/src/index.ts", import.meta.url))
    }
  },
  test: {
    include: ["test/**/*.test.ts"],
    globals: false,
    environment: "node",
    testTimeout: 30_000
  }
});
