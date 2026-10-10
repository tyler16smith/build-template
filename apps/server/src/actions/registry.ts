import {
  ACTIONS,
  ActionError,
  mayRun,
  type ActionContract,
  type ActionId,
  type OrganizationRef,
} from "@template/contracts";
import type { RuntimeContext } from "../lib/context";
import { fingerprint, isExpected, toActionError } from "../lib/errors";
import { dispatchActionEvents } from "../modules/automations/dispatch";
import { recordMetric } from "../lib/metrics";
import { ASSISTANT_ACTIONS } from "../modules/assistant/actions";
import { AUTOMATION_ACTIONS } from "../modules/automations/actions";
import { ORGANIZATION_ACTIONS } from "../modules/organization/actions";
import { getProfile, updateProfile } from "../modules/profile/actions";
import { ZAPIER_ACTIONS } from "../modules/zapier/actions";
import { buildActionContext, type ServerAction, type VerifiedCaller } from "./define";
import { refusal, requireActionPermission } from "./permissions";

/** Every action, by id. A module adds its actions here (and its contracts to `ACTIONS`). */
export const REGISTRY: Record<ActionId, ServerAction> = {
  [getProfile.id]: getProfile as unknown as ServerAction,
  [updateProfile.id]: updateProfile as unknown as ServerAction,
  ...(ORGANIZATION_ACTIONS as unknown as Record<string, ServerAction>),
  ...(AUTOMATION_ACTIONS as unknown as Record<string, ServerAction>),
  ...(ZAPIER_ACTIONS as unknown as Record<string, ServerAction>),
  ...(ASSISTANT_ACTIONS as unknown as Record<string, ServerAction>),
} as Record<ActionId, ServerAction>;

export function findAction(id: string): ServerAction | null {
  return Object.hasOwn(REGISTRY, id) ? REGISTRY[id as ActionId] : null;
}

/** Contracts with no handler, or handlers with no contract: a test keeps this empty. */
export function registryProblems(): string[] {
  const contracts = Object.keys(ACTIONS);
  const handlers = Object.keys(REGISTRY);
  return [
    ...contracts.filter((id) => !handlers.includes(id)).map((id) => `${id} has no handler`),
    ...handlers.filter((id) => !contracts.includes(id)).map((id) => `${id} has no contract`),
  ];
}

export type ActionCaller = VerifiedCaller;

/**
 * The organization's name and slug for `ctx.organization`: from the caller when it already read
 * them (a session, a profile), else one read (an automation step).
 */
async function organizationOf(
  ctx: RuntimeContext,
  caller: VerifiedCaller,
): Promise<OrganizationRef> {
  if (caller.organization) return { id: caller.organizationId, ...caller.organization };
  const row = await ctx.accounts().organizations.get({
    organizationId: caller.organizationId,
    userId: caller.userId,
  });
  return { id: row.id, name: row.name, slug: row.slug };
}

function scopeMessage(action: ActionContract): string {
  return `This connection isn't allowed to ${action.title.toLowerCase()}. Reconnect it and allow ${action.scope}.`;
}

/**
 * Runs an action for a verified caller (the web app, an MCP client, the Assistant or an
 * automation step: every surface goes through here): checks the scope, parses the input, runs the
 * handler, checks the output against the contract, dispatches its events to automations, and
 * records one metric point and one log line. Inputs and outputs are never logged.
 */
export async function runAction(
  ctx: RuntimeContext,
  action: ServerAction,
  rawInput: unknown,
  caller: ActionCaller,
): Promise<unknown> {
  const started = performance.now();
  const log = ctx.log.with({ actionId: action.id });
  let outcome: "ok" | "expected_error" | "failure" = "ok";
  let errorCode: string | null = null;
  try {
    if (!caller.scopes.includes(action.scope))
      throw new ActionError("forbidden", scopeMessage(action));
    // The registry is the authority; screens and tool lists only hide what the caller can't do.
    if (!mayRun(action, caller.role))
      throw new ActionError("forbidden", refusal(action.permission!));
    const parsed = action.input.safeParse(rawInput ?? {});
    if (!parsed.success) throw parsed.error;
    const actionContext = buildActionContext({
      runtime: ctx,
      database: ctx.database(),
      accounts: ctx.accounts(),
      caller,
      organization: await organizationOf(ctx, caller),
      actionId: action.id,
      requestId: ctx.requestId,
      log,
    });
    if (action.permission) await requireActionPermission(actionContext, action.permission);
    const output = action.output.parse(await action.handler(actionContext, parsed.data));
    // Automations listening for the action's events start after it succeeded; dispatch never
    // fails the person's action and doesn't hold its response.
    if (action.events?.length)
      ctx.waitUntil(
        dispatchActionEvents(ctx, {
          action,
          input: parsed.data,
          output,
          caller,
        }),
      );
    return output;
  } catch (error) {
    const actionError = toActionError(error);
    errorCode = actionError.code;
    outcome = isExpected(actionError.code) ? "expected_error" : "failure";
    if (outcome === "failure") ctx.fingerprint ??= await fingerprint(error, action.id);
    throw error;
  } finally {
    const durationMs = performance.now() - started;
    recordMetric(
      ctx.env,
      {
        organizationId: caller.organizationId,
        kind: caller.caller === "mcp" ? "mcp" : "action",
        name: action.id,
        outcome,
        errorCode,
        version: ctx.version,
        mcpClient: ctx.mcpClient,
        fingerprint: ctx.fingerprint,
        requestId: ctx.requestId,
        durationMs,
        roundTrips: ctx.roundTrips(),
      },
      ctx.log,
    );
    if (outcome !== "failure")
      log.info("action", {
        caller: caller.caller,
        durationMs: Math.round(durationMs),
        ...(errorCode ? { errorCode } : {}),
      });
  }
}
