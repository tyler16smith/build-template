import { z } from "zod";
import {
  conditionSchema,
  jsonValueSchema,
  referencePathSchema,
  type Condition,
  type ConditionOperator,
  type JsonValue,
} from "./conditions";
import { Role } from "./schemas";
import {
  EVENT_TYPE_PATTERN,
  PROVIDER_PATTERN,
  type ZapierConnectionStatus,
  type ZapierDirection,
} from "./zapier";

export {
  CONDITION_OPERATORS,
  conditionSchema,
  jsonValueSchema,
  referencePathSchema,
  type Condition,
  type ConditionOperator,
  type JsonValue,
} from "./conditions";

/**
 * Automations (`specs/ai.md`, ported from Custombase): a definition is data, not code. The
 * Automation Builder writes it with `save_draft`, the visual editor renders it, and the Workflow
 * runs an immutable published version of it. `validateDefinition` (server) checks every save.
 */
export const AUTOMATION_LIMITS = {
  /** Every step counts, including the ones inside Branch and For each. */
  maxSteps: 40,
  /** Branches and loops nest at most this deep. */
  maxNesting: 3,
  maxDefinitionBytes: 96_000,
  maxPayloadBytes: 64_000,
  maxStoredValueBytes: 32_000,
  maxChainDepth: 3,
  defaultMaxRunsPerHour: 60,
  maxRunsPerHourCeiling: 500,
  maxAutomationsPerEvent: 20,
  maxApprovalHours: 720,
  /** Delay steps wait at most this long. */
  maxDelayDays: 90,
  maxLoopItems: 100,
  httpTimeoutSeconds: 15,
  maxHttpResponseBytes: 256_000,
  consecutiveFailuresBeforeStop: 5,
} as const;

/** `profile.update`, `jobs.complete`: an action id from the registry. */
export const actionIdSchema = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/, "use an action id like profile.update");

/** `profile.updated`: an event an action declares. */
export const eventIdSchema = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9_]*(\.[a-z][a-zA-Z0-9_]*)+$/, "use an event id like profile.updated");

export const automationStepIdSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{0,39}$/,
    "step ids are lowercase words joined by underscores, e.g. send_email",
  );

export const TRIGGER_FIELD_TYPES = ["text", "number", "boolean", "email", "datetime"] as const;
export type TriggerFieldType = (typeof TRIGGER_FIELD_TYPES)[number];

export const triggerFieldSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,40}$/),
  label: z.string().min(1).max(80),
  type: z.enum(TRIGGER_FIELD_TYPES).default("text"),
  required: z.boolean().default(false),
});
export type TriggerField = z.infer<typeof triggerFieldSchema>;

export const SCHEDULE_FREQUENCIES = ["hourly", "daily", "weekly", "monthly"] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

export const scheduleTriggerSchema = z.strictObject({
  kind: z.literal("schedule"),
  frequency: z.enum(SCHEDULE_FREQUENCIES).default("daily"),
  /** Local time of day for daily, weekly and monthly schedules. */
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use a 24-hour time like 09:00")
    .default("09:00"),
  /** Minute past the hour for hourly schedules. */
  minute: z.number().int().min(0).max(59).default(0),
  /** Weekly: 0 is Sunday … 6 is Saturday. */
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([1]),
  /** Monthly: the day of the month; 31 means the last day in shorter months. */
  dayOfMonth: z.number().int().min(1).max(31).default(1),
  /** An IANA time zone, e.g. America/New_York. */
  timezone: z.string().min(1).max(64).default("UTC"),
});
export type ScheduleTrigger = z.infer<typeof scheduleTriggerSchema>;

export const automationTriggerSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("manual"),
    fields: z.array(triggerFieldSchema).max(20).default([]),
  }),
  /** An event an action declares (`profile.updated`), after the action succeeds. */
  z.strictObject({
    kind: z.literal("app.event"),
    eventId: eventIdSchema,
    when: z.array(conditionSchema).max(10).default([]),
  }),
  scheduleTriggerSchema,
  z.strictObject({
    kind: z.literal("webhook"),
    fields: z.array(triggerFieldSchema).max(20).default([]),
  }),
  /**
   * An event another system sent through a Zapier inbound connection. Empty `provider` or
   * `eventType`, or a null `connectionId`, matches any.
   */
  z.strictObject({
    kind: z.literal("zapier.event"),
    connectionId: z.string().min(1).max(64).nullable().default(null),
    provider: z
      .string()
      .refine(
        (v) => v === "" || PROVIDER_PATTERN.test(v),
        "use a short lowercase name like hubspot",
      )
      .default(""),
    eventType: z
      .string()
      .refine(
        (v) => v === "" || EVENT_TYPE_PATTERN.test(v),
        "use lowercase words joined by dots or underscores, like deal.closed_won",
      )
      .default(""),
    when: z.array(conditionSchema).max(10).default([]),
  }),
]);
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;
export type TriggerKind = AutomationTrigger["kind"];

export const retryPolicySchema = z.strictObject({
  limit: z.number().int().min(0).max(10),
  delaySeconds: z.number().int().min(1).max(3600),
  backoff: z.enum(["constant", "linear", "exponential"]),
});
export type RetryPolicy = z.infer<typeof retryPolicySchema>;

const stepBase = {
  id: automationStepIdSchema,
  name: z.string().min(1).max(80),
  /** The step is skipped unless every condition holds. */
  runIf: z.array(conditionSchema).max(10).optional(),
  retry: retryPolicySchema.optional(),
  timeoutSeconds: z.number().int().min(5).max(900).optional(),
};

export const approversSchema = z.union([
  z.strictObject({ roles: z.array(Role).min(1) }),
  z.strictObject({ userIds: z.array(z.string().min(1)).min(1).max(20) }),
]);
export type Approvers = z.infer<typeof approversSchema>;

export const DELAY_UNITS = ["minutes", "hours", "days"] as const;
export type DelayUnit = (typeof DELAY_UNITS)[number];

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const AI_FIELD_TYPES = ["text", "number", "boolean", "list"] as const;

export const aiOutputFieldSchema = z.strictObject({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/),
  type: z.enum(AI_FIELD_TYPES).default("text"),
  description: z.string().max(300).default(""),
});
export type AiOutputField = z.infer<typeof aiOutputFieldSchema>;

type StepBase = {
  id: string;
  name: string;
  runIf?: Condition[];
  retry?: RetryPolicy;
  timeoutSeconds?: number;
};

/** The step kinds, with the shape each one is stored in. Branch and For each hold steps. */
export type AutomationStep = StepBase &
  (
    | { kind: "condition"; match: "all" | "any"; conditions: Condition[] }
    | { kind: "map"; fields: Record<string, JsonValue> }
    | { kind: "approval"; approvers: Approvers; message: string; timeoutHours: number }
    | { kind: "action"; actionId: string; input: Record<string, JsonValue> }
    | { kind: "delay"; amount: number; unit: DelayUnit; until?: string }
    | {
        kind: "branch";
        match: "all" | "any";
        conditions: Condition[];
        then: AutomationStep[];
        else: AutomationStep[];
      }
    | { kind: "forEach"; items: string; maxItems: number; steps: AutomationStep[] }
    | {
        kind: "http.request";
        method: HttpMethod;
        url: string;
        headers: Record<string, string>;
        body?: JsonValue;
        failOnError: boolean;
      }
    | {
        kind: "ai.generate";
        instruction: string;
        input: string;
        output: "text" | "fields";
        fields: AiOutputField[];
      }
    | { kind: "notify"; to: Approvers; subject: string; body: string }
    | { kind: "email.send"; to: string; subject: string; body: string }
    | { kind: "zapier.send"; connectionId: string | null; body: Record<string, JsonValue> }
  );
export type StepKind = AutomationStep["kind"];

/** What a step looks like before defaults are applied (drafts from chat, the editor). */
export type AutomationStepInput = StepBase & { kind: StepKind } & Record<string, unknown>;

const fieldKey = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/);

const stepSchemas = () =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      ...stepBase,
      kind: z.literal("condition"),
      match: z.enum(["all", "any"]).default("all"),
      conditions: z.array(conditionSchema).min(1).max(10),
    }),
    z.strictObject({
      ...stepBase,
      kind: z.literal("map"),
      fields: z.record(fieldKey, jsonValueSchema),
    }),
    z.strictObject({
      ...stepBase,
      kind: z.literal("approval"),
      approvers: approversSchema,
      message: z.string().max(2000),
      timeoutHours: z.number().int().min(1).max(AUTOMATION_LIMITS.maxApprovalHours).default(72),
    }),
    z.strictObject({
      ...stepBase,
      kind: z.literal("action"),
      actionId: actionIdSchema,
      input: z.record(z.string().max(80), jsonValueSchema).default({}),
    }),
    z.strictObject({
      ...stepBase,
      kind: z.literal("delay"),
      amount: z.number().int().min(1).max(10_000).default(1),
      unit: z.enum(DELAY_UNITS).default("hours"),
      /** Wait until this date and time instead (a template, e.g. {{trigger.data.dueAt}}). */
      until: z.string().min(1).max(300).optional(),
    }),
    z.strictObject({
      ...stepBase,
      kind: z.literal("branch"),
      match: z.enum(["all", "any"]).default("all"),
      conditions: z.array(conditionSchema).min(1).max(10),
      then: z.array(automationStepSchema).max(AUTOMATION_LIMITS.maxSteps).default([]),
      else: z.array(automationStepSchema).max(AUTOMATION_LIMITS.maxSteps).default([]),
    }),
    z.strictObject({
      ...stepBase,
      kind: z.literal("forEach"),
      /** A reference to a list, e.g. {{trigger.data.lineItems}}. */
      items: z.string().min(1).max(300),
      maxItems: z.number().int().min(1).max(AUTOMATION_LIMITS.maxLoopItems).default(50),
      steps: z.array(automationStepSchema).max(AUTOMATION_LIMITS.maxSteps).default([]),
    }),
    z.strictObject({
      ...stepBase,
      kind: z.literal("http.request"),
      method: z.enum(HTTP_METHODS).default("POST"),
      url: z.string().min(1).max(2000),
      headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,80}$/), z.string().max(2000)).default({}),
      body: jsonValueSchema.optional(),
      failOnError: z.boolean().default(true),
    }),
    z.strictObject({
      ...stepBase,
      kind: z.literal("ai.generate"),
      instruction: z.string().min(1).max(4000),
      /** What the model reads, usually references to earlier data. */
      input: z.string().max(12_000).default(""),
      output: z.enum(["text", "fields"]).default("text"),
      fields: z.array(aiOutputFieldSchema).max(20).default([]),
    }),
    z.strictObject({
      ...stepBase,
      kind: z.literal("notify"),
      /** Members by role or by id; each gets an email. */
      to: approversSchema,
      subject: z.string().min(1).max(200),
      body: z.string().max(4000).default(""),
    }),
    z.strictObject({
      ...stepBase,
      kind: z.literal("email.send"),
      /** Comma-separated addresses; each gets their own copy. */
      to: z.string().min(1).max(1000),
      subject: z.string().min(1).max(200),
      body: z.string().min(1).max(4000),
    }),
    z.strictObject({
      ...stepBase,
      kind: z.literal("zapier.send"),
      /** An outbound Zapier connection (a saved Catch Hook). */
      connectionId: z.string().min(1).max(64).nullable().default(null),
      /** The JSON body, field by field: values or templates. */
      body: z.record(fieldKey, jsonValueSchema).default({}),
    }),
  ]);

export const automationStepSchema: z.ZodType<AutomationStep, AutomationStepInput> = z.lazy(
  stepSchemas,
) as unknown as z.ZodType<AutomationStep, AutomationStepInput>;

export const automationDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: z.string().min(1).max(80),
  description: z.string().max(1000).default(""),
  trigger: automationTriggerSchema,
  steps: z.array(automationStepSchema).max(AUTOMATION_LIMITS.maxSteps),
  settings: z
    .strictObject({
      maxRunsPerHour: z
        .number()
        .int()
        .min(1)
        .max(AUTOMATION_LIMITS.maxRunsPerHourCeiling)
        .default(AUTOMATION_LIMITS.defaultMaxRunsPerHour),
    })
    .default({ maxRunsPerHour: AUTOMATION_LIMITS.defaultMaxRunsPerHour }),
});
export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;
export type AutomationDefinitionInput = z.input<typeof automationDefinitionSchema>;

export function emptyDefinition(name = "Untitled automation"): AutomationDefinition {
  return {
    schemaVersion: 1,
    name,
    description: "",
    trigger: { kind: "manual", fields: [] },
    steps: [],
    settings: { maxRunsPerHour: AUTOMATION_LIMITS.defaultMaxRunsPerHour },
  };
}

/** Step kinds with effects outside the interpreter; everything else is computed or waits. */
export const EFFECTFUL_STEP_KINDS: readonly StepKind[] = [
  "action",
  "http.request",
  "ai.generate",
  "notify",
  "email.send",
  "zapier.send",
];

/** Step kinds that hold other steps. */
export const CONTAINER_STEP_KINDS: readonly StepKind[] = ["branch", "forEach"];

/**
 * The webhook trigger's headers: the Unix-seconds timestamp, `sha256=<hex HMAC-SHA256 of
 * "<timestamp>.<body>">` with the automation's secret, and an optional delivery id (repeats are
 * ignored). Requests more than 5 minutes old are refused.
 */
export const WEBHOOK_HEADERS = {
  timestamp: "x-webhook-timestamp",
  signature: "x-webhook-signature",
  delivery: "x-webhook-delivery",
} as const;

export const DEFAULT_RETRY: RetryPolicy = { limit: 3, delaySeconds: 5, backoff: "exponential" };
export const DEFAULT_STEP_TIMEOUT_SECONDS = 120;

// ---------- nested steps ----------

/** The step lists directly inside a step: Branch's then and else, For each's steps. */
export function childLists(
  step: AutomationStep,
): { key: "then" | "else" | "steps"; steps: AutomationStep[] }[] {
  if (step.kind === "branch")
    return [
      { key: "then", steps: step.then },
      { key: "else", steps: step.else },
    ];
  if (step.kind === "forEach") return [{ key: "steps", steps: step.steps }];
  return [];
}

export type FlatStep = {
  step: AutomationStep;
  /** Dotted path in the definition, e.g. `steps.2.then.0`. */
  path: string;
  depth: number;
  /** Ids of the Branch and For each steps that contain it, outermost first. */
  ancestors: string[];
  /** The innermost For each around it, if any. */
  loopId: string | null;
};

/** Every step in execution order (a container before its children), with where it sits. */
export function flattenSteps(steps: AutomationStep[], prefix = "steps"): FlatStep[] {
  const out: FlatStep[] = [];
  const walk = (
    list: AutomationStep[],
    at: string,
    depth: number,
    ancestors: string[],
    loopId: string | null,
  ) => {
    list.forEach((step, index) => {
      const path = `${at}.${index}`;
      out.push({ step, path, depth, ancestors, loopId });
      for (const child of childLists(step))
        walk(
          child.steps,
          `${path}.${child.key}`,
          depth + 1,
          [...ancestors, step.id],
          step.kind === "forEach" ? step.id : loopId,
        );
    });
  };
  walk(steps, prefix, 0, [], null);
  return out;
}

export function findStep(steps: AutomationStep[], id: string): AutomationStep | undefined {
  return flattenSteps(steps).find((f) => f.step.id === id)?.step;
}

/** Returns the steps with `id` replaced by `next(step)` wherever it is nested (null removes it). */
export function updateStep(
  steps: AutomationStep[],
  id: string,
  next: (step: AutomationStep) => AutomationStep | null,
): AutomationStep[] {
  return steps.flatMap((step) => {
    if (step.id === id) {
      const replaced = next(step);
      return replaced ? [replaced] : [];
    }
    if (step.kind === "branch")
      return [
        { ...step, then: updateStep(step.then, id, next), else: updateStep(step.else, id, next) },
      ];
    if (step.kind === "forEach") return [{ ...step, steps: updateStep(step.steps, id, next) }];
    return [step];
  });
}

/** Where a step list lives: the top level, or a container's then, else or steps. */
export type StepListRef = { parentId: string | null; key: "then" | "else" | "steps" | null };

export function stepListAt(steps: AutomationStep[], ref: StepListRef): AutomationStep[] {
  if (!ref.parentId) return steps;
  const parent = findStep(steps, ref.parentId);
  if (!parent) return [];
  return childLists(parent).find((c) => c.key === ref.key)?.steps ?? [];
}

/** Returns the steps with the list at `ref` replaced. */
export function replaceStepList(
  steps: AutomationStep[],
  ref: StepListRef,
  list: AutomationStep[],
): AutomationStep[] {
  if (!ref.parentId) return list;
  return updateStep(steps, ref.parentId, (parent) =>
    parent.kind === "branch" && (ref.key === "then" || ref.key === "else")
      ? { ...parent, [ref.key]: list }
      : parent.kind === "forEach" && ref.key === "steps"
        ? { ...parent, steps: list }
        : parent,
  );
}

// ---------- schedules ----------

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function validTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

type LocalParts = {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock date and time at `date` in `timezone`. */
export function localParts(date: Date, timezone: string): LocalParts {
  let format = formatters.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timezone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? ""),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Whether a schedule fires in the minute that contains `date`. */
export function scheduleMatches(trigger: ScheduleTrigger, date: Date): boolean {
  const local = localParts(date, validTimeZone(trigger.timezone) ? trigger.timezone : "UTC");
  if (trigger.frequency === "hourly") return local.minute === trigger.minute;
  const [hour, minute] = trigger.time.split(":").map(Number);
  if (local.hour !== hour || local.minute !== minute) return false;
  if (trigger.frequency === "weekly") return trigger.weekdays.includes(local.weekday);
  if (trigger.frequency === "monthly")
    return local.day === Math.min(trigger.dayOfMonth, daysInMonth(local.year, local.month));
  return true;
}

/** The first minute at or after `from` when the schedule fires, within about five weeks. */
export function nextScheduledRun(trigger: ScheduleTrigger, from: Date): Date | null {
  // Every real time zone's offset is a multiple of 15 minutes: once a minute lines up with the
  // local minute the schedule names, every later match is a whole number of 15 minutes away.
  const start = new Date(Math.ceil(from.getTime() / 60_000) * 60_000);
  for (let i = 0; i < 60; i++) {
    const candidate = new Date(start.getTime() + i * 60_000);
    if (scheduleMatches(trigger, candidate)) return candidate;
    const local = localParts(candidate, validTimeZone(trigger.timezone) ? trigger.timezone : "UTC");
    const target = trigger.frequency === "hourly" ? trigger.minute : Number(trigger.time.slice(3));
    if (local.minute === target) {
      for (let step = 0; step < 36 * 24 * 4; step++) {
        const at = new Date(candidate.getTime() + step * 15 * 60_000);
        if (scheduleMatches(trigger, at)) return at;
      }
      return null;
    }
  }
  return null;
}

export function describeSchedule(trigger: ScheduleTrigger): string {
  const zone = trigger.timezone === "UTC" ? "UTC" : trigger.timezone.replace(/_/g, " ");
  if (trigger.frequency === "hourly")
    return `Every hour at ${String(trigger.minute).padStart(2, "0")} minutes past (${zone})`;
  const at = `at ${trigger.time} (${zone})`;
  if (trigger.frequency === "daily") return `Every day ${at}`;
  if (trigger.frequency === "weekly") {
    const days = [...trigger.weekdays].sort().map((d) => WEEKDAY_NAMES[d]);
    const list =
      days.length === 5 && !trigger.weekdays.includes(0) && !trigger.weekdays.includes(6)
        ? "weekday"
        : days.join(", ");
    return `Every ${list} ${at}`;
  }
  const day = trigger.dayOfMonth >= 31 ? "the last day" : `day ${trigger.dayOfMonth}`;
  return `Monthly on ${day} ${at}`;
}

// ---------- statuses ----------

export const AUTOMATION_STATUSES = ["draft", "active", "paused", "failed"] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

export const RUN_MODES = ["live", "simulated", "live_test"] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "waiting",
  "succeeded",
  "failed",
  "rejected",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STEP_RUN_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "simulated",
  "skipped",
  "stopped",
  "waiting",
  "failed",
  "rejected",
] as const;
export type StepRunStatus = (typeof STEP_RUN_STATUSES)[number];

export function isRunOpen(status: RunStatus): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "waiting_approval" ||
    status === "waiting"
  );
}

// ---------- issues and diffs ----------

export type AutomationIssue = {
  severity: "error" | "warning";
  message: string;
  /** Dotted path in the definition, e.g. `steps.2.input.title`. */
  path?: string;
  stepId?: string;
  /** A fix the UI can offer: set up a Zapier connection. */
  fix?: { kind: "zapier"; direction: ZapierDirection };
  /** A draft is expected to start incomplete; the editor shows these as next steps, not faults. */
  incomplete?: boolean;
};

export type DefinitionDiff = {
  nameChanged: boolean;
  triggerChanged: boolean;
  settingsChanged: boolean;
  added: { id: string; name: string; kind: StepKind }[];
  removed: { id: string; name: string; kind: StepKind }[];
  changed: { id: string; name: string; kind: StepKind; fields: string[] }[];
  reordered: boolean;
};

export function diffDefinitions(
  before: AutomationDefinition,
  after: AutomationDefinition,
): DefinitionDiff {
  const beforeSteps = flattenSteps(before.steps).map((f) => f.step);
  const afterSteps = flattenSteps(after.steps).map((f) => f.step);
  const beforeById = new Map(beforeSteps.map((s) => [s.id, s]));
  const afterById = new Map(afterSteps.map((s) => [s.id, s]));
  // A container's children are compared on their own, not as part of the container.
  const own = (s: AutomationStep): Record<string, unknown> => {
    const { then: _t, else: _e, steps: _s, ...rest } = s as Record<string, unknown>;
    return rest;
  };
  const summary = (s: AutomationStep) => ({ id: s.id, name: s.name, kind: s.kind });
  const changed: DefinitionDiff["changed"] = [];
  for (const step of afterSteps) {
    const previous = beforeById.get(step.id);
    if (!previous) continue;
    const a = own(previous);
    const b = own(step);
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const fields = [...keys].filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
    if (fields.length) changed.push({ ...summary(step), fields });
  }
  const commonBefore = beforeSteps.filter((s) => afterById.has(s.id)).map((s) => s.id);
  const commonAfter = afterSteps.filter((s) => beforeById.has(s.id)).map((s) => s.id);
  return {
    nameChanged: before.name !== after.name || before.description !== after.description,
    triggerChanged: JSON.stringify(before.trigger) !== JSON.stringify(after.trigger),
    settingsChanged: JSON.stringify(before.settings) !== JSON.stringify(after.settings),
    added: afterSteps.filter((s) => !beforeById.has(s.id)).map(summary),
    removed: beforeSteps.filter((s) => !afterById.has(s.id)).map(summary),
    changed,
    reordered: commonBefore.join(",") !== commonAfter.join(","),
  };
}

export function describeDiff(diff: DefinitionDiff): string {
  const parts: string[] = [];
  if (diff.triggerChanged) parts.push("changed the trigger");
  if (diff.added.length) parts.push(`added ${diff.added.map((s) => `“${s.name}”`).join(", ")}`);
  if (diff.removed.length)
    parts.push(`removed ${diff.removed.map((s) => `“${s.name}”`).join(", ")}`);
  if (diff.changed.length)
    parts.push(`edited ${diff.changed.map((s) => `“${s.name}”`).join(", ")}`);
  if (diff.reordered) parts.push("reordered steps");
  if (diff.nameChanged) parts.push("renamed it");
  if (diff.settingsChanged) parts.push("changed its limits");
  return parts.length ? parts.join("; ") : "no changes";
}

// ---------- references, templates and conditions ----------

const TEMPLATE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const WHOLE_TEMPLATE = /^\{\{\s*([^{}]+?)\s*\}\}$/;

export const TEMPLATE_HELPERS = [
  "default",
  "upper",
  "lower",
  "trim",
  "truncate",
  "date",
  "addMinutes",
  "addHours",
  "addDays",
  "number",
  "round",
  "count",
  "first",
  "last",
  "join",
  "pluck",
  "json",
] as const;
type TemplateHelper = (typeof TEMPLATE_HELPERS)[number];

export type TemplateScope = {
  trigger: unknown;
  steps: Record<string, { output: unknown } | undefined>;
  run: { id: string; startedAt: string };
  /** Inside a For each step: the current item and its position (from 0). */
  loop?: { item: unknown; index: number; count: number };
};

export class TemplateError extends Error {}

type ParsedExpression = { path: string; helpers: { name: string; arg: string | number | null }[] };

function parseArg(raw: string | undefined): string | number | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  const quoted = /^"(.*)"$|^'(.*)'$/.exec(text);
  return quoted ? (quoted[1] ?? quoted[2] ?? "") : text;
}

export function parseExpression(expression: string): ParsedExpression {
  const [rawPath, ...rawHelpers] = expression.split("|");
  const path = (rawPath ?? "").trim();
  if (!referencePathSchema.safeParse(path).success)
    throw new TemplateError(`“${path}” is not a valid reference`);
  const helpers = rawHelpers.map((raw) => {
    const colon = raw.indexOf(":");
    const name = (colon < 0 ? raw : raw.slice(0, colon)).trim();
    if (!(TEMPLATE_HELPERS as readonly string[]).includes(name))
      throw new TemplateError(`Unknown helper “${name}” (use ${TEMPLATE_HELPERS.join(", ")})`);
    return { name, arg: colon < 0 ? null : parseArg(raw.slice(colon + 1)) };
  });
  return { path, helpers };
}

/** Every `{{ … }}` expression inside a value, with where it sits. */
export function collectReferences(value: unknown, at = ""): { at: string; expression: string }[] {
  if (typeof value === "string")
    return [...value.matchAll(TEMPLATE_PATTERN)].map((m) => ({ at, expression: m[1]! }));
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      collectReferences(item, at ? `${at}.${index}` : String(index)),
    );
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, item]) =>
      collectReferences(item, at ? `${at}.${key}` : key),
    );
  return [];
}

export function readPath(scope: unknown, path: string): unknown {
  let current: unknown = scope;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current))
      current = /^\d+$/.test(segment) ? current[Number(segment)] : undefined;
    else if (typeof current === "object")
      current = Object.hasOwn(current, segment)
        ? (current as Record<string, unknown>)[segment]
        : undefined;
    else return undefined;
  }
  return current;
}

function toDate(value: unknown): Date {
  const date =
    value === "now" || value === undefined || value === null ? new Date() : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new TemplateError(`“${String(value)}” is not a date`);
  return date;
}

function applyHelper(value: unknown, name: TemplateHelper, arg: string | number | null): unknown {
  switch (name) {
    case "default":
      return value === undefined || value === null || value === "" ? arg : value;
    case "upper":
      return typeof value === "string" ? value.toUpperCase() : value;
    case "lower":
      return typeof value === "string" ? value.toLowerCase() : value;
    case "trim":
      return typeof value === "string" ? value.trim() : value;
    case "truncate": {
      const limit = Math.max(1, Number(arg ?? 100));
      return typeof value === "string" && value.length > limit
        ? `${value.slice(0, limit - 1)}…`
        : value;
    }
    case "date":
      return toDate(value).toISOString().slice(0, 10);
    case "addMinutes":
      return new Date(toDate(value).getTime() + Number(arg ?? 0) * 60_000).toISOString();
    case "addHours":
      return new Date(toDate(value).getTime() + Number(arg ?? 0) * 3_600_000).toISOString();
    case "addDays":
      return new Date(toDate(value).getTime() + Number(arg ?? 0) * 86_400_000).toISOString();
    case "number": {
      const numeric = typeof value === "number" ? value : Number(String(value ?? "").trim());
      return Number.isNaN(numeric) ? null : numeric;
    }
    case "round": {
      const numeric = Number(value);
      if (Number.isNaN(numeric)) return value;
      const places = 10 ** Number(arg ?? 0);
      return Math.round(numeric * places) / places;
    }
    case "count":
      return Array.isArray(value)
        ? value.length
        : typeof value === "string"
          ? value.length
          : value && typeof value === "object"
            ? Object.keys(value).length
            : 0;
    case "first":
      return Array.isArray(value) ? value[0] : value;
    case "last":
      return Array.isArray(value) ? value[value.length - 1] : value;
    case "join":
      return Array.isArray(value)
        ? value.map((item) => interpolated(item)).join(arg === null ? ", " : String(arg))
        : value;
    case "pluck":
      return Array.isArray(value) && arg !== null
        ? value.map((item) => readPath(item, String(arg)))
        : value;
    case "json":
      return JSON.stringify(value ?? null);
  }
}

export function evaluateExpression(expression: string, scope: TemplateScope): unknown {
  const parsed = parseExpression(expression);
  return parsed.helpers.reduce<unknown>(
    (value, helper) => applyHelper(value, helper.name as TemplateHelper, helper.arg),
    readPath(scope, parsed.path),
  );
}

function interpolated(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : JSON.stringify(value);
}

/**
 * Substitutes references in a configured value. Substituted text is never scanned again, so
 * data from records, emails or webhooks can't inject references of its own.
 */
export function resolveValue(value: unknown, scope: TemplateScope): unknown {
  if (typeof value === "string") {
    const whole = WHOLE_TEMPLATE.exec(value);
    if (whole) return evaluateExpression(whole[1]!, scope);
    return value.replace(TEMPLATE_PATTERN, (_match, expression: string) =>
      interpolated(evaluateExpression(expression, scope)),
    );
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, scope));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveValue(item, scope)]),
    );
  return value;
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function comparable(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    if (!Number.isNaN(numeric)) return numeric;
    const date = Date.parse(value);
    if (!Number.isNaN(date)) return date;
  }
  return null;
}

function looselyEqual(actual: unknown, expected: unknown): boolean {
  if (actual !== null && typeof actual === "object")
    return JSON.stringify(actual) === JSON.stringify(expected);
  if (typeof actual === "string" && typeof expected === "string")
    return actual.trim().toLowerCase() === expected.trim().toLowerCase();
  return String(actual) === String(expected);
}

function containsValue(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) return actual.some((item) => looselyEqual(item, expected));
  return (
    typeof actual === "string" &&
    actual.toLowerCase().includes(String(expected ?? "").toLowerCase())
  );
}

export function evaluateCondition(condition: Condition, scope: TemplateScope): boolean {
  const actual = readPath(scope, condition.path);
  const expected = resolveValue(condition.value ?? null, scope);
  switch (condition.op) {
    case "equals":
      return looselyEqual(actual, expected);
    case "notEquals":
      return !looselyEqual(actual, expected);
    case "contains":
      return containsValue(actual, expected);
    case "notContains":
      return !containsValue(actual, expected);
    case "matches": {
      if (typeof expected !== "string" || expected.length > 200) return false;
      try {
        return new RegExp(expected, "i").test(interpolated(actual));
      } catch {
        return false;
      }
    }
    case "in":
      return Array.isArray(expected) && expected.some((item) => looselyEqual(actual, item));
    case "exists":
      return !isEmpty(actual);
    case "notExists":
      return isEmpty(actual);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = comparable(actual);
      const b = comparable(expected);
      if (a === null || b === null) return false;
      if (condition.op === "gt") return a > b;
      if (condition.op === "gte") return a >= b;
      if (condition.op === "lt") return a < b;
      return a <= b;
    }
  }
}

export function evaluateConditions(
  conditions: Condition[],
  scope: TemplateScope,
  match: "all" | "any" = "all",
): boolean {
  if (conditions.length === 0) return true;
  return match === "all"
    ? conditions.every((c) => evaluateCondition(c, scope))
    : conditions.some((c) => evaluateCondition(c, scope));
}

export function describeCondition(condition: Condition): string {
  const words: Record<ConditionOperator, string> = {
    equals: "is",
    notEquals: "is not",
    contains: "contains",
    notContains: "doesn't contain",
    in: "is one of",
    exists: "is set",
    notExists: "is empty",
    gt: "is greater than",
    gte: "is at least",
    lt: "is less than",
    lte: "is at most",
    matches: "matches",
  };
  const value =
    condition.op === "exists" || condition.op === "notExists"
      ? ""
      : ` ${JSON.stringify(condition.value ?? null)}`;
  return `${condition.path} ${words[condition.op]}${value}`;
}

// ---------- JSON Schema paths, for pickers and output checks ----------

export type SchemaPath = { path: string; type: string; description?: string };

type JsonSchemaNode = {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  description?: string;
  anyOf?: JsonSchemaNode[];
  enum?: unknown[];
};

/** Flattens an object schema into dotted paths (arrays expose index 0), up to `depth` levels. */
export function schemaPaths(schema: unknown, prefix: string, depth = 4): SchemaPath[] {
  const node = schema as JsonSchemaNode | undefined;
  if (!node || depth < 0) return [];
  const variant = node.anyOf?.find((v) => v.type !== "null") ?? node;
  const type = Array.isArray(variant.type)
    ? (variant.type.find((t) => t !== "null") ?? "any")
    : (variant.type ?? (variant.properties ? "object" : "any"));
  const here: SchemaPath[] = prefix
    ? [{ path: prefix, type, ...(variant.description ? { description: variant.description } : {}) }]
    : [];
  if (type === "object" && variant.properties) {
    return [
      ...here,
      ...Object.entries(variant.properties).flatMap(([key, child]) =>
        schemaPaths(child, prefix ? `${prefix}.${key}` : key, depth - 1),
      ),
    ];
  }
  if (type === "array" && variant.items)
    return [...here, ...schemaPaths(variant.items, `${prefix}.0`, depth - 1)];
  return here;
}

/** A plausible value for a JSON Schema, used for simulated outputs and sample test payloads. */
export function sampleFromSchema(schema: unknown, key = "value", depth = 5): unknown {
  const node = schema as
    (JsonSchemaNode & { format?: string; default?: unknown; examples?: unknown[] }) | undefined;
  if (!node || depth < 0) return null;
  if (node.default !== undefined) return node.default;
  if (node.examples?.length) return node.examples[0];
  if (node.enum?.length) return node.enum[0];
  const variant = node.anyOf?.find((v) => v.type !== "null") ?? node;
  const type = Array.isArray(variant.type)
    ? variant.type.find((t) => t !== "null")
    : (variant.type ?? (variant.properties ? "object" : undefined));
  switch (type) {
    case "object":
      return Object.fromEntries(
        Object.entries(variant.properties ?? {}).map(([k, child]) => [
          k,
          sampleFromSchema(child, k, depth - 1),
        ]),
      );
    case "array":
      return variant.items ? [sampleFromSchema(variant.items, key, depth - 1)] : [];
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return true;
    case "string": {
      const format = (variant as { format?: string }).format;
      if (format === "date-time") return new Date().toISOString();
      if (format === "email" || /email/i.test(key)) return "customer@example.com";
      if (key === "id" || key.endsWith("Id") || key.endsWith("_id")) return `sample_${key}`;
      return `Sample ${key}`;
    }
    default:
      return null;
  }
}

// ---------- capability catalog ----------

export type CatalogTrigger =
  | { kind: "manual"; title: string; description: string }
  | { kind: "webhook"; title: string; description: string }
  | { kind: "schedule"; title: string; description: string }
  | {
      kind: "zapier.event";
      title: string;
      description: string;
      connections: CatalogZapierConnection[];
      /** Event types recently received, with the data fields they carried. */
      seen: SeenZapierEvent[];
    }
  | {
      kind: "app.event";
      title: string;
      description: string;
      /** `profile.updated`. */
      eventId: string;
      /** The action that emits it. */
      actionId: string;
      payloadPaths: SchemaPath[];
    };

export type CatalogZapierConnection = {
  id: string;
  name: string;
  status: ZapierConnectionStatus;
  /** Whether a real event has ever arrived through it (inbound) or a send succeeded (outbound). */
  connected: boolean;
};

export type SeenZapierEvent = {
  connectionId: string;
  provider: string;
  eventType: string;
  lastSeenAt: string;
  /** `trigger.data.*` paths from the latest such event. */
  dataPaths: SchemaPath[];
};

/** A registry action an automation step can run, as this person may run it. */
export type CatalogAction = {
  kind: "action";
  actionId: string;
  title: string;
  description: string;
  readOnly: boolean;
  /** An agent asks before running it; the editor says so. */
  confirm: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  outputPaths: SchemaPath[];
};

export type CatalogLogic = {
  kind: "condition" | "map" | "approval" | "delay" | "branch" | "forEach";
  title: string;
  description: string;
};

/** Steps the product runs itself, with nothing to connect (except Zapier's hooks). */
export type CatalogBuiltinAction = {
  kind: "http.request" | "ai.generate" | "notify" | "email.send" | "zapier.send";
  title: string;
  description: string;
  outputPaths: SchemaPath[];
  status: "ready" | "unavailable";
  statusReason: string | null;
};

export type AutomationCatalog = {
  triggers: CatalogTrigger[];
  logic: CatalogLogic[];
  actions: CatalogAction[];
  builtinActions: CatalogBuiltinAction[];
  /** Outbound Zapier connections (Catch Hooks) a `zapier.send` step can post to. */
  zapierHooks: CatalogZapierConnection[];
  members: { id: string; name: string; role: Role }[];
};

/** What the Automation Builder agent is given on each turn. Contains no secrets. */
export type AutomationBuilderContext = {
  automation: {
    id: string;
    name: string;
    status: AutomationStatus;
    activeVersion: number | null;
    draftRevision: number;
  };
  draft: AutomationDefinition;
  issues: AutomationIssue[];
  catalog: AutomationCatalog;
  organization: { id: string; name: string };
  user: { id: string; name: string; role: Role };
  canEdit: boolean;
};

export type DraftSaveResult = {
  revision: number;
  issues: AutomationIssue[];
  diff: DefinitionDiff;
  summary: string;
};

export type RunStepView = {
  stepId: string;
  name: string;
  kind: StepKind | "trigger";
  status: StepRunStatus;
  simulated: boolean;
  attempts: number;
  input: unknown;
  output: unknown;
  error: string | null;
  hint: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type ApprovalView = {
  id: string;
  stepId: string;
  status: ApprovalStatus;
  message: string;
  decidedBy: string | null;
  decidedAt: string | null;
  canDecide: boolean;
};

export type RunView = {
  id: string;
  automationId: string;
  version: number;
  mode: RunMode;
  status: RunStatus;
  triggerKind: TriggerKind;
  currentStepId: string | null;
  error: string | null;
  fixHint: string | null;
  startedBy: string | null;
  runAsUserId: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  steps: RunStepView[];
  approvals: ApprovalView[];
};

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export type Person = { id: string; name: string };

export type AutomationSummary = {
  id: string;
  name: string;
  status: AutomationStatus;
  statusReason: string | null;
  trigger: AutomationTrigger;
  triggerTitle: string;
  stepCount: number;
  nextRunAt: string | null;
  owner: Person;
  runAs: Person | null;
  activeVersion: number | null;
  lastRunAt: string | null;
  lastRunStatus: RunStatus | null;
  runsToday: number;
  updatedAt: string;
};

export type ApprovalWaiting = {
  id: string;
  automationId: string;
  automationName: string;
  runId: string;
  message: string;
  createdAt: string;
};

export type AutomationList = {
  automations: AutomationSummary[];
  approvalsWaiting: ApprovalWaiting[];
  canManage: boolean;
};

export type AutomationVersionView = {
  version: number;
  publishedBy: string | null;
  notes: string | null;
  draftRevision: number;
  createdAt: string;
  definition: AutomationDefinition;
};

export type AutomationRevisionView = {
  revision: number;
  source: DraftSource;
  author: string | null;
  summary: string;
  createdAt: string;
  definition: AutomationDefinition;
};

export const DRAFT_SOURCES = ["chat", "ui", "system"] as const;
export type DraftSource = (typeof DRAFT_SOURCES)[number];

export type AutomationDetail = {
  automation: {
    id: string;
    name: string;
    status: AutomationStatus;
    statusReason: string | null;
    owner: Person;
    runAs: Person | null;
    activeVersion: number | null;
    draftRevision: number;
    lastRunAt: string | null;
    lastRunStatus: RunStatus | null;
    createdAt: string;
    updatedAt: string;
  };
  draft: AutomationDefinition;
  issues: AutomationIssue[];
  activeDefinition: AutomationDefinition | null;
  draftMatchesActive: boolean;
  versions: AutomationVersionView[];
  revisions: AutomationRevisionView[];
  /** The webhook trigger's URL, once published with one (managers only). */
  webhook: { url: string } | null;
  nextRunAt: string | null;
  catalog: AutomationCatalog;
  canManage: boolean;
};

// ---------- API inputs ----------

export const AutomationCreateInput = z.object({ name: z.string().trim().max(80).optional() });
export type AutomationCreateInput = z.infer<typeof AutomationCreateInput>;

export const DraftSaveInput = z.object({
  baseRevision: z.number().int().min(1),
  definition: z.unknown(),
  summary: z.string().max(500).optional(),
});
export type DraftSaveInput = z.infer<typeof DraftSaveInput>;

export const RestoreRevisionInput = z.object({
  revision: z.number().int().min(1),
  baseRevision: z.number().int().min(1),
});
export type RestoreRevisionInput = z.infer<typeof RestoreRevisionInput>;

export const PublishInput = z.object({
  /** The draft revision the person reviewed. */
  revision: z.number().int().min(1),
  notes: z.string().max(1000).optional(),
});
export type PublishInput = z.infer<typeof PublishInput>;

export const PauseInput = z.object({ paused: z.boolean() });
export type PauseInput = z.infer<typeof PauseInput>;

export const SimulateInput = z.object({ payload: z.unknown().optional() });
export type SimulateInput = z.infer<typeof SimulateInput>;

export const LiveTestInput = z.object({
  revision: z.number().int().min(1),
  payload: z.unknown().optional(),
  /** The person ticked the box that lists every real effect. */
  confirmEffects: z.literal(true),
});
export type LiveTestInput = z.infer<typeof LiveTestInput>;

export const RunManuallyInput = z.object({ fields: z.record(z.string(), z.unknown()).default({}) });
export type RunManuallyInput = z.infer<typeof RunManuallyInput>;

export const ApprovalDecisionInput = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().max(1000).optional(),
});
export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionInput>;

/** A trigger in plain words, using the catalog's titles when one is given. */
export function describeTrigger(
  trigger: AutomationTrigger,
  catalog?: Pick<AutomationCatalog, "triggers"> | null,
): string {
  const conditions =
    (trigger.kind === "app.event" || trigger.kind === "zapier.event") && trigger.when.length
      ? `, if ${trigger.when.map(describeCondition).join(" and ")}`
      : "";
  switch (trigger.kind) {
    case "manual":
      return "When someone runs it";
    case "webhook":
      return "When a signed webhook arrives";
    case "schedule":
      return describeSchedule(trigger);
    case "zapier.event": {
      const what = [trigger.provider, trigger.eventType].filter(Boolean).join(" · ");
      const source = catalog?.triggers.find((t) => t.kind === "zapier.event");
      const connection =
        source?.kind === "zapier.event" && trigger.connectionId
          ? source.connections.find((c) => c.id === trigger.connectionId)
          : null;
      return `When a Zapier event arrives${what ? `: ${what}` : ""}${
        connection ? ` (${connection.name})` : ""
      }${conditions}`;
    }
    case "app.event": {
      const match = catalog?.triggers.find(
        (t) => t.kind === "app.event" && t.eventId === trigger.eventId,
      );
      return match?.kind === "app.event"
        ? `${match.title}${conditions}`
        : `When ${trigger.eventId} happens${conditions}`;
    }
  }
}
