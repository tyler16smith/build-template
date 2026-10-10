import { z } from "zod";

/**
 * The Assistant and the Automation Builder (`specs/ai.md`): the models they may use, what a turn
 * costs, and the shapes the web app and the agents share.
 */

export const AI_PROVIDERS = ["anthropic", "workers-ai"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export type AiModel = {
  id: string;
  label: string;
  provider: AiProvider;
  /** Reads attached images. */
  vision: boolean;
  /** Takes an effort setting. */
  reasoning: boolean;
  /** US dollars per million tokens, for the cost shown under a reply and the budget. */
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

/** Every model the product knows. `AI_MODELS` (a Worker var) picks which ones are offered. */
export const KNOWN_MODELS: readonly AiModel[] = [
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    provider: "anthropic",
    vision: true,
    reasoning: true,
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 10,
  },
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    provider: "anthropic",
    vision: true,
    reasoning: true,
    inputUsdPerMillion: 4,
    outputUsdPerMillion: 20,
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    provider: "anthropic",
    vision: true,
    reasoning: false,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 5,
  },
  {
    id: "@cf/meta/llama-4-scout-17b-16e-instruct",
    label: "Llama 4 Scout (Workers AI)",
    provider: "workers-ai",
    vision: true,
    reasoning: false,
    inputUsdPerMillion: 0.27,
    outputUsdPerMillion: 0.85,
  },
];

/** Offered when `AI_MODELS` isn't set: the default first. */
export const DEFAULT_MODEL_IDS = [
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-haiku-4-5-20251001",
];

/** With no provider key, the Assistant still works on Workers AI. */
export const WORKERS_AI_FALLBACK_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

export function findModel(id: string): AiModel | undefined {
  return KNOWN_MODELS.find((model) => model.id === id);
}

export function estimateCostUsd(
  model: Pick<AiModel, "inputUsdPerMillion" | "outputUsdPerMillion">,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens * model.inputUsdPerMillion + outputTokens * model.outputUsdPerMillion) / 1_000_000
  );
}

export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

export const AI_LIMITS = {
  /** Model steps in one Assistant turn (each tool round is one). */
  assistantSteps: 8,
  automationBuilderSteps: 14,
  /** A new organization's monthly budget and daily request cap. */
  defaultMonthlyBudgetUsd: 20,
  defaultDailyRequests: 500,
  maxImages: 4,
  conversationsListed: 30,
} as const;

/** Where a model call was made, for `ai_usage`. */
export const AI_SURFACES = ["assistant", "automation_builder", "ai.generate"] as const;
export type AiSurface = (typeof AI_SURFACES)[number];

/** The agent kinds a client can connect to (`/agents/<kind>/<name>`). */
export const AGENT_KINDS = ["assistant", "automation"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** A conversation or automation id in an agent's path: short, URL-safe. */
export const AGENT_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * What a screen tells the Assistant about itself (`useAssistantPageContext`). It's a hint for
 * the prompt, sent as data with each turn: never authorization, never record contents a screen
 * wouldn't show.
 */
export const AssistantPageHint = z.object({
  path: z.string().max(200).default(""),
  title: z.string().max(120).default(""),
  summary: z.string().max(400).optional(),
  selection: z
    .object({ type: z.string().max(40), id: z.string().max(64), name: z.string().max(120) })
    .optional(),
});
export type AssistantPageHint = z.infer<typeof AssistantPageHint>;

export const AiConversation = z.object({
  id: z.string(),
  title: z.string().nullable(),
  updatedAt: z.string(),
});
export type AiConversation = z.infer<typeof AiConversation>;

/** What the web app needs to show the Assistant (`assistant.config`). */
export const AssistantConfig = z.object({
  enabled: z.boolean(),
  models: z.array(
    z.object({ id: z.string(), label: z.string(), vision: z.boolean(), reasoning: z.boolean() }),
  ),
  defaultModel: z.string().nullable(),
});
export type AssistantConfig = z.infer<typeof AssistantConfig>;

/** Usage under a reply: the turn's model, tokens and estimated cost. */
export type TurnUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
};

/** A reply's metadata (the AI SDK's message metadata). */
export type AgentMessageMetadata = {
  startedAt?: string;
  finishedAt?: string;
  usage?: TurnUsage;
  /** Set when a turn's tools changed data, so screens re-read their queries. */
  wrote?: boolean;
};

export const AiSettings = z.object({
  defaultModel: z.string(),
  monthlyBudgetUsd: z.number().min(0).max(100_000),
  dailyRequests: z.number().int().min(0).max(1_000_000),
});
export type AiSettings = z.infer<typeof AiSettings>;

export const AiUsageSummary = z.object({
  monthUsd: z.number(),
  todayRequests: z.number(),
  settings: AiSettings,
});
export type AiUsageSummary = z.infer<typeof AiUsageSummary>;
