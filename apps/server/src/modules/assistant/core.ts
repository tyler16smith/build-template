import {
  ActionError,
  AI_LIMITS,
  estimateCostUsd,
  findModel,
  type AiModel,
  type AiSettings,
  type AiUsageSummary,
  type AssistantConfig,
} from "@template/contracts";

/**
 * The Assistant's rules (`apps/server/AGENTS.md`, "Functional core, imperative shell"): the AI
 * policy's defaults, the budget, what the panel is told and what settings are accepted. Pure:
 * the shell reads the settings, usage and offered models and passes them in.
 */

/** The model the tests run against, so a turn never reaches a provider. */
export const TEST_MODEL: AiModel = {
  id: "test-model",
  label: "Test model",
  provider: "workers-ai",
  vision: false,
  reasoning: false,
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 2,
};

/** The organization's AI policy, with the defaults filled in for what it never set. */
export function withDefaults(
  row: { [K in keyof AiSettings]?: AiSettings[K] | null } | null,
  firstOfferedModel: string | null,
): AiSettings {
  return {
    defaultModel: row?.defaultModel ?? firstOfferedModel ?? "",
    monthlyBudgetUsd: row?.monthlyBudgetUsd ?? AI_LIMITS.defaultMonthlyBudgetUsd,
    dailyRequests: row?.dailyRequests ?? AI_LIMITS.defaultDailyRequests,
  };
}

/** The start of `now`'s month and day, in UTC: where spend and the daily cap reset. */
export function usageWindows(now: Date): { monthStart: Date; dayStart: Date } {
  return {
    monthStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    dayStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
  };
}

export type Authorization = { ok: true; model: AiModel } | { ok: false; message: string };

/**
 * Whether one more model call may go ahead. Over the monthly budget or the daily cap, the person
 * gets a calm message instead of a failure.
 */
export function authorization(model: AiModel | null, usage: AiUsageSummary): Authorization {
  if (!model)
    return {
      ok: false,
      message:
        "AI isn't set up on this deployment yet. Ask whoever runs it to add an Anthropic key or Workers AI.",
    };
  if (usage.monthUsd >= usage.settings.monthlyBudgetUsd)
    return {
      ok: false,
      message: `Your company has used this month's AI budget ($${usage.settings.monthlyBudgetUsd.toFixed(2)}). An owner can raise it, or it resets on the 1st.`,
    };
  if (usage.todayRequests >= usage.settings.dailyRequests)
    return {
      ok: false,
      message: `Your company has made today's ${usage.settings.dailyRequests} AI requests. It resets at midnight UTC.`,
    };
  return { ok: true, model };
}

/** A call's estimated cost; 0 for a model we don't price. */
export function estimateFor(modelId: string, inputTokens: number, outputTokens: number): number {
  const model = findModel(modelId) ?? (modelId === TEST_MODEL.id ? TEST_MODEL : null);
  return model ? estimateCostUsd(model, inputTokens, outputTokens) : 0;
}

/** What the panel needs: whether the Assistant is on, its models and the default. */
export function assistantConfig(
  offered: AiModel[],
  settings: AiSettings,
  testModelEnabled: boolean,
): AssistantConfig {
  return {
    enabled: offered.length > 0 || testModelEnabled,
    models: offered.map(({ id, label, vision, reasoning }) => ({ id, label, vision, reasoning })),
    defaultModel: offered.find((m) => m.id === settings.defaultModel)?.id ?? offered[0]?.id ?? null,
  };
}

/** New settings name a model this deployment offers. */
export function ensureOfferedModel(offered: AiModel[], settings: AiSettings): void {
  if (!offered.some((m) => m.id === settings.defaultModel))
    throw new ActionError("invalid_input", "That model isn't offered here.", {
      defaultModel: "Pick one of the offered models.",
    });
}
