import { hashToken, randomToken } from "@template/auth";
import { ActionError, AUTOMATION_LIMITS, WEBHOOK_HEADERS } from "@template/contracts";
import { automations, automationWebhooks, eq, NO_ORGANIZATION } from "@template/db";
import type { RuntimeContext } from "../../lib/context";
import { open, seal } from "../../lib/seal";
import { requirePermission } from "../../actions/permissions";
import { currentRole, scopeFor, type Scope } from "./context";
import { startRun, withinRateLimit } from "./dispatch";
import { pinnedDefinition } from "./runs";
import { checkFieldValues } from "./core";
import { getAutomation } from "./service";

/**
 * The webhook trigger: `POST /hooks/automations/<token>`, with a body signed by HMAC-SHA256 of
 * `<timestamp>.<body>` in `X-Webhook-Signature: sha256=<hex>` and the timestamp (Unix seconds,
 * within 5 minutes) in `X-Webhook-Timestamp`, as Custombase. The token in the URL is hashed at
 * rest; the signing secret is sealed, because verifying needs it back.
 */

const TOLERANCE_SECONDS = 300;

type Sealed = { token: string; secret: string };

const context = (organizationId: string, automationId: string) =>
  `webhook:${organizationId}:${automationId}`;

export function hookPath(token: string): string {
  return `/hooks/automations/${token}`;
}

/** Creates the webhook's token and secret the first time an automation is published with one. */
export async function ensureWebhook(scope: Scope, automationId: string): Promise<void> {
  const existing = await scope.db.one((q) =>
    q.first(automationWebhooks, eq(automationWebhooks.automationId, automationId)),
  );
  if (existing) return;
  await createWebhook(scope, automationId);
}

async function createWebhook(scope: Scope, automationId: string): Promise<Sealed> {
  const value: Sealed = { token: randomToken(32), secret: `whsec_${randomToken(32)}` };
  const row = {
    tokenHash: await hashToken(value.token, scope.ctx.env.SESSION_PEPPER),
    sealed: await seal(
      scope.ctx.env.CONNECTION_ENCRYPTION_KEY,
      context(scope.principal.organizationId, automationId),
      value,
    ),
  };
  await scope.db.one((q) =>
    q.drizzle
      .insert(automationWebhooks)
      .values({ organizationId: q.organizationId, automationId, ...row })
      .onConflictDoUpdate({
        target: [automationWebhooks.organizationId, automationWebhooks.automationId],
        set: row,
      }),
  );
  return value;
}

async function opened(scope: Scope, automationId: string): Promise<Sealed | null> {
  const row = await scope.db.one((q) =>
    q.first(automationWebhooks, eq(automationWebhooks.automationId, automationId)),
  );
  if (!row) return null;
  return open<Sealed>(
    scope.ctx.env.CONNECTION_ENCRYPTION_KEY,
    context(scope.principal.organizationId, automationId),
    row.sealed,
  );
}

/** The URL alone, for the automation's page. */
export async function webhookUrl(
  scope: Scope,
  automationId: string,
): Promise<{ url: string } | null> {
  const value = await opened(scope, automationId).catch(() => null);
  return value ? { url: `${scope.ctx.origin}${hookPath(value.token)}` } : null;
}

/** The URL and the signing secret, for a manager setting up the sender. */
export async function webhookSecret(
  scope: Scope,
  automationId: string,
): Promise<{ url: string; secret: string }> {
  requirePermission(scope.principal, "automations.manage");
  await getAutomation(scope, automationId);
  const value = await opened(scope, automationId);
  if (!value)
    throw new ActionError(
      "not_found",
      "Publish this automation with a webhook trigger to get its URL.",
    );
  return { url: `${scope.ctx.origin}${hookPath(value.token)}`, secret: value.secret };
}

/** A new URL and secret; the old ones stop working at once. */
export async function rotateWebhook(
  scope: Scope,
  automationId: string,
): Promise<{ url: string; secret: string }> {
  requirePermission(scope.principal, "automations.manage");
  await getAutomation(scope, automationId);
  const value = await createWebhook(scope, automationId);
  scope.ctx.log.info("automation.webhook_rotated", { automationId });
  return { url: `${scope.ctx.origin}${hookPath(value.token)}`, secret: value.secret };
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2) return null;
  return new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}

export async function signatureValid(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
): Promise<boolean> {
  const bytes = hexToBytes(signature.replace(/^sha256=/, ""));
  if (!bytes) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(`${timestamp}.${body}`));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const reply = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * `POST /hooks/automations/:token`. The token finds the automation (and with it the
 * organization) through the `token_lookup` policy; nothing in the body can choose either.
 */
export async function receiveWebhook(
  ctx: RuntimeContext,
  token: string,
  request: Request,
): Promise<Response> {
  if (request.method !== "POST") return reply(405, { ok: false, error: "Use POST." });
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token))
    return reply(404, { ok: false, error: "Unknown webhook." });
  const tokenHash = await hashToken(token, ctx.env.SESSION_PEPPER);
  const [hook] = await ctx
    .database()
    .one(
      (d) => d.select().from(automationWebhooks).where(eq(automationWebhooks.tokenHash, tokenHash)),
      { "app.organization_id": NO_ORGANIZATION, "app.webhook_token": tokenHash },
      { name: "automation.webhook.lookup" },
    );
  if (!hook) return reply(404, { ok: false, error: "Unknown webhook." });
  const lookup = scopeFor(
    ctx,
    { organizationId: hook.organizationId, userId: NO_ORGANIZATION, role: "member" },
    "automation.webhook",
  );
  const automation = await lookup.db.one((q) =>
    q.first(automations, eq(automations.id, hook.automationId)),
  );
  if (!automation?.activeVersion || !automation.runAsUserId)
    return reply(404, { ok: false, error: "Unknown webhook." });
  const body = await request.text();
  if (body.length > AUTOMATION_LIMITS.maxPayloadBytes)
    return reply(413, { ok: false, error: "Payload too large." });
  const timestamp = request.headers.get(WEBHOOK_HEADERS.timestamp) ?? "";
  const signature = request.headers.get(WEBHOOK_HEADERS.signature) ?? "";
  const { secret } = await open<Sealed>(
    ctx.env.CONNECTION_ENCRYPTION_KEY,
    context(hook.organizationId, hook.automationId),
    hook.sealed,
  );
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (
    !/^\d{9,11}$/.test(timestamp) ||
    age > TOLERANCE_SECONDS ||
    !(await signatureValid(secret, timestamp, body, signature))
  ) {
    ctx.log.info("automation.webhook_refused", { automationId: automation.id });
    return reply(401, { ok: false, error: "Signature or timestamp is invalid." });
  }
  if (automation.status !== "active")
    return reply(409, { ok: false, error: `This automation is ${automation.status}.` });
  let parsed: unknown;
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    return reply(400, { ok: false, error: "The body must be JSON." });
  }
  const role = await currentRole(ctx, hook.organizationId, automation.runAsUserId);
  if (!role) return reply(409, { ok: false, error: "This automation can't run right now." });
  const scope = scopeFor(
    ctx,
    { organizationId: hook.organizationId, userId: automation.runAsUserId, role },
    "automation.webhook",
  );
  const definition = await pinnedDefinition(scope.db, automation.id, automation.activeVersion);
  if (definition.trigger.kind !== "webhook")
    return reply(404, { ok: false, error: "Unknown webhook." });
  const problems = checkFieldValues(
    definition.trigger.fields,
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {},
  );
  if (problems.length) return reply(422, { ok: false, error: problems.join(" ") });
  if (!(await withinRateLimit(scope, automation, definition)))
    return reply(429, { ok: false, error: "Too many runs this hour." });
  const deliveryId =
    (request.headers.get(WEBHOOK_HEADERS.delivery) ?? "").slice(0, 100) ||
    (await sha256Hex(`${timestamp}.${body}`));
  const started = await startRun(scope, {
    automation,
    version: automation.activeVersion,
    definition,
    mode: "live",
    triggerKind: "webhook",
    triggerEventId: `whk:${deliveryId}`,
    triggerPayload: { body: parsed, deliveryId, receivedAt: new Date().toISOString() },
    runAsUserId: automation.runAsUserId,
    startedBy: null,
    chainDepth: 0,
  });
  return reply(202, { ok: true, runId: started.runId, duplicate: started.deduplicated });
}
