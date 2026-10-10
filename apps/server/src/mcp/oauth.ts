import {
  OAuthAuthorizationServer,
  type ClientInfo,
  type GrantSummary,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import {
  ActionError,
  ALL_SCOPES,
  normalizeScopes,
  PATHS,
  type OrganizationRef,
  type Role,
  type Scope,
} from "@template/contracts";
import type { Env } from "../env";
import type { RequestContext, RuntimeContext } from "../lib/context";

/** What a grant's tokens carry (`completeAuthorization`'s props). */
export type GrantProps = {
  userId: string;
  organizationId: string;
  scopes: Scope[];
  clientName: string;
};

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** The one protected resource: `/mcp`. Tokens are bound to it by audience. */
export function mcpResource(origin: string): string {
  return `${origin}${PATHS.mcp}`;
}

const servers = new Map<string, OAuthAuthorizationServer<Env>>();

/** The authorization server for this origin (one per isolate). */
export function authorizationServer(origin: string): OAuthAuthorizationServer<Env> {
  let server = servers.get(origin);
  if (!server) {
    server = new OAuthAuthorizationServer<Env>({
      issuer: origin,
      resources: [mcpResource(origin)],
      defaultResource: mcpResource(origin),
      authorizeEndpoint: PATHS.authorize,
      tokenEndpoint: PATHS.token,
      clientRegistrationEndpoint: PATHS.register,
      scopesSupported: [...ALL_SCOPES],
      accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
      // Clients that identify with a client ID metadata document URL (Claude, ChatGPT) instead of
      // registering. Needs the `global_fetch_strictly_public` compatibility flag. Dynamic
      // registration stays for the rest (Cursor, the MCP Inspector).
      clientIdMetadataDocumentEnabled: true,
    });
    servers.set(origin, server);
  }
  return server;
}

export function oauthApi(ctx: RequestContext): OAuthHelpers {
  return authorizationServer(ctx.origin).getOAuthApi(ctx.env);
}

/**
 * Whether the grant behind an access token (`userId:grantId:secret`) still exists. Revoking a
 * grant deletes its record by key but finds its access tokens with a KV listing, which lags new
 * writes by up to a minute, so a token minted just before revocation could live out its TTL. The
 * record's direct read sees the delete, so a token only counts while its grant exists.
 */
export async function grantIsLive(kv: KVNamespace, token: string): Promise<boolean> {
  const [userId, grantId] = token.split(":");
  if (!userId || !grantId) return false;
  return (await kv.get(`grant:${userId}:${grantId}`)) !== null;
}

export function grantIdOf(token: string): string | null {
  return token.split(":")[1] ?? null;
}

const lastUsedWrites = new Map<string, number>();
const LAST_USED_EVERY_MS = 10 * 60_000;

/** Records when a grant was last used, at most every 10 minutes per isolate. */
export function touchGrant(ctx: RequestContext, grantId: string): void {
  const now = Date.now();
  if (now - (lastUsedWrites.get(grantId) ?? 0) < LAST_USED_EVERY_MS) return;
  lastUsedWrites.set(grantId, now);
  ctx.exec.waitUntil(
    ctx.env.OAUTH_KV.put(`used:${grantId}`, new Date(now).toISOString(), {
      expirationTtl: REFRESH_TOKEN_TTL_SECONDS,
    }),
  );
}

export async function lastUsed(env: Env, grantId: string): Promise<string | null> {
  return env.OAUTH_KV.get(`used:${grantId}`);
}

const MEMBERSHIP_CACHE_MS = 60_000;
type CachedMembership = {
  role: Role;
  emailVerified: boolean;
  organization: Pick<OrganizationRef, "name" | "slug">;
  at: number;
};
const memberships = new Map<string, CachedMembership>();

/**
 * The membership behind a token, checked again on every call: removing someone (or deleting the
 * account, or the company) cuts off their clients. Like sessions, a check is cached per isolate
 * for 60 seconds; removing a member also revokes their grants, so the cache never outlives access.
 */
export async function verifyMembership(
  ctx: RequestContext,
  props: Pick<GrantProps, "userId" | "organizationId">,
): Promise<Omit<CachedMembership, "at">> {
  const key = `${props.userId}:${props.organizationId}`;
  const cached = memberships.get(key);
  if (cached && Date.now() - cached.at < MEMBERSHIP_CACHE_MS) return cached;
  try {
    const profile = await ctx.accounts().profile(props);
    if (!profile.organization || !profile.role) throw new ActionError("not_found", "Not a member.");
    const entry: CachedMembership = {
      role: profile.role,
      emailVerified: profile.emailVerified,
      organization: { name: profile.organization.name, slug: profile.organization.slug },
      at: Date.now(),
    };
    memberships.set(key, entry);
    return entry;
  } catch (error) {
    memberships.delete(key);
    if (error instanceof ActionError && error.code === "not_found")
      throw new ActionError("not_a_member", "This account is no longer part of that company.");
    throw error;
  }
}

/** Drops this isolate's cached memberships of a person (in one organization, or all). */
export function forgetMembership(userId: string, organizationId?: string): void {
  if (organizationId) {
    memberships.delete(`${userId}:${organizationId}`);
    return;
  }
  for (const key of memberships.keys()) if (key.startsWith(`${userId}:`)) memberships.delete(key);
}

/** The organization a grant was made for (its metadata, fixed at consent). */
export function grantOrganization(grant: GrantSummary): string | null {
  return (grant.metadata as { organizationId?: string } | null)?.organizationId ?? null;
}

/**
 * Revokes a person's grants for one organization: they were removed from it, left it, or it was
 * deleted. Their connections to other companies carry on.
 */
export async function revokeGrantsIn(
  ctx: RuntimeContext,
  userId: string,
  organizationId: string,
): Promise<number> {
  const oauth = authorizationServer(ctx.origin).getOAuthApi(ctx.env);
  const grants = (await grantsFor(oauth, userId)).filter(
    (grant) => grantOrganization(grant) === organizationId,
  );
  for (const grant of grants) await oauth.revokeGrant(grant.id, userId);
  forgetMembership(userId, organizationId);
  if (grants.length) ctx.log.info("oauth.grants_revoked", { count: grants.length, organizationId });
  return grants.length;
}

export function mcpRequiresVerifiedEmail(env: Env): boolean {
  return env.MCP_REQUIRE_VERIFIED_EMAIL !== "false";
}

/** A grant's props, checked: tokens issued by this app always carry these. */
export function grantProps(props: unknown, scope: string[] | undefined): GrantProps {
  const p = (props ?? {}) as Partial<GrantProps>;
  if (typeof p.userId !== "string" || typeof p.organizationId !== "string")
    throw new ActionError("unauthenticated", "This connection's token is invalid. Reconnect.");
  return {
    userId: p.userId,
    organizationId: p.organizationId,
    scopes: normalizeScopes(scope ?? p.scopes ?? []),
    clientName: typeof p.clientName === "string" ? p.clientName : "MCP client",
  };
}

/**
 * A bearer token for `/api/actions` (future native and desktop clients): the same tokens as
 * `/mcp`, the same liveness and membership checks.
 */
export async function authenticateBearer(ctx: RequestContext, token: string) {
  const validated = await authorizationServer(ctx.origin).validateToken<GrantProps>(
    mcpResource(ctx.origin),
    token,
    ctx.env,
  );
  if (!validated || !(await grantIsLive(ctx.env.OAUTH_KV, token)))
    throw new ActionError("unauthenticated", "This token is invalid or was revoked.");
  const props = grantProps(validated.props, validated.scope);
  const membership = await verifyMembership(ctx, props);
  const grantId = grantIdOf(token);
  if (grantId) touchGrant(ctx, grantId);
  return { ...props, ...membership };
}

/** Every grant of a person (paged). */
export async function grantsFor(oauth: OAuthHelpers, userId: string): Promise<GrantSummary[]> {
  const grants: GrantSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await oauth.listUserGrants(userId, { limit: 100, cursor });
    grants.push(...result.items);
    if (!result.cursor) return grants;
    cursor = result.cursor;
  }
  return grants;
}

/** Revokes every grant (and so every token) of a person: password reset, account deletion. */
export async function revokeAllGrants(ctx: RequestContext, userId: string): Promise<number> {
  const oauth = oauthApi(ctx);
  const grants = await grantsFor(oauth, userId);
  for (const grant of grants) await oauth.revokeGrant(grant.id, userId);
  forgetMembership(userId);
  if (grants.length) ctx.log.info("oauth.grants_revoked", { count: grants.length });
  return grants.length;
}

export function clientDisplay(client: ClientInfo | null, redirectUri: string) {
  let redirectHost = "an unknown address";
  try {
    redirectHost = new URL(redirectUri).host || redirectUri;
  } catch {
    redirectHost = "an unknown address";
  }
  const safeUri = (value: string | undefined) =>
    value && /^https:\/\//.test(value) ? value : null;
  return {
    clientName: client?.clientName?.trim().slice(0, 100) || "An MCP client",
    clientUri: safeUri(client?.clientUri),
    logoUri: safeUri(client?.logoUri),
    redirectHost,
  };
}
