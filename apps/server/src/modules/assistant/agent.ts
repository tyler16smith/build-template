import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  AI_LIMITS,
  REASONING_EFFORTS,
  type AgentMessageMetadata,
  type MemberProfile,
  type ReasoningEffort,
} from "@template/contracts";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isStepCount,
  pruneMessages,
  streamText,
  type LanguageModelUsage,
} from "ai";
import type { Connection, ConnectionContext } from "agents";
import type { Env } from "../../env";
import { createRuntimeContext, type RuntimeContext } from "../../lib/context";
import { recordMetric } from "../../lib/metrics";
import { scopeFor } from "../automations/context";
import { authorizeModelCall, recordUsage } from "./budget";
import { estimateFor } from "./core";
import { parseConversationName, touchConversation } from "./conversations";
import { describeModelError } from "./model-errors";
import { languageModel } from "./models";
import { firstUserMessageTitle, readPageHint } from "./page";
import { assistantInstructions } from "./prompt";
import { TurnTimer } from "./timing";
import { assistantTools } from "./tools";

/** The header the Worker sets on a verified agent request: the session's token hash. */
export const AGENT_SESSION_HEADER = "x-agent-session";
const SESSION_KEY = "session";

/** A reply that's only words: a calm message instead of a failure. */
export function textResponse(text: string): Response {
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: ({ writer }) => {
        const id = crypto.randomUUID();
        writer.write({ type: "text-start", id });
        writer.write({ type: "text-delta", id, delta: text });
        writer.write({ type: "text-end", id });
      },
    }),
  });
}

export function sumUsage(steps: { usage: LanguageModelUsage }[]) {
  return steps.reduce(
    (total, step) => ({
      inputTokens: total.inputTokens + (step.usage.inputTokens ?? 0),
      outputTokens: total.outputTokens + (step.usage.outputTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
}

/**
 * Who this agent belongs to, checked at the start of every turn: the Worker's session (by its
 * hash, kept from the last connection) must still be live, for this person in this organization,
 * and they must still be a member. A revoked session or a removed member gets a calm message and
 * no tools.
 */
export async function verifyTurn(
  ctx: RuntimeContext,
  storage: DurableObjectStorage,
  agentName: string,
): Promise<
  | {
      ok: true;
      organizationId: string;
      userId: string;
      conversation: string;
      profile: MemberProfile;
    }
  | { ok: false; message: string }
> {
  const { organizationId, userId, conversation } = parseConversationName(agentName);
  const sessionHash = await storage.get<string>(SESSION_KEY);
  const identity = sessionHash ? await ctx.accounts().sessions.authenticateHash(sessionHash) : null;
  if (!identity || identity.userId !== userId)
    return {
      ok: false,
      message: "Your session has ended. Reload the page and sign in to continue.",
    };
  if (identity.organizationId !== organizationId)
    return {
      ok: false,
      message: "You switched to another company. Reload the page to continue there.",
    };
  const profile = await ctx
    .accounts()
    .profile({ organizationId, userId })
    .catch(() => null);
  if (!profile) return { ok: false, message: "You're no longer a member of this company." };
  return { ok: true, organizationId, userId, conversation, profile };
}

/** Keeps the session hash the Worker verified for this connection, for the per-turn check. */
export async function rememberSession(storage: DurableObjectStorage, request: Request) {
  const hash = request.headers.get(AGENT_SESSION_HEADER);
  if (hash) await storage.put(SESSION_KEY, hash);
}

/**
 * One conversation of one person in one organization (ported from Custombase's `agent.ts`).
 * Named `<organization>:<user>:<conversation>` by the Worker from the session, never from the
 * URL alone. Messages live in this Durable Object's SQLite. Every tool call runs an action
 * in-process as this person.
 */
export class AssistantAgent extends AIChatAgent<Env> {
  override async onConnect(connection: Connection, context: ConnectionContext) {
    await rememberSession(this.ctx.storage, context.request);
    return super.onConnect(connection, context);
  }

  /** Account or conversation deletion: every message goes (`conversations.ts`). */
  async destroyConversation(): Promise<void> {
    await this.destroy();
  }

  override async onChatMessage(
    _onFinish: unknown,
    options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    const timer = new TurnTimer();
    const started = Date.now();
    const { organizationId, userId, conversation } = parseConversationName(this.name);
    const ctx = createRuntimeContext(this.env, {
      source: "agent",
      route: "agent:assistant",
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      organizationId,
      userId,
    });
    let outcome: "ok" | "expected_error" | "failure" = "ok";
    const finish = () => {
      recordMetric(this.env, {
        organizationId,
        kind: "agent",
        name: "assistant",
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
    const { profile } = verified;
    const scope = scopeFor(ctx, { organizationId, userId, role: profile.role }, "agent:assistant");
    const requested = typeof options?.body?.model === "string" ? options.body.model : null;
    const effort = REASONING_EFFORTS.find((e) => e === options?.body?.effort) as
      ReasoningEffort | undefined;
    const page = readPageHint(options?.body);
    const authorization = await authorizeModelCall(scope.db, this.env, requested);
    timer.ready();
    if (!authorization.ok) {
      outcome = "expected_error";
      finish();
      return textResponse(authorization.message);
    }
    const model = authorization.model;
    // The panel's conversation list is bookkeeping: the reply doesn't wait for it.
    this.ctx.waitUntil(
      touchConversation(scope.db, {
        userId,
        id: conversation,
        title: firstUserMessageTitle(this.messages),
      }).catch((error: unknown) => ctx.log.warn("assistant.index_failed", { error })),
    );
    let wrote = false;
    const tools = assistantTools({
      ctx,
      caller: {
        userId,
        organizationId,
        organization: { name: profile.organization.name, slug: profile.organization.slug },
        role: profile.role,
        emailVerified: profile.emailVerified,
      },
      pending: this.ctx.storage,
      timer,
      onWrite: () => {
        wrote = true;
      },
    });
    const settle = async (steps: { usage: LanguageModelUsage }[]) => {
      const usage = sumUsage(steps);
      await recordUsage(scope.db, {
        userId,
        surface: "assistant",
        model: model.id,
        ...usage,
      }).catch((error: unknown) => ctx.log.error("assistant.usage_not_recorded", { error }));
      ctx.log.info("agent.turn", {
        agent: "assistant",
        model: model.id,
        ...usage,
        ...timer.finish(),
      });
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
          surface: "assistant",
          requestId: ctx.requestId,
        }),
        instructions: assistantInstructions({
          appName: this.env.APP_NAME,
          organization: profile.organization.name,
          person: { name: profile.name, role: profile.role },
          now: new Date(),
          page,
        }),
        messages,
        tools,
        ...(effort && model.reasoning ? { reasoning: effort } : {}),
        stopWhen: isStepCount(AI_LIMITS.assistantSteps),
        abortSignal: options?.abortSignal,
        onChunk: () => timer.chunk(),
        onStepStart: () => timer.stepStart(),
        onStepEnd: () => timer.stepEnd(),
        onFinish: ({ steps }) => settle(steps),
        onAbort: ({ steps }) => settle(steps),
      });
      return result.toUIMessageStreamResponse({
        onError: (error) => {
          outcome = "failure";
          ctx.log.error("assistant.model_failed", { model: model.id, error });
          return describeModelError(error, model.label);
        },
        messageMetadata: ({ part }): AgentMessageMetadata | undefined => {
          // Start and finish times let the chat say "Thought for 6s" about past replies too.
          if (part.type === "start") return { startedAt: new Date().toISOString() };
          if (part.type !== "finish") return undefined;
          const inputTokens = part.totalUsage.inputTokens ?? 0;
          const outputTokens = part.totalUsage.outputTokens ?? 0;
          return {
            finishedAt: new Date().toISOString(),
            wrote,
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
      ctx.log.error("assistant.model_failed", { model: model.id, error });
      finish();
      return textResponse(describeModelError(error, model.label));
    }
  }
}
