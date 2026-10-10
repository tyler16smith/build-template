import { expect, test } from "@playwright/test";

/**
 * Read-only checks, safe on production (`pnpm smoke`): nothing signs up or writes. The deploy
 * steps run them after every deploy; EXPECTED_COMMIT makes the health check prove which build is
 * live.
 */
test("@smoke health reports this build", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  const health = (await response.json()) as { ok: boolean; version: string; commit: string };
  expect(health.ok).toBe(true);
  if (process.env.EXPECTED_COMMIT) expect(health.commit).toBe(process.env.EXPECTED_COMMIT);
  expect(response.headers()["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
});

test("@smoke the session endpoint answers signed out", async ({ request }) => {
  const response = await request.get("/api/session");
  const session = (await response.json()) as {
    profile: unknown;
    signInMethods: string[];
    mcpUrl: string;
  };
  expect(session.profile).toBeNull();
  expect(session.signInMethods).toContain("password");
  expect(session.mcpUrl).toMatch(/\/mcp$/);
});

test("@smoke the sign-in page renders", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("@smoke MCP challenges a request without a token", async ({ request }) => {
  const response = await request.post("/mcp", {
    headers: { accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  expect(response.status()).toBe(401);
  expect(response.headers()["www-authenticate"]).toMatch(/resource_metadata=/);
  const metadata = await request.get("/.well-known/oauth-authorization-server");
  expect(metadata.ok()).toBe(true);
});
