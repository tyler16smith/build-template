import { defineConfig } from "vitest/config";

// `pnpm test:db`: the same tests against a real Postgres, where `app_runtime` is a real login
// (CI's service container, or `pnpm db:local`). Needs TEST_DATABASE_URL (the migrator) and
// TEST_RUNTIME_URL (the runtime role).
if (!process.env.TEST_DATABASE_URL || !process.env.TEST_RUNTIME_URL)
  throw new Error("pnpm test:db needs TEST_DATABASE_URL and TEST_RUNTIME_URL");

export default defineConfig({
  test: {
    include: ["test/database.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
