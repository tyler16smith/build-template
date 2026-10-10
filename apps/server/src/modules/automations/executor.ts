import {
  AUTOMATION_LIMITS,
  DEFAULT_RETRY,
  DEFAULT_STEP_TIMEOUT_SECONDS,
  EFFECTFUL_STEP_KINDS,
  evaluateConditions,
  resolveValue,
  TemplateError,
  type AutomationStep,
  type TemplateScope,
} from "@template/contracts";
import type { WorkflowStepConfig } from "cloudflare:workers";
import { StepFailure } from "./errors";
import { executeStep, type RunContext, type StepResult } from "./interpreter";
import { redactMessage } from "./redact";
import { recordMetric } from "../../lib/metrics";
import { markRunStatus, recordStepOutcome, recordStepStart } from "./runs";

export type ApprovalOutcome = {
  status: "approved" | "rejected" | "expired";
  decidedBy: string | null;
  note: string | null;
};

/**
 * How a run's steps are carried out. The durable engine (the Workflow) persists each unit, sleeps
 * and waits for approvals for real; the simulated engine (a test from the editor) runs the same
 * code inline, skips waits and approves automatically. Unit names are stable per step and loop
 * item, so a replayed Workflow takes the same path.
 */
export interface RunEngine {
  readonly simulated: boolean;
  unit<T>(name: string, config: WorkflowStepConfig, work: () => Promise<T>): Promise<T>;
  sleepUntil(name: string, until: Date): Promise<void>;
  approval(
    node: Extract<AutomationStep, { kind: "approval" }>,
    scope: TemplateScope,
  ): Promise<ApprovalOutcome>;
}

/** Bookkeeping units (recording a step, loading the run): quick, retried a few times. */
export const PLATFORM_STEP: WorkflowStepConfig = {
  retries: { limit: 5, delay: "2 seconds", backoff: "exponential" },
  timeout: "1 minute",
};

export class RunStopped extends Error {
  constructor(
    readonly status: "failed" | "rejected",
    message: string,
  ) {
    super(message);
  }
}

/** A step that must not be retried: returned, not thrown, across the step boundary. */
type StepHalt = { halt: string };

function isStepHalt(value: unknown): value is StepHalt {
  return (
    Boolean(value) && typeof value === "object" && typeof (value as StepHalt).halt === "string"
  );
}

export function stepConfig(node: AutomationStep): WorkflowStepConfig {
  const retry =
    node.retry ??
    (EFFECTFUL_STEP_KINDS.includes(node.kind)
      ? DEFAULT_RETRY
      : { limit: 0, delaySeconds: 1, backoff: "constant" as const });
  return {
    retries: { limit: retry.limit, delay: `${retry.delaySeconds} seconds`, backoff: retry.backoff },
    timeout: `${node.timeoutSeconds ?? DEFAULT_STEP_TIMEOUT_SECONDS} seconds`,
  };
}

/** Mutable run state shared across nested step lists: which step failed, for the record. */
export type RunFrame = { currentStepId: string | null };

type ListOutcome = "done" | "stopped";

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;

function resolveOrFail(value: unknown, scope: TemplateScope, stepName: string): unknown {
  try {
    return resolveValue(value, scope);
  } catch (error) {
    if (error instanceof TemplateError)
      throw new StepFailure(`“${stepName}”: ${error.message}`, {
        retryable: false,
        hint: "Fix this step's mapping in the editor.",
      });
    throw error;
  }
}

/** When a delay step ends, from its amount or its `until` template. */
export function delayEnd(
  node: Extract<AutomationStep, { kind: "delay" }>,
  scope: TemplateScope,
  now: Date,
): Date {
  const max = now.getTime() + AUTOMATION_LIMITS.maxDelayDays * 86_400_000;
  if (node.until) {
    const raw = resolveOrFail(node.until, scope, node.name);
    const at = new Date(String(raw ?? ""));
    if (Number.isNaN(at.getTime()))
      throw new StepFailure(`“${node.name}”: “${String(raw).slice(0, 60)}” isn't a date.`, {
        retryable: false,
        hint: "Map Until to an ISO date and time, e.g. {{trigger.data.dueAt | addDays:-1}}.",
      });
    return new Date(Math.min(Math.max(at.getTime(), now.getTime()), max));
  }
  return new Date(Math.min(now.getTime() + node.amount * UNIT_MS[node.unit], max));
}

/**
 * Runs a list of steps in order. Returns `stopped` when an "Only continue if" step fails: the run
 * ends there, except inside a For each, where only that item's remaining steps are skipped.
 * Failures throw `RunStopped`.
 */
export async function executeSteps(
  engine: RunEngine,
  ctx: RunContext,
  steps: AutomationStep[],
  scope: TemplateScope,
  frame: RunFrame,
  iteration = "",
): Promise<ListOutcome> {
  const db = ctx.db;
  // One `automation` metric point per live step, like any action: duration and outcome.
  const measure = (node: AutomationStep, started: number, outcome: "ok" | "failure") => {
    if (engine.simulated) return;
    recordMetric(ctx.ctx.env, {
      organizationId: ctx.organizationId,
      kind: "automation",
      name: `${ctx.automationId}:${node.id}`,
      outcome,
      errorCode: outcome === "failure" ? "step_failed" : null,
      version: ctx.ctx.version,
      requestId: ctx.runId,
      durationMs: Date.now() - started,
    });
  };
  for (const node of steps) {
    const key = iteration ? `${node.id}@${iteration}` : node.id;
    frame.currentStepId = node.id;
    if (node.runIf && !evaluateConditions(node.runIf, scope)) {
      await engine.unit(`skip:${key}`, PLATFORM_STEP, () =>
        recordStepOutcome(db, ctx.runId, node.id, {
          status: "skipped",
          output: { reason: "Its run-if conditions didn't hold." },
        }),
      );
      continue;
    }

    switch (node.kind) {
      case "approval": {
        const outcome = await engine.approval(node, scope);
        scope.steps[node.id] = {
          output: {
            approved: outcome.status === "approved",
            decidedBy: outcome.decidedBy,
            note: outcome.note,
          },
        };
        if (outcome.status === "rejected")
          throw new RunStopped(
            "rejected",
            `Rejected at “${node.name}”${outcome.note ? `: ${outcome.note}` : "."}`,
          );
        if (outcome.status === "expired")
          throw new RunStopped(
            "failed",
            `Nobody decided “${node.name}” within ${node.timeoutHours} hours.`,
          );
        continue;
      }

      case "delay": {
        const planned = await engine.unit<{ until: string } | StepHalt>(
          `delay:${key}:plan`,
          PLATFORM_STEP,
          async () => {
            await recordStepStart(db, ctx.runId, node.id);
            try {
              const until = delayEnd(node, scope, new Date()).toISOString();
              await recordStepOutcome(db, ctx.runId, node.id, {
                status: engine.simulated ? "simulated" : "waiting",
                simulated: engine.simulated,
                input: { until },
                ...(engine.simulated ? { output: { waitedUntil: until } } : {}),
              });
              if (!engine.simulated)
                await markRunStatus(db, ctx.runId, { status: "waiting", currentStepId: node.id });
              return { until };
            } catch (error) {
              if (error instanceof StepFailure) return { halt: redactMessage(error.message) };
              throw error;
            }
          },
        );
        if (isStepHalt(planned)) throw new RunStopped("failed", planned.halt);
        if (!engine.simulated) {
          await engine.sleepUntil(`delay:${key}`, new Date(planned.until));
          await engine.unit(`delay:${key}:done`, PLATFORM_STEP, async () => {
            await recordStepOutcome(db, ctx.runId, node.id, {
              status: "succeeded",
              output: { waitedUntil: planned.until },
            });
            await markRunStatus(db, ctx.runId, { status: "running" });
          });
        }
        scope.steps[node.id] = { output: { waitedUntil: planned.until } };
        continue;
      }

      case "branch": {
        const passed = await engine.unit(`step:${key}`, PLATFORM_STEP, async () => {
          await recordStepStart(db, ctx.runId, node.id);
          const holds = evaluateConditions(node.conditions, scope, node.match);
          await recordStepOutcome(db, ctx.runId, node.id, {
            status: "succeeded",
            input: { conditions: node.conditions, match: node.match },
            output: { passed: holds, path: holds ? "then" : "otherwise" },
          });
          // The steps on the path not taken are skipped, so the run shows what didn't happen.
          const skipped = holds ? node.else : node.then;
          for (const child of skipped)
            await recordStepOutcome(db, ctx.runId, child.id, {
              status: "skipped",
              output: { reason: holds ? "The conditions held." : "The conditions didn't hold." },
            });
          return holds;
        });
        scope.steps[node.id] = { output: { passed } };
        const outcome = await executeSteps(
          engine,
          ctx,
          passed ? node.then : node.else,
          scope,
          frame,
          iteration,
        );
        if (outcome === "stopped") return "stopped";
        continue;
      }

      case "forEach": {
        const listed = await engine.unit<{ items: unknown[]; total: number } | StepHalt>(
          `step:${key}:items`,
          PLATFORM_STEP,
          async () => {
            await recordStepStart(db, ctx.runId, node.id);
            try {
              const value = resolveOrFail(node.items, scope, node.name);
              const list = Array.isArray(value)
                ? value
                : value === undefined || value === null || value === ""
                  ? []
                  : null;
              if (!list)
                throw new StepFailure(`“${node.name}”: the items aren't a list.`, {
                  retryable: false,
                  hint: "Map Items to a list, e.g. {{steps.find_contacts.output.contacts}}.",
                });
              await recordStepOutcome(db, ctx.runId, node.id, {
                status: "running",
                input: { count: list.length, limit: node.maxItems },
              });
              return { items: list.slice(0, node.maxItems), total: list.length };
            } catch (error) {
              if (error instanceof StepFailure) return { halt: redactMessage(error.message) };
              throw error;
            }
          },
        );
        if (isStepHalt(listed)) throw new RunStopped("failed", listed.halt);
        const results: unknown[] = [];
        const last = node.steps[node.steps.length - 1];
        for (const [index, item] of listed.items.entries()) {
          const itemScope: TemplateScope = {
            ...scope,
            steps: { ...scope.steps },
            loop: { item, index, count: listed.items.length },
          };
          await executeSteps(
            engine,
            ctx,
            node.steps,
            itemScope,
            frame,
            iteration ? `${iteration}.${index}` : String(index),
          );
          if (last) results.push(itemScope.steps[last.id]?.output ?? null);
          frame.currentStepId = node.id;
        }
        const output = {
          count: listed.items.length,
          skipped: listed.total - listed.items.length,
          results,
        };
        await engine.unit(`step:${key}:done`, PLATFORM_STEP, () =>
          recordStepOutcome(db, ctx.runId, node.id, {
            status: "succeeded",
            output,
            ...(output.skipped
              ? {
                  hint: `Only the first ${node.maxItems} of ${listed.total} items ran (the step's limit).`,
                }
              : {}),
          }),
        );
        scope.steps[node.id] = { output };
        continue;
      }

      default: {
        const result = await engine.unit<StepResult | StepHalt>(
          `step:${key}`,
          engine.simulated ? PLATFORM_STEP : stepConfig(node),
          async () => {
            await recordStepStart(db, ctx.runId, node.id);
            const started = Date.now();
            try {
              const outcome = await executeStep(ctx, node, scope, key);
              await recordStepOutcome(db, ctx.runId, node.id, outcome);
              measure(node, started, "ok");
              return outcome;
            } catch (error) {
              measure(node, started, "failure");
              const message = error instanceof Error ? error.message : String(error);
              const hint = error instanceof StepFailure ? error.hint : null;
              await recordStepOutcome(db, ctx.runId, node.id, {
                status: "running",
                error: message,
                hint,
              });
              if (engine.simulated || (error instanceof StepFailure && !error.retryable))
                return { halt: redactMessage(message) };
              throw error;
            }
          },
        );
        if (isStepHalt(result)) throw new RunStopped("failed", result.halt);
        scope.steps[node.id] = { output: result.output };
        if (result.status === "stopped") return "stopped";
      }
    }
  }
  return "done";
}
