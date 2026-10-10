import {
  mayRun,
  schemaPaths,
  type AutomationCatalog,
  type CatalogAction,
  type CatalogBuiltinAction,
  type CatalogTrigger,
  type SchemaPath,
} from "@template/contracts";
import { asc, zapierConnections } from "@template/db";
import { z } from "zod";
import type { ServerAction } from "../../actions/define";
import { REGISTRY } from "../../actions/registry";
import type { Env } from "../../env";
import { aiAvailable } from "../assistant/models";
import { seenZapierEvents } from "../zapier/events";
import type { Scope } from "./context";

const schemas = new Map<
  string,
  { input: Record<string, unknown>; output: Record<string, unknown> }
>();

/** An action's input and output as JSON Schema (computed once per action). */
export function actionSchemas(action: ServerAction) {
  let found = schemas.get(action.id);
  if (!found) {
    found = {
      input: z.toJSONSchema(action.input, { io: "input", unrepresentable: "any" }) as Record<
        string,
        unknown
      >,
      output: z.toJSONSchema(action.output, { io: "output", unrepresentable: "any" }) as Record<
        string,
        unknown
      >,
    };
    schemas.set(action.id, found);
  }
  return found;
}

const ACTOR_SCHEMA = {
  type: "object",
  properties: { id: { type: "string" }, name: { type: "string" } },
};

/** The trigger payload of an action's event: `{ event, data, input, actor, caller }`. */
export function eventPayloadPaths(action: ServerAction): SchemaPath[] {
  const { input, output } = actionSchemas(action);
  return schemaPaths(
    {
      type: "object",
      properties: {
        event: { type: "string" },
        data: output,
        input,
        actor: ACTOR_SCHEMA,
        caller: { type: "string", description: "web, mcp, assistant or automation" },
      },
    },
    "trigger",
  );
}

/** Actions an agent or an automation may use as this role: not web-only, and permitted. */
export function usableActions(role: Parameters<typeof mayRun>[1]): ServerAction[] {
  return Object.values(REGISTRY).filter((action) => !action.webOnly && mayRun(action, role));
}

const LOGIC: AutomationCatalog["logic"] = [
  {
    kind: "condition",
    title: "Only continue if…",
    description: "Stops the run unless the conditions hold.",
  },
  {
    kind: "map",
    title: "Prepare values",
    description: "Computes named values from earlier steps for later steps to use.",
  },
  {
    kind: "approval",
    title: "Wait for approval",
    description: "Pauses until an allowed person approves or declines. They're emailed a link.",
  },
  {
    kind: "delay",
    title: "Wait",
    description: "Pauses for minutes, hours or days, or until a date and time.",
  },
  {
    kind: "branch",
    title: "If / otherwise",
    description: "Runs one set of steps when the conditions hold and another when they don't.",
  },
  {
    kind: "forEach",
    title: "For each item",
    description: "Runs the steps inside once for every item in a list.",
  },
];

const BUILTINS: Omit<CatalogBuiltinAction, "status" | "statusReason">[] = [
  {
    kind: "email.send",
    title: "Send an email",
    description: "Sends a plain-text email to any address. No account to connect.",
    outputPaths: [{ path: "sent", type: "number" }],
  },
  {
    kind: "notify",
    title: "Email members",
    description: "Emails members of the company by role or by name.",
    outputPaths: [{ path: "notified", type: "number" }],
  },
  {
    kind: "ai.generate",
    title: "Ask AI",
    description:
      "Summarizes, classifies, extracts or drafts text with the company's default model. Returns text or named fields.",
    outputPaths: [
      { path: "text", type: "string" },
      { path: "fields", type: "object" },
    ],
  },
  {
    kind: "http.request",
    title: "Call a web address (HTTP)",
    description:
      "Sends an HTTPS request to another service's API and returns the status and response body.",
    outputPaths: [
      { path: "status", type: "number" },
      { path: "ok", type: "boolean" },
      { path: "body", type: "any" },
    ],
  },
  {
    kind: "zapier.send",
    title: "Send to Zapier",
    description:
      "Posts JSON to a Zapier Catch Hook, so a Zap can put it in any app Zapier connects (Sheets, Mailchimp, HubSpot…).",
    outputPaths: [{ path: "status", type: "number" }],
  },
];

function builtinUnavailable(env: Env, kind: CatalogBuiltinAction["kind"]): string | null {
  if (kind === "ai.generate" && !aiAvailable(env))
    return "This deployment has no AI model set up (ANTHROPIC_API_KEY or Workers AI).";
  if (
    (kind === "email.send" || kind === "notify") &&
    env.ENVIRONMENT !== "local" &&
    env.ENVIRONMENT !== "test" &&
    !env.RESEND_API_KEY
  )
    return "This deployment can't send email yet (RESEND_API_KEY).";
  if (kind === "zapier.send" && !env.CONNECTION_ENCRYPTION_KEY)
    return "Zapier isn't set up on this deployment yet (CONNECTION_ENCRYPTION_KEY).";
  return null;
}

/**
 * What one person may compose into an automation: the actions their role may run (with their
 * events as triggers), the built-in steps, Zapier connections and the members to approve or
 * notify. The same list the Assistant's tools come from.
 */
export async function buildCatalog(scope: Scope): Promise<AutomationCatalog> {
  const { ctx, db, principal } = scope;
  const usable = usableActions(principal.role);
  const [members, connections, seen] = await Promise.all([
    ctx.accounts().members(principal),
    db.one((q) => q.select(zapierConnections, { orderBy: [asc(zapierConnections.createdAt)] })),
    seenZapierEvents(db),
  ]);
  const zapier = (direction: "inbound" | "outbound") =>
    connections
      .filter((c) => c.direction === direction)
      .map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        connected: c.lastUsedAt !== null,
      }));
  const eventTriggers: CatalogTrigger[] = usable.flatMap((action) =>
    (action.events ?? []).map((event) => ({
      kind: "app.event" as const,
      title: `When: ${event.title}`,
      description: `${action.description}${event.when ? ` Emitted ${event.when}.` : ""}`,
      eventId: event.id,
      actionId: action.id,
      payloadPaths: eventPayloadPaths(action),
    })),
  );
  const actions: CatalogAction[] = usable.map((action) => {
    const { input, output } = actionSchemas(action);
    return {
      kind: "action",
      actionId: action.id,
      title: action.title,
      description: action.description,
      readOnly: action.readOnly,
      confirm: action.confirm ?? false,
      inputSchema: input,
      outputSchema: output,
      outputPaths: schemaPaths(output, ""),
    };
  });
  return {
    triggers: [
      ...eventTriggers,
      {
        kind: "schedule",
        title: "On a schedule",
        description: "Every hour, day, week or month at a time you choose, in your time zone.",
      },
      {
        kind: "manual",
        title: "Run manually",
        description: "Someone starts it with the Run button, optionally filling in fields.",
      },
      {
        kind: "zapier.event",
        title: "Zapier event received",
        description:
          "An event from another app (HubSpot, Google Sheets, Typeform…) that a Zap sends with Webhooks by Zapier.",
        connections: zapier("inbound"),
        seen,
      },
      {
        kind: "webhook",
        title: "Incoming webhook",
        description: "Another system POSTs signed JSON to a private URL.",
      },
    ],
    logic: LOGIC,
    actions,
    builtinActions: BUILTINS.map((builtin) => {
      const reason = builtinUnavailable(ctx.env, builtin.kind);
      return { ...builtin, status: reason ? "unavailable" : "ready", statusReason: reason };
    }),
    zapierHooks: zapier("outbound"),
    members: members.map(({ id, name, role }) => ({ id, name, role })),
  };
}
