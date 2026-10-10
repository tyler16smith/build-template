import {
  CONTAINER_STEP_KINDS,
  ZAPIER_EVENT_PATHS,
  describeCondition,
  describeSchedule,
  flattenSteps,
  type Approvers,
  type AutomationCatalog,
  type AutomationDefinition,
  type AutomationIssue,
  type AutomationStatus,
  type AutomationStep,
  type AutomationTrigger,
  type DefinitionDiff,
  type RunStatus,
  type SchemaPath,
  type StepKind,
  type StepRunStatus,
} from "@template/contracts";

export { describeTrigger } from "@template/contracts";

/** A Badge or Alert tone. */
export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info" | "outline";

/** "6 Oct 2026, 09:14": absolute, in the person's own time. Empty for null. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** A change the Builder or the editor just saved, highlighted on the canvas until dismissed. */
export type RecentChange = {
  revision: number;
  summary: string;
  diff: DefinitionDiff;
  source: "chat" | "ui";
};

export const AUTOMATION_STATUS_LABELS: Record<AutomationStatus, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  failed: "Stopped",
};

export function automationStatusTone(status: AutomationStatus): Tone {
  return status === "active"
    ? "success"
    : status === "failed"
      ? "danger"
      : status === "paused"
        ? "warning"
        : "neutral";
}

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting_approval: "Waiting for approval",
  waiting: "Waiting",
  succeeded: "Succeeded",
  failed: "Failed",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export function runStatusTone(status: RunStatus): Tone {
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  if (status === "waiting_approval" || status === "waiting") return "warning";
  if (status === "rejected" || status === "cancelled") return "neutral";
  return "info";
}

export const STEP_STATUS_LABELS: Record<StepRunStatus, string> = {
  pending: "Not reached",
  running: "Running",
  succeeded: "Done",
  simulated: "Simulated",
  skipped: "Skipped",
  stopped: "Stopped the run",
  waiting: "Waiting",
  failed: "Failed",
  rejected: "Rejected",
};

export function stepStatusTone(status: StepRunStatus): Tone {
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  if (status === "waiting") return "warning";
  if (status === "simulated" || status === "running") return "info";
  return "neutral";
}

export const STEP_KIND_LABELS: Record<StepKind, string> = {
  condition: "Only continue if",
  map: "Prepare values",
  approval: "Ask for approval",
  action: "Action",
  delay: "Wait",
  branch: "If / otherwise",
  forEach: "For each item",
  "http.request": "Call a web address",
  "ai.generate": "Ask AI",
  notify: "Email members",
  "email.send": "Send email",
  "zapier.send": "Send to Zapier",
};

const ROLE_LABELS: Record<string, string> = { owner: "owner", admin: "admin", member: "member" };

/** "any owner or admin", or the named members. */
export function approversText(to: Approvers, catalog: Pick<AutomationCatalog, "members">): string {
  if ("roles" in to) return `any ${to.roles.map((r) => ROLE_LABELS[r] ?? r).join(" or ")}`;
  return to.userIds
    .map((id) => catalog.members.find((m) => m.id === id)?.name ?? "someone")
    .join(", ");
}

/** One line under a step's name on its card. */
export function describeStep(step: AutomationStep, catalog: AutomationCatalog): string {
  switch (step.kind) {
    case "condition":
      return `${step.match === "any" ? "Any of" : "All of"}: ${step.conditions.map(describeCondition).join("; ")}`;
    case "branch":
      return `If ${step.conditions.map(describeCondition).join(step.match === "any" ? " or " : " and ")}`;
    case "forEach":
      return `Each item in ${step.items || "…"} (up to ${step.maxItems})`;
    case "delay":
      return step.until
        ? `Until ${step.until}`
        : `${step.amount} ${step.amount === 1 ? step.unit.replace(/s$/, "") : step.unit}`;
    case "map":
      return `Sets ${Object.keys(step.fields).join(", ") || "no values"}`;
    case "approval":
      return `${approversText(step.approvers, catalog)} decides`.replace(/^./, (c) =>
        c.toUpperCase(),
      );
    case "notify":
      return `To ${approversText(step.to, catalog)} · “${step.subject || "…"}”`;
    case "email.send":
      return `To ${step.to || "…"} · “${step.subject || "…"}”`;
    case "ai.generate":
      return step.output === "fields" && step.fields.length
        ? `Fills ${step.fields.map((f) => f.key).join(", ")}`
        : step.instruction.slice(0, 80) || "Returns text";
    case "http.request":
      return `${step.method} ${step.url || "…"}`;
    case "action": {
      const action = catalog.actions.find((a) => a.actionId === step.actionId);
      return action
        ? `${action.title}${action.readOnly ? "" : " (changes data)"}`
        : `${step.actionId} (not available)`;
    }
    case "zapier.send": {
      const hook = catalog.zapierHooks.find((h) => h.id === step.connectionId);
      const fields = Object.keys(step.body);
      return `${hook ? hook.name : "No Zapier hook chosen"}${fields.length ? ` · ${fields.join(", ")}` : ""}`;
    }
  }
}

export type PathGroup = { group: string; paths: SchemaPath[] };

function triggerPaths(definition: AutomationDefinition, catalog: AutomationCatalog): SchemaPath[] {
  const trigger = definition.trigger;
  switch (trigger.kind) {
    case "app.event": {
      const match = catalog.triggers.find(
        (t) => t.kind === "app.event" && t.eventId === trigger.eventId,
      );
      return match?.kind === "app.event" ? match.payloadPaths : [];
    }
    case "schedule":
      return [
        { path: "trigger.scheduledFor", type: "string", description: "When this run was due" },
        { path: "trigger.timezone", type: "string" },
      ];
    case "manual":
      return [
        ...trigger.fields.map((f) => ({
          path: `trigger.fields.${f.key}`,
          type: f.type,
          description: f.label,
        })),
        { path: "trigger.actor.name", type: "string" },
        { path: "trigger.actor.id", type: "string" },
      ];
    case "webhook":
      return [
        ...trigger.fields.map((f) => ({
          path: `trigger.body.${f.key}`,
          type: f.type,
          description: f.label,
        })),
        { path: "trigger.receivedAt", type: "string" },
        { path: "trigger.deliveryId", type: "string" },
      ];
    case "zapier.event": {
      const source = catalog.triggers.find((t) => t.kind === "zapier.event");
      const seen =
        source?.kind === "zapier.event"
          ? source.seen.filter(
              (e) =>
                (!trigger.connectionId || e.connectionId === trigger.connectionId) &&
                (!trigger.provider || e.provider === trigger.provider) &&
                (!trigger.eventType || e.eventType === trigger.eventType),
            )
          : [];
      // Fields from recent events first: they're what people reach for.
      const fields = new Map<string, SchemaPath>();
      for (const e of seen)
        for (const p of e.dataPaths) if (!fields.has(p.path)) fields.set(p.path, p);
      return [
        ...fields.values(),
        ...ZAPIER_EVENT_PATHS.filter((p) => p.path !== "trigger.data" || fields.size === 0),
      ];
    }
  }
}

/** What a step's output offers later steps (paths relative to its output). */
export function stepOutputPaths(step: AutomationStep, catalog: AutomationCatalog): SchemaPath[] {
  switch (step.kind) {
    case "action":
      return catalog.actions.find((a) => a.actionId === step.actionId)?.outputPaths ?? [];
    case "http.request":
    case "notify":
    case "email.send":
    case "zapier.send":
      return catalog.builtinActions.find((b) => b.kind === step.kind)?.outputPaths ?? [];
    case "ai.generate":
      return step.output === "fields"
        ? step.fields.map((f) => ({
            path: f.key,
            type: f.type === "list" ? "array" : f.type === "text" ? "string" : f.type,
            description: f.description,
          }))
        : [{ path: "text", type: "string" }];
    case "map":
      return Object.keys(step.fields).map((key) => ({ path: key, type: "any" }));
    case "approval":
      return [
        { path: "approved", type: "boolean" },
        { path: "note", type: "string" },
      ];
    case "condition":
    case "branch":
      return [{ path: "passed", type: "boolean" }];
    case "delay":
      return [{ path: "waitedUntil", type: "string" }];
    case "forEach":
      return [
        { path: "count", type: "number" },
        { path: "results", type: "array" },
      ];
  }
}

/**
 * Where a value in `stepId` may read from: the trigger, the steps that surely ran before it
 * (not the ones inside a For each it isn't in), the current loop item, and the run.
 * `stepId` null means the trigger's own conditions.
 */
export function availablePaths(
  definition: AutomationDefinition,
  catalog: AutomationCatalog,
  stepId: string | null,
): PathGroup[] {
  const groups: PathGroup[] = [{ group: "Trigger", paths: triggerPaths(definition, catalog) }];
  if (stepId === null) return groups;
  const flat = flattenSteps(definition.steps);
  const index = flat.findIndex((f) => f.step.id === stepId);
  const current = flat[index];
  if (current?.loopId) {
    const loop = flat.find((f) => f.step.id === current.loopId)?.step;
    groups.push({
      group: `Current item (${loop?.name ?? "For each"})`,
      paths: [
        { path: "loop.item", type: "any", description: "The item this pass is about" },
        { path: "loop.index", type: "number", description: "Its position, from 0" },
        { path: "loop.count", type: "number" },
      ],
    });
  }
  for (const entry of flat.slice(0, Math.max(index, 0))) {
    const insideOtherLoop = entry.loopId && !current?.ancestors.includes(entry.loopId);
    const ownLoop = entry.step.kind === "forEach" && current?.ancestors.includes(entry.step.id);
    if (insideOtherLoop || ownLoop) continue;
    const prefix = `steps.${entry.step.id}.output`;
    const paths = stepOutputPaths(entry.step, catalog).map((p) => ({
      ...p,
      path: p.path ? `${prefix}.${p.path}` : prefix,
    }));
    if (paths.length) groups.push({ group: entry.step.name, paths });
  }
  groups.push({
    group: "Run",
    paths: [
      { path: "run.id", type: "string" },
      { path: "run.startedAt", type: "string", description: "When this run started" },
    ],
  });
  return groups;
}

/** Issues for the trigger card (stepId null) or one step. */
export function issuesFor(issues: AutomationIssue[], stepId: string | null): AutomationIssue[] {
  return issues.filter((i) =>
    stepId === null ? !i.stepId && Boolean(i.path?.startsWith("trigger")) : i.stepId === stepId,
  );
}

export function newStepId(definition: AutomationDefinition, base: string): string {
  const taken = new Set(flattenSteps(definition.steps).map((f) => f.step.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

function slugify(text: string, fallback: string): string {
  const id = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "s_$1")
    .slice(0, 30);
  return /^[a-z]/.test(id) ? id : fallback;
}

/** A new step of `kind`, ready to edit. `actionId` picks the registry action directly. */
export function blankStep(
  kind: StepKind,
  definition: AutomationDefinition,
  catalog: AutomationCatalog,
  actionId?: string,
): AutomationStep {
  const id = (base: string) => newStepId(definition, base);
  switch (kind) {
    case "condition":
      return {
        id: id("check"),
        name: "Only continue if",
        kind,
        match: "all",
        conditions: [{ path: "trigger", op: "exists" }],
      };
    case "branch":
      return {
        id: id("if"),
        name: "If / otherwise",
        kind,
        match: "all",
        conditions: [{ path: "trigger", op: "exists" }],
        then: [],
        else: [],
      };
    case "forEach":
      return { id: id("each"), name: "For each item", kind, items: "", maxItems: 50, steps: [] };
    case "delay":
      return { id: id("wait"), name: "Wait", kind, amount: 1, unit: "days" };
    case "map":
      return { id: id("prepare"), name: "Prepare values", kind, fields: {} };
    case "approval":
      return {
        id: id("approval"),
        name: "Owner approves",
        kind,
        approvers: { roles: ["owner"] },
        message: "Approve this?",
        timeoutHours: 72,
      };
    case "notify":
      return {
        id: id("notify"),
        name: "Email the owners",
        kind,
        to: { roles: ["owner"] },
        subject: "",
        body: "",
      };
    case "email.send":
      return { id: id("email"), name: "Send email", kind, to: "", subject: "", body: "" };
    case "ai.generate":
      return {
        id: id("ai"),
        name: "Ask AI",
        kind,
        instruction: "",
        input: "",
        output: "text",
        fields: [],
      };
    case "http.request":
      return {
        id: id("http"),
        name: "Call a web address",
        kind,
        method: "POST",
        url: "https://",
        headers: {},
        failOnError: true,
      };
    case "zapier.send":
      return {
        id: id("send_to_zapier"),
        name: "Send to Zapier",
        kind,
        connectionId: catalog.zapierHooks.find((h) => h.status === "active")?.id ?? null,
        body: {},
      };
    case "action": {
      const action =
        catalog.actions.find((a) => a.actionId === actionId) ??
        catalog.actions.find((a) => !a.readOnly) ??
        catalog.actions[0];
      return {
        id: id(slugify(action?.title ?? "", "action")),
        name: action?.title ?? "Action",
        kind,
        actionId: action?.actionId ?? "profile.update",
        input: {},
      };
    }
  }
}

/** A short line for the schedule trigger. */
export function scheduleLine(trigger: AutomationTrigger): string | null {
  return trigger.kind === "schedule" ? describeSchedule(trigger) : null;
}

/** Whether a step kind holds other steps (Branch, For each). */
export function isContainer(kind: StepKind): boolean {
  return CONTAINER_STEP_KINDS.includes(kind);
}

/** Every real effect the draft has when it runs, in plain words, for the live test and publish. */
export function effectsOf(definition: AutomationDefinition, catalog: AutomationCatalog): string[] {
  return flattenSteps(definition.steps).flatMap(({ step }) => {
    switch (step.kind) {
      case "action": {
        const action = catalog.actions.find((a) => a.actionId === step.actionId);
        return action && !action.readOnly ? [`${step.name}: changes data (${action.title})`] : [];
      }
      case "email.send":
        return [`${step.name}: emails ${step.to || "…"}`];
      case "notify":
        return [`${step.name}: emails ${approversText(step.to, catalog)}`];
      case "http.request":
        return [`${step.name}: sends a ${step.method} request to ${step.url || "an address"}`];
      case "ai.generate":
        return [`${step.name}: uses AI (counts toward the AI budget)`];
      case "zapier.send": {
        const hook = catalog.zapierHooks.find((h) => h.id === step.connectionId);
        return [`${step.name}: posts to Zapier (${hook?.name ?? "no hook chosen yet"})`];
      }
      default:
        return [];
    }
  });
}
