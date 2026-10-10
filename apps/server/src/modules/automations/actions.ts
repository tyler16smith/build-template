import {
  automationsCancelRun,
  automationsCatalog,
  automationsCreate,
  automationsDecideApproval,
  automationsDelete,
  automationsGet,
  automationsGetRun,
  automationsList,
  automationsLiveTest,
  automationsPublish,
  automationsRestore,
  automationsRotateWebhook,
  automationsRun,
  automationsRuns,
  automationsSaveDraft,
  automationsSetPaused,
  automationsSimulate,
  automationsWebhook,
} from "@template/contracts";
import { defineAction } from "../../actions/define";
import { buildCatalog } from "./catalog";
import { scopeOf } from "./context";
import {
  automationDetail,
  cancelRun,
  createAutomation,
  decideApproval,
  deleteDraft,
  listAutomations,
  listRuns,
  liveTestAutomation,
  publishAutomation,
  restoreRevision,
  runDetail,
  runManually,
  saveDraft,
  setPaused,
  simulateAutomation,
} from "./service";
import { rotateWebhook, webhookSecret } from "./webhooks";

/**
 * Automations in the app (`specs/ai.md`): web-only actions over the module's services, which the
 * Automation Builder agent calls too. The services check `automations.manage` again themselves.
 */

export const AUTOMATION_ACTIONS = {
  [automationsList.id]: defineAction({
    ...automationsList,
    handler: (ctx) => listAutomations(scopeOf(ctx)),
  }),
  [automationsCatalog.id]: defineAction({
    ...automationsCatalog,
    handler: (ctx) => buildCatalog(scopeOf(ctx)),
  }),
  [automationsGet.id]: defineAction({
    ...automationsGet,
    handler: (ctx, input) => automationDetail(scopeOf(ctx), input.automationId),
  }),
  [automationsCreate.id]: defineAction({
    ...automationsCreate,
    handler: (ctx, input) => createAutomation(scopeOf(ctx), input),
  }),
  [automationsSaveDraft.id]: defineAction({
    ...automationsSaveDraft,
    handler: (ctx, input) => saveDraft(scopeOf(ctx), { ...input, source: "ui" }),
  }),
  [automationsRestore.id]: defineAction({
    ...automationsRestore,
    handler: (ctx, input) => restoreRevision(scopeOf(ctx), input),
  }),
  [automationsDelete.id]: defineAction({
    ...automationsDelete,
    handler: async (ctx, input) => {
      await deleteDraft(scopeOf(ctx), input.automationId);
      return { ok: true as const };
    },
  }),
  [automationsPublish.id]: defineAction({
    ...automationsPublish,
    handler: (ctx, input) => publishAutomation(scopeOf(ctx), input),
  }),
  [automationsSetPaused.id]: defineAction({
    ...automationsSetPaused,
    handler: (ctx, input) => setPaused(scopeOf(ctx), input),
  }),
  [automationsSimulate.id]: defineAction({
    ...automationsSimulate,
    handler: (ctx, input) => simulateAutomation(scopeOf(ctx), input),
  }),
  [automationsLiveTest.id]: defineAction({
    ...automationsLiveTest,
    handler: (ctx, input) => liveTestAutomation(scopeOf(ctx), input),
  }),
  [automationsRun.id]: defineAction({
    ...automationsRun,
    handler: (ctx, input) => runManually(scopeOf(ctx), input),
  }),
  [automationsRuns.id]: defineAction({
    ...automationsRuns,
    handler: async (ctx, input) => ({ runs: await listRuns(scopeOf(ctx), input.automationId) }),
  }),
  [automationsGetRun.id]: defineAction({
    ...automationsGetRun,
    handler: (ctx, input) => runDetail(scopeOf(ctx), input.runId),
  }),
  [automationsCancelRun.id]: defineAction({
    ...automationsCancelRun,
    handler: (ctx, input) => cancelRun(scopeOf(ctx), input.runId),
  }),
  [automationsDecideApproval.id]: defineAction({
    ...automationsDecideApproval,
    handler: (ctx, input) => decideApproval(scopeOf(ctx), input),
  }),
  [automationsWebhook.id]: defineAction({
    ...automationsWebhook,
    handler: (ctx, input) => webhookSecret(scopeOf(ctx), input.automationId),
  }),
  [automationsRotateWebhook.id]: defineAction({
    ...automationsRotateWebhook,
    handler: (ctx, input) => rotateWebhook(scopeOf(ctx), input.automationId),
  }),
};
