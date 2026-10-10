import { z } from "zod";
import type { SchemaPath } from "./automations";

/**
 * Zapier, the bridge to systems the product has no connector for (`specs/ai.md`, "Zapier"):
 * - **inbound:** a Zap posts one event with Webhooks by Zapier to a connection's URL, with the
 *   connection's secret in a header. It's normalized into a `ZapierEvent` and starts the
 *   automations listening for it.
 * - **outbound:** a `zapier.send` step posts JSON to a saved Catch Hook URL.
 * Ported from Custombase's inbound integrations (`specs/zapier-integration.md` there).
 */
export const ZAPIER_DIRECTIONS = ["inbound", "outbound"] as const;
export type ZapierDirection = (typeof ZAPIER_DIRECTIONS)[number];

export const ZAPIER_CONNECTION_STATUSES = ["active", "disabled"] as const;
export type ZapierConnectionStatus = (typeof ZAPIER_CONNECTION_STATUSES)[number];

export const ZAPIER_LIMITS = {
  /** A JSON body larger than this is refused with 413. Matches automation trigger payloads. */
  maxBodyBytes: 64_000,
  maxConnectionsPerOrganization: 20,
  /** Accepted events per connection per minute, before any automation's own hourly limit. */
  eventsPerMinute: 120,
  /** Dispatch is retried by the five-minute cron until it succeeds or this many attempts fail. */
  dispatchAttempts: 5,
  /** Event history is kept this long. */
  historyDays: 30,
  historyPageSize: 50,
} as const;

/** Webhooks by Zapier sends the connection secret in this header. */
export const ZAPIER_SECRET_HEADER = "x-webhook-secret";
/** Optional: a sender-chosen key that deduplicates deliveries instead of the event's fields. */
export const ZAPIER_IDEMPOTENCY_HEADER = "idempotency-key";

/** `/hooks/zapier/<connectionId>/events`. */
export function zapierInboundPath(connectionId: string): string {
  return `/hooks/zapier/${connectionId}/events`;
}

/** Lowercase words joined by `_`, `.`, `-` (and `:` in event types): `hubspot`, `deal.closed_won`. */
export const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
export const EVENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;

/**
 * A Zapier Catch Hook: `https://hooks.zapier.com/hooks/catch/<account>/<hook>/`. Only that host
 * is accepted for outbound connections. The URL is a credential: sealed at rest, never shown
 * again after it's saved.
 */
export function zapierHookUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "Paste the Catch Hook URL Zapier shows, starting with https://hooks.zapier.com/.";
  }
  if (url.protocol !== "https:" || url.hostname !== "hooks.zapier.com")
    return "Only Zapier Catch Hook URLs (https://hooks.zapier.com/…) can be used.";
  if (!url.pathname.startsWith("/hooks/catch/"))
    return "That isn't a Catch Hook URL. In Zapier, use Webhooks by Zapier → Catch Hook and copy its URL.";
  return null;
}

/** What every inbound delivery becomes, and what a `zapier.event` automation receives. */
export type ZapierEvent = {
  /** Our id for the event. */
  id: string;
  /** Where the event really came from: `hubspot`. Empty when the sender didn't say. */
  provider: string;
  /** `deal.closed_won`. */
  eventType: string;
  /** Always the connection's organization, never a value from the request. */
  organizationId: string;
  connectionId: string;
  connectionName: string;
  externalId?: string;
  occurredAt: string;
  receivedAt: string;
  data: Record<string, unknown>;
};

/** Trigger paths every Zapier event offers, whatever its data holds. */
export const ZAPIER_EVENT_PATHS: SchemaPath[] = [
  { path: "trigger.data", type: "object", description: "Everything the Zap put in data" },
  { path: "trigger.provider", type: "string", description: "Which app sent it, e.g. hubspot" },
  { path: "trigger.eventType", type: "string", description: "e.g. deal.closed_won" },
  { path: "trigger.externalId", type: "string", description: "The record's id in that app" },
  { path: "trigger.occurredAt", type: "string", description: "When it happened" },
  { path: "trigger.receivedAt", type: "string", description: "When it was received" },
  { path: "trigger.connectionName", type: "string" },
  { path: "trigger.id", type: "string", description: "Our id for this event" },
];

/** `HubSpot`, ` Deal Closed Won ` → `deal_closed_won`. Returns "" for anything unusable. */
export function normalizeEventName(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim().toLowerCase().replace(/\s+/g, "_").slice(0, 80);
}

const ENVELOPE_KEYS = new Set([
  "provider",
  "eventType",
  "event_type",
  "externalId",
  "external_id",
  "occurredAt",
  "occurred_at",
  "idempotencyKey",
  "idempotency_key",
  "data",
  // Never trusted from a request: the connection decides these.
  "organizationId",
  "organization_id",
  "connectionId",
  "connection_id",
]);

function pick(body: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (body[key] !== undefined && body[key] !== null) return body[key];
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Zapier with "Unflatten" off sends `data__dealId`; fold those into nested objects. */
function setPath(target: Record<string, unknown>, parts: string[], value: unknown) {
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (!isRecord(node[part])) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
}

export type NormalizedZapierEvent = {
  provider: string;
  eventType: string;
  externalId: string | null;
  occurredAt: string;
  data: Record<string, unknown>;
  /**
   * What identifies this event for deduplication, before hashing. `null` means "use the body":
   * the caller hashes the raw request so identical deliveries collapse.
   */
  idempotencySeed: string | null;
};

/**
 * Reads a sender's JSON into the standard envelope. Lenient on purpose, because people build
 * these by hand in Zapier: snake_case keys work, `data` may be a JSON string, `data__x` keys are
 * folded in, and with no `data` at all every non-envelope key becomes data. An organization or
 * connection id in the body is dropped, never trusted.
 */
export function normalizeZapierBody(
  body: unknown,
  options: { receivedAt: string; idempotencyHeader?: string | null },
): { ok: true; event: NormalizedZapierEvent } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "The body must be a JSON object." };
  const eventType = normalizeEventName(pick(body, "eventType", "event_type"));
  if (!eventType)
    return {
      ok: false,
      error:
        'Add an "eventType" to the body, e.g. "deal.closed_won", so automations can tell events apart.',
    };
  if (!EVENT_TYPE_PATTERN.test(eventType))
    return {
      ok: false,
      error: `"${eventType}" isn't a usable eventType. Use letters, numbers, dots, dashes and underscores, e.g. "deal.closed_won".`,
    };
  const provider = normalizeEventName(pick(body, "provider"));
  if (provider && !PROVIDER_PATTERN.test(provider))
    return {
      ok: false,
      error: `"${provider}" isn't a usable provider. Use a short lowercase name such as "hubspot".`,
    };

  let data: Record<string, unknown>;
  const rawData = body.data;
  if (typeof rawData === "string") {
    try {
      const parsed: unknown = JSON.parse(rawData);
      if (!isRecord(parsed)) throw new Error("not an object");
      data = parsed;
    } catch {
      return { ok: false, error: '"data" must be a JSON object.' };
    }
  } else if (rawData === undefined || rawData === null) {
    data = {};
    for (const [key, value] of Object.entries(body))
      if (!ENVELOPE_KEYS.has(key) && !key.startsWith("data__")) data[key] = value;
  } else if (isRecord(rawData)) {
    data = { ...rawData };
  } else {
    return { ok: false, error: '"data" must be a JSON object.' };
  }
  for (const [key, value] of Object.entries(body))
    if (key.startsWith("data__") && key.length > "data__".length)
      setPath(data, key.slice("data__".length).split("__"), value);

  const externalRaw = pick(body, "externalId", "external_id");
  const externalId =
    typeof externalRaw === "string" || typeof externalRaw === "number"
      ? String(externalRaw).trim().slice(0, 200) || null
      : null;
  const occurredRaw = pick(body, "occurredAt", "occurred_at");
  const occurredText =
    typeof occurredRaw === "string" || typeof occurredRaw === "number"
      ? String(occurredRaw).trim()
      : "";
  const occurredDate = occurredText
    ? new Date(/^\d{9,11}$/.test(occurredText) ? Number(occurredText) * 1000 : occurredText)
    : null;
  const occurredAt =
    occurredDate && !Number.isNaN(occurredDate.getTime())
      ? occurredDate.toISOString()
      : options.receivedAt;

  const explicit = pick(body, "idempotencyKey", "idempotency_key") ?? options.idempotencyHeader;
  const idempotencySeed =
    (typeof explicit === "string" || typeof explicit === "number") && String(explicit).trim()
      ? `key|${String(explicit).trim().slice(0, 200)}`
      : externalId
        ? `fields|${provider}|${eventType}|${externalId}|${occurredText}`
        : null;

  return {
    ok: true,
    event: { provider, eventType, externalId, occurredAt, data, idempotencySeed },
  };
}

/**
 * The trigger key a `zapier.event` automation is stored under. Provider and event type may be
 * left open (`*`), so an event is offered to the four keys `zapierTriggerKeys` lists.
 */
export function zapierTriggerKey(provider: string, eventType: string): string {
  return `zapier.event:${provider || "*"}:${eventType || "*"}`;
}

export function zapierTriggerKeys(provider: string, eventType: string): string[] {
  return [
    ...new Set([
      zapierTriggerKey(provider, eventType),
      zapierTriggerKey(provider, ""),
      zapierTriggerKey("", eventType),
      zapierTriggerKey("", ""),
    ]),
  ];
}

/** Paths into a sample value, for the data picker: `trigger.data.clientName` and so on. */
export function valuePaths(value: unknown, prefix: string, depth = 0): SchemaPath[] {
  if (depth > 4) return [];
  if (Array.isArray(value)) return [{ path: prefix, type: "array" }];
  if (isRecord(value)) {
    const out: SchemaPath[] = depth === 0 ? [] : [{ path: prefix, type: "object" }];
    for (const [key, item] of Object.entries(value).slice(0, 60)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      out.push(...valuePaths(item, `${prefix}.${key}`, depth + 1));
    }
    return out;
  }
  const type =
    value === null
      ? "any"
      : typeof value === "number" || typeof value === "boolean"
        ? typeof value
        : "string";
  return [{ path: prefix, type }];
}

// ---------- API shapes ----------

export type ZapierConnectionView = {
  id: string;
  direction: ZapierDirection;
  name: string;
  status: ZapierConnectionStatus;
  /** Inbound: where the Zap POSTs (holds the connection id, which isn't a secret). */
  url: string | null;
  /** Inbound: the secret's last characters. Outbound: the hook URL's. */
  hint: string;
  createdBy: string;
  createdAt: string;
  /** Inbound: the last real event. Outbound: the last successful send. */
  lastUsedAt: string | null;
  lastEvent: { provider: string; eventType: string } | null;
  /** Active automations that use it (or, inbound, every connection). */
  automationCount: number;
};

export type ZapierEventStatus = "received" | "dispatched" | "no_match" | "failed" | "test";

export type ZapierEventRun = {
  automationId: string;
  automationName: string;
  /** `null` for a test event, which shows what would start without starting it. */
  runId: string | null;
};

export type ZapierEventView = {
  id: string;
  connectionId: string;
  provider: string;
  eventType: string;
  externalId: string | null;
  occurredAt: string;
  receivedAt: string;
  status: ZapierEventStatus;
  /** How many times the sender delivered it; repeats after the first are ignored. */
  deliveries: number;
  attempts: number;
  runs: ZapierEventRun[];
  error: string | null;
  /** The event's data, redacted. Only people who can manage automations see it. */
  data: unknown;
};

export const ZapierConnectionCreateInput = z.discriminatedUnion("direction", [
  z.object({ direction: z.literal("inbound"), name: z.string().trim().max(80).optional() }),
  z.object({
    direction: z.literal("outbound"),
    name: z.string().trim().max(80).optional(),
    url: z
      .string()
      .trim()
      .max(500)
      .refine((v) => zapierHookUrlProblem(v) === null, {
        message:
          "Only Zapier Catch Hook URLs (https://hooks.zapier.com/hooks/catch/…) can be used.",
      }),
  }),
]);
export type ZapierConnectionCreateInput = z.infer<typeof ZapierConnectionCreateInput>;

export const ZapierConnectionUpdateInput = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  status: z.enum(ZAPIER_CONNECTION_STATUSES).optional(),
});
export type ZapierConnectionUpdateInput = z.infer<typeof ZapierConnectionUpdateInput>;

/** A filled-in example body, for "Send test event". */
export const ZAPIER_SAMPLE_EVENT = {
  provider: "huff_and_puff",
  eventType: "stress_test.completed",
  externalId: "stress_test_1",
  data: {
    subject: "Stress test: Straw MVP",
    result: "Blown down after one huff",
    reportedBy: "Wolfgang Huffington",
  },
} as const;

/** What the Zap's POST body should look like, with Zapier's field placeholders. */
export const ZAPIER_BODY_EXAMPLE = {
  provider: "hubspot",
  eventType: "deal.closed_won",
  externalId: "{{deal_id}}",
  occurredAt: "{{closed_at}}",
  data: { dealId: "{{deal_id}}", name: "{{deal_name}}", amount: "{{amount}}" },
} as const;
