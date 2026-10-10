import { createAnthropic } from "@ai-sdk/anthropic";
import {
  DEFAULT_MODEL_IDS,
  findModel,
  WORKERS_AI_FALLBACK_MODEL,
  type AiModel,
  type AiSurface,
} from "@template/contracts";
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { Env } from "../../env";

/**
 * The models this deployment offers: `AI_MODELS` (comma-separated, default first), else the
 * Claude models. Claude needs `ANTHROPIC_API_KEY`; without one, Workers AI.
 */
export function offeredModels(env: Env): AiModel[] {
  const ids = env.AI_MODELS?.split(",")
    .map((id) => id.trim())
    .filter(Boolean) ?? [...DEFAULT_MODEL_IDS];
  const usable = ids
    .map((id) => findModel(id))
    .filter((model): model is AiModel => Boolean(model))
    .filter((model) =>
      model.provider === "anthropic" ? Boolean(env.ANTHROPIC_API_KEY) : Boolean(env.AI),
    );
  if (usable.length) return usable;
  const fallback = findModel(WORKERS_AI_FALLBACK_MODEL);
  return env.AI && fallback ? [fallback] : [];
}

export function aiAvailable(env: Env): boolean {
  return offeredModels(env).length > 0 || testModelEnabled(env);
}

/** Tests drive the agents with a scripted model (`test/ai-model.ts`) instead of a provider. */
export function testModelEnabled(env: Env): boolean {
  return env.ENVIRONMENT === "test";
}

/** The requested model when it's offered, else the organization's default, else the first. */
export function resolveModel(
  env: Env,
  requested: string | null,
  organizationDefault: string | null,
): AiModel | null {
  const offered = offeredModels(env);
  return (
    offered.find((m) => m.id === requested) ??
    offered.find((m) => m.id === organizationDefault) ??
    offered[0] ??
    null
  );
}

export type ModelCallLabels = {
  organizationId: string;
  userId: string | null;
  surface: AiSurface;
  requestId: string;
};

let testModel: ((labels: ModelCallLabels) => LanguageModel) | null = null;

/** Tests only: the model every call uses while `ENVIRONMENT` is `test`. */
export function setTestModel(factory: ((labels: ModelCallLabels) => LanguageModel) | null): void {
  testModel = factory;
}

/**
 * The AI SDK model for one call, through AI Gateway when `AI_GATEWAY_ID` is set. The gateway's
 * metadata names the organization, the surface and the request (ids only), so its logs line up
 * with `ai_usage` and ours.
 */
export async function languageModel(
  env: Env,
  model: AiModel,
  labels: ModelCallLabels,
): Promise<LanguageModel> {
  if (testModelEnabled(env) && testModel) return testModel(labels);
  const metadata = {
    organizationId: labels.organizationId,
    surface: labels.surface,
    requestId: labels.requestId,
  };
  if (model.provider === "anthropic") {
    const gateway =
      env.AI && env.AI_GATEWAY_ID
        ? await env.AI.gateway(env.AI_GATEWAY_ID).getUrl("anthropic")
        : null;
    const anthropic = createAnthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      ...(gateway
        ? {
            baseURL: `${gateway.replace(/\/$/, "")}/v1`,
            headers: { "cf-aig-metadata": JSON.stringify(metadata) },
          }
        : {}),
    });
    return anthropic(model.id);
  }
  if (!env.AI) throw new Error("No Workers AI binding");
  const workersAi = createWorkersAI({
    binding: env.AI,
    ...(env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID, metadata } } : {}),
  });
  return workersAi(model.id as Parameters<typeof workersAi>[0]);
}
