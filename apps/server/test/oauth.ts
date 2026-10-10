import type { ConsentView } from "@template/contracts";
import { expect } from "vitest";
import { call, ORIGIN, type Browser } from "./helpers";

/** The OAuth and MCP sides of a connection, for the tests that connect a client. */
export const REDIRECT = "https://client.example/callback";

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function pkce() {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64Url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge };
}

export async function registerClient(): Promise<string> {
  const response = await call(
    new Request(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Test Client",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

/**
 * The whole browser side of connecting: authorize, sign in, consent (for `organizationId`, or
 * the open company). Returns the code.
 */
export async function connect(
  browser: Browser,
  clientId: string,
  scopes: string[],
  organizationId?: string,
) {
  const { verifier, challenge } = await pkce();
  const authorize = new URL(`${ORIGIN}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "profile:read profile:write",
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${ORIGIN}/mcp`,
  }).toString();
  const started = await browser.fetch(authorize.toString());
  expect(started.status).toBe(302);
  const location = new URL(started.headers.get("location")!, ORIGIN);
  expect(location.pathname).toBe("/oauth/consent");
  const handle = location.searchParams.get("handle")!;

  const view = await browser.json<ConsentView>(`/api/oauth/consent/${handle}`);
  expect(view.status).toBe(200);
  expect(view.body).toMatchObject({
    clientName: "Test Client",
    redirectHost: "client.example",
    needsVerifiedEmail: false,
  });
  expect(view.body.scopes.map((s) => [s.id, s.required])).toEqual([
    ["profile:read", true],
    ["profile:write", false],
    ["organization:read", true],
  ]);

  const decided = await browser.json<{ redirectTo: string }>("/api/oauth/consent", {
    json: { handle, decision: "allow", scopes, ...(organizationId ? { organizationId } : {}) },
  });
  expect(decided.status).toBe(200);
  const back = new URL(decided.body.redirectTo);
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
  expect(back.searchParams.get("state")).toBe("xyz");
  return { code: back.searchParams.get("code")!, verifier };
}

export async function exchange(clientId: string, code: string, verifier: string) {
  const response = await call(
    new Request(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${ORIGIN}/mcp`,
      }),
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { access_token: string; refresh_token: string; scope: string };
}

let rpcId = 0;
export async function rpc(token: string | null, method: string, params: unknown = {}) {
  const response = await call(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}
