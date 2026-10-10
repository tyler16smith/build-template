import {
  AUTOMATION_LIMITS,
  ZAPIER_EVENT_PATHS,
  automationDefinitionSchema,
  collectReferences,
  flattenSteps,
  parseExpression,
  TemplateError,
  validTimeZone,
  type AutomationCatalog,
  type AutomationDefinition,
  type AutomationIssue,
  type AutomationStep,
  type CatalogTrigger,
  type FlatStep,
  type SchemaPath,
} from "@template/contracts";
import type { z } from "zod";
import { findAction } from "../../actions/registry";
import { allowedHttpUrl } from "./http";

export type ValidationResult = {
  definition: AutomationDefinition | null;
  issues: AutomationIssue[];
  /** Issues that make the draft unsafe to store: bad structure or references outside what this person may use. */
  rejectsSave: boolean;
};

type Issue = AutomationIssue & { rejectsSave?: boolean };

const CONFIG_KEYS_WITHOUT_REFERENCES = new Set([
  "id",
  "name",
  "kind",
  "retry",
  "timeoutSeconds",
  "connectionId",
  "actionId",
  "approvers",
  "match",
  "then",
  "else",
  "steps",
  "maxItems",
  "method",
  "output",
  "failOnError",
  "email",
  "amount",
  "unit",
]);

/** Header names whose literal values are credentials. */
const SECRET_HEADER = /^(authorization|x-api-key|api-key|x-auth-token|cookie)$/i;

function stepPathLabel(
  definition: unknown,
  path: (string | number | symbol)[],
): { path: string; stepId?: string } {
  const dotted = path.map(String).join(".");
  // The innermost step the problem sits in: walk steps.N(.then|.else|.steps.N)*.
  let node: unknown = definition;
  let stepId: string | undefined;
  for (let i = 0; i < path.length; i++) {
    node = (node as Record<string | number, unknown> | null)?.[path[i] as string | number];
    const container = String(path[i - 1] ?? "");
    if (
      typeof path[i] === "number" &&
      ["steps", "then", "else"].includes(container) &&
      node &&
      typeof node === "object" &&
      typeof (node as { id?: unknown }).id === "string"
    )
      stepId = (node as { id: string }).id;
  }
  return stepId ? { path: dotted, stepId } : { path: dotted };
}

function pathKnown(paths: SchemaPath[], path: string): boolean {
  return paths.some(
    (p) =>
      p.path === path ||
      (path.startsWith(`${p.path}.`) && (p.type === "any" || p.type === "object")),
  );
}

function manualPayloadPaths(definition: AutomationDefinition): SchemaPath[] {
  if (definition.trigger.kind === "schedule")
    return [
      { path: "trigger.scheduledFor", type: "string" },
      { path: "trigger.timezone", type: "string" },
    ];
  if (definition.trigger.kind === "manual") {
    return [
      { path: "trigger.fields", type: "object" },
      ...definition.trigger.fields.map((f) => ({ path: `trigger.fields.${f.key}`, type: f.type })),
      { path: "trigger.actor", type: "object" },
    ];
  }
  if (definition.trigger.kind === "webhook")
    return [
      { path: "trigger.body", type: "any" },
      { path: "trigger.deliveryId", type: "string" },
      { path: "trigger.receivedAt", type: "string" },
    ];
  return [];
}

function triggerPaths(
  definition: AutomationDefinition,
  catalog: AutomationCatalog,
): SchemaPath[] | null {
  if (definition.trigger.kind === "app.event") {
    const eventId = definition.trigger.eventId;
    const trigger = catalog.triggers.find(
      (t): t is Extract<CatalogTrigger, { kind: "app.event" }> =>
        t.kind === "app.event" && t.eventId === eventId,
    );
    return trigger?.payloadPaths ?? null;
  }
  if (definition.trigger.kind === "zapier.event") {
    const trigger = definition.trigger;
    const source = catalog.triggers.find(
      (t): t is Extract<CatalogTrigger, { kind: "zapier.event" }> => t.kind === "zapier.event",
    );
    const seen = (source?.seen ?? []).filter(
      (s) =>
        (!trigger.connectionId || s.connectionId === trigger.connectionId) &&
        (!trigger.provider || s.provider === trigger.provider) &&
        (!trigger.eventType || s.eventType === trigger.eventType),
    );
    return [...ZAPIER_EVENT_PATHS, ...seen.flatMap((s) => s.dataPaths)];
  }
  return manualPayloadPaths(definition);
}

/** The paths a step's output offers to later steps, when they're known. */
export function outputPathsFor(
  step: AutomationStep,
  catalog: AutomationCatalog,
): SchemaPath[] | null {
  switch (step.kind) {
    case "action":
      return catalog.actions.find((a) => a.actionId === step.actionId)?.outputPaths ?? null;
    case "http.request":
    case "notify":
    case "email.send":
    case "zapier.send":
      return [
        ...(catalog.builtinActions.find((a) => a.kind === step.kind)?.outputPaths ?? []),
        ...(step.kind === "http.request" ? [{ path: "body", type: "any" }] : []),
      ];
    case "ai.generate":
      return step.output === "fields"
        ? [
            { path: "fields", type: "object" },
            ...step.fields.flatMap((f) => [
              {
                path: f.key,
                type: f.type === "list" ? "array" : f.type === "text" ? "string" : f.type,
              },
              {
                path: `fields.${f.key}`,
                type: f.type === "list" ? "array" : f.type === "text" ? "string" : f.type,
              },
            ]),
          ]
        : [{ path: "text", type: "string" }];
    case "map":
      return Object.keys(step.fields).map((key) => ({ path: key, type: "any" }));
    case "condition":
    case "branch":
      return [{ path: "passed", type: "boolean" }];
    case "approval":
      return [
        { path: "approved", type: "boolean" },
        { path: "decidedBy", type: "string" },
        { path: "note", type: "string" },
      ];
    case "delay":
      return [{ path: "waitedUntil", type: "string" }];
    case "forEach":
      return [
        { path: "count", type: "number" },
        { path: "skipped", type: "number" },
        { path: "results", type: "array" },
        { path: "results.0", type: "any" },
      ];
  }
}

/** The list path a flattened step sits in: `steps`, or `steps.0.then`. */
function listPath(flat: FlatStep): string {
  return flat.path.slice(0, flat.path.lastIndexOf("."));
}

function checkReference(
  expression: string,
  at: string,
  current: FlatStep | null,
  earlier: Map<string, FlatStep>,
  all: FlatStep[],
  definition: AutomationDefinition,
  catalog: AutomationCatalog,
): Issue[] {
  const step = current?.step ?? null;
  let path: string;
  try {
    path = parseExpression(expression).path;
  } catch (error) {
    return [
      {
        severity: "error",
        message: error instanceof TemplateError ? error.message : String(error),
        path: at,
        stepId: step?.id,
      },
    ];
  }
  const where = { path: at, stepId: step?.id };
  if (path.startsWith("run"))
    return path === "run.id" || path === "run.startedAt"
      ? []
      : [
          {
            severity: "error",
            message: `“${path}” isn't available; use run.id or run.startedAt.`,
            ...where,
          },
        ];
  if (path === "loop" || path.startsWith("loop.")) {
    if (!current?.loopId)
      return [
        {
          severity: "error",
          message: `“${path}” only exists inside a For each step.`,
          rejectsSave: true,
          ...where,
        },
      ];
    const [, field] = path.split(".");
    return !field || ["item", "index", "count"].includes(field)
      ? []
      : [
          {
            severity: "error",
            message: `“${path}” isn't available; use loop.item, loop.index or loop.count.`,
            ...where,
          },
        ];
  }
  if (path.startsWith("trigger")) {
    const known = triggerPaths(definition, catalog);
    if (path === "trigger" || !known || known.length === 0 || pathKnown(known, path)) return [];
    return [
      {
        severity: "warning",
        message: `The trigger doesn't obviously provide “${path}”, so it may be empty at run time.`,
        ...where,
      },
    ];
  }
  const [, stepId, section, ...rest] = path.split(".");
  const found = earlier.get(stepId!);
  if (
    found &&
    current &&
    found.step.kind === "forEach" &&
    current.ancestors.includes(found.step.id)
  )
    return [
      {
        severity: "error",
        message: `“${found.step.name}” produces its output after the loop; inside it, use loop.item.`,
        ...where,
      },
    ];
  if (found && current && found.loopId && !current.ancestors.includes(found.loopId))
    return [
      {
        severity: "error",
        message: `“${found.step.name}” runs once per item inside a For each; after the loop, use that step's results (steps.${found.loopId}.output.results).`,
        ...where,
      },
    ];
  const maybeSkipped =
    found && current && !current.path.startsWith(`${listPath(found)}.`) && !found.loopId;
  const target = found?.step;
  if (!target) {
    const later = all.some((f) => f.step.id === stepId);
    return [
      {
        severity: "error",
        message: later
          ? `“${path}” refers to step “${stepId}”, which runs later. Steps can only use earlier steps.`
          : `“${path}” refers to a step “${stepId}” that doesn't exist.`,
        rejectsSave: true,
        ...where,
      },
    ];
  }
  if (section !== "output")
    return [
      {
        severity: "error",
        message: `Use steps.${stepId}.output… to read what “${target.name}” produced.`,
        ...where,
      },
    ];
  const skipWarning: Issue[] = maybeSkipped
    ? [
        {
          severity: "warning",
          message: `“${target.name}” only runs on one path of an If step, so “${path}” may be empty.`,
          ...where,
        },
      ]
    : [];
  if (rest.length === 0) return skipWarning;
  const known = outputPathsFor(target, catalog);
  if (!known || pathKnown(known, rest.join("."))) return skipWarning;
  return [
    {
      severity: "warning",
      message: `“${target.name}” doesn't list “${rest.join(".")}” in its output, so it may be empty at run time.`,
      ...where,
    },
  ];
}

function referencesIn(step: AutomationStep): { at: string; expression: string }[] {
  const refs: { at: string; expression: string }[] = [];
  for (const [key, value] of Object.entries(step)) {
    if (CONFIG_KEYS_WITHOUT_REFERENCES.has(key) || key === "runIf" || key === "conditions")
      continue;
    refs.push(...collectReferences(value, key));
  }
  const conditions = [
    ...(step.runIf ?? []).map((c, i) => ({ c, at: `runIf.${i}` })),
    ...(step.kind === "condition" || step.kind === "branch"
      ? step.conditions.map((c, i) => ({ c, at: `conditions.${i}` }))
      : []),
  ];
  for (const { c, at } of conditions) {
    refs.push({ at: `${at}.path`, expression: c.path });
    refs.push(...collectReferences(c.value ?? null, `${at}.value`));
  }
  return refs;
}

/** The zod schema of one input field, when the action's input is an object. */
function fieldSchema(actionId: string, key: string): z.ZodType | null {
  const input = findAction(actionId)?.input as unknown as { shape?: Record<string, z.ZodType> };
  return input?.shape?.[key] ?? null;
}

function checkActionInput(
  step: Extract<AutomationStep, { kind: "action" }>,
  schema: Record<string, unknown>,
  stepPath: string,
): Issue[] {
  const issues: Issue[] = [];
  const at = (key?: string) => ({
    path: `${stepPath}.input${key ? `.${key}` : ""}`,
    stepId: step.id,
  });
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];
  for (const key of required) {
    if (!(key in step.input))
      issues.push({
        severity: "error",
        message: `“${step.name}” needs a value for “${key}”.`,
        ...at(key),
      });
  }
  for (const [key, value] of Object.entries(step.input)) {
    if (!properties[key]) {
      issues.push({
        severity: "error",
        message: `“${key}” isn't an input of this action.`,
        rejectsSave: true,
        ...at(key),
      });
      continue;
    }
    if (collectReferences(value).length > 0) continue;
    const parsed = fieldSchema(step.actionId, key)?.safeParse(value);
    if (parsed && !parsed.success)
      issues.push({
        severity: "error",
        message: `“${key}”: ${parsed.error.issues[0]?.message ?? "isn't a valid value"}`,
        ...at(key),
      });
  }
  return issues;
}

function unknownMembers(
  to: { roles: string[] } | { userIds: string[] },
  catalog: AutomationCatalog,
): boolean {
  return "userIds" in to && to.userIds.some((id) => !catalog.members.some((m) => m.id === id));
}

function builtinUnavailable(
  kind: "http.request" | "ai.generate" | "notify" | "email.send" | "zapier.send",
  catalog: AutomationCatalog,
): string | null {
  const action = catalog.builtinActions.find((a) => a.kind === kind);
  return action?.status === "unavailable" ? (action.statusReason ?? "Not available.") : null;
}

function checkStep(flat: FlatStep, catalog: AutomationCatalog, origin: string): Issue[] {
  const step = flat.step;
  const at = (field?: string) => ({
    path: `${flat.path}${field ? `.${field}` : ""}`,
    stepId: step.id,
  });
  if (flat.depth > AUTOMATION_LIMITS.maxNesting)
    return [
      {
        severity: "error",
        message: `“${step.name}” is nested more than ${AUTOMATION_LIMITS.maxNesting} levels deep.`,
        rejectsSave: true,
        ...at(),
      },
    ];
  switch (step.kind) {
    case "action": {
      const action = catalog.actions.find((a) => a.actionId === step.actionId);
      if (!action)
        return [
          {
            severity: "error",
            message: `“${step.actionId}” isn't an action you can use here.`,
            rejectsSave: true,
            ...at("actionId"),
          },
        ];
      return checkActionInput(step, action.inputSchema, flat.path);
    }
    case "approval": {
      if (flat.loopId)
        return [
          {
            severity: "error",
            message: `“${step.name}”: approvals can't run inside a For each. Ask once before the loop.`,
            ...at(),
          },
        ];
      if (unknownMembers(step.approvers, catalog))
        return [
          {
            severity: "error",
            message: "Some approvers aren't members of this company.",
            rejectsSave: true,
            ...at("approvers"),
          },
        ];
      return [];
    }
    case "notify": {
      const reason = builtinUnavailable("notify", catalog);
      if (reason) return [{ severity: "error", message: reason, ...at() }];
      if (unknownMembers(step.to, catalog))
        return [
          {
            severity: "error",
            message: "Some people to notify aren't members of this company.",
            rejectsSave: true,
            ...at("to"),
          },
        ];
      return [];
    }
    case "email.send": {
      const reason = builtinUnavailable("email.send", catalog);
      const issues: Issue[] = reason ? [{ severity: "error", message: reason, ...at() }] : [];
      if (collectReferences(step.to).length === 0) {
        const bad = step.to
          .split(/[,;]/)
          .map((r) => r.trim())
          .filter((r) => r && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r));
        if (bad.length)
          issues.push({
            severity: "error",
            message: `“${bad[0]}” isn't an email address.`,
            ...at("to"),
          });
      }
      return issues;
    }
    case "ai.generate": {
      const reason = builtinUnavailable("ai.generate", catalog);
      const issues: Issue[] = reason ? [{ severity: "error", message: reason, ...at() }] : [];
      if (step.output === "fields" && step.fields.length === 0)
        issues.push({
          severity: "error",
          message: `Name at least one field for “${step.name}” to fill in.`,
          ...at("fields"),
        });
      return issues;
    }
    case "http.request": {
      const issues: Issue[] = [];
      if (collectReferences(step.url).length === 0) {
        const url = allowedHttpUrl(step.url, origin);
        if (typeof url === "string") issues.push({ severity: "error", message: url, ...at("url") });
      } else if (!/^https:\/\//i.test(step.url)) {
        issues.push({
          severity: "warning",
          message: "The address should start with https://.",
          ...at("url"),
        });
      }
      for (const [name, value] of Object.entries(step.headers))
        if (SECRET_HEADER.test(name) && collectReferences(value).length === 0)
          issues.push({
            severity: "warning",
            message: `The ${name} header is stored in the automation, so anyone who can edit it can read it.`,
            ...at(`headers.${name}`),
          });
      if (step.method === "GET" && step.body !== undefined)
        issues.push({
          severity: "warning",
          message: "GET requests don't send a body; it will be ignored.",
          ...at("body"),
        });
      return issues;
    }
    case "delay": {
      if (step.until && collectReferences(step.until).length === 0) {
        if (Number.isNaN(new Date(step.until).getTime()))
          return [
            {
              severity: "error",
              message: `“${step.until}” isn't a date and time.`,
              ...at("until"),
            },
          ];
      }
      return [];
    }
    case "branch":
      return step.then.length === 0 && step.else.length === 0
        ? [
            {
              severity: "error",
              message: `Add a step inside “${step.name}”.`,
              incomplete: true,
              ...at(),
            },
          ]
        : [];
    case "forEach": {
      const issues: Issue[] = [];
      if (flat.loopId)
        issues.push({
          severity: "error",
          message: `“${step.name}”: a For each can't run inside another For each.`,
          rejectsSave: true,
          ...at(),
        });
      if (collectReferences(step.items).length === 0)
        issues.push({
          severity: "error",
          message: `“${step.name}” needs a list to go through, e.g. {{trigger.data.items}}.`,
          ...at("items"),
        });
      if (step.steps.length === 0)
        issues.push({
          severity: "error",
          message: `Add a step inside “${step.name}” to run for each item.`,
          incomplete: true,
          ...at(),
        });
      return issues;
    }
    case "zapier.send": {
      const reason = builtinUnavailable("zapier.send", catalog);
      if (reason) return [{ severity: "error", message: reason, ...at() }];
      if (!step.connectionId)
        return [
          {
            severity: "error",
            message: `Choose which Zapier hook “${step.name}” sends to.`,
            fix: { kind: "zapier", direction: "outbound" },
            incomplete: true,
            ...at("connectionId"),
          },
        ];
      const hook = catalog.zapierHooks.find((h) => h.id === step.connectionId);
      if (!hook)
        return [
          {
            severity: "error",
            message: "That Zapier hook doesn't exist here. Choose another.",
            rejectsSave: true,
            ...at("connectionId"),
          },
        ];
      if (hook.status !== "active")
        return [
          {
            severity: "warning",
            message: `The Zapier hook “${hook.name}” is disabled, so this step fails until it's enabled.`,
            ...at("connectionId"),
          },
        ];
      return [];
    }
    default:
      return [];
  }
}

/**
 * Validates a proposed definition for one person (against their catalog). Structural problems
 * and references outside what they may use reject the save; incomplete configuration is allowed in
 * a draft but blocks publishing.
 */
export function validateDefinition(
  raw: unknown,
  catalog: AutomationCatalog,
  options: { origin?: string } = {},
): ValidationResult {
  const size = JSON.stringify(raw ?? null).length;
  if (size > AUTOMATION_LIMITS.maxDefinitionBytes) {
    return {
      definition: null,
      issues: [
        {
          severity: "error",
          message: `The automation is too large (${Math.round(size / 1000)} KB; the limit is ${AUTOMATION_LIMITS.maxDefinitionBytes / 1000} KB).`,
        },
      ],
      rejectsSave: true,
    };
  }
  const parsed = automationDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      definition: null,
      issues: parsed.error.issues.slice(0, 20).map((issue) => ({
        severity: "error" as const,
        message: issue.message,
        ...stepPathLabel(raw, issue.path),
      })),
      rejectsSave: true,
    };
  }
  const definition = parsed.data;
  const issues: Issue[] = [];
  const flat = flattenSteps(definition.steps);
  if (flat.length > AUTOMATION_LIMITS.maxSteps)
    issues.push({
      severity: "error",
      message: `An automation can have at most ${AUTOMATION_LIMITS.maxSteps} steps, counting the ones inside If and For each (this one has ${flat.length}).`,
      rejectsSave: true,
    });
  const seen = new Set<string>();
  for (const { step, path } of flat) {
    if (seen.has(step.id))
      issues.push({
        severity: "error",
        message: `Two steps use the id “${step.id}”.`,
        path: `${path}.id`,
        stepId: step.id,
        rejectsSave: true,
      });
    seen.add(step.id);
  }
  if (definition.trigger.kind === "app.event") {
    const eventId = definition.trigger.eventId;
    if (!catalog.triggers.some((t) => t.kind === "app.event" && t.eventId === eventId))
      issues.push({
        severity: "error",
        message: `“${eventId}” isn't an event you can automate here.`,
        path: "trigger.eventId",
        rejectsSave: true,
      });
    for (const [i, condition] of definition.trigger.when.entries())
      if (!condition.path.startsWith("trigger"))
        issues.push({
          severity: "error",
          message: "Trigger conditions can only use trigger values.",
          path: `trigger.when.${i}.path`,
          rejectsSave: true,
        });
  }
  if (definition.trigger.kind === "zapier.event") {
    const trigger = definition.trigger;
    const source = catalog.triggers.find(
      (t): t is Extract<CatalogTrigger, { kind: "zapier.event" }> => t.kind === "zapier.event",
    );
    const connections = source?.connections ?? [];
    if (connections.length === 0)
      issues.push({
        severity: "error",
        message:
          "Create a Zapier connection first (Connections → Zapier), then point your Zap at its URL.",
        path: "trigger.connectionId",
        fix: { kind: "zapier", direction: "inbound" },
        incomplete: true,
      });
    else if (trigger.connectionId) {
      const connection = connections.find((c) => c.id === trigger.connectionId);
      if (!connection)
        issues.push({
          severity: "error",
          message: "The Zapier connection this trigger uses no longer exists. Choose another.",
          path: "trigger.connectionId",
        });
      else if (connection.status !== "active")
        issues.push({
          severity: "warning",
          message: `The Zapier connection “${connection.name}” is disabled, so no events arrive until it's enabled.`,
          path: "trigger.connectionId",
        });
    }
    if (!trigger.eventType)
      issues.push({
        severity: "warning",
        message:
          "No event type is chosen, so every event from Zapier starts this automation. Pick one, e.g. deal.closed_won.",
        path: "trigger.eventType",
      });
    for (const [i, condition] of trigger.when.entries())
      if (!condition.path.startsWith("trigger"))
        issues.push({
          severity: "error",
          message: "Trigger conditions can only use trigger values.",
          path: `trigger.when.${i}.path`,
          rejectsSave: true,
        });
  }
  if (definition.trigger.kind === "schedule" && !validTimeZone(definition.trigger.timezone))
    issues.push({
      severity: "error",
      message: `“${definition.trigger.timezone}” isn't a time zone. Use a name like America/New_York.`,
      path: "trigger.timezone",
    });
  if (definition.steps.length === 0)
    issues.push({
      severity: "error",
      message: "Add at least one step.",
      path: "steps",
      incomplete: true,
    });

  const earlier = new Map<string, FlatStep>();
  for (const entry of flat) {
    issues.push(...checkStep(entry, catalog, options.origin ?? "https://invalid"));
    for (const ref of referencesIn(entry.step))
      issues.push(
        ...checkReference(
          ref.expression,
          `${entry.path}.${ref.at}`,
          entry,
          earlier,
          flat,
          definition,
          catalog,
        ),
      );
    earlier.set(entry.step.id, entry);
  }
  return {
    definition,
    issues: issues.map(({ rejectsSave: _r, ...issue }) => issue),
    rejectsSave: issues.some((i) => i.rejectsSave),
  };
}
