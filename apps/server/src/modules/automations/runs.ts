import {
  ActionError,
  AUTOMATION_LIMITS,
  flattenSteps,
  uuidv7,
  type AutomationDefinition,
  type Role,
  type RunMode,
  type RunStatus,
  type RunView,
  type StepRunStatus,
  type TriggerKind,
} from "@template/contracts";
import {
  and,
  automationApprovals,
  automationRuns,
  automationRunSteps,
  automations,
  automationVersions,
  desc,
  eq,
  inArray,
  increment,
  keepOr,
  type AutomationRow,
  type AutomationRunRow,
  type TenantDb,
} from "@template/db";
import { automationPaused } from "../../lib/emails";
import { iso, type Scope } from "./context";
import { approverAllowed } from "./core";
import { redact, redactMessage } from "./redact";

export async function pinnedDefinition(
  db: TenantDb,
  automationId: string,
  version: number,
): Promise<AutomationDefinition> {
  const row = await db.one((q) =>
    q.first(
      automationVersions,
      and(
        eq(automationVersions.automationId, automationId),
        eq(automationVersions.version, version),
      ),
    ),
  );
  if (!row) throw new ActionError("not_found", `Version ${version} of this automation is missing.`);
  return row.definition;
}

export type NewRun = {
  automation: Pick<AutomationRow, "id">;
  version: number;
  definition: AutomationDefinition;
  mode: RunMode;
  triggerKind: TriggerKind;
  /** Unique per automation: a repeat of the same event finds the run it already started. */
  triggerEventId: string;
  triggerPayload: unknown;
  runAsUserId: string;
  startedBy: string | null;
  chainDepth: number;
};

/** Records a run and one pending row per step, or finds the run this event already started. */
export async function createRunRecord(
  db: TenantDb,
  input: NewRun,
): Promise<{ run: AutomationRunRow; deduplicated: boolean }> {
  const id = uuidv7();
  return db.transaction(async (q) => {
    const inserted = await q.drizzle
      .insert(automationRuns)
      .values({
        organizationId: q.organizationId,
        id,
        automationId: input.automation.id,
        version: input.version,
        mode: input.mode,
        status: "queued",
        triggerKind: input.triggerKind,
        triggerEventId: input.triggerEventId,
        triggerPayload: redact(input.triggerPayload),
        runAsUserId: input.runAsUserId,
        startedBy: input.startedBy,
        chainDepth: input.chainDepth,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted[0]) {
      const existing = await q
        .first(
          automationRuns,
          and(
            eq(automationRuns.automationId, input.automation.id),
            eq(automationRuns.triggerEventId, input.triggerEventId),
          ),
        )
        .execute();
      if (!existing) throw new Error("Run insert conflicted without an existing run");
      return { run: existing, deduplicated: true };
    }
    // One row per step wherever it's nested; a step inside For each keeps its latest item's result.
    const steps = flattenSteps(input.definition.steps).map((f) => f.step);
    if (steps.length)
      await q
        .insert(
          automationRunSteps,
          steps.map((step, position) => ({
            runId: id,
            stepId: step.id,
            position,
            kind: step.kind,
            name: step.name,
            status: "pending" as StepRunStatus,
          })),
        )
        .execute();
    return { run: inserted[0], deduplicated: false };
  }, "automation.run.create");
}

export async function getRun(db: TenantDb, runId: string): Promise<AutomationRunRow> {
  const run = await db.one((q) => q.first(automationRuns, eq(automationRuns.id, runId)));
  if (!run) throw new ActionError("not_found", "That run doesn't exist.");
  return run;
}

export async function markRunStatus(
  db: TenantDb,
  runId: string,
  patch: Partial<Pick<AutomationRunRow, "status" | "currentStepId" | "startedAt" | "error">>,
): Promise<void> {
  await db.one((q) => q.update(automationRuns, patch, eq(automationRuns.id, runId)));
}

export async function recordStepStart(db: TenantDb, runId: string, stepId: string): Promise<void> {
  await db.batch((q) => [
    q.update(
      automationRunSteps,
      {
        status: "running",
        attempts: increment(automationRunSteps.attempts) as unknown as number,
        startedAt: keepOr(automationRunSteps.startedAt, new Date()) as unknown as Date,
        error: null,
      },
      and(eq(automationRunSteps.runId, runId), eq(automationRunSteps.stepId, stepId)),
    ),
    q.update(
      automationRuns,
      { currentStepId: stepId, status: "running" },
      eq(automationRuns.id, runId),
    ),
  ]);
}

export type StepOutcome = {
  status: StepRunStatus;
  input?: unknown;
  output?: unknown;
  simulated?: boolean;
  error?: string | null;
  hint?: string | null;
};

export async function recordStepOutcome(
  db: TenantDb,
  runId: string,
  stepId: string,
  outcome: StepOutcome,
): Promise<void> {
  const finished = !["running", "waiting", "pending"].includes(outcome.status);
  await db.one((q) =>
    q.update(
      automationRunSteps,
      {
        status: outcome.status,
        ...(outcome.input !== undefined ? { input: redact(outcome.input) } : {}),
        ...(outcome.output !== undefined ? { output: redact(outcome.output) } : {}),
        ...(outcome.simulated !== undefined ? { simulated: outcome.simulated } : {}),
        ...(outcome.error !== undefined
          ? { error: outcome.error === null ? null : redactMessage(outcome.error) }
          : {}),
        ...(outcome.hint !== undefined ? { hint: outcome.hint } : {}),
        ...(finished ? { finishedAt: new Date() } : {}),
      },
      and(eq(automationRunSteps.runId, runId), eq(automationRunSteps.stepId, stepId)),
    ),
  );
}

/**
 * Closes a run and updates its automation's health. Live runs that fail
 * `consecutiveFailuresBeforeStop` times in a row pause the automation and email its owner, so a
 * broken mapping doesn't fail on every event.
 */
export async function finishRun(
  scope: Scope,
  runId: string,
  outcome: {
    status: Extract<RunStatus, "succeeded" | "failed" | "rejected" | "cancelled">;
    error?: string | null;
    hint?: string | null;
  },
): Promise<AutomationRunRow> {
  const { db, ctx } = scope;
  const run = await getRun(db, runId);
  if (["succeeded", "failed", "rejected", "cancelled"].includes(run.status)) return run;
  const now = new Date();
  await db.batch((q) => [
    q.update(
      automationRuns,
      {
        status: outcome.status,
        error: outcome.error ? redactMessage(outcome.error) : null,
        fixHint: outcome.hint ?? null,
        finishedAt: now,
      },
      eq(automationRuns.id, runId),
    ),
    q.update(
      automationRunSteps,
      { status: "skipped", finishedAt: now },
      and(eq(automationRunSteps.runId, runId), eq(automationRunSteps.status, "pending")),
    ),
  ]);
  if (run.mode !== "live") return { ...run, status: outcome.status };
  const automation = await db.one((q) =>
    q.first(automations, eq(automations.id, run.automationId)),
  );
  if (!automation) return run;
  const failures = outcome.status === "failed" ? automation.consecutiveFailures + 1 : 0;
  const stop =
    failures >= AUTOMATION_LIMITS.consecutiveFailuresBeforeStop && automation.status === "active";
  const reason = `Paused after ${failures} failed runs in a row. Last error: ${redactMessage(outcome.error ?? "unknown")}`;
  await db.one((q) =>
    q.update(
      automations,
      {
        lastRunAt: now,
        lastRunStatus: outcome.status,
        consecutiveFailures: failures,
        ...(stop ? { status: "paused" as const, statusReason: reason } : {}),
        updatedAt: now,
      },
      eq(automations.id, automation.id),
    ),
  );
  if (stop) {
    ctx.log.warn("automation.paused", { automationId: automation.id, failures });
    const owner = (await ctx.accounts().members(db)).find((m) => m.id === automation.ownerId);
    if (owner)
      await ctx.mailer
        .send(
          automationPaused(
            ctx.env.APP_NAME,
            owner.email,
            automation.name,
            reason,
            `${ctx.origin}/automations/${automation.id}?tab=runs`,
          ),
        )
        .catch((error: unknown) =>
          ctx.log.warn("automation.paused_email_failed", { automationId: automation.id, error }),
        );
  }
  return { ...run, status: outcome.status };
}

/** Run history for people. Step inputs and outputs only for those who manage automations. */
export async function runViews(
  db: TenantDb,
  runs: AutomationRunRow[],
  viewer: { userId: string; role: Role; canSeeData: boolean },
): Promise<RunView[]> {
  if (runs.length === 0) return [];
  const ids = runs.map((r) => r.id);
  const [steps, approvals] = await db.batch((q) => [
    q.select(automationRunSteps, { where: inArray(automationRunSteps.runId, ids) }),
    q.select(automationApprovals, { where: inArray(automationApprovals.runId, ids) }),
  ]);
  return runs.map((run) => ({
    id: run.id,
    automationId: run.automationId,
    version: run.version,
    mode: run.mode,
    status: run.status,
    triggerKind: run.triggerKind,
    currentStepId: run.currentStepId,
    error: run.error,
    fixHint: run.fixHint,
    startedBy: run.startedBy,
    runAsUserId: run.runAsUserId,
    createdAt: run.createdAt.toISOString(),
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.finishedAt),
    steps: [
      {
        stepId: "trigger",
        name: "Trigger",
        kind: "trigger" as const,
        status: "succeeded" as const,
        simulated: run.mode === "simulated",
        attempts: 1,
        input: null,
        output: viewer.canSeeData ? run.triggerPayload : null,
        error: null,
        hint: null,
        startedAt: run.createdAt.toISOString(),
        finishedAt: run.createdAt.toISOString(),
      },
      ...steps
        .filter((s) => s.runId === run.id)
        .sort((a, b) => a.position - b.position)
        .map((s) => ({
          stepId: s.stepId,
          name: s.name,
          kind: s.kind as RunView["steps"][number]["kind"],
          status: s.status,
          simulated: s.simulated,
          attempts: s.attempts,
          input: viewer.canSeeData ? s.input : null,
          output: viewer.canSeeData ? s.output : null,
          error: s.error,
          hint: s.hint,
          startedAt: iso(s.startedAt),
          finishedAt: iso(s.finishedAt),
        })),
    ],
    approvals: approvals
      .filter((a) => a.runId === run.id)
      .map((a) => ({
        id: a.id,
        stepId: a.stepId,
        status: a.status,
        message: a.message,
        decidedBy: a.decidedBy,
        decidedAt: iso(a.decidedAt),
        canDecide: a.status === "pending" && approverAllowed(a.approvers, viewer),
      })),
  }));
}

export async function recentRuns(
  db: TenantDb,
  automationId: string,
  limit = 30,
): Promise<AutomationRunRow[]> {
  return db.one((q) =>
    q.select(automationRuns, {
      where: eq(automationRuns.automationId, automationId),
      orderBy: [desc(automationRuns.createdAt)],
      limit,
    }),
  );
}
