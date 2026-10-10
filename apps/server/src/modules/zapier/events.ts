import {
  ActionError,
  AUTOMATION_LIMITS,
  evaluateConditions,
  normalizeZapierBody,
  uuidv7,
  valuePaths,
  zapierTriggerKeys,
  ZAPIER_LIMITS,
  type AutomationDefinition,
  type NormalizedZapierEvent,
  type SeenZapierEvent,
  type ZapierEvent,
  type ZapierEventRun,
  type ZapierEventView,
} from "@template/contracts";
import {
  and,
  automations,
  desc,
  eq,
  gt,
  increment,
  inArray,
  lt,
  NO_ORGANIZATION,
  zapierConnections,
  zapierEvents,
  type AutomationRow,
  type TenantDb,
  type ZapierConnectionRow,
  type ZapierEventRow,
} from "@template/db";
import type { RuntimeContext } from "../../lib/context";
import { can, requirePermission } from "../../actions/permissions";
import { currentRole, scopeFor, type Scope } from "../automations/context";
import { startRun, withinRateLimit } from "../automations/dispatch";
import { redact } from "../automations/redact";
import { pinnedDefinition } from "../automations/runs";
import { getConnection } from "./connections";

/**
 * The transport-independent half of inbound Zapier events (ported from Custombase's
 * `integrations/events.ts`): record a normalized event once, then start the automations
 * listening for it. Dispatch runs after the response, and the five-minute cron retries events
 * whose dispatch didn't finish; runs are keyed `zap:<event id>` per automation, so a retry never
 * starts a second one.
 */

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type IngestResult = { eventId: string; duplicate: boolean; payload: ZapierEvent };

/**
 * Records one event for a verified connection. A repeat (same idempotency key on this
 * connection) only bumps its delivery count. The organization is always the connection's.
 */
export async function ingestEvent(
  db: TenantDb,
  input: {
    connection: ZapierConnectionRow;
    event: NormalizedZapierEvent;
    /** Hashed for the idempotency key when the event names no id of its own. */
    rawBody: string;
    receivedAt: Date;
    test?: boolean;
  },
): Promise<IngestResult> {
  const { connection, event } = input;
  const id = uuidv7();
  const seed = input.test ? `test|${id}` : (event.idempotencySeed ?? `body|${input.rawBody}`);
  const idempotencyKey = await sha256Hex(seed);
  const payload: ZapierEvent = {
    id,
    provider: event.provider,
    eventType: event.eventType,
    organizationId: connection.organizationId,
    connectionId: connection.id,
    connectionName: connection.name,
    ...(event.externalId ? { externalId: event.externalId } : {}),
    occurredAt: event.occurredAt,
    receivedAt: input.receivedAt.toISOString(),
    data: event.data,
  };
  const [row] = await db.one((q) =>
    q.drizzle
      .insert(zapierEvents)
      .values({
        organizationId: q.organizationId,
        id,
        connectionId: connection.id,
        provider: event.provider,
        eventType: event.eventType,
        externalId: event.externalId,
        occurredAt: new Date(event.occurredAt),
        receivedAt: input.receivedAt,
        idempotencyKey,
        status: input.test ? "test" : "received",
        test: Boolean(input.test),
        payload,
      })
      .onConflictDoUpdate({
        target: [
          zapierEvents.organizationId,
          zapierEvents.connectionId,
          zapierEvents.idempotencyKey,
        ],
        set: { deliveries: increment(zapierEvents.deliveries) },
      })
      .returning({ id: zapierEvents.id, payload: zapierEvents.payload }),
  );
  const duplicate = row!.id !== id;
  if (!input.test && !duplicate)
    await db.one((q) =>
      q.update(
        zapierConnections,
        {
          lastUsedAt: input.receivedAt,
          lastProvider: event.provider,
          lastEventType: event.eventType,
        },
        eq(zapierConnections.id, connection.id),
      ),
    );
  return { eventId: row!.id, duplicate, payload: duplicate ? row!.payload : payload };
}

type Listener = { automation: AutomationRow; definition: AutomationDefinition };

/** Active automations whose published trigger this event satisfies, conditions included. */
async function matchingListeners(db: TenantDb, payload: ZapierEvent): Promise<Listener[]> {
  const candidates = await db.one((q) =>
    q.select(automations, {
      where: and(
        inArray(automations.triggerKey, zapierTriggerKeys(payload.provider, payload.eventType)),
        eq(automations.status, "active"),
      ),
      limit: AUTOMATION_LIMITS.maxAutomationsPerEvent,
    }),
  );
  const at = { trigger: payload, steps: {}, run: { id: "", startedAt: new Date().toISOString() } };
  const out: Listener[] = [];
  for (const automation of candidates) {
    if (!automation.activeVersion || !automation.runAsUserId) continue;
    const definition = await pinnedDefinition(db, automation.id, automation.activeVersion);
    const trigger = definition.trigger;
    if (trigger.kind !== "zapier.event") continue;
    if (trigger.connectionId && trigger.connectionId !== payload.connectionId) continue;
    if (trigger.provider && trigger.provider !== payload.provider) continue;
    if (trigger.eventType && trigger.eventType !== payload.eventType) continue;
    if (!evaluateConditions(trigger.when, at)) continue;
    out.push({ automation, definition });
  }
  return out;
}

/**
 * Starts a run of every automation listening for this event, each as its own run-as person.
 * Safe to call again for the same event: runs already started are found, not repeated.
 */
export async function dispatchEvent(
  ctx: RuntimeContext,
  organizationId: string,
  eventId: string,
): Promise<ZapierEventRun[]> {
  const lookup = scopeFor(
    ctx,
    { organizationId, userId: NO_ORGANIZATION, role: "member" },
    "zapier.dispatch",
  );
  const row = await lookup.db.one((q) => q.first(zapierEvents, eq(zapierEvents.id, eventId)));
  if (!row || row.test || (row.status !== "received" && row.status !== "failed")) return [];
  const payload = row.payload;
  const runs: ZapierEventRun[] = [];
  const failures: string[] = [];
  let listeners: Listener[] = [];
  try {
    listeners = await matchingListeners(lookup.db, payload);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  for (const { automation, definition } of listeners) {
    try {
      const role = await currentRole(ctx, organizationId, automation.runAsUserId!);
      if (!role) continue;
      const scope = scopeFor(
        ctx,
        { organizationId, userId: automation.runAsUserId!, role },
        "zapier.dispatch",
      );
      if (JSON.stringify(payload).length > AUTOMATION_LIMITS.maxPayloadBytes) continue;
      if (!(await withinRateLimit(scope, automation, definition))) {
        ctx.log.warn("automation.rate_limited", { automationId: automation.id, eventId });
        continue;
      }
      const { runId } = await startRun(scope, {
        automation,
        version: automation.activeVersion!,
        definition,
        mode: "live",
        triggerKind: "zapier.event",
        triggerEventId: `zap:${row.id}`,
        triggerPayload: payload,
        runAsUserId: automation.runAsUserId!,
        startedBy: null,
        chainDepth: 0,
      });
      runs.push({ automationId: automation.id, automationName: automation.name, runId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${automation.name}: ${message}`);
      ctx.log.error("zapier.dispatch_failed", {
        eventId,
        automationId: automation.id,
        error: message,
      });
    }
  }
  const attempts = row.attempts + 1;
  const status = failures.length ? "failed" : runs.length ? "dispatched" : "no_match";
  await lookup.db.one((q) =>
    q.update(
      zapierEvents,
      {
        status,
        attempts,
        runs,
        error: failures.length ? failures.join(" · ").slice(0, 1000) : null,
        processedAt: new Date(),
      },
      eq(zapierEvents.id, row.id),
    ),
  );
  ctx.log.info("zapier.dispatched", {
    connectionId: row.connectionId,
    eventId: row.id,
    result: status,
    runs: runs.length,
    attempts,
  });
  return runs;
}

/**
 * Cron: dispatches events whose handoff never finished (the Worker was evicted before
 * `waitUntil` ran, or a dispatch failed), up to `dispatchAttempts` times within a day, and
 * deletes history older than `historyDays`. Listing across organizations uses the `events_job`
 * policy; each event is then handled as its own organization.
 */
export async function retryAndPurgeEvents(
  ctx: RuntimeContext,
  now: Date,
): Promise<{ retried: number; runs: number; purged: number }> {
  const settled = new Date(now.getTime() - 60_000);
  const oldest = new Date(now.getTime() - 86_400_000);
  const cutoff = new Date(now.getTime() - ZAPIER_LIMITS.historyDays * 86_400_000);
  const job = { "app.organization_id": NO_ORGANIZATION, "app.job": "zapier-events" };
  const [pending, expired] = await ctx.database().batch(
    (d) => [
      d
        .select({ organizationId: zapierEvents.organizationId, id: zapierEvents.id })
        .from(zapierEvents)
        .where(
          and(
            inArray(zapierEvents.status, ["received", "failed"]),
            lt(zapierEvents.receivedAt, settled),
            gt(zapierEvents.receivedAt, oldest),
            lt(zapierEvents.attempts, ZAPIER_LIMITS.dispatchAttempts),
          ),
        )
        .orderBy(zapierEvents.receivedAt)
        .limit(50),
      d
        .select({ organizationId: zapierEvents.organizationId, id: zapierEvents.id })
        .from(zapierEvents)
        .where(lt(zapierEvents.receivedAt, cutoff))
        .limit(500),
    ],
    job,
    { name: "zapier.events.job" },
  );
  let runs = 0;
  for (const { organizationId, id } of pending) {
    try {
      runs += (await dispatchEvent(ctx, organizationId, id)).length;
    } catch (error) {
      ctx.log.error("zapier.retry_failed", { eventId: id, error });
    }
  }
  const byOrganization = new Map<string, string[]>();
  for (const { organizationId, id } of expired)
    byOrganization.set(organizationId, [...(byOrganization.get(organizationId) ?? []), id]);
  for (const [organizationId, ids] of byOrganization) {
    const scope = scopeFor(
      ctx,
      { organizationId, userId: NO_ORGANIZATION, role: "member" },
      "zapier.purge",
    );
    await scope.db.one((q) => q.delete(zapierEvents, inArray(zapierEvents.id, ids)));
  }
  return { retried: pending.length, runs, purged: expired.length };
}

function eventView(row: ZapierEventRow, withData: boolean): ZapierEventView {
  return {
    id: row.id,
    connectionId: row.connectionId,
    provider: row.provider,
    eventType: row.eventType,
    externalId: row.externalId,
    occurredAt: row.occurredAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    status: row.status,
    deliveries: row.deliveries,
    attempts: row.attempts,
    runs: row.runs,
    error: row.error,
    data: withData ? redact(row.payload.data) : null,
  };
}

export async function listEvents(scope: Scope, connectionId: string): Promise<ZapierEventView[]> {
  const connection = await getConnection(scope, connectionId);
  const rows = await scope.db.one((q) =>
    q.select(zapierEvents, {
      where: eq(zapierEvents.connectionId, connection.id),
      orderBy: [desc(zapierEvents.receivedAt)],
      limit: ZAPIER_LIMITS.historyPageSize,
    }),
  );
  return rows.map((row) => eventView(row, can(scope.principal, "automations.manage")));
}

/**
 * "Send test event": the body goes through the same normalizing and recording as a real
 * delivery, and the result says which automations it would start, without starting them. It
 * doesn't count as the Zap having connected.
 */
export async function sendTestEvent(
  scope: Scope,
  connectionId: string,
  body: unknown,
): Promise<ZapierEventView> {
  requirePermission(scope.principal, "automations.manage");
  const connection = await getConnection(scope, connectionId);
  if (connection.direction !== "inbound")
    throw new ActionError("conflict", "Test events are for inbound connections.");
  const receivedAt = new Date();
  const normalized = normalizeZapierBody(body, { receivedAt: receivedAt.toISOString() });
  if (!normalized.ok) throw new ActionError("invalid_input", normalized.error);
  const { eventId, payload } = await ingestEvent(scope.db, {
    connection,
    event: normalized.event,
    rawBody: JSON.stringify(body),
    receivedAt,
    test: true,
  });
  const runs = (await matchingListeners(scope.db, payload)).map(({ automation }) => ({
    automationId: automation.id,
    automationName: automation.name,
    runId: null,
  }));
  const [row] = await scope.db.one((q) =>
    q.update(zapierEvents, { runs, processedAt: new Date() }, eq(zapierEvents.id, eventId)),
  );
  return eventView(row!, true);
}

/**
 * Event types received lately, with the fields their data carried, so the editor's trigger and
 * data picker can offer them. Test events count: sending one shows the editor the fields before
 * the Zap is live.
 */
export async function seenZapierEvents(db: TenantDb): Promise<SeenZapierEvent[]> {
  const rows = await db.one((q) =>
    q.select(zapierEvents, { orderBy: [desc(zapierEvents.receivedAt)], limit: 100 }),
  );
  const seen = new Map<string, SeenZapierEvent>();
  for (const row of rows) {
    const key = `${row.connectionId}|${row.provider}|${row.eventType}`;
    if (seen.has(key) || seen.size >= 20) continue;
    seen.set(key, {
      connectionId: row.connectionId,
      provider: row.provider,
      eventType: row.eventType,
      lastSeenAt: row.receivedAt.toISOString(),
      dataPaths: valuePaths(row.payload.data, "trigger.data").slice(0, 60),
    });
  }
  return [...seen.values()];
}

/** The latest event a Zapier trigger would match: real sample data for simulated tests. */
export async function latestZapierPayload(
  db: TenantDb,
  trigger: Extract<AutomationDefinition["trigger"], { kind: "zapier.event" }>,
): Promise<ZapierEvent | null> {
  const conditions = [
    ...(trigger.connectionId ? [eq(zapierEvents.connectionId, trigger.connectionId)] : []),
    ...(trigger.provider ? [eq(zapierEvents.provider, trigger.provider)] : []),
    ...(trigger.eventType ? [eq(zapierEvents.eventType, trigger.eventType)] : []),
  ];
  const [row] = await db.one((q) =>
    q.select(zapierEvents, {
      where: conditions.length ? and(...conditions) : undefined,
      orderBy: [desc(zapierEvents.receivedAt)],
      limit: 1,
    }),
  );
  return row?.payload ?? null;
}
