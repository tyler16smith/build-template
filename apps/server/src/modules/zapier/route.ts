import {
  isUuid,
  normalizeZapierBody,
  ZAPIER_IDEMPOTENCY_HEADER,
  ZAPIER_LIMITS,
  ZAPIER_SECRET_HEADER,
} from "@template/contracts";
import { and, eq, gt, NO_ORGANIZATION, zapierConnections, zapierEvents } from "@template/db";
import { createRuntimeContext, type RequestContext } from "../../lib/context";
import { scopeFor } from "../automations/context";
import { hashSecret } from "./connections";
import { dispatchEvent, ingestEvent } from "./events";

function reply(status: number, body: Record<string, unknown>, headers: HeadersInit = {}) {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

/** Compares two digests without stopping at the first difference. */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * `POST /hooks/zapier/<connectionId>/events`: Webhooks by Zapier delivers one event per Zap run.
 * No cookies, no session. The connection id finds the connection (through the `inbound_lookup`
 * policy) and with it the organization; nothing in the body can choose either. The
 * `X-Webhook-Secret` header must match the stored hash. The event is recorded once (repeats
 * are acknowledged and ignored), answered with 202 at once, and dispatched after the response.
 * Every delivery logs its outcome, never its body.
 */
export async function receiveZapierEvent(
  ctx: RequestContext,
  connectionId: string,
): Promise<Response> {
  const request = ctx.request;
  const outcome = (result: string, extra: Record<string, unknown> = {}) =>
    ctx.log.info("zapier.delivery", { connectionId, result, ...extra });
  if (request.method !== "POST") return reply(405, { ok: false, error: "Use POST." });
  if (!isUuid(connectionId)) {
    outcome("rejected", { reason: "unknown connection" });
    return reply(404, { ok: false, error: "Unknown connection." });
  }
  // Per-connection overload protection, before any database work.
  if (ctx.env.ZAPIER_LIMIT) {
    const { success } = await ctx.env.ZAPIER_LIMIT.limit({ key: `zapier:${connectionId}` });
    if (!success) {
      outcome("rejected", { reason: "rate limited" });
      return reply(
        429,
        { ok: false, error: "Too many events. Slow down and retry." },
        { "retry-after": "10" },
      );
    }
  }
  if (Number(request.headers.get("content-length") ?? "0") > ZAPIER_LIMITS.maxBodyBytes) {
    outcome("rejected", { reason: "too large" });
    return reply(413, { ok: false, error: "Payload too large (64 KB at most)." });
  }
  const [connection] = await ctx
    .database()
    .one(
      (d) => d.select().from(zapierConnections).where(eq(zapierConnections.id, connectionId)),
      { "app.organization_id": NO_ORGANIZATION, "app.zapier_connection": connectionId },
      { name: "zapier.lookup" },
    );
  if (!connection || connection.direction !== "inbound") {
    outcome("rejected", { reason: "unknown connection" });
    return reply(404, { ok: false, error: "Unknown connection." });
  }
  ctx.identify({ organizationId: connection.organizationId, userId: NO_ORGANIZATION });
  const secret = request.headers.get(ZAPIER_SECRET_HEADER)?.trim() ?? "";
  if (
    !secret ||
    secret.length > 200 ||
    !connection.secretHash ||
    !sameDigest(await hashSecret(ctx.env, secret), connection.secretHash)
  ) {
    outcome("rejected", { reason: secret ? "wrong secret" : "missing secret" });
    return reply(401, {
      ok: false,
      error: `Missing or wrong secret. Send it in the ${ZAPIER_SECRET_HEADER} header.`,
    });
  }
  if (connection.status !== "active") {
    outcome("rejected", { reason: "disabled" });
    return reply(403, {
      ok: false,
      error: "This connection is disabled. Enable it to receive events.",
    });
  }
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).length > ZAPIER_LIMITS.maxBodyBytes) {
    outcome("rejected", { reason: "too large" });
    return reply(413, { ok: false, error: "Payload too large (64 KB at most)." });
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    outcome("rejected", { reason: "not json" });
    return reply(400, {
      ok: false,
      error: "The body must be JSON. In Zapier, set Payload Type to json.",
    });
  }
  const receivedAt = new Date();
  const normalized = normalizeZapierBody(body, {
    receivedAt: receivedAt.toISOString(),
    idempotencyHeader: request.headers.get(ZAPIER_IDEMPOTENCY_HEADER),
  });
  if (!normalized.ok) {
    outcome("rejected", { reason: "invalid envelope" });
    return reply(422, { ok: false, error: normalized.error });
  }
  const scope = scopeFor(
    ctx,
    { organizationId: connection.organizationId, userId: NO_ORGANIZATION, role: "member" },
    "zapier.receive",
  );
  const recent = await scope.db.one((q) =>
    q.count(
      zapierEvents,
      and(
        eq(zapierEvents.connectionId, connection.id),
        gt(zapierEvents.receivedAt, new Date(Date.now() - 60_000)),
      ),
    ),
  );
  if (recent >= ZAPIER_LIMITS.eventsPerMinute) {
    outcome("rejected", { reason: "rate limited" });
    return reply(
      429,
      { ok: false, error: "Too many events this minute. Retry shortly." },
      { "retry-after": "60" },
    );
  }
  const { eventId, duplicate } = await ingestEvent(scope.db, {
    connection,
    event: normalized.event,
    rawBody,
    receivedAt,
  });
  if (duplicate) {
    outcome("duplicate", { eventId });
    return reply(200, { ok: true, eventId, duplicate: true });
  }
  outcome("accepted", { eventId, eventType: normalized.event.eventType });
  // Its own context: this request's connection closes once the response is on its way. If the
  // Worker is evicted first, the event stays `received` and the cron dispatches it.
  const background = createRuntimeContext(ctx.env, {
    source: "server",
    route: "zapier.dispatch",
    waitUntil: (promise) => ctx.waitUntil(promise),
    organizationId: connection.organizationId,
  });
  ctx.waitUntil(
    dispatchEvent(background, connection.organizationId, eventId).finally(() => background.close()),
  );
  return reply(202, { ok: true, eventId });
}
