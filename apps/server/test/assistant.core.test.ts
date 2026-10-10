import { ActionError, AI_LIMITS, type AiModel } from "@template/contracts";
import { describe, expect, it } from "vitest";
import {
  assistantConfig,
  authorization,
  ensureOfferedModel,
  estimateFor,
  TEST_MODEL,
  usageWindows,
  withDefaults,
} from "../src/modules/assistant/core";

const model: AiModel = { ...TEST_MODEL, id: "claude", label: "Claude" };
const settings = { defaultModel: "claude", monthlyBudgetUsd: 20, dailyRequests: 500 };

describe("assistant core", () => {
  it("fills in the policy's defaults", () => {
    expect(withDefaults(null, "claude")).toEqual({
      defaultModel: "claude",
      monthlyBudgetUsd: AI_LIMITS.defaultMonthlyBudgetUsd,
      dailyRequests: AI_LIMITS.defaultDailyRequests,
    });
    expect(withDefaults({ monthlyBudgetUsd: 5, defaultModel: null }, null)).toMatchObject({
      defaultModel: "",
      monthlyBudgetUsd: 5,
    });
  });

  it("resets spend monthly and requests daily, in UTC", () => {
    expect(usageWindows(new Date("2026-10-06T23:30:00-07:00"))).toEqual({
      monthStart: new Date("2026-10-01T00:00:00Z"),
      dayStart: new Date("2026-10-07T00:00:00Z"),
    });
  });

  it("allows a call under the budget and the daily cap, and explains a refusal", () => {
    const usage = { monthUsd: 1, todayRequests: 1, settings };
    expect(authorization(model, usage)).toEqual({ ok: true, model });
    expect(authorization(null, usage)).toMatchObject({ ok: false });
    expect(authorization(model, { ...usage, monthUsd: 20 })).toMatchObject({
      ok: false,
      message: expect.stringContaining("$20.00"),
    });
    expect(authorization(model, { ...usage, todayRequests: 500 })).toMatchObject({
      ok: false,
      message: expect.stringContaining("500 AI requests"),
    });
  });

  it("prices known models only", () => {
    expect(estimateFor(TEST_MODEL.id, 1_000_000, 1_000_000)).toBe(3);
    expect(estimateFor("unknown", 1_000, 1_000)).toBe(0);
  });

  it("tells the panel what's offered and the default", () => {
    expect(assistantConfig([model], settings, false)).toEqual({
      enabled: true,
      models: [{ id: "claude", label: "Claude", vision: false, reasoning: false }],
      defaultModel: "claude",
    });
    expect(assistantConfig([], settings, false)).toMatchObject({
      enabled: false,
      defaultModel: null,
    });
    expect(assistantConfig([], settings, true).enabled).toBe(true);
  });

  it("accepts only an offered default model", () => {
    expect(() => ensureOfferedModel([model], settings)).not.toThrow();
    expect(() => ensureOfferedModel([model], { ...settings, defaultModel: "gpt" })).toThrow(
      ActionError,
    );
  });
});
