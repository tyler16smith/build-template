import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { createSqlProxy } from "./test/sql-proxy";

/**
 * The Worker's tests run in workerd (`@cloudflare/vitest-pool-workers`), against the real Worker.
 * The database is PGlite in this process, reached through the `TEST_SQL` service binding, so no
 * Docker is needed.
 */
export default defineConfig(async () => {
  const sql = await createSqlProxy();
  return {
    plugins: [
      cloudflareTest({
        main: "./src/index.ts",
        miniflare: {
          compatibilityDate: "2026-08-20",
          compatibilityFlags: ["nodejs_compat"],
          kvNamespaces: ["OAUTH_KV"],
          durableObjects: {
            AssistantAgent: { className: "AssistantAgent", useSQLite: true },
            AutomationAgent: { className: "AutomationAgent", useSQLite: true },
          },
          workflows: {
            AUTOMATION_WORKFLOW: {
              name: "automation-runs-test",
              className: "AutomationRunWorkflow",
            },
          },
          serviceBindings: {
            TEST_SQL: (request: Request) => sql.fetch(request),
          },
          ratelimits: {
            AUTH_LIMIT: { namespace_id: "1", simple: { limit: 1000, period: 60 } },
            REGISTER_LIMIT: { namespace_id: "2", simple: { limit: 1000, period: 60 } },
            CLIENT_ERROR_LIMIT: { namespace_id: "3", simple: { limit: 3, period: 60 } },
            ZAPIER_LIMIT: { namespace_id: "4", simple: { limit: 1000, period: 60 } },
          },
          bindings: {
            ENVIRONMENT: "test",
            APP_NAME: "Build Template",
            APP_ORIGIN: "https://app.test",
            SESSION_PEPPER: "test-pepper-0123456789abcdef0123456789",
            MCP_REQUIRE_VERIFIED_EMAIL: "true",
            TEST_MAIL_SECRET: "test-mail-secret",
            // 32 zero bytes, base64: seals Zapier hook URLs and webhook secrets in tests.
            CONNECTION_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          },
        },
      }),
    ],
    resolve: { alias: { pg: fileURLToPath(new URL("./test/pg-stub.ts", import.meta.url)) } },
    test: {
      include: ["test/**/*.test.ts"],
      fileParallelism: false,
      testTimeout: 30_000,
    },
  };
});
