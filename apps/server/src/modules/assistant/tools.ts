import { ActionError, ALL_SCOPES, toolName } from "@template/contracts";
import { jsonSchema, tool, type ToolSet } from "ai";
import type { VerifiedCaller } from "../../actions/define";
import { runAction } from "../../actions/registry";
import type { RuntimeContext } from "../../lib/context";
import { actionSchemas, usableActions } from "../automations/catalog";
import {
  confirmationReply,
  isPending,
  pendingKey,
  rememberPending,
  type PendingStore,
} from "./bulk-confirmation";
import type { TurnTimer } from "./timing";

function describeFailure(error: ActionError): string {
  if (error.code === "forbidden") return `Not allowed: ${error.message}`;
  if (error.code === "not_found") return `Not found: ${error.message}`;
  if (error.code === "invalid_input") return `The input was not accepted: ${error.message}`;
  if (error.code === "conflict") return `Conflict: ${error.message}`;
  return error.message;
}

export type AssistantToolsOptions = {
  ctx: RuntimeContext;
  /** The person, verified this turn. */
  caller: Omit<VerifiedCaller, "caller" | "scopes">;
  /** Where stopped writes wait for the model to ask again (the Durable Object's storage). */
  pending: PendingStore;
  timer?: TurnTimer;
  /** Called after a write succeeds, so the reply can tell the screens to re-read. */
  onWrite?: (actionId: string) => void;
};

/**
 * The Assistant's tools: the action registry, as MCP's `tools/list` sees it, filtered to the
 * person's role. A new action shows up here with no extra code. Each call runs the action
 * in-process with a fresh `ActionContext` (`caller: "assistant"`), so validation, permissions,
 * row-level security, logs and metrics are those of a web call. Actions marked `confirm` always
 * ask first; any write asks again after `confirmation_required` stopped it.
 */
export function assistantTools(options: AssistantToolsOptions): ToolSet {
  const { ctx, caller, pending, timer } = options;
  const tools: ToolSet = {};
  for (const action of usableActions(caller.role)) {
    tools[toolName(action.id)] = tool({
      description: `${action.title}. ${action.description}`,
      inputSchema: jsonSchema(actionSchemas(action).input as Parameters<typeof jsonSchema>[0]),
      needsApproval: async (input: unknown) =>
        Boolean(action.confirm) ||
        (!action.readOnly && (await isPending(pending, await pendingKey(action.id, input)))),
      execute: async (input: unknown) => {
        const key = action.readOnly ? null : await pendingKey(action.id, input);
        // Pending means the person just approved this exact call after it was stopped.
        const approvedAgain = key ? await isPending(pending, key) : false;
        const run = () =>
          runAction(ctx, action, input, {
            ...caller,
            scopes: ALL_SCOPES,
            caller: "assistant",
            confirmed: Boolean(action.confirm) || approvedAgain,
          });
        try {
          const output = await (timer ? timer.tool(action.id, run) : run());
          if (key && approvedAgain) await pending.delete(key);
          if (!action.readOnly) options.onWrite?.(action.id);
          return output;
        } catch (error) {
          if (!(error instanceof ActionError)) throw error;
          if (error.code === "confirmation_required" && key) {
            await rememberPending(pending, key);
            return confirmationReply(error.message);
          }
          throw new Error(describeFailure(error));
        }
      },
    });
  }
  return tools;
}
