import {
  ActionError,
  AUTOMATION_LIMITS,
  emptyDefinition,
  isRunOpen,
  sampleFromSchema,
  zapierTriggerKey,
  type AutomationCatalog,
  type SchemaPath,
  type TriggerField,
  type ApprovalStatus,
  type Approvers,
  type AutomationDefinition,
  type AutomationIssue,
  type AutomationTrigger,
  type Role,
  type RunStatus,
} from "@template/contracts";

/**
 * Automations' rules (`apps/server/AGENTS.md`, "Functional core, imperative shell"): what a save,
 * publish, pause, approval or cancel may do, given what the shell read. Pure: the shell passes
 * `now` and writes what comes back.
 */

/** What dispatch looks an automation up by. */
export function triggerKeyOf(trigger: AutomationTrigger): string {
  if (trigger.kind === "app.event") return `app.event:${trigger.eventId}`;
  if (trigger.kind === "zapier.event") return zapierTriggerKey(trigger.provider, trigger.eventType);
  return trigger.kind;
}

/** Issues that stop a definition from being published or resumed. */
export function publishBlockers(issues: AutomationIssue[]): AutomationIssue[] {
  return issues.filter((i) => i.severity === "error");
}

/** Whether this person is one of an approval's approvers. */
export function approverAllowed(approvers: Approvers, viewer: { userId: string; role: Role }) {
  return "roles" in approvers
    ? approvers.roles.includes(viewer.role)
    : approvers.userIds.includes(viewer.userId);
}

/** A save builds on the revision the person last loaded, so chat and editor never overwrite each other. */
export function ensureDraftCurrent(automation: { draftRevision: number }, baseRevision: number) {
  if (baseRevision !== automation.draftRevision)
    throw new ActionError(
      "conflict",
      `The draft changed since revision ${baseRevision} (it's now at ${automation.draftRevision}). Reload it and apply the change again.`,
    );
}

/**
 * Publishing the revision the person reviewed, once it has no errors: the next version number, the
 * version row and the change to the automation. The publisher becomes the run-as person.
 */
export function publication(options: {
  automation: { draftRevision: number };
  reviewedRevision: number;
  checked: { definition: AutomationDefinition | null; issues: AutomationIssue[] };
  latestVersion: number | null;
  publisherId: string;
  notes?: string;
  now: Date;
}) {
  const { automation, reviewedRevision, checked, now } = options;
  if (automation.draftRevision !== reviewedRevision)
    throw new ActionError(
      "conflict",
      `The draft changed after you reviewed it (you reviewed revision ${reviewedRevision}; it's now ${automation.draftRevision}). Review it again before publishing.`,
    );
  const blockers = publishBlockers(checked.issues);
  if (!checked.definition || blockers.length)
    throw Object.assign(
      new ActionError(
        "invalid_input",
        `Fix ${blockers.length} problem${blockers.length === 1 ? "" : "s"} before publishing: ${blockers[0]?.message ?? ""}`,
      ),
      { issues: checked.issues },
    );
  const definition = checked.definition;
  const version = (options.latestVersion ?? 0) + 1;
  const triggerKey = triggerKeyOf(definition.trigger);
  return {
    version,
    definition,
    triggerKey,
    versionRow: {
      version,
      kind: "published" as const,
      definition,
      draftRevision: automation.draftRevision,
      publishedBy: options.publisherId,
      notes: options.notes?.slice(0, 1000) ?? null,
    },
    automationChange: {
      activeVersion: version,
      runAsUserId: options.publisherId,
      status: "active" as const,
      statusReason: null,
      triggerKey,
      consecutiveFailures: 0,
      updatedAt: now,
    },
  };
}

/** Only a published automation can be paused or resumed. */
export function ensurePublished(automation: {
  activeVersion: number | null;
  runAsUserId: string | null;
}): { activeVersion: number } {
  if (!automation.activeVersion || !automation.runAsUserId)
    throw new ActionError("conflict", "Publish this automation before pausing or resuming it.");
  return { activeVersion: automation.activeVersion };
}

/**
 * Pausing, or resuming once the published version still validates (an action it uses may have
 * gone, or a connection been removed). `resumeIssues` is null when pausing.
 */
export function pauseChange(paused: boolean, resumeIssues: AutomationIssue[] | null, now: Date) {
  const blockers = publishBlockers(resumeIssues ?? []);
  if (!paused && blockers.length)
    throw new ActionError(
      "invalid_input",
      `The published version can't run as it stands: ${blockers[0]!.message} Fix the draft and publish again.`,
    );
  return {
    status: paused ? ("paused" as const) : ("active" as const),
    statusReason: null,
    ...(paused ? {} : { consecutiveFailures: 0 }),
    updatedAt: now,
  };
}

/** A pending approval decided by one of its approvers. */
export function approvalDecision(
  approval: { approvers: Approvers; status: ApprovalStatus },
  viewer: { userId: string; role: Role },
  input: { decision: "approved" | "rejected"; note?: string },
  now: Date,
) {
  if (!approverAllowed(approval.approvers, viewer))
    throw new ActionError("forbidden", "You aren't one of the approvers for this step.");
  if (approval.status !== "pending")
    throw new ActionError("conflict", `This approval was already ${approval.status}.`);
  return {
    status: input.decision,
    decidedBy: viewer.userId,
    decidedAt: now,
    note: input.note?.slice(0, 1000) ?? null,
  };
}

/** Only a run that hasn't finished can be cancelled. */
export function ensureCancellable(run: { status: RunStatus }) {
  if (!isRunOpen(run.status)) throw new ActionError("conflict", `This run already ${run.status}.`);
}

/** A new automation: an empty draft as revision 1, owned by the person who started it. */
export function newAutomation(input: { name?: string }, ids: { id: string; ownerId: string }) {
  const draft = emptyDefinition(input.name?.trim() || "Untitled automation");
  return {
    draft,
    row: {
      id: ids.id,
      name: draft.name,
      status: "draft" as const,
      ownerId: ids.ownerId,
      draft,
      draftRevision: 1,
    },
    revision: {
      automationId: ids.id,
      revision: 1,
      definition: draft,
      source: "system" as const,
      authorId: ids.ownerId,
      summary: "Started a new automation",
    },
  };
}

/** Only a draft that was never published can be deleted; a published one is paused instead. */
export function ensureDeletable(automation: { status: string; activeVersion: number | null }) {
  if (automation.status !== "draft" || automation.activeVersion !== null)
    throw new ActionError("conflict", "Only drafts that were never published can be deleted.");
}

/** A live test runs the revision the person reviewed, once it has no errors. */
export function liveTestDefinition(
  automation: { draftRevision: number },
  reviewedRevision: number,
  checked: { definition: AutomationDefinition | null; issues: AutomationIssue[] },
): AutomationDefinition {
  if (automation.draftRevision !== reviewedRevision)
    throw new ActionError(
      "conflict",
      "The draft changed after you reviewed it. Review it again before a live test.",
    );
  if (!checked.definition || publishBlockers(checked.issues).length)
    throw new ActionError("invalid_input", "Fix the draft's problems before a live test.");
  return checked.definition;
}

/** A payload a run may carry. */
export function ensurePayloadSize(payload: unknown, message: string): void {
  if (JSON.stringify(payload ?? null).length > AUTOMATION_LIMITS.maxPayloadBytes)
    throw new ActionError("invalid_input", message);
}

/** Only an active, published automation can be run by hand. */
export function ensureRunnable(automation: {
  status: string;
  activeVersion: number | null;
  runAsUserId: string | null;
}): { activeVersion: number; runAsUserId: string } {
  if (automation.status !== "active" || !automation.activeVersion || !automation.runAsUserId)
    throw new ActionError("conflict", "Only an active, published automation can be run.");
  return { activeVersion: automation.activeVersion, runAsUserId: automation.runAsUserId };
}

const FIELD_CHECKS: Record<TriggerField["type"], (value: unknown) => boolean> = {
  text: (v) => typeof v === "string",
  number: (v) =>
    typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))),
  boolean: (v) => typeof v === "boolean" || v === "true" || v === "false",
  email: (v) => typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()),
  datetime: (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)),
};

/** Required fields present, and each provided field of its declared type. */
export function checkFieldValues(
  fields: TriggerField[],
  values: Record<string, unknown>,
): string[] {
  const problems: string[] = [];
  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined || value === null || value === "") {
      if (field.required) problems.push(`${field.label} is required.`);
      continue;
    }
    if (!FIELD_CHECKS[field.type](value))
      problems.push(
        `${field.label} should be ${field.type === "email" ? "an email address" : `a ${field.type}`}.`,
      );
  }
  return problems;
}

/** A manual run's fields, checked against the published trigger. */
export function ensureManualRun(definition: AutomationDefinition, fields: Record<string, unknown>) {
  if (definition.trigger.kind !== "manual")
    throw new ActionError("conflict", "This automation starts from its trigger, not by hand.");
  const problems = checkFieldValues(definition.trigger.fields, fields);
  if (problems.length) throw new ActionError("invalid_input", problems.join(" "));
}

/** A sample object shaped like the given `trigger.*` paths, for simulated tests. */
export function samplePathsObject(paths: SchemaPath[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const { path, type } of [...paths].sort((a, b) => a.path.length - b.path.length)) {
    const parts = path.split(".").slice(1);
    if (parts.length === 0) continue;
    let node: Record<string, unknown> = root;
    for (const [i, part] of parts.entries()) {
      if (i === parts.length - 1) {
        if (node[part] === undefined)
          node[part] =
            type === "object"
              ? {}
              : type === "array"
                ? []
                : sampleFromSchema({ type: type === "any" ? "string" : type }, part);
      } else {
        if (node[part] === undefined || typeof node[part] !== "object")
          node[part] = /^\d+$/.test(parts[i + 1] ?? "") ? [] : {};
        node = node[part] as Record<string, unknown>;
      }
    }
  }
  return root;
}

/**
 * A plausible trigger payload for a test: the latest real Zapier event when the shell found one,
 * otherwise one shaped from the catalog.
 */
export function samplePayload(
  definition: AutomationDefinition,
  catalog: Pick<AutomationCatalog, "triggers">,
  known: {
    actor: { id: string; name: string };
    organizationId: string;
    latestZapierPayload: unknown;
    now: Date;
  },
): unknown {
  const trigger = definition.trigger;
  const { actor } = known;
  const now = known.now.toISOString();
  switch (trigger.kind) {
    case "zapier.event": {
      if (known.latestZapierPayload) return known.latestZapierPayload;
      const source = catalog.triggers.find((t) => t.kind === "zapier.event");
      const seen =
        source?.kind === "zapier.event"
          ? source.seen.find(
              (e) =>
                (!trigger.provider || e.provider === trigger.provider) &&
                (!trigger.eventType || e.eventType === trigger.eventType),
            )
          : undefined;
      return {
        id: "sample",
        provider: trigger.provider || seen?.provider || "",
        eventType: trigger.eventType || seen?.eventType || "sample.event",
        organizationId: known.organizationId,
        connectionId: trigger.connectionId ?? "",
        connectionName: "Sample",
        occurredAt: now,
        receivedAt: now,
        data: (samplePathsObject(seen?.dataPaths ?? []).data as object | undefined) ?? {},
      };
    }
    case "app.event": {
      const event = catalog.triggers.find(
        (t) => t.kind === "app.event" && t.eventId === trigger.eventId,
      );
      return {
        ...(event?.kind === "app.event" ? samplePathsObject(event.payloadPaths) : {}),
        event: trigger.eventId,
        actor,
        caller: "web",
      };
    }
    case "schedule":
      return { scheduledFor: now, timezone: trigger.timezone };
    case "manual": {
      const sample = {
        text: "Sample text",
        number: 1,
        boolean: true,
        email: "someone@example.com",
        datetime: now,
      } as const;
      return {
        fields: Object.fromEntries(trigger.fields.map((f) => [f.key, sample[f.type]])),
        actor,
      };
    }
    case "webhook":
      return { body: {}, deliveryId: "sample", receivedAt: now };
  }
}
