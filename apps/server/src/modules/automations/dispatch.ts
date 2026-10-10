import {
  AUTOMATION_LIMITS,
  evaluateConditions,
  type AutomationDefinition,
} from "@template/contracts";
import {
  and,
  automationRuns,
  automations,
  eq,
  gt,
  inArray,
  type AutomationRow,
} from "@template/db";
import type { ServerAction, VerifiedCaller } from "../../actions/define";
import { createRuntimeContext, type RuntimeContext } from "../../lib/context";
import { scopeFor, type Scope } from "./context";
import { createRunRecord, finishRun, pinnedDefinition, type NewRun } from "./runs";

/**
 * Records a run and starts its Workflow instance. The instance id is the run id; its params
 * carry ids and the trigger payload only. The definition is read from the pinned version inside
 * the Workflow, and no secret is ever a param.
 */
export async function startRun(
  scope: Scope,
  input: NewRun,
): Promise<{ runId: string; deduplicated: boolean }> {
  const { run, deduplicated } = await createRunRecord(scope.db, input);
  if (deduplicated) return { runId: run.id, deduplicated };
  try {
    await scope.ctx.env.AUTOMATION_WORKFLOW.create({
      id: run.id,
      params: {
        organizationId: scope.db.organizationId,
        runId: run.id,
        triggerPayload: input.triggerPayload,
      },
    });
  } catch (error) {
    await finishRun(scope, run.id, {
      status: "failed",
      error: `The run couldn't start: ${error instanceof Error ? error.message : String(error)}`,
    });
    throw error;
  }
  scope.ctx.log.info("automation.run_started", {
    automationId: input.automation.id,
    runId: run.id,
    mode: input.mode,
    trigger: input.triggerKind,
  });
  return { runId: run.id, deduplicated: false };
}

/** Under the automation's runs-per-hour limit (live runs only). */
export async function withinRateLimit(
  scope: Scope,
  automation: Pick<AutomationRow, "id">,
  definition: AutomationDefinition,
): Promise<boolean> {
  const since = new Date(Date.now() - 3_600_000);
  const runs = await scope.db.one((q) =>
    q.count(
      automationRuns,
      and(
        eq(automationRuns.automationId, automation.id),
        eq(automationRuns.mode, "live"),
        gt(automationRuns.createdAt, since),
      ),
    ),
  );
  return runs < definition.settings.maxRunsPerHour;
}

/** The trigger payload of an action event: what happened, to what, and who did it. */
export type EventPayload = {
  event: string;
  data: unknown;
  input: unknown;
  actor: { id: string; name: string };
  caller: string;
};

/**
 * Starts the active automations listening for a successful action's events. Runs in
 * `waitUntil` after the action returned: a failure here is logged and never fails the action.
 * An automation's own writes don't start it again, and chains stop at `maxChainDepth`.
 */
export async function dispatchActionEvents(
  parent: RuntimeContext,
  input: {
    action: ServerAction;
    input: unknown;
    output: unknown;
    caller: VerifiedCaller;
    /** Only these events (`emitEvent`); otherwise every event that isn't `manual`. */
    only?: string[];
  },
): Promise<string[]> {
  const { action, caller } = input;
  const depth = caller.automation ? caller.automation.depth + 1 : 0;
  const events = (action.events ?? []).filter((event) =>
    input.only ? input.only.includes(event.id) : !event.manual,
  );
  if (depth > AUTOMATION_LIMITS.maxChainDepth || !events.length) return [];
  // Its own connection: the request that ran the action may already be closing its own.
  const ctx = createRuntimeContext(parent.env, {
    source: "server",
    route: "automation.dispatch",
    waitUntil: (promise) => parent.waitUntil(promise),
    organizationId: caller.organizationId,
    userId: caller.userId,
  });
  const scope = scopeFor(
    ctx,
    { organizationId: caller.organizationId, userId: caller.userId, role: caller.role },
    "automation.dispatch",
  );
  const started: string[] = [];
  try {
    const keys = events.map((event) => `app.event:${event.id}`);
    const listeners = await scope.db.one((q) =>
      q.select(automations, {
        where: and(inArray(automations.triggerKey, keys), eq(automations.status, "active")),
        limit: AUTOMATION_LIMITS.maxAutomationsPerEvent,
      }),
    );
    const eligible = listeners.filter(
      (a) => a.id !== caller.automation?.automationId && a.activeVersion && a.runAsUserId,
    );
    if (eligible.length === 0) return [];
    const actor = (await ctx.accounts().members(scope.db)).find((m) => m.id === caller.userId);
    for (const automation of eligible) {
      for (const event of events) {
        if (automation.triggerKey !== `app.event:${event.id}`) continue;
        try {
          const payload: EventPayload = {
            event: event.id,
            data: input.output,
            input: input.input,
            actor: { id: caller.userId, name: actor?.name ?? "" },
            caller: caller.caller,
          };
          const runId = await startListener(scope, automation, payload, depth);
          if (runId) started.push(runId);
        } catch (error) {
          ctx.log.error("automation.dispatch_failed", {
            automationId: automation.id,
            event: event.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  } finally {
    ctx.close();
  }
  return started;
}

async function startListener(
  scope: Scope,
  automation: AutomationRow,
  payload: EventPayload,
  depth: number,
): Promise<string | null> {
  const definition = await pinnedDefinition(scope.db, automation.id, automation.activeVersion!);
  const trigger = definition.trigger;
  if (trigger.kind !== "app.event") return null;
  const at = { trigger: payload, steps: {}, run: { id: "", startedAt: new Date().toISOString() } };
  if (!evaluateConditions(trigger.when, at)) return null;
  if (JSON.stringify(payload).length > AUTOMATION_LIMITS.maxPayloadBytes) {
    scope.ctx.log.warn("automation.skipped", { automationId: automation.id, reason: "payload" });
    return null;
  }
  if (!(await withinRateLimit(scope, automation, definition))) {
    scope.ctx.log.warn("automation.rate_limited", { automationId: automation.id });
    return null;
  }
  const { runId } = await startRun(scope, {
    automation,
    version: automation.activeVersion!,
    definition,
    mode: "live",
    triggerKind: "app.event",
    // A fresh id per occurrence: every successful call is its own event.
    triggerEventId: `evt:${crypto.randomUUID()}`,
    triggerPayload: payload,
    runAsUserId: automation.runAsUserId!,
    startedBy: null,
    chainDepth: depth,
  });
  return runId;
}

/**
 * Emits a `manual` event (one that happens outside its action's call: `members.joined` when an
 * invitation is accepted) to the automations listening for it, as `caller`. Never throws.
 */
export async function emitEvent(
  ctx: RuntimeContext,
  input: { eventId: string; data: unknown; caller: VerifiedCaller },
): Promise<void> {
  const { REGISTRY } = await import("../../actions/registry");
  const action = Object.values(REGISTRY).find((a) =>
    a.events?.some((event) => event.id === input.eventId),
  );
  if (!action) return;
  await dispatchActionEvents(ctx, {
    action,
    input: {},
    output: input.data,
    caller: input.caller,
    only: [input.eventId],
  }).catch((error: unknown) =>
    ctx.log.error("automation.dispatch_failed", {
      event: input.eventId,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}
