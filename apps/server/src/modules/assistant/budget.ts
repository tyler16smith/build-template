import { uuidv7, type AiSettings, type AiSurface, type AiUsageSummary } from "@template/contracts";
import { aiSettings, aiUsage, and, gte, sum, type TenantDb } from "@template/db";
import type { Env } from "../../env";
import {
  authorization,
  estimateFor,
  TEST_MODEL,
  usageWindows,
  withDefaults,
  type Authorization,
} from "./core";
import { offeredModels, resolveModel, testModelEnabled } from "./models";

/** The organization's AI policy, with the defaults filled in. */
export async function settingsFor(db: TenantDb, env: Env): Promise<AiSettings> {
  return withDefaults(await db.one((q) => q.first(aiSettings)), offeredModels(env)[0]?.id ?? null);
}

/** Settings, this month's spend and today's requests, in one round trip. */
export async function usageSummary(db: TenantDb, env: Env): Promise<AiUsageSummary> {
  const { monthStart, dayStart } = usageWindows(new Date());
  const [row, month, today] = await db.batch(
    (q) => [
      q.first(aiSettings),
      q.drizzle
        .select({ usd: sum(aiUsage.costUsd) })
        .from(aiUsage)
        .where(and(q.owned(aiUsage), gte(aiUsage.createdAt, monthStart))),
      q.count(aiUsage, gte(aiUsage.createdAt, dayStart)),
    ],
    "ai.usage",
  );
  return {
    monthUsd: Number(month[0]?.usd ?? 0),
    todayRequests: today,
    settings: withDefaults(row, offeredModels(env)[0]?.id ?? null),
  };
}

/** Whether the organization may make one more model call now, and with which model. */
export async function authorizeModelCall(
  db: TenantDb,
  env: Env,
  requested: string | null,
): Promise<Authorization> {
  const summary = await usageSummary(db, env);
  const resolved = resolveModel(env, requested, summary.settings.defaultModel);
  return authorization(resolved ?? (testModelEnabled(env) ? TEST_MODEL : null), summary);
}

/** One `ai_usage` row per call. Returns the estimated cost. */
export async function recordUsage(
  db: TenantDb,
  usage: {
    userId: string | null;
    surface: AiSurface;
    model: string;
    inputTokens: number;
    outputTokens: number;
  },
): Promise<number> {
  const costUsd = estimateFor(usage.model, usage.inputTokens, usage.outputTokens);
  await db.one((q) =>
    q.insert(aiUsage, {
      id: uuidv7(),
      userId: usage.userId,
      surface: usage.surface,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd,
    }),
  );
  return costUsd;
}
