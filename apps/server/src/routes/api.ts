import {
  ActionError,
  ALL_SCOPES,
  ClientErrorReport,
  permissionsOf,
  type Connection,
  type Health,
  type SessionView,
  type SignInMethod,
} from "@template/contracts";
import { z } from "zod";
import { findAction, runAction } from "../actions/registry";
import type { Env } from "../env";
import {
  checkOrigin,
  clientIp,
  currentSession,
  inOrganization,
  rateLimit,
  sessionToken,
  type RequestContext,
} from "../lib/context";
import { fingerprint } from "../lib/errors";
import { capturedMail } from "../lib/mail";
import {
  authenticateBearer,
  grantOrganization,
  grantsFor,
  lastUsed,
  mcpRequiresVerifiedEmail,
  mcpResource,
  oauthApi,
} from "../mcp/oauth";
import { body, ctxOf, json, notFound, router } from "./http";

export const apiRoutes = router();

export function googleEnabled(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

/** No auth, no tenant data: `SELECT 1` as `app_runtime`, and which build is running. */
apiRoutes.get("/health", async (c) => {
  const ctx = ctxOf(c);
  await ctx.database().ping();
  const health: Health = {
    ok: true,
    version: ctx.env.CF_VERSION?.id ?? "local",
    commit: ctx.env.CF_VERSION?.tag || "local",
  };
  return json(health);
});

/**
 * Everything the app needs on first load, in one call and one round trip: the person, the open
 * organization and what they may do there, and every organization they belong to.
 */
export async function sessionView(
  ctx: RequestContext,
): Promise<{ view: SessionView; cookies: string[] }> {
  const signInMethods: SignInMethod[] = [
    "password",
    ...(googleEnabled(ctx.env) ? (["google"] as const) : []),
  ];
  const base = {
    signInMethods,
    mcpRequiresVerifiedEmail: mcpRequiresVerifiedEmail(ctx.env),
    mcpUrl: mcpResource(ctx.origin),
    environment: ctx.env.ENVIRONMENT,
  };
  const token = sessionToken(ctx.request);
  const cookies: string[] = [];
  const details = token ? await ctx.accounts().sessions.details(token) : null;
  if (details && token) {
    ctx.identify(details.identity);
    const renewed = await ctx.accounts().sessions.renew(details.identity, token);
    if (renewed) cookies.push(renewed);
  }
  const view: SessionView = {
    ...base,
    profile: details?.profile ?? null,
    organizations: details?.organizations ?? [],
    permissions: permissionsOf(details?.identity.role),
    account: details?.account ?? null,
  };
  return { view, cookies };
}

apiRoutes.get("/session", async (c) => {
  const { view, cookies } = await sessionView(ctxOf(c));
  return json(view, cookies);
});

/**
 * Every action, for the web app (session cookie) and future clients (bearer token from the same
 * OAuth server as MCP).
 */
apiRoutes.post("/actions/:id", async (c) => {
  const ctx = ctxOf(c);
  const action = findAction(c.req.param("id"));
  if (!action) notFound();
  ctx.route = `action:${action.id}`;
  checkOrigin(ctx);
  const input = await body(c, z.unknown(), action.maxInputBytes);
  const authorization = ctx.request.headers.get("authorization") ?? "";
  const cookies: string[] = [];
  if (/^bearer\s/i.test(authorization)) {
    const caller = await authenticateBearer(ctx, authorization.replace(/^bearer\s+/i, ""));
    ctx.identify(caller);
    return json(await runAction(ctx, action, input, { ...caller, caller: "api" }));
  }
  const signedIn = await currentSession(ctx, cookies);
  if (!signedIn) throw new ActionError("unauthenticated", "Sign in to continue.");
  const identity = inOrganization(ctx, signedIn);
  const output = await runAction(ctx, action, input, {
    userId: identity.userId,
    organizationId: identity.organizationId,
    organization: { name: identity.organization.name, slug: identity.organization.slug },
    role: identity.role,
    emailVerified: identity.emailVerified,
    // The person themselves, in the app: every scope.
    scopes: ALL_SCOPES,
    caller: "web",
  });
  return json(output, cookies);
});

/** Connected apps: the person's live MCP grants, each with the company it's connected to. */
apiRoutes.get("/connections", async (c) => {
  const ctx = ctxOf(c);
  const cookies: string[] = [];
  const identity = await currentSession(ctx, cookies);
  if (!identity) throw new ActionError("unauthenticated", "Sign in to continue.");
  const oauth = oauthApi(ctx);
  const companies = new Map(
    (await ctx.accounts().organizations.list(identity.userId)).map((o) => [o.id, o.name]),
  );
  // A grant for a company the person has left is revoked then; one that slipped through isn't shown.
  const grants = (await grantsFor(oauth, identity.userId)).filter((g) =>
    companies.has(grantOrganization(g) ?? ""),
  );
  const names = new Map<string, string>();
  const connections: Connection[] = await Promise.all(
    grants.map(async (grant) => {
      let name = names.get(grant.clientId);
      if (!name) {
        const client = await oauth.lookupClient(grant.clientId).catch(() => null);
        name =
          client?.clientName?.trim() ||
          (grant.metadata as { clientName?: string } | null)?.clientName ||
          "MCP client";
        names.set(grant.clientId, name);
      }
      return {
        id: grant.id,
        clientName: name,
        scopes: grant.scope,
        connectedAt: new Date(grant.createdAt * 1000).toISOString(),
        lastUsedAt: await lastUsed(ctx.env, grant.id),
        organization: {
          id: grantOrganization(grant)!,
          name: companies.get(grantOrganization(grant)!)!,
        },
      };
    }),
  );
  connections.sort((a, b) => b.connectedAt.localeCompare(a.connectedAt));
  return json({ connections }, cookies);
});

apiRoutes.delete("/connections/:id", async (c) => {
  const ctx = ctxOf(c);
  checkOrigin(ctx);
  const cookies: string[] = [];
  const identity = await currentSession(ctx, cookies);
  if (!identity) throw new ActionError("unauthenticated", "Sign in to continue.");
  const oauth = oauthApi(ctx);
  const grant = (await grantsFor(oauth, identity.userId)).find((g) => g.id === c.req.param("id"));
  if (!grant) throw new ActionError("not_found", "That connection is already gone.");
  await oauth.revokeGrant(grant.id, identity.userId);
  ctx.log.info("oauth.revoked", { grantId: grant.id });
  return json({ ok: true }, cookies);
});

/**
 * Browser errors from `apps/web`: logged through the same redacting logger, never stored.
 * Same origin, rate limited, size capped (`body`).
 */
apiRoutes.post("/client-errors", async (c) => {
  const ctx = ctxOf(c);
  checkOrigin(ctx);
  await rateLimit(
    ctx,
    ctx.env.CLIENT_ERROR_LIMIT,
    `client-errors:${clientIp(ctx.request)}`,
    "client-errors",
  );
  const report = await body(c, ClientErrorReport);
  const cookies: string[] = [];
  await currentSession(ctx, cookies).catch(() => null);
  const error = Object.assign(new Error(report.message), {
    name: report.kind,
    stack: report.stack ?? "",
  });
  ctx.log.with({ source: "browser" }).error("browser.error", {
    kind: report.kind,
    path: report.path.replace(/[?#].*$/s, ""),
    error: report.message,
    stack: report.stack,
    failedRequestId: report.requestId,
    fingerprint: await fingerprint(error, `browser:${report.path.replace(/[?#].*$/s, "")}`),
  });
  return new Response(null, {
    status: 204,
    headers: cookies.length ? { "set-cookie": cookies[0]! } : {},
  });
});

/** Local development: the mail the app would have sent (`/dev/mail`). */
apiRoutes.get("/dev/mail", async (c) => {
  const ctx = ctxOf(c);
  if (ctx.env.ENVIRONMENT !== "local") notFound();
  return json({ mail: await capturedMail(ctx.env) });
});

/**
 * Staging and tests: the e2e suite reads mail sent to its own `.example` addresses. Needs
 * `TEST_MAIL_SECRET`; production never has one.
 */
apiRoutes.get("/test/mail", async (c) => {
  const ctx = ctxOf(c);
  const secret = ctx.env.TEST_MAIL_SECRET;
  if (!secret || ctx.env.ENVIRONMENT === "production") notFound();
  if (ctx.request.headers.get("authorization") !== `Bearer ${secret}`)
    throw new ActionError("unauthenticated", "Wrong test mail secret.");
  const to = c.req.query("to") ?? "";
  if (!/\.example$/i.test(to)) throw new ActionError("invalid_input", "Only .example addresses.");
  return json({ mail: await capturedMail(ctx.env, to) });
});
