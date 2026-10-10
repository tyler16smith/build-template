import { Accounts } from "@template/auth";
import { ActionError, PATHS, uuidv7 } from "@template/contracts";
import { Database } from "@template/db";
import type { Env } from "./env";
import {
  clientIp,
  createContext,
  createRuntimeContext,
  rateLimit,
  type RequestContext,
} from "./lib/context";
import { sqlDatabase } from "./lib/database";
import { errorResponse, fingerprint } from "./lib/errors";
import { handleError } from "./lib/failures";
import { Logger } from "./lib/log";
import { recordMetric, timingRecorder, versionTag } from "./lib/metrics";
import { mcpResourceServer, authorizationServer } from "./mcp";
import { purgeConversationsOf } from "./modules/assistant/conversations";
import { purgeOrganizationAgents } from "./modules/organization/cleanup";
import { dispatchSchedules } from "./modules/automations/schedule";
import { receiveWebhook } from "./modules/automations/webhooks";
import { retryAndPurgeEvents } from "./modules/zapier/events";
import { receiveZapierEvent } from "./modules/zapier/route";
import { AGENT_PATH, routeAgent } from "./routes/agents";
import { apiRoutes } from "./routes/api";
import { authRoutes } from "./routes/auth";
import { googleRoutes } from "./routes/google";
import { attachContext, ctxOf, router } from "./routes/http";
import { oauthRoutes } from "./routes/oauth";
import { organizationRoutes } from "./routes/organizations";

export { AssistantAgent } from "./modules/assistant/agent";
export { AutomationAgent } from "./modules/automations/agent/agent";
export { AutomationRunWorkflow } from "./modules/automations/workflow";

/**
 * One Worker serves everything on one origin: the SPA's static assets (served without running
 * this code, except the paths in `run_worker_first`), `/api`, the OAuth endpoints, `/mcp`, the
 * agents (`/agents`, Durable Objects) and the inbound hooks (`/hooks`). The automation runtime is
 * a Workflow class exported from here too.
 */
const app = router();
app.route("/api", organizationRoutes);
app.route("/api/auth", authRoutes);
app.route("/api", apiRoutes);
app.route("/", oauthRoutes);
app.route("/", googleRoutes);
app.notFound((c) => {
  const ctx = ctxOf(c);
  if (ctx.route.startsWith("/api/"))
    return errorResponse(new ActionError("not_found", "There's nothing here."), ctx.requestId);
  return ctx.env.ASSETS.fetch(ctx.request);
});
app.onError((error, c) => handleError(ctxOf(c), error));

async function dispatch(ctx: RequestContext): Promise<Response> {
  const path = new URL(ctx.request.url).pathname;
  // `/mcp` and its resource metadata: the resource server challenges and validates first.
  if (path === PATHS.mcp || path.startsWith("/.well-known/oauth-protected-resource"))
    return mcpResourceServer(ctx).fetch(ctx.request, ctx.env, ctx.exec);
  if (path === PATHS.register)
    await rateLimit(
      ctx,
      ctx.env.REGISTER_LIMIT,
      `register:${clientIp(ctx.request)}`,
      "oauth-register",
    );
  // Discovery, `/token`, `/register` and revocation belong to the authorization server.
  if (path === PATHS.token || path === PATHS.register || path.startsWith("/.well-known/"))
    return authorizationServer(ctx.origin).fetch(ctx.request, ctx.env, ctx.exec);
  if (AGENT_PATH.test(path)) return routeAgent(ctx, path);
  // Inbound hooks carry no session: a secret (Zapier) or a signature (webhooks) instead.
  const zapier = ZAPIER_HOOK.exec(path);
  if (zapier) {
    ctx.route = "hook:zapier";
    return receiveZapierEvent(ctx, zapier[1]!);
  }
  const webhook = WEBHOOK_HOOK.exec(path);
  if (webhook) {
    ctx.route = "hook:webhook";
    return receiveWebhook(ctx, webhook[1]!, ctx.request);
  }
  attachContext(ctx.request, ctx);
  return app.fetch(ctx.request, ctx.env, ctx.exec);
}

const ZAPIER_HOOK = /^\/hooks\/zapier\/([A-Za-z0-9_-]{1,64})\/events$/;
const WEBHOOK_HOOK = /^\/hooks\/automations\/([A-Za-z0-9_-]{1,100})$/;

/** Paths the request metric and log line describe by pattern, not by their ids. */
function routeName(path: string): string {
  return path
    .replace(/^\/api\/oauth\/consent\/[^/]+$/, "/api/oauth/consent/:handle")
    .replace(/^\/api\/connections\/[^/]+$/, "/api/connections/:id")
    .replace(/^\/api\/invites\/(?!accept$|join$)[^/]+$/, "/api/invites/:token")
    .replace(/^\/api\/assistant\/conversations\/[^/]+$/, "/api/assistant/conversations/:id")
    .replace(/^\/hooks\/automations\/[^/]+$/, "/hooks/automations/:token")
    .replace(/^\/agents\/([a-z]+)\/[^/]+(\/.*)?$/, "/agents/$1/:name$2")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");
}

/** Points the request at the canonical origin, so OAuth metadata and cookies agree everywhere. */
function canonicalRequest(request: Request, env: Env): Request {
  if (!env.APP_ORIGIN) return request;
  const url = new URL(request.url);
  const canonical = new URL(env.APP_ORIGIN);
  if (url.origin === canonical.origin) return request;
  return new Request(`${canonical.origin}${url.pathname}${url.search}`, request);
}

export default {
  async fetch(incoming: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const ctx = createContext(canonicalRequest(incoming, env), env, exec);
    ctx.route = routeName(ctx.route);
    let response: Response;
    try {
      response = await dispatch(ctx);
    } catch (error) {
      response = await handleError(ctx, error);
    } finally {
      ctx.close();
    }
    // A WebSocket handshake (an agent) is passed through as it is: copying would drop the socket.
    if (response.status !== 101) {
      // Responses from fetch() can be immutable; copy before adding the header.
      response = new Response(response.body, response);
      response.headers.set("x-request-id", ctx.requestId);
    }
    const durationMs = performance.now() - ctx.started;
    const status = response.status;
    const outcome = status >= 500 ? "failure" : status >= 400 ? "expected_error" : "ok";
    recordMetric(
      env,
      {
        organizationId: ctx.organizationId,
        kind: "request",
        name: `${ctx.request.method} ${ctx.route}`,
        outcome,
        version: ctx.version,
        mcpClient: ctx.mcpClient,
        fingerprint: ctx.fingerprint,
        requestId: ctx.requestId,
        durationMs,
        status,
        roundTrips: ctx.roundTrips(),
      },
      ctx.log,
    );
    ctx.log.info("request", {
      method: ctx.request.method,
      route: ctx.route,
      status,
      durationMs: Math.round(durationMs),
      roundTrips: ctx.roundTrips(),
    });
    return response;
  },

  /**
   * Two crons. Every five minutes: due schedules start their automations, and Zapier events whose
   * dispatch didn't finish are retried (`automations`). Daily: accounts and organizations deleted
   * 30+ days ago are removed, with their Durable Objects' storage, then invitations accepted or
   * expired 90+ days ago and expired OAuth records (`cleanup`). One `job` point per run.
   */
  async scheduled(
    controller: ScheduledController,
    env: Env,
    exec: ExecutionContext,
  ): Promise<void> {
    if (controller.cron === AUTOMATIONS_CRON) return runAutomationJobs(env, exec);
    const requestId = uuidv7();
    const version = versionTag(env);
    const log = new Logger({ requestId, version, source: "cron", route: "job:cleanup" });
    const timing = timingRecorder(env, log, () => null);
    const database = new Database(sqlDatabase(env), { onTiming: timing.onTiming });
    const started = performance.now();
    let outcome: "ok" | "failure" = "ok";
    let print: string | null = null;
    try {
      const accounts = new Accounts(database, env.SESSION_PEPPER);
      const removed = await accounts.purgeDeletedAccounts(100, {
        // Their conversations' messages live in Durable Objects: deleted first.
        beforeRemove: async (userId) => {
          await purgeConversationsOf(env, database, userId);
        },
      });
      // Organizations deleted 30+ days ago, Durable Objects first; then old invitations.
      const organizationsRemoved = await accounts.organizations.purgeDeleted(50, {
        beforeRemove: async (organizationId) => {
          await purgeOrganizationAgents(env, database, organizationId);
        },
      });
      const invitesRemoved = await accounts.organizations.purgeInvites();
      const purged = await authorizationServer(
        env.APP_ORIGIN ?? "https://localhost",
      ).purgeExpiredData(env);
      log.info("job.cleanup", {
        accountsRemoved: removed.length,
        organizationsRemoved: organizationsRemoved.length,
        invitesRemoved,
        oauth: purged,
        durationMs: Math.round(performance.now() - started),
      });
    } catch (error) {
      outcome = "failure";
      print = await fingerprint(error, "job:cleanup");
      log.error("job.failed", {
        errorCode: "internal",
        fingerprint: print,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    } finally {
      recordMetric(
        env,
        {
          organizationId: null,
          kind: "job",
          name: "cleanup",
          outcome,
          errorCode: outcome === "failure" ? "internal" : null,
          version,
          fingerprint: print,
          requestId,
          durationMs: performance.now() - started,
          roundTrips: timing.roundTrips(),
        },
        log,
      );
      exec.waitUntil(database.close());
    }
  },
} satisfies ExportedHandler<Env>;

/** `wrangler.jsonc`'s second cron. */
const AUTOMATIONS_CRON = "*/5 * * * *";

async function runAutomationJobs(env: Env, exec: ExecutionContext): Promise<void> {
  const ctx = createRuntimeContext(env, {
    source: "cron",
    route: "job:automations",
    waitUntil: (promise) => exec.waitUntil(promise),
  });
  const started = performance.now();
  let outcome: "ok" | "failure" = "ok";
  try {
    const now = new Date();
    const schedules = await dispatchSchedules(ctx, now);
    const zapier = await retryAndPurgeEvents(ctx, now);
    ctx.log.info("job.automations", {
      schedules,
      zapier,
      durationMs: Math.round(performance.now() - started),
    });
  } catch (error) {
    outcome = "failure";
    ctx.log.error("job.failed", {
      errorCode: "internal",
      fingerprint: await fingerprint(error, "job:automations"),
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  } finally {
    recordMetric(
      env,
      {
        organizationId: null,
        kind: "job",
        name: "automations",
        outcome,
        errorCode: outcome === "failure" ? "internal" : null,
        version: ctx.version,
        requestId: ctx.requestId,
        durationMs: performance.now() - started,
        roundTrips: ctx.roundTrips(),
      },
      ctx.log,
    );
    ctx.close();
  }
}
