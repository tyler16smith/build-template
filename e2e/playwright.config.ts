import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// The root `.env` (E2E_BASE_URL, E2E_TEST_MAIL_SECRET); variables already set win.
const dotenv = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

/**
 * Locally (`pnpm e2e`) against `pnpm dev`; in CI against staging (E2E_BASE_URL). Production gets
 * only the read-only `@smoke` tests (`pnpm smoke`), never a sign-up.
 */
export default defineConfig({
  testDir: "tests",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "https://app.local.private",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
