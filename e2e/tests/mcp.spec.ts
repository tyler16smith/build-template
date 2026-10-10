import { createHash, randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_PASSWORD, base64Url, linkFor, median, signUpWithCompany } from "./helpers";

/**
 * Connecting an MCP client end to end: dynamic registration, /authorize, sign-in and the real
 * consent screen, the token exchange, tools/list and tools/call, then Disconnect, after which the
 * token stops working. With E2E_BUDGETS=1 (staging CI) it also checks the speed budgets.
 */
const REDIRECT = "https://client.example/callback";

async function rpc(
  request: APIRequestContext,
  token: string,
  method: string,
  params: unknown = {},
) {
  const started = performance.now();
  const response = await request.post("/mcp", {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    data: { jsonrpc: "2.0", id: 1, method, params },
  });
  return {
    status: response.status(),
    body: response.ok() ? await response.json() : null,
    ms: performance.now() - started,
  };
}

async function signUpAndVerify(page: Page, request: APIRequestContext) {
  const email = await signUpWithCompany(page, "E2E Connector");
  await page.goto(await linkFor(request, email, /Verify your email/));
  await expect(page.getByText("is verified")).toBeVisible();
  return email;
}

test("an MCP client connects through OAuth, calls tools, and is disconnected", async ({
  page,
  request,
  baseURL,
}) => {
  const email = await signUpAndVerify(page, request);

  const registered = await request.post("/register", {
    data: {
      client_name: "E2E Client",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
  });
  expect(registered.status()).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };

  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const authorize = new URL("/authorize", baseURL);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "profile:read profile:write",
    state: "e2e",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: new URL("/mcp", baseURL).toString(),
  }).toString();

  // The client's redirect never loads: catch it and keep the code.
  let callback: URL | null = null;
  await page.route("https://client.example/**", async (route) => {
    callback = new URL(route.request().url());
    await route.fulfill({ status: 200, body: "ok" });
  });
  await page.goto(authorize.toString());
  await expect(page.getByRole("heading", { name: "Connect E2E Client?" })).toBeVisible();
  await expect(page.getByText("Sends you back to client.example")).toBeVisible();
  await page.getByRole("button", { name: "Allow" }).click();
  await expect.poll(() => callback?.searchParams.get("code") ?? null).not.toBeNull();
  expect(callback!.searchParams.get("state")).toBe("e2e");

  const token = await request.post("/token", {
    form: {
      grant_type: "authorization_code",
      code: callback!.searchParams.get("code")!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: new URL("/mcp", baseURL).toString(),
    },
  });
  expect(token.status()).toBe(200);
  const { access_token: accessToken } = (await token.json()) as { access_token: string };

  const list = await rpc(request, accessToken, "tools/list");
  // The owner's reads (organization:read is always granted) and the profile update.
  expect(list.body.result.tools.map((t: { name: string }) => t.name)).toEqual([
    "profile_get",
    "profile_update",
    "organization_get",
    "members_list",
    "invites_list",
  ]);
  const got = await rpc(request, accessToken, "tools/call", { name: "profile_get", arguments: {} });
  expect(got.body.result.structuredContent.email).toBe(email);

  if (process.env.E2E_BUDGETS === "1") {
    const calls: number[] = [];
    for (let i = 0; i < 15; i++)
      calls.push(
        (await rpc(request, accessToken, "tools/call", { name: "profile_get", arguments: {} })).ms,
      );
    expect(median(calls), "MCP tools/call profile_get p50").toBeLessThanOrEqual(80);
  }

  await page.goto("/profile");
  const apps = page.locator("#connected-apps");
  await expect(apps.getByText("E2E Client")).toBeVisible();
  await apps.getByRole("button", { name: "Disconnect" }).click();
  await expect(apps.getByText("Nothing is connected yet.")).toBeVisible();
  expect((await rpc(request, accessToken, "tools/list")).status).toBe(401);

  await page.getByRole("button", { name: "Delete account" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Type DELETE to confirm").fill("DELETE");
  await dialog.getByLabel("Current password").fill(E2E_PASSWORD);
  await dialog.getByRole("button", { name: "Delete account" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
});

test("the speed budgets hold", async ({ page, request }) => {
  test.skip(process.env.E2E_BUDGETS !== "1", "Budgets are checked against staging (E2E_BUDGETS=1)");
  await signUpAndVerify(page, request);
  const api = page.request;
  await api.get("/api/session"); // warm
  const session: number[] = [];
  for (let i = 0; i < 20; i++) {
    const started = performance.now();
    expect((await api.get("/api/session")).ok()).toBe(true);
    session.push(performance.now() - started);
  }
  const updates: number[] = [];
  for (let i = 0; i < 15; i++) {
    const started = performance.now();
    const response = await api.post("/api/actions/profile.update", {
      data: { title: `Budget ${i}` },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(response.ok()).toBe(true);
    updates.push(performance.now() - started);
  }
  expect(median(session), "GET /api/session p50").toBeLessThanOrEqual(60);
  expect(median(updates), "profile.update p50").toBeLessThanOrEqual(90);
});
