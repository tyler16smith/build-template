import { Accounts, readCookie, type SessionIdentity } from "@template/auth";
import {
  ActionError,
  ORGANIZATION_HEADER,
  SESSION_COOKIE,
  uuidv7,
  type OrganizationRef,
  type Role,
} from "@template/contracts";
import { Database } from "@template/db";
import type { Env } from "../env";
import { sqlDatabase } from "./database";
import { Logger, type LogContext } from "./log";
import { createMailer, type Mailer } from "./mail";
import { timingRecorder, versionTag } from "./metrics";

/**
 * What running an action needs, with or without a request: the request pipeline, an agent's
 * turn (a Durable Object), a Workflow step and a cron job each build one.
 */
export type RuntimeContext = {
  requestId: string;
  env: Env;
  /** The app's canonical origin (`APP_ORIGIN`, else the request's). */
  origin: string;
  version: string;
  log: Logger;
  mailer: Mailer;
  /** The MCP client's name, on `/mcp` requests. */
  mcpClient: string | null;
  /** Set once an unexpected failure is reported, for the request's metric. */
  fingerprint: string | null;
  database(): Database;
  accounts(): Accounts;
  roundTrips(): number;
  /** Work that may finish after the response (automation dispatch, bookkeeping). */
  waitUntil(promise: Promise<unknown>): void;
  /** Releases the connection once the work is done. */
  close(): void;
};

/**
 * Everything one request carries. Built first, before anything else runs, so even a failure in
 * routing has a request id, a logger and a version.
 */
export type RequestContext = RuntimeContext & {
  exec: ExecutionContext;
  request: Request;
  started: number;
  /** The route or action id, for logs and metrics; set by the router. */
  route: string;
  /** Known once the person is: for metrics' index and log lines. */
  organizationId: string | null;
  userId: string | null;
  /** Adds the person to the logger and metrics once they're known. */
  identify(identity: { userId: string; organizationId: string | null }): void;
};

export function canonicalOrigin(env: Env, request: Request): string {
  return env.APP_ORIGIN ?? new URL(request.url).origin;
}

export function createContext(request: Request, env: Env, exec: ExecutionContext): RequestContext {
  const requestId = uuidv7();
  const version = versionTag(env);
  let database: Database | null = null;
  let accounts: Accounts | null = null;
  const ctx: RequestContext = {
    requestId,
    env,
    exec,
    request,
    origin: canonicalOrigin(env, request),
    version,
    started: performance.now(),
    log: new Logger({ requestId, version, source: "server" }),
    mailer: null as unknown as Mailer,
    route: new URL(request.url).pathname,
    organizationId: null,
    userId: null,
    mcpClient: null,
    fingerprint: null,
    database() {
      return (database ??= new Database(sqlDatabase(env), { onTiming: timing.onTiming }));
    },
    accounts() {
      return (accounts ??= new Accounts(ctx.database(), env.SESSION_PEPPER));
    },
    roundTrips: () => timing.roundTrips(),
    waitUntil: (promise) => exec.waitUntil(promise),
    identify(identity) {
      // Only the ids: callers pass richer objects (a sign-in result holds the session token).
      const { userId, organizationId } = identity;
      ctx.userId = userId;
      ctx.organizationId = organizationId;
      ctx.log = ctx.log.with({ userId, ...(organizationId ? { organizationId } : {}) });
    },
    close() {
      if (database) exec.waitUntil(database.close().catch(() => undefined));
    },
  };
  const timing = timingRecorder(env, ctx.log, () => ctx.organizationId);
  ctx.mailer = createMailer(env, ctx.log);
  return ctx;
}

/**
 * A context with no request: an agent turn, a Workflow step, a cron job. Without a `waitUntil`
 * (a Workflow step), deferred work is collected and `settle()` waits for it before the step ends.
 */
export function createRuntimeContext(
  env: Env,
  options: {
    source: NonNullable<LogContext["source"]>;
    route: string;
    waitUntil?: (promise: Promise<unknown>) => void;
    organizationId?: string;
    userId?: string;
  },
): RuntimeContext & { settle(): Promise<void> } {
  const requestId = uuidv7();
  const version = versionTag(env);
  let log = new Logger({ requestId, version, source: options.source, route: options.route });
  if (options.organizationId)
    log = log.with({ organizationId: options.organizationId, userId: options.userId });
  const timing = timingRecorder(env, log, () => options.organizationId ?? null);
  const pending: Promise<unknown>[] = [];
  let database: Database | null = null;
  let accounts: Accounts | null = null;
  const ctx: RuntimeContext & { settle(): Promise<void> } = {
    requestId,
    env,
    origin: env.APP_ORIGIN ?? "https://app.local.private",
    version,
    log,
    mailer: createMailer(env, log),
    mcpClient: null,
    fingerprint: null,
    database() {
      return (database ??= new Database(sqlDatabase(env), { onTiming: timing.onTiming }));
    },
    accounts() {
      return (accounts ??= new Accounts(ctx.database(), env.SESSION_PEPPER));
    },
    roundTrips: () => timing.roundTrips(),
    waitUntil(promise: Promise<unknown>) {
      const settled = promise.catch((error: unknown) =>
        log.error("deferred.failed", { error: error instanceof Error ? error.message : error }),
      );
      if (options.waitUntil) options.waitUntil(settled);
      else pending.push(settled);
    },
    async settle() {
      while (pending.length) await Promise.all(pending.splice(0));
    },
    close() {
      const closing = database?.close().catch(() => undefined);
      database = null;
      accounts = null;
      if (closing) ctx.waitUntil(closing);
    },
  };
  return ctx;
}

/**
 * CSRF: a state-changing `/api` request must come from the app's own origin, on top of
 * `SameSite=Lax` on the session cookie. Requests with a bearer token carry no ambient
 * credentials, so they don't need it.
 */
export function checkOrigin(ctx: RequestContext): void {
  const method = ctx.request.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  if (/^bearer\s/i.test(ctx.request.headers.get("authorization") ?? "")) return;
  const origin = ctx.request.headers.get("origin");
  if (origin !== ctx.origin)
    throw new ActionError(
      "forbidden",
      "This request didn't come from the app. Reload and try again.",
    );
}

/** Workers Rate Limiting. A hit is an expected outcome, logged as an auth event. */
export async function rateLimit(
  ctx: RequestContext,
  limiter: RateLimit | undefined,
  key: string,
  what: string,
): Promise<void> {
  if (!limiter) return;
  const { success } = await limiter.limit({ key });
  if (!success) {
    ctx.log.info("auth.rate_limited", { limit: what });
    throw new ActionError("rate_limited", "Too many attempts. Wait a minute and try again.");
  }
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "local";
}

export function sessionToken(request: Request): string | null {
  return readCookie(request.headers.get("cookie"), SESSION_COOKIE);
}

/**
 * The signed-in person from the session cookie, or null. Slides the session forward when it's
 * due (the refreshed cookie goes in `setCookies`).
 */
export async function currentSession(
  ctx: RequestContext,
  setCookies: string[],
): Promise<SessionIdentity | null> {
  const token = sessionToken(ctx.request);
  if (!token) return null;
  const sessions = ctx.accounts().sessions;
  let identity = await sessions.authenticate(token);
  // The cache is per isolate: a company created, joined or switched to through another isolate
  // isn't in this one's copy yet. A session with no company, or a page loaded for another one
  // than the copy says, asks the database before anything is refused.
  const expected = ctx.request.headers.get(ORGANIZATION_HEADER);
  if (identity && (!identity.organizationId || (expected && expected !== identity.organizationId)))
    identity = await sessions.authenticate(token, { fresh: true });
  if (!identity) return null;
  ctx.identify(identity);
  const renewed = await ctx.accounts().sessions.renew(identity, token);
  if (renewed) setCookies.push(renewed);
  return identity;
}

export async function requireSession(
  ctx: RequestContext,
  setCookies: string[],
): Promise<SessionIdentity> {
  const identity = await currentSession(ctx, setCookies);
  if (!identity) throw new ActionError("unauthenticated", "Sign in to continue.");
  return identity;
}

/** A session with an organization open, and the person's membership in it. */
export type OrganizationSession = SessionIdentity & {
  organizationId: string;
  organization: OrganizationRef;
  role: Role;
};

/**
 * The open organization of a session, for anything scoped to one (actions, the Assistant,
 * automations). Refuses a session whose organization just went away (`not_a_member`), one with
 * none (`no_organization`: the web app sends the person to `/onboarding`), and a page loaded
 * for another organization than the one open now (`organization_changed`).
 */
export function inOrganization(
  ctx: RequestContext,
  identity: SessionIdentity,
): OrganizationSession {
  if (identity.movedFrom) {
    ctx.log.info("organization.membership_gone", { organizationId: identity.movedFrom });
    throw new ActionError(
      "not_a_member",
      "You're no longer a member of that company. Reload to continue.",
    );
  }
  if (!identity.organizationId || !identity.organization || !identity.role)
    throw new ActionError("no_organization", "Create or join a company first.");
  checkOrganizationGuard(ctx, identity.organizationId);
  return identity as OrganizationSession;
}

/**
 * The organization guard: the web app sends `X-Organization-Id`, the organization its page was
 * loaded for. If another tab switched since, the request is refused and nothing runs. The header
 * can only cause a refusal; it never selects an organization.
 */
export function checkOrganizationGuard(ctx: RequestContext, organizationId: string): void {
  const expected = ctx.request.headers.get(ORGANIZATION_HEADER);
  if (!expected || expected === organizationId) return;
  // Counted: a burst means the web app isn't reloading after a switch.
  ctx.log.info("organization.guard_refused", { organizationId });
  throw new ActionError(
    "organization_changed",
    "You switched to another company in another tab. Reload to continue.",
  );
}
