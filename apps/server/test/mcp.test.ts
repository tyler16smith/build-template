import { beforeEach, describe, expect, it } from "vitest";
import type { ConsentView, Connection } from "@template/contracts";
import { Browser, call, ORIGIN, resetDatabase, signUp, verify } from "./helpers";
import { connect, exchange, pkce, REDIRECT, registerClient, rpc } from "./oauth";

beforeEach(resetDatabase);

describe("MCP over OAuth", () => {
  it("challenges a request without a token, pointing at the resource metadata", async () => {
    const response = await rpc(null, "tools/list");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/resource_metadata=/);
    const metadata = await call(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`));
    expect(await metadata.json()).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/token`,
      registration_endpoint: `${ORIGIN}/register`,
    });
  });

  it("runs the whole flow: register, authorize, consent, token, tools, revoke", async () => {
    const { browser, email } = await signUp();
    await verify(browser, email);
    const clientId = await registerClient();
    const { code, verifier } = await connect(browser, clientId, ["profile:read", "profile:write"]);
    const tokens = await exchange(clientId, code, verifier);
    expect(tokens.scope.split(" ").sort()).toEqual([
      "organization:read",
      "profile:read",
      "profile:write",
    ]);

    const init = await rpc(tokens.access_token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.status).toBe(200);

    const list = await rpc(tokens.access_token, "tools/list");
    expect(list.status).toBe(200);
    const tools = list.body.result.tools as {
      name: string;
      annotations: { readOnlyHint: boolean };
    }[];
    // The owner's reads: profile, company, members and invitations (organization:read is always
    // granted); profile:write adds the profile update, not the organization's writes.
    expect(tools.map((t) => [t.name, t.annotations.readOnlyHint])).toEqual([
      ["profile_get", true],
      ["profile_update", false],
      ["organization_get", true],
      ["members_list", true],
      ["invites_list", true],
    ]);

    const got = await rpc(tokens.access_token, "tools/call", {
      name: "profile_get",
      arguments: {},
    });
    expect(got.body.result.isError).toBeUndefined();
    expect(got.body.result.structuredContent).toMatchObject({ email, role: "owner" });

    const updated = await rpc(tokens.access_token, "tools/call", {
      name: "profile_update",
      arguments: { title: "Ventilation" },
    });
    expect(updated.body.result.structuredContent.title).toBe("Ventilation");

    const invalid = await rpc(tokens.access_token, "tools/call", {
      name: "profile_update",
      arguments: {},
    });
    expect(invalid.body.result.isError).toBe(true);
    expect(invalid.body.result.content[0].text).toMatch(/invalid_input; request /);

    // Connected apps lists it; Disconnect revokes it, and the token stops working at once.
    const connections = await browser.json<{ connections: Connection[] }>("/api/connections");
    expect(connections.body.connections).toHaveLength(1);
    expect(connections.body.connections[0]).toMatchObject({ clientName: "Test Client" });
    const id = connections.body.connections[0]!.id;
    expect((await browser.json(`/api/connections/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await rpc(tokens.access_token, "tools/list")).status).toBe(401);
  });

  it("gives a read-only connection no write tools", async () => {
    const { browser, email } = await signUp(new Browser(), "Hank Hayes");
    await verify(browser, email);
    const clientId = await registerClient();
    const { code, verifier } = await connect(browser, clientId, []);
    const tokens = await exchange(clientId, code, verifier);
    expect(tokens.scope).toBe("profile:read organization:read");
    const list = await rpc(tokens.access_token, "tools/list");
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "profile_get",
      "organization_get",
      "members_list",
      "invites_list",
    ]);
    const write = await rpc(tokens.access_token, "tools/call", {
      name: "profile_update",
      arguments: { title: "Dispatch" },
    });
    expect(write.body.result.isError).toBe(true);
    expect(write.body.result.structuredContent.error.code).toBe("forbidden");
  });

  it("accepts the same token at /api/actions, for future native clients", async () => {
    const { browser, email } = await signUp(new Browser(), "Clem Chimney");
    await verify(browser, email);
    const clientId = await registerClient();
    const { code, verifier } = await connect(browser, clientId, ["profile:write"]);
    const tokens = await exchange(clientId, code, verifier);
    const response = await call(
      new Request(`${ORIGIN}/api/actions/profile.get`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { email: string }).email).toBe(email);
  });

  it("requires a verified email before allowing a connection", async () => {
    const { browser } = await signUp(new Browser(), "Polly Planks");
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const started = await browser.fetch(
      `${ORIGIN}/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        state: "s",
        code_challenge: challenge,
        code_challenge_method: "S256",
      })}`,
    );
    const handle = new URL(started.headers.get("location")!, ORIGIN).searchParams.get("handle")!;
    const view = await browser.json<ConsentView>(`/api/oauth/consent/${handle}`);
    expect(view.body.needsVerifiedEmail).toBe(true);
    const decided = await browser.json<{ error: { code: string } }>("/api/oauth/consent", {
      json: { handle, decision: "allow", scopes: [] },
    });
    expect(decided.body.error.code).toBe("email_unverified");
  });

  it("asks a signed-out person to sign in, and keeps the handle", async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const browser = new Browser();
    const started = await browser.fetch(
      `${ORIGIN}/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        state: "s",
        code_challenge: challenge,
        code_challenge_method: "S256",
      })}`,
    );
    const handle = new URL(started.headers.get("location")!, ORIGIN).searchParams.get("handle")!;
    expect((await browser.json(`/api/oauth/consent/${handle}`)).status).toBe(401);
    const { email } = await signUp(browser, "Sid Sparks");
    await verify(browser, email);
    expect((await browser.json(`/api/oauth/consent/${handle}`)).status).toBe(200);
    const cancelled = await browser.json<{ redirectTo: string }>("/api/oauth/consent", {
      json: { handle, decision: "cancel" },
    });
    expect(new URL(cancelled.body.redirectTo).searchParams.get("error")).toBe("access_denied");
  });
});
