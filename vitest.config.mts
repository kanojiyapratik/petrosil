import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // One Postgres, one schema: the suites share a database and clean up
    // after themselves, so they must not interleave.
    fileParallelism: false,
    testTimeout: 30_000,
    setupFiles: ["tests/setup.ts"],
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
