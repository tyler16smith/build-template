import {
  ActionError,
  ALWAYS_GRANTED,
  ALL_SCOPES,
  ConsentDecision,
  normalizeScopes,
  PATHS,
  SCOPES,
  type ConsentView,
  type Scope,
} from "@template/contracts";
import { checkOrigin, requireSession } from "../lib/context";
import { clientDisplay, mcpRequiresVerifiedEmail, oauthApi, type GrantProps } from "../mcp/oauth";
import { body, ctxOf, json, redirect, router } from "./http";

/**
 * The interactive part of the OAuth flow. `/authorize` stores the request under a 10-minute
 * consent handle and sends the browser to the SPA's consent screen, which signs the person in
 * first if needed (the handle survives the detour) and posts the decision here.
 */
export const oauthRoutes = router();

const CONSENT_TTL_SECONDS = 10 * 60;
const consentKey = (handle: string) => `consent:${handle}`;

type ConsentRecord = {
  clientName: string;
  clientUri: string | null;
  logoUri: string | null;
  redirectHost: string;
  /** What the client asked for; empty means it didn't say, so everything is offered. */
  requested: string[];
};

function offered(record: ConsentRecord): Scope[] {
  return record.requested.length ? normalizeScopes(record.requested) : [...ALL_SCOPES];
}

oauthRoutes.get(PATHS.authorize, async (c) => {
  const ctx = ctxOf(c);
  const oauth = oauthApi(ctx);
  let authRequest;
  try {
    authRequest = await oauth.parseAuthRequest(ctx.request);
  } catch (error) {
    ctx.log.info("oauth.authorize_refused", { error });
    return redirect(
      `${PATHS.consent}?error=${encodeURIComponent("This connection request isn't valid. Start again from your AI app.")}`,
    );
  }
  const client = await oauth.lookupClient(authRequest.clientId).catch(() => null);
  const { handle, headers } = await oauth.beginConsent(authRequest);
  const record: ConsentRecord = {
    ...clientDisplay(client, authRequest.redirectUri),
    requested: authRequest.scope,
  };
  await ctx.env.OAUTH_KV.put(consentKey(handle), JSON.stringify(record), {
    expirationTtl: CONSENT_TTL_SECONDS,
  });
  return redirect(`${PATHS.consent}?handle=${encodeURIComponent(handle)}`, [], headers);
});

async function consentRecord(kv: KVNamespace, handle: string): Promise<ConsentRecord> {
  const record = /^[\w-]{8,200}$/.test(handle)
    ? await kv.get<ConsentRecord>(consentKey(handle), "json")
    : null;
  if (!record)
    throw new ActionError(
      "not_found",
      "This connection request expired. Start it again from your AI app.",
    );
  return record;
}

oauthRoutes.get("/api/oauth/consent/:handle", async (c) => {
  const ctx = ctxOf(c);
  const cookies: string[] = [];
  const identity = await requireSession(ctx, cookies);
  const handle = c.req.param("handle");
  const record = await consentRecord(ctx.env.OAUTH_KV, handle);
  const organizations = await ctx.accounts().organizations.list(identity.userId);
  // A person with no company yet goes through /onboarding and back here; the handle survives.
  if (!organizations.length)
    throw new ActionError("no_organization", "Create or join a company first.");
  const view: ConsentView = {
    handle,
    clientName: record.clientName,
    clientUri: record.clientUri,
    logoUri: record.logoUri,
    redirectHost: record.redirectHost,
    scopes: offered(record).map((id) => ({
      id,
      description: SCOPES[id],
      required: ALWAYS_GRANTED.includes(id),
    })),
    needsVerifiedEmail: mcpRequiresVerifiedEmail(ctx.env) && !identity.emailVerified,
    organizations: organizations.map(({ id, name, slug, role }) => ({ id, name, slug, role })),
    organizationId: organizations.some((o) => o.id === identity.organizationId)
      ? identity.organizationId
      : organizations[0]!.id,
  };
  return json(view, cookies);
});

oauthRoutes.post("/api/oauth/consent", async (c) => {
  const ctx = ctxOf(c);
  checkOrigin(ctx);
  const cookies: string[] = [];
  const identity = await requireSession(ctx, cookies);
  const decision = await body(c, ConsentDecision);
  const record = await consentRecord(ctx.env.OAUTH_KV, decision.handle);
  const oauth = oauthApi(ctx);
  const withCookies = (headers: Headers) => {
    for (const cookie of headers.getSetCookie()) cookies.push(cookie);
  };
  if (decision.decision === "cancel") {
    const denied = await oauth.denyConsent(ctx.request, decision.handle);
    await ctx.env.OAUTH_KV.delete(consentKey(decision.handle));
    withCookies(denied.headers);
    ctx.log.info("oauth.denied");
    return json({ redirectTo: denied.redirectTo }, cookies);
  }
  if (mcpRequiresVerifiedEmail(ctx.env) && !identity.emailVerified)
    throw new ActionError(
      "email_unverified",
      "Verify your email address before connecting an app. Check your inbox for the link.",
    );
  // A connection is for one company, which the person must belong to.
  const organizationId = decision.organizationId ?? identity.organizationId;
  const organizations = await ctx.accounts().organizations.list(identity.userId);
  if (!organizationId || !organizations.some((o) => o.id === organizationId))
    throw new ActionError("not_a_member", "You don't have access to that company.");
  // Only what was offered; reading is always granted.
  const allowed = offered(record);
  const scopes = normalizeScopes(decision.scopes.filter((s) => allowed.includes(s as Scope)));
  const approved = await oauth.approveConsent(ctx.request, decision.handle, { scope: scopes });
  withCookies(approved.headers);
  const props: GrantProps = {
    userId: identity.userId,
    organizationId,
    scopes,
    clientName: record.clientName,
  };
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: identity.userId,
    metadata: { organizationId, clientName: record.clientName },
    scope: scopes,
    props,
  });
  await ctx.env.OAUTH_KV.delete(consentKey(decision.handle));
  ctx.log.info("oauth.granted", { clientName: record.clientName, scopes, organizationId });
  return json({ redirectTo }, cookies);
});
