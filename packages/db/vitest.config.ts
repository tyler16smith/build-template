import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // PGlite takes a moment to start; each file gets its own.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
