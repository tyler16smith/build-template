import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  ActionError,
  AI_LIMITS,
  type AgentMessageMetadata,
  type AutomationBuilderContext,
  type AutomationIssue,
  type RunView,
} from "@template/contracts";
import {
  convertToModelMessages,
  isStepCount,
  jsonSchema,
  pruneMessages,
  streamText,
  tool,
  type LanguageModelUsage,
} from "ai";
import type { Connection, ConnectionContext } from "agents";
import type { Env } from "../../../env";
import { createRuntimeContext } from "../../../lib/context";
import { recordMetric } from "../../../lib/metrics";
import { rememberSession, sumUsage, textResponse, verifyTurn } from "../../assistant/agent";
import { authorizeModelCall, recordUsage } from "../../assistant/budget";
import { estimateFor } from "../../assistant/core";
import { describeModelError } from "../../assistant/model-errors";
import { languageModel } from "../../assistant/models";
import { listConnections } from "../../zapier/connections";
import { inboundSetup, outboundSetup } from "../../zapier/setup";
import { scopeFor, type Scope } from "../context";
import {
  builderContext,
  builderRuns,
  lookupForBuilder,
  saveDraft,
  simulateAutomation,
} from "../service";
import { automationInstructions, describeCatalogEntries, searchCatalog } from "./prompt";

function summarizeRun(run: RunView) {
  return {
    id: run.id,
    mode: run.mode,
    status: run.status,
    version: run.version,
    error: run.error,
    fixHint: run.fixHint,
    createdAt: run.createdAt,
    steps: run.steps.map((s) => ({
      step: s.stepId,
      status: s.status,
      simulated: s.simulated,
      attempts: s.attempts,
      error: s.error,
      hint: s.hint,
      output: s.output,
    })),
  };
}

const NO_INPUT = jsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

/** The Builder's tools, as the person: it edits only the draft, validated like a UI save. */
export function builderTools(scope: Scope, state: { context: AutomationBuilderContext }) {
  const automationId = state.context.automation.id;
  const refresh = async () => (state.context = await builderContext(scope, automationId));
  return {
    get_automation: tool({
      description:
        "Loads the latest draft, its validation issues and its revision. Use after a conflict or when the person says they edited the workflow.",
      inputSchema: NO_INPUT,
      execute: async () => {
        const context = await refresh();
        return {
          revision: context.automation.draftRevision,
          status: context.automation.status,
          draft: context.draft,
          issues: context.issues,
        };
      },
    }),
    save_draft: tool({
      description:
        "Saves the complete automation definition as the new draft. The server validates it; the person sees the change on the workflow with Undo. Doesn't publish.",
      inputSchema: jsonSchema<{ definition: Record<string, unknown>; summary: string }>({
        type: "object",
        properties: {
          definition: {
            type: "object",
            description: "The complete definition in the documented format.",
          },
          summary: {
            type: "string",
            description:
              "One line saying what changed, e.g. 'Added an owner approval before the email'.",
          },
        },
        required: ["definition", "summary"],
        additionalProperties: false,
      }),
      execute: async ({ definition, summary }) => {
        try {
          const saved = await saveDraft(scope, {
            automationId,
            baseRevision: state.context.automation.draftRevision,
            definition,
            summary,
            source: "chat",
          });
          state.context = {
            ...state.context,
            automation: { ...state.context.automation, draftRevision: saved.revision },
            issues: saved.issues,
          };
          return { saved: true, ...saved };
        } catch (error) {
          if (!(error instanceof ActionError)) throw error;
          return {
            saved: false,
            code: error.code,
            message: error.message,
            issues: (error as ActionError & { issues?: AutomationIssue[] }).issues ?? [],
          };
        }
      },
    }),
    simulate: tool({
      description:
        "Runs the current draft with sample data. Lookups run for real; writes, email, AI, Zapier and approvals are simulated. Optionally pass a sample trigger payload.",
      inputSchema: jsonSchema<{ samplePayload?: Record<string, unknown> }>({
        type: "object",
        properties: {
          samplePayload: {
            type: "object",
            description: "Optional trigger payload in the documented shape for this trigger.",
          },
        },
        additionalProperties: false,
      }),
      execute: async ({ samplePayload }) =>
        summarizeRun(await simulateAutomation(scope, { automationId, payload: samplePayload })),
    }),
    recent_runs: tool({
      description:
        "Lists the automation's recent runs with step statuses, errors and fix hints, to explain failures.",
      inputSchema: NO_INPUT,
      execute: async () => (await builderRuns(scope, automationId)).map(summarizeRun),
    }),
    search_catalog: tool({
      description:
        "Finds events, actions, built-in steps and Zapier connections by meaning, e.g. 'profile changed', 'send email'.",
      inputSchema: jsonSchema<{ query: string }>({
        type: "object",
        properties: { query: { type: "string", description: "A few words describing it." } },
        required: ["query"],
        additionalProperties: false,
      }),
      execute: async ({ query }) => searchCatalog(state.context.catalog, query),
    }),
    describe_actions: tool({
      description:
        "Returns the full input schema and output fields of actions, or the payload fields of events, by id. Use before mapping values into a step.",
      inputSchema: jsonSchema<{ ids: string[] }>({
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "Action ids (profile.update) or event ids (profile.updated), up to 8.",
          },
        },
        required: ["ids"],
        additionalProperties: false,
      }),
      execute: async ({ ids }) => describeCatalogEntries(state.context.catalog, ids),
    }),
    lookup: tool({
      description:
        "Runs one read-only action as the person to find real records and ids. Never changes anything.",
      inputSchema: jsonSchema<{ actionId: string; input: Record<string, unknown> }>({
        type: "object",
        properties: {
          actionId: { type: "string", description: "A read action's id." },
          input: { type: "object", description: "Its input, per describe_actions." },
        },
        required: ["actionId", "input"],
        additionalProperties: false,
      }),
      execute: async ({ actionId, input }) => {
        try {
          return { ok: true, ...(await lookupForBuilder(scope, { actionId, input })) };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    }),
    zapier_setup: tool({
      description:
        "Produces the exact Zap the person builds in Zapier for this automation: inbound (another app's event → this automation) or outbound (a zapier.send step → another app). Call it after saving a draft that uses Zapier, and give the person the steps.",
      inputSchema: jsonSchema<{
        direction: "inbound" | "outbound";
        app: string;
        connectionId?: string;
      }>({
        type: "object",
        properties: {
          direction: { type: "string", enum: ["inbound", "outbound"] },
          app: {
            type: "string",
            description: "The other app, as the person named it: HubSpot, Google Sheets…",
          },
          connectionId: {
            type: "string",
            description: "The Zapier connection or hook, if chosen.",
          },
        },
        required: ["direction", "app"],
        additionalProperties: false,
      }),
      execute: async ({ direction, app, connectionId }) => {
        const connections = await listConnections(scope);
        const connection =
          connections.find((c) => c.id === connectionId && c.direction === direction) ??
          connections.find((c) => c.direction === direction) ??
          null;
        return direction === "inbound"
          ? inboundSetup(state.context.draft, connection, app)
          : outboundSetup(state.context.draft, connection, app);
      },
    }),
  };
}

/**
 * One person's conversation about one automation (ported from Custombase's
 * `automation-agent.ts`), named `<organization>:<user>:<automation>` by the Worker from the
 * session. It edits only the draft, through the same service the editor uses; it has no publish
 * tool and never sees secrets.
 */
export class AutomationAgent extends AIChatAgent<Env> {
  /** Organization deletion: the builder conversation's messages go before the rows do. */
  async destroyConversation(): Promise<void> {
    await this.destroy();
  }

  override async onConnect(connection: Connection, context: ConnectionContext) {
    await rememberSession(this.ctx.storage, context.request);
    return super.onConnect(connection, context);
  }

  override async onChatMessage(
    _onFinish: unknown,
    options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    const started = Date.now();
    const ctx = createRuntimeContext(this.env, {
      source: "agent",
      route: "agent:automation",
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
    let outcome: "ok" | "expected_error" | "failure" = "ok";
    let organizationId: string | null = null;
    const finish = () => {
      recordMetric(this.env, {
        organizationId,
        kind: "agent",
        name: "automation_builder",
        outcome,
        version: ctx.version,
        requestId: ctx.requestId,
        durationMs: Date.now() - started,
        roundTrips: ctx.roundTrips(),
      });
      ctx.close();
    };
    const verified = await verifyTurn(ctx, this.ctx.storage, this.name);
    if (!verified.ok) {
      outcome = "expected_error";
      finish();
      return textResponse(verified.message);
    }
    organizationId = verified.organizationId;
    const { userId, profile, conversation: automationId } = verified;
    const scope = scopeFor(ctx, { organizationId, userId, role: profile.role }, "agent:automation");
    const requested = typeof options?.body?.model === "string" ? options.body.model : null;
    const [loaded, authorization] = await Promise.all([
      builderContext(scope, automationId).catch((error: unknown) =>
        error instanceof ActionError ? error : Promise.reject(error),
      ),
      authorizeModelCall(scope.db, this.env, requested),
    ]);
    if (loaded instanceof ActionError) {
      outcome = "expected_error";
      finish();
      return textResponse(loaded.message);
    }
    if (!authorization.ok) {
      outcome = "expected_error";
      finish();
      return textResponse(authorization.message);
    }
    const model = authorization.model;
    const state = { context: loaded };
    const settle = async (steps: { usage: LanguageModelUsage }[]) => {
      const usage = sumUsage(steps);
      await recordUsage(scope.db, {
        userId,
        surface: "automation_builder",
        model: model.id,
        ...usage,
      }).catch((error: unknown) => ctx.log.error("builder.usage_not_recorded", { error }));
      ctx.log.info("agent.turn", { agent: "automation_builder", model: model.id, ...usage });
      finish();
    };
    const messages = pruneMessages({
      messages: await convertToModelMessages(this.messages),
      reasoning: "before-last-message",
      toolCalls: "before-last-2-messages",
    });
    try {
      const result = streamText({
        model: await languageModel(this.env, model, {
          organizationId,
          userId,
          surface: "automation_builder",
          requestId: ctx.requestId,
        }),
        instructions: automationInstructions(loaded, new Date()),
        messages,
        tools: builderTools(scope, state),
        stopWhen: isStepCount(AI_LIMITS.automationBuilderSteps),
        abortSignal: options?.abortSignal,
        onFinish: ({ steps }) => settle(steps),
        onAbort: ({ steps }) => settle(steps),
      });
      return result.toUIMessageStreamResponse({
        onError: (error) => {
          outcome = "failure";
          ctx.log.error("builder.model_failed", { model: model.id, error });
          return describeModelError(error, model.label);
        },
        messageMetadata: ({ part }): AgentMessageMetadata | undefined => {
          if (part.type === "start") return { startedAt: new Date().toISOString() };
          if (part.type !== "finish") return undefined;
          const inputTokens = part.totalUsage.inputTokens ?? 0;
          const outputTokens = part.totalUsage.outputTokens ?? 0;
          return {
            finishedAt: new Date().toISOString(),
            usage: {
              model: model.id,
              inputTokens,
              outputTokens,
              estimatedCostUsd: estimateFor(model.id, inputTokens, outputTokens),
            },
          };
        },
      });
    } catch (error) {
      outcome = "failure";
      ctx.log.error("builder.model_failed", { model: model.id, error });
      finish();
      return textResponse(describeModelError(error, model.label));
    }
  }
}
