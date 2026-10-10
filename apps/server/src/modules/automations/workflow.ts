import {
  uuidv7,
  type AutomationDefinition,
  type AutomationStep,
  type TemplateScope,
} from "@template/contracts";
import { and, automationApprovals, automations, eq } from "@template/db";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers";
import type { AutomationRunParams, Env } from "../../env";
import { createRuntimeContext } from "../../lib/context";
import { approvalRequested } from "../../lib/emails";
import { fingerprint } from "../../lib/errors";
import { currentRole, scopeFor, type Scope } from "./context";
import {
  executeSteps,
  PLATFORM_STEP,
  RunStopped,
  type ApprovalOutcome,
  type RunEngine,
  type RunFrame,
} from "./executor";
import { approvalMessage, type RunContext } from "./interpreter";
import { redactMessage } from "./redact";
import { approverAllowed } from "./core";
import {
  finishRun,
  getRun,
  markRunStatus,
  pinnedDefinition,
  recordStepOutcome,
  recordStepStart,
} from "./runs";

type Loaded = {
  run: {
    id: string;
    automationId: string;
    runAsUserId: string;
    chainDepth: number;
    startedAt: string;
    mode: string;
  };
  definition: AutomationDefinition;
};

type StepRunner = {
  do(name: string, config: WorkflowStepConfig, work: () => Promise<unknown>): Promise<unknown>;
};

export function approvalEventType(stepId: string): string {
  return `approval_${stepId}`;
}

/**
 * The automation interpreter (ported from Custombase's `AutomationRunWorkflow`). One instance runs
 * one run: it loads the exact version the run pinned, then executes its steps as durable units
 * named after their stable ids, so a replay after a sleep, retry or approval wait takes the same
 * path even if a newer version was published meanwhile. No model is called except by an
 * `ai.generate` step. Every unit acts as the run-as person, through `ctx.db` with the
 * organization's row-level security, exactly as their own request would.
 */
export class AutomationRunWorkflow extends WorkflowEntrypoint<Env, AutomationRunParams> {
  override async run(event: WorkflowEvent<AutomationRunParams>, step: WorkflowStep) {
    const { organizationId, runId, triggerPayload } = event.payload;
    const ctx = createRuntimeContext(this.env, {
      source: "workflow",
      route: "automation.run",
      organizationId,
    });
    /**
     * `step.do` with its result typed. Results cross the step boundary as a JSON string (an
     * object keeps the step's RPC context alive: workerd#6925). Deferred work (events an action
     * step emitted) finishes inside the unit.
     */
    const durable = <T>(name: string, config: WorkflowStepConfig, work: () => Promise<T>) =>
      (step as unknown as StepRunner)
        .do(name, config, async () => {
          const result = await work();
          await ctx.settle();
          return JSON.stringify(result ?? null);
        })
        .then((encoded) => JSON.parse(encoded as string) as T);

    try {
      // The run's own row says who it runs as; until it's loaded, act as nobody in particular.
      const bootstrap = scopeFor(
        ctx,
        { organizationId, userId: uuidv7(), role: "member" },
        "automation.run",
      );
      const loaded = await durable<Loaded | null>("load run", PLATFORM_STEP, async () => {
        const run = await getRun(bootstrap.db, runId);
        if (!["queued", "running", "waiting", "waiting_approval"].includes(run.status)) return null;
        const definition = await pinnedDefinition(bootstrap.db, run.automationId, run.version);
        const startedAt = run.startedAt ?? new Date();
        await markRunStatus(bootstrap.db, runId, { status: "running", startedAt });
        return {
          run: {
            id: run.id,
            automationId: run.automationId,
            runAsUserId: run.runAsUserId,
            chainDepth: run.chainDepth,
            startedAt: startedAt.toISOString(),
            mode: run.mode,
          },
          definition,
        };
      });
      if (!loaded) return { status: "skipped" };

      // Membership and role are rechecked on every run: someone removed can't keep acting here.
      const role = await durable("check run-as access", PLATFORM_STEP, () =>
        currentRole(ctx, organizationId, loaded.run.runAsUserId),
      );
      const scope = scopeFor(
        ctx,
        { organizationId, userId: loaded.run.runAsUserId, role: role ?? "member" },
        "automation.run",
      );
      const context: RunContext = {
        ctx,
        db: scope.db,
        runId,
        organizationId,
        automationId: loaded.run.automationId,
        runAs: { userId: loaded.run.runAsUserId, role: role ?? "member" },
        chainDepth: loaded.run.chainDepth,
        mode: "live",
      };
      const at: TemplateScope = {
        trigger: triggerPayload,
        steps: {},
        run: { id: runId, startedAt: loaded.run.startedAt },
      };
      const frame: RunFrame = { currentStepId: null };
      const engine: RunEngine = {
        simulated: false,
        unit: (name, config, work) => durable(name, config, work),
        sleepUntil: (name, until) => step.sleepUntil(name, until),
        approval: (node, values) => this.approval(step, durable, scope, context, node, values),
      };

      try {
        if (!role) {
          if (loaded.run.mode === "live")
            await durable("stop automation", PLATFORM_STEP, () =>
              scope.db.one((q) =>
                q.update(
                  automations,
                  {
                    status: "failed",
                    statusReason:
                      "The person it runs as is no longer a member. Publish it again as a current member.",
                    updatedAt: new Date(),
                  },
                  and(eq(automations.id, context.automationId), eq(automations.status, "active")),
                ),
              ),
            );
          throw new RunStopped(
            "failed",
            "The person this automation runs as is no longer a member.",
          );
        }
        const outcome = await executeSteps(engine, context, loaded.definition.steps, at, frame);
        await durable("finish", PLATFORM_STEP, () =>
          finishRun(scope, runId, { status: "succeeded" }),
        );
        return outcome === "stopped"
          ? { status: "succeeded", stoppedAt: frame.currentStepId }
          : { status: "succeeded" };
      } catch (error) {
        const status = error instanceof RunStopped ? error.status : "failed";
        const message = redactMessage(error instanceof Error ? error.message : String(error));
        const failedStep = frame.currentStepId;
        await durable("record failure", PLATFORM_STEP, async () => {
          if (failedStep && status === "failed")
            await recordStepOutcome(scope.db, runId, failedStep, {
              status: "failed",
              error: message,
            });
          await finishRun(scope, runId, { status, error: message });
          if (status === "failed" && loaded.run.mode === "live") {
            // Logged once, with a fingerprint, so failing automations group and alert like any
            // other error (`specs/observability.md`, SPEC.md "Observability").
            const where = `automation:${context.automationId}:${failedStep ?? "run"}`;
            ctx.log.error("automation.run_failed", {
              automationId: context.automationId,
              runId,
              stepId: failedStep,
              errorCode: "step_failed",
              fingerprint: await fingerprint(
                Object.assign(new Error(message), { name: "AutomationRunFailed", stack: "" }),
                where,
              ),
              error: message,
            });
          }
        });
        return { status, error: message };
      }
    } finally {
      ctx.close();
      await ctx.settle();
    }
  }

  private async approval(
    step: WorkflowStep,
    durable: <T>(name: string, config: WorkflowStepConfig, work: () => Promise<T>) => Promise<T>,
    scope: Scope,
    context: RunContext,
    node: Extract<AutomationStep, { kind: "approval" }>,
    values: TemplateScope,
  ): Promise<ApprovalOutcome> {
    const { db, ctx } = scope;
    const runId = context.runId;
    const thisApproval = and(
      eq(automationApprovals.runId, runId),
      eq(automationApprovals.stepId, node.id),
    );
    await durable(`approval:${node.id}:request`, PLATFORM_STEP, async () => {
      const message = approvalMessage(node, values);
      const existing = await db.one((q) => q.first(automationApprovals, thisApproval));
      if (!existing)
        await db.one((q) =>
          q.insert(automationApprovals, {
            id: uuidv7(),
            automationId: context.automationId,
            runId,
            stepId: node.id,
            approvers: node.approvers,
            message,
            status: "pending",
            expiresAt: new Date(Date.now() + node.timeoutHours * 3_600_000),
          }),
        );
      await recordStepStart(db, runId, node.id);
      await recordStepOutcome(db, runId, node.id, {
        status: "waiting",
        input: { approvers: node.approvers, message },
      });
      await markRunStatus(db, runId, { status: "waiting_approval", currentStepId: node.id });
      if (existing) return;
      // Approvers are emailed a link; the decision is made in the app.
      const [automation, members] = await Promise.all([
        db.one((q) => q.first(automations, eq(automations.id, context.automationId))),
        ctx.accounts().members(db),
      ]);
      const link = `${ctx.origin}/automations/${context.automationId}?tab=runs&run=${runId}`;
      for (const person of members.filter((m) =>
        approverAllowed(node.approvers, { userId: m.id, role: m.role }),
      ))
        await ctx.mailer
          .send(
            approvalRequested(
              ctx.env.APP_NAME,
              person.email,
              automation?.name ?? "An automation",
              message,
              link,
            ),
          )
          .catch((error: unknown) =>
            ctx.log.warn("automation.approval_email_failed", { runId, error }),
          );
    });

    const decided = await durable(`approval:${node.id}:check`, PLATFORM_STEP, async () => ({
      status:
        (await db.one((q) => q.first(automationApprovals, thisApproval)))?.status ?? "pending",
    }));
    if (decided.status === "pending") {
      try {
        await step.waitForEvent(`approval:${node.id}:wait`, {
          type: approvalEventType(node.id),
          timeout: `${node.timeoutHours} hours`,
        });
      } catch {
        await durable(`approval:${node.id}:expire`, PLATFORM_STEP, () =>
          db.one((q) =>
            q.update(
              automationApprovals,
              { status: "expired" },
              and(thisApproval, eq(automationApprovals.status, "pending")),
            ),
          ),
        );
      }
    }

    // The decision is re-read from Postgres, not taken from the event: only a recorded decision
    // by an allowed approver counts.
    return durable<ApprovalOutcome>(`approval:${node.id}:record`, PLATFORM_STEP, async () => {
      const row = await db.one((q) => q.first(automationApprovals, thisApproval));
      const status =
        row?.status === "approved" || row?.status === "rejected" ? row.status : "expired";
      const outcome: ApprovalOutcome = {
        status,
        decidedBy: row?.decidedBy ?? null,
        note: row?.note ?? null,
      };
      await recordStepOutcome(db, runId, node.id, {
        status: status === "approved" ? "succeeded" : status === "rejected" ? "rejected" : "failed",
        output: {
          approved: status === "approved",
          decidedBy: outcome.decidedBy,
          note: outcome.note,
        },
        ...(status === "expired" ? { error: "No decision before the approval timed out." } : {}),
      });
      if (status === "approved") await markRunStatus(db, runId, { status: "running" });
      return outcome;
    });
  }
}
