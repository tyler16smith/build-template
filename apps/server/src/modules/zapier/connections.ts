import { hashToken, randomToken } from "@template/auth";
import {
  ActionError,
  uuidv7,
  zapierHookUrlProblem,
  type ZapierConnectionCreateInput,
  type ZapierConnectionUpdateInput,
  type ZapierConnectionView,
} from "@template/contracts";
import {
  and,
  asc,
  automations,
  automationVersions,
  eq,
  zapierConnections,
  type ZapierConnectionRow,
} from "@template/db";
import type { Env } from "../../env";
import { open, seal } from "../../lib/seal";
import { requirePermission } from "../../actions/permissions";
import type { Scope } from "../automations/context";
import {
  connectionChange,
  connectionUsage,
  connectionView,
  deletion,
  ensureDirection,
  hookHint,
  newConnection,
  testSendOutcome,
  type ConnectionUsage,
} from "./core";

/**
 * Zapier connections. Inbound: a URL (`/hooks/zapier/<id>/events`) and a secret shown once
 * (only a peppered hash is kept). Outbound: a saved Catch Hook URL, which is a credential, so
 * it's sealed with the organization and connection as additional data and never returned.
 */

const SECRET_PREFIX = "zap_";

const sealContext = (row: Pick<ZapierConnectionRow, "organizationId" | "id">) =>
  `zapier:${row.organizationId}:${row.id}`;

export function hashSecret(env: Env, secret: string): Promise<string> {
  return hashToken(secret, env.SESSION_PEPPER);
}

async function newSecret(env: Env) {
  const secret = `${SECRET_PREFIX}${randomToken(32)}`;
  return { secret, secretHash: await hashSecret(env, secret), hint: secret.slice(-4) };
}

/** The outbound hook's URL, opened only inside the step that posts to it. */
export async function openHookUrl(env: Env, row: ZapierConnectionRow): Promise<string> {
  if (!row.sealedUrl) throw new Error("Not an outbound connection");
  return open<string>(env.CONNECTION_ENCRYPTION_KEY, sealContext(row), row.sealedUrl);
}

export async function getConnection(scope: Scope, id: string): Promise<ZapierConnectionRow> {
  const row = await scope.db.one((q) => q.first(zapierConnections, eq(zapierConnections.id, id)));
  if (!row) throw new ActionError("not_found", "That Zapier connection doesn't exist.");
  return row;
}

/** The active automations' published definitions, for which connections they use. */
async function activeDefinitions(scope: Scope) {
  return scope.db.one((q) =>
    q.drizzle
      .select({ id: automations.id, definition: automationVersions.definition })
      .from(automations)
      .innerJoin(
        automationVersions,
        and(
          eq(automationVersions.organizationId, automations.organizationId),
          eq(automationVersions.automationId, automations.id),
          eq(automationVersions.version, automations.activeVersion),
        ),
      )
      .where(and(q.owned(automations), eq(automations.status, "active"))),
  );
}

async function usage(scope: Scope): Promise<ConnectionUsage> {
  return connectionUsage(await activeDefinitions(scope));
}

export async function listConnections(scope: Scope): Promise<ZapierConnectionView[]> {
  const [rows, members, used] = await Promise.all([
    scope.db.one((q) =>
      q.select(zapierConnections, { orderBy: [asc(zapierConnections.createdAt)] }),
    ),
    scope.ctx.accounts().members(scope.db),
    usage(scope),
  ]);
  const names = new Map(members.map((m) => [m.id, m.name]));
  return rows.map((row) => connectionView(row, scope.ctx.origin, names, used));
}

async function viewOf(scope: Scope, id: string): Promise<ZapierConnectionView> {
  const found = (await listConnections(scope)).find((c) => c.id === id);
  if (!found) throw new ActionError("not_found", "That Zapier connection doesn't exist.");
  return found;
}

/** Creates a connection. An inbound one's secret is returned this once. */
export async function createConnection(
  scope: Scope,
  input: ZapierConnectionCreateInput,
): Promise<{ connection: ZapierConnectionView; secret: string | null }> {
  requirePermission(scope.principal, "automations.manage");
  const existing = await scope.db.one((q) => q.count(zapierConnections));
  const { name } = newConnection(input, existing);
  const id = uuidv7();
  let secret: string | null = null;
  if (input.direction === "inbound") {
    const made = await newSecret(scope.ctx.env);
    secret = made.secret;
    await scope.db.one((q) =>
      q.insert(zapierConnections, {
        id,
        direction: "inbound",
        name,
        secretHash: made.secretHash,
        hint: made.hint,
        createdBy: scope.principal.userId,
      }),
    );
  } else {
    const problem = zapierHookUrlProblem(input.url);
    if (problem) throw new ActionError("invalid_input", problem, { url: problem });
    const url = input.url.trim();
    const sealedUrl = await seal(
      scope.ctx.env.CONNECTION_ENCRYPTION_KEY,
      sealContext({ organizationId: scope.principal.organizationId, id }),
      url,
    );
    await scope.db.one((q) =>
      q.insert(zapierConnections, {
        id,
        direction: "outbound",
        name,
        sealedUrl,
        hint: hookHint(url),
        createdBy: scope.principal.userId,
      }),
    );
  }
  scope.ctx.log.info("zapier.connection_created", { connectionId: id, direction: input.direction });
  return { connection: await viewOf(scope, id), secret };
}

export async function updateConnection(
  scope: Scope,
  id: string,
  input: ZapierConnectionUpdateInput,
): Promise<ZapierConnectionView> {
  requirePermission(scope.principal, "automations.manage");
  await getConnection(scope, id);
  await scope.db.one((q) =>
    q.update(zapierConnections, connectionChange(input, new Date()), eq(zapierConnections.id, id)),
  );
  return viewOf(scope, id);
}

/** A new inbound secret; the old one stops working at once. */
export async function regenerateSecret(
  scope: Scope,
  id: string,
): Promise<{ secret: string; hint: string }> {
  requirePermission(scope.principal, "automations.manage");
  ensureDirection(await getConnection(scope, id), "inbound");
  const { secret, secretHash, hint } = await newSecret(scope.ctx.env);
  await scope.db.one((q) =>
    q.update(
      zapierConnections,
      { secretHash, hint, updatedAt: new Date() },
      eq(zapierConnections.id, id),
    ),
  );
  scope.ctx.log.info("zapier.secret_rotated", { connectionId: id });
  return { secret, hint };
}

/**
 * Deletes a connection and its event history. Active automations that use it fail with a
 * reason, so nothing silently waits for events that will never come.
 */
export async function deleteConnection(
  scope: Scope,
  id: string,
): Promise<{ stoppedAutomations: number }> {
  requirePermission(scope.principal, "automations.manage");
  const [row, active] = await Promise.all([getConnection(scope, id), activeDefinitions(scope)]);
  const { stopped, change } = deletion(row, active, new Date());
  await scope.db.batch((q) => [
    ...stopped.map((automationId) =>
      q.update(
        automations,
        change,
        and(eq(automations.id, automationId), eq(automations.status, "active")),
      ),
    ),
    q.delete(zapierConnections, eq(zapierConnections.id, id)),
  ]);
  scope.ctx.log.info("zapier.connection_deleted", {
    connectionId: id,
    stoppedAutomations: stopped.length,
  });
  return { stoppedAutomations: stopped.length };
}

/**
 * "Send test" on an outbound hook: posts a sample body so the Zap's Catch Hook sees the fields,
 * and counts as the hook working once Zapier accepts it.
 */
export async function sendTestToHook(
  scope: Scope,
  id: string,
  sample: Record<string, unknown>,
): Promise<{ status: number }> {
  requirePermission(scope.principal, "automations.manage");
  const row = await getConnection(scope, id);
  ensureDirection(row, "outbound");
  const response = await fetch(await openHookUrl(scope.ctx.env, row), {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": `test:${uuidv7()}` },
    body: JSON.stringify({ test: true, ...sample }),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  const status = testSendOutcome(response?.status ?? null);
  await scope.db.one((q) =>
    q.update(zapierConnections, { lastUsedAt: new Date() }, eq(zapierConnections.id, id)),
  );
  scope.ctx.log.info("zapier.test_sent", { connectionId: id, status });
  return { status };
}
