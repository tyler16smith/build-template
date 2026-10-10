import {
  assistantConfig,
  assistantConversations,
  assistantDeleteConversation,
  assistantSaveSettings,
  assistantUsage,
} from "@template/contracts";
import { aiSettings } from "@template/db";
import { defineAction } from "../../actions/define";
import { settingsFor, usageSummary } from "./budget";
import { deleteConversation, listConversations } from "./conversations";
import { assistantConfig as configFor, ensureOfferedModel } from "./core";
import { offeredModels, testModelEnabled } from "./models";

/** The Assistant panel's reads and the AI settings (`specs/ai.md`): web-only actions. */

export const ASSISTANT_ACTIONS = {
  [assistantConfig.id]: defineAction({
    ...assistantConfig,
    handler: async (ctx) => {
      const env = ctx.runtime.env;
      return configFor(offeredModels(env), await settingsFor(ctx.db, env), testModelEnabled(env));
    },
  }),
  [assistantConversations.id]: defineAction({
    ...assistantConversations,
    handler: async (ctx) => ({ conversations: await listConversations(ctx.db) }),
  }),
  [assistantDeleteConversation.id]: defineAction({
    ...assistantDeleteConversation,
    handler: async (ctx, input) => {
      await deleteConversation(ctx.runtime.env, ctx.db, input.conversationId);
      return { ok: true as const };
    },
  }),
  [assistantUsage.id]: defineAction({
    ...assistantUsage,
    handler: (ctx) => usageSummary(ctx.db, ctx.runtime.env),
  }),
  [assistantSaveSettings.id]: defineAction({
    ...assistantSaveSettings,
    handler: async (ctx, input) => {
      ensureOfferedModel(offeredModels(ctx.runtime.env), input);
      const now = new Date();
      await ctx.db.one((q) =>
        q.drizzle
          .insert(aiSettings)
          .values({ organizationId: q.organizationId, ...input, updatedAt: now })
          .onConflictDoUpdate({
            target: [aiSettings.organizationId],
            set: { ...input, updatedAt: now },
          }),
      );
      ctx.log.info("ai.settings_saved");
      return usageSummary(ctx.db, ctx.runtime.env);
    },
  }),
};
