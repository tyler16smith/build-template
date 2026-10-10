import {
  ZAPIER_SAMPLE_EVENT,
  zapierCreate,
  zapierDelete,
  zapierEvents,
  zapierList,
  zapierRegenerateSecret,
  zapierSendTest,
  zapierSendTestEvent,
  zapierUpdate,
} from "@template/contracts";
import { defineAction } from "../../actions/define";
import { scopeOf } from "../automations/context";
import {
  createConnection,
  deleteConnection,
  listConnections,
  regenerateSecret,
  sendTestToHook,
  updateConnection,
} from "./connections";
import { listEvents, sendTestEvent } from "./events";

/** Connections → Zapier (`specs/ai.md`): web-only actions. Owners and admins manage them. */

export const ZAPIER_ACTIONS = {
  [zapierList.id]: defineAction({
    ...zapierList,
    handler: async (ctx) => ({ connections: await listConnections(scopeOf(ctx)) }),
  }),
  [zapierCreate.id]: defineAction({
    ...zapierCreate,
    handler: (ctx, input) => createConnection(scopeOf(ctx), input),
  }),
  [zapierUpdate.id]: defineAction({
    ...zapierUpdate,
    handler: (ctx, { connectionId, ...input }) =>
      updateConnection(scopeOf(ctx), connectionId, input),
  }),
  [zapierDelete.id]: defineAction({
    ...zapierDelete,
    handler: (ctx, input) => deleteConnection(scopeOf(ctx), input.connectionId),
  }),
  [zapierRegenerateSecret.id]: defineAction({
    ...zapierRegenerateSecret,
    handler: (ctx, input) => regenerateSecret(scopeOf(ctx), input.connectionId),
  }),
  [zapierEvents.id]: defineAction({
    ...zapierEvents,
    handler: async (ctx, input) => ({
      events: await listEvents(scopeOf(ctx), input.connectionId),
    }),
  }),
  /** Inbound: a test event through the real pipeline, starting nothing. */
  [zapierSendTestEvent.id]: defineAction({
    ...zapierSendTestEvent,
    handler: (ctx, input) =>
      sendTestEvent(scopeOf(ctx), input.connectionId, input.body ?? ZAPIER_SAMPLE_EVENT),
  }),
  /** Outbound: a sample body posted to the Catch Hook. */
  [zapierSendTest.id]: defineAction({
    ...zapierSendTest,
    handler: (ctx, input) =>
      sendTestToHook(scopeOf(ctx), input.connectionId, input.sample ?? { hello: "from the app" }),
  }),
};
