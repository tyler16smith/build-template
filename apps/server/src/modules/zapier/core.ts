import {
  ActionError,
  zapierInboundPath,
  ZAPIER_LIMITS,
  type AutomationDefinition,
  type ZapierConnectionCreateInput,
  type ZapierConnectionUpdateInput,
  type ZapierConnectionView,
} from "@template/contracts";

/**
 * Zapier connections' rules (`apps/server/AGENTS.md`, "Functional core, imperative shell"): limits,
 * names, which automations use a connection and what a person sees of one. Pure: the shell reads
 * the rows, seals and hashes, and writes.
 */

/** A connection row, as far as the rules look at it. */
type ConnectionRow = {
  id: string;
  direction: "inbound" | "outbound";
  name: string;
  status: ZapierConnectionView["status"];
  hint: string;
  createdBy: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  lastProvider: string | null;
  lastEventType: string | null;
};

export type ConnectionUsage = { any: number; byConnection: Map<string, number> };

/** Whether a definition uses the connection: its trigger, or a `zapier.send` step. */
function uses(definition: AutomationDefinition, connectionId: string): boolean {
  return (
    (definition.trigger.kind === "zapier.event" &&
      definition.trigger.connectionId === connectionId) ||
    JSON.stringify(definition.steps).includes(`"connectionId":"${connectionId}"`)
  );
}

/** How many active automations use each connection, and how many take any inbound one. */
export function connectionUsage(active: { definition: AutomationDefinition }[]): ConnectionUsage {
  let any = 0;
  const byConnection = new Map<string, number>();
  const count = (id: string) => byConnection.set(id, (byConnection.get(id) ?? 0) + 1);
  for (const { definition } of active) {
    const trigger = definition.trigger;
    if (trigger.kind === "zapier.event") {
      if (trigger.connectionId) count(trigger.connectionId);
      else any += 1;
    }
    const sends = JSON.stringify(definition.steps).matchAll(
      /"kind":"zapier\.send","connectionId":"([^"]+)"/g,
    );
    for (const match of sends) count(match[1]!);
  }
  return { any, byConnection };
}

/** A connection as people see it: never its secret or hook URL. */
export function connectionView(
  row: ConnectionRow,
  origin: string,
  names: Map<string, string>,
  used: ConnectionUsage,
): ZapierConnectionView {
  const inbound = row.direction === "inbound";
  return {
    id: row.id,
    direction: row.direction,
    name: row.name,
    status: row.status,
    url: inbound ? `${origin}${zapierInboundPath(row.id)}` : null,
    hint: row.hint,
    createdBy: (row.createdBy && names.get(row.createdBy)) || "Former member",
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastEvent:
      inbound && row.lastUsedAt
        ? { provider: row.lastProvider ?? "", eventType: row.lastEventType ?? "" }
        : null,
    automationCount: (inbound ? used.any : 0) + (used.byConnection.get(row.id) ?? 0),
  };
}

/** A new connection's name and the limit on how many a company has. */
export function newConnection(input: ZapierConnectionCreateInput, existing: number) {
  if (existing >= ZAPIER_LIMITS.maxConnectionsPerOrganization)
    throw new ActionError(
      "conflict",
      `You can have at most ${ZAPIER_LIMITS.maxConnectionsPerOrganization} Zapier connections. Delete one you no longer use.`,
    );
  return {
    name: input.name?.trim() || (input.direction === "inbound" ? "Zapier events" : "Zapier hook"),
  };
}

/** The last characters of an outbound hook's URL, to tell hooks apart without showing them. */
export function hookHint(url: string): string {
  return url.replace(/\/$/, "").slice(-6);
}

/** A rename or an on/off switch. */
export function connectionChange(input: ZapierConnectionUpdateInput, now: Date) {
  return {
    ...(input.name ? { name: input.name } : {}),
    ...(input.status ? { status: input.status } : {}),
    updatedAt: now,
  };
}

/** Secrets are inbound; test sends are outbound. */
export function ensureDirection(
  row: { direction: "inbound" | "outbound" },
  direction: "inbound" | "outbound",
) {
  if (row.direction !== direction)
    throw new ActionError(
      "conflict",
      direction === "inbound"
        ? "Only inbound connections have a secret."
        : "Test sends are for outbound hooks.",
    );
}

/**
 * Deleting a connection: the active automations that use it fail with a reason, so nothing
 * silently waits for events that will never come.
 */
export function deletion(
  connection: { id: string; name: string },
  active: { id: string; definition: AutomationDefinition }[],
  now: Date,
) {
  return {
    stopped: active.filter((a) => uses(a.definition, connection.id)).map((a) => a.id),
    change: {
      status: "failed" as const,
      statusReason: `The Zapier connection “${connection.name}” was deleted. Choose another and publish again.`,
      updatedAt: now,
    },
  };
}

/** What Zapier's answer to a test send means for the person: its status when it accepted. */
export function testSendOutcome(status: number | null): number {
  if (status === null)
    throw new ActionError("conflict", "Zapier couldn't be reached. Try again in a moment.");
  if (status < 200 || status >= 300)
    throw new ActionError(
      "conflict",
      `Zapier answered ${status}. Check that the Zap's Catch Hook URL is the one saved here.`,
    );
  return status;
}
