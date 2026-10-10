import {
  ActionError,
  ALL_SCOPES,
  describeDiff,
  describeTrigger,
  diffDefinitions,
  flattenSteps,
  isRunOpen,
  nextScheduledRun,
  uuidv7,
  type AutomationBuilderContext,
  type AutomationCatalog,
  type AutomationDefinition,
  type AutomationDetail,
  type AutomationList,
  type DraftSaveResult,
  type DraftSource,
  type RunView,
  type TemplateScope,
} from "@template/contracts";
import {
  and,
  automationApprovals,
  automationDraftRevisions,
  automationRuns,
  automations,
  automationVersions,
  desc,
  eq,
  gte,
  isNull,
  organizations,
  type AutomationRow,
} from "@template/db";
import { findAction, runAction } from "../../actions/registry";
import { latestZapierPayload } from "../zapier/events";
import { buildCatalog } from "./catalog";
import { can, requirePermission } from "../../actions/permissions";
import { iso, type Scope } from "./context";
import {
  approvalDecision,
  approverAllowed,
  ensureCancellable,
  ensureDeletable,
  ensureDraftCurrent,
  ensureManualRun,
  ensurePayloadSize,
  ensurePublished,
  ensureRunnable,
  liveTestDefinition,
  newAutomation,
  pauseChange,
  publication,
  samplePayload,
} from "./core";
import { startRun, withinRateLimit } from "./dispatch";
import { StepFailure } from "./errors";
import { executeSteps, RunStopped, type RunEngine, type RunFrame } from "./executor";
import { approvalMessage, type RunContext } from "./interpreter";
import {
  createRunRecord,
  finishRun,
  getRun,
  markRunStatus,
  pinnedDefinition,
  recentRuns,
  recordStepOutcome,
  recordStepStart,
  runViews,
} from "./runs";
import { validateDefinition } from "./validate";
import { ensureWebhook, webhookUrl } from "./webhooks";
import { approvalEventType } from "./workflow";

export async function getAutomation(scope: Scope, automationId: string): Promise<AutomationRow> {
  const row = await scope.db.one((q) => q.first(automations, eq(automations.id, automationId)));
  if (!row) throw new ActionError("not_found", "That automation doesn't exist.");
  return row;
}

function validate(scope: Scope, definition: unknown, catalog: AutomationCatalog) {
  return validateDefinition(definition, catalog, { origin: scope.ctx.origin });
}

// ---------- drafts ----------

export async function createAutomation(
  scope: Scope,
  input: { name?: string },
): Promise<{ id: string; draftRevision: number }> {
  requirePermission(scope.principal, "automations.manage");
  const id = uuidv7();
  const created = newAutomation(input, { id, ownerId: scope.principal.userId });
  await scope.db.batch((q) => [
    q.insert(automations, created.row),
    q.insert(automationDraftRevisions, created.revision),
  ]);
  scope.ctx.log.info("automation.created", { automationId: id });
  return { id, draftRevision: 1 };
}

/**
 * Saves a full definition as the next draft revision, from chat or the editor. A save based on
 * an older revision gets `conflict`, so the chat and the editor never overwrite each other.
 */
export async function saveDraft(
  scope: Scope,
  input: {
    automationId: string;
    baseRevision: number;
    definition: unknown;
    summary?: string;
    source: DraftSource;
  },
): Promise<DraftSaveResult> {
  requirePermission(scope.principal, "automations.manage");
  const automation = await getAutomation(scope, input.automationId);
  ensureDraftCurrent(automation, input.baseRevision);
  const catalog = await buildCatalog(scope);
  const { definition, issues, rejectsSave } = validate(scope, input.definition, catalog);
  if (!definition || rejectsSave)
    throw Object.assign(
      new ActionError(
        "invalid_input",
        `The automation wasn't saved: ${issues.find((i) => i.severity === "error")?.message ?? "it has problems to fix first."}`,
      ),
      { issues },
    );
  const diff = diffDefinitions(automation.draft, definition);
  const summary = (input.summary?.trim() || describeDiff(diff)).slice(0, 500);
  const revision = automation.draftRevision + 1;
  const saved = await scope.db.transaction(async (q) => {
    const updated = await q
      .update(
        automations,
        {
          draft: definition,
          draftRevision: revision,
          name: definition.name,
          updatedAt: new Date(),
        },
        and(eq(automations.id, automation.id), eq(automations.draftRevision, input.baseRevision)),
      )
      .execute();
    if (!updated.length) return false;
    await q
      .insert(automationDraftRevisions, {
        automationId: automation.id,
        revision,
        definition,
        source: input.source,
        authorId: scope.principal.userId,
        summary,
      })
      .execute();
    return true;
  }, "automation.draft.save");
  if (!saved)
    throw new ActionError(
      "conflict",
      "Someone changed the draft at the same moment. Reload it and apply the change again.",
    );
  scope.ctx.log.info("automation.draft_saved", {
    automationId: automation.id,
    revision,
    source: input.source,
  });
  return { revision, issues, diff, summary };
}

export async function restoreRevision(
  scope: Scope,
  input: { automationId: string; revision: number; baseRevision: number },
): Promise<DraftSaveResult> {
  const row = await scope.db.one((q) =>
    q.first(
      automationDraftRevisions,
      and(
        eq(automationDraftRevisions.automationId, input.automationId),
        eq(automationDraftRevisions.revision, input.revision),
      ),
    ),
  );
  if (!row) throw new ActionError("not_found", "That revision doesn't exist.");
  return saveDraft(scope, {
    automationId: input.automationId,
    baseRevision: input.baseRevision,
    definition: row.definition,
    summary: `Restored revision ${input.revision}`,
    source: "ui",
  });
}

/** Removes a never-published draft and everything that belongs to it (runs cascade). */
export async function deleteDraft(scope: Scope, automationId: string): Promise<void> {
  requirePermission(scope.principal, "automations.manage");
  const row = await getAutomation(scope, automationId);
  ensureDeletable(row);
  const open = await scope.db.one((q) =>
    q.select(automationRuns, { where: eq(automationRuns.automationId, row.id) }),
  );
  for (const run of open.filter((r) => isRunOpen(r.status)))
    await (await scope.ctx.env.AUTOMATION_WORKFLOW.get(run.id)).terminate().catch(() => undefined);
  await scope.db.one((q) =>
    q.delete(
      automations,
      and(
        eq(automations.id, row.id),
        eq(automations.status, "draft"),
        isNull(automations.activeVersion),
      ),
    ),
  );
  scope.ctx.log.info("automation.deleted", { automationId: row.id });
}

// ---------- reading ----------

export async function listAutomations(scope: Scope): Promise<AutomationList> {
  const today = new Date(new Date().toISOString().slice(0, 10));
  const [rows, pending, runsToday, members, catalog] = await Promise.all([
    scope.db.one((q) => q.select(automations, { orderBy: [desc(automations.updatedAt)] })),
    scope.db.one((q) =>
      q.select(automationApprovals, { where: eq(automationApprovals.status, "pending") }),
    ),
    scope.db.one((q) =>
      q.drizzle
        .select({ automationId: automationRuns.automationId })
        .from(automationRuns)
        .where(
          and(
            q.owned(automationRuns),
            eq(automationRuns.mode, "live"),
            gte(automationRuns.createdAt, today),
          ),
        ),
    ),
    scope.ctx.accounts().members(scope.db),
    // Titles only; the list still renders (with raw ids) if the catalog can't be built.
    buildCatalog(scope).catch(() => null),
  ]);
  const name = (id: string | null) =>
    id ? (members.find((m) => m.id === id)?.name ?? "Former member") : null;
  const now = new Date();
  return {
    automations: rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      statusReason: r.statusReason,
      trigger: r.draft.trigger,
      triggerTitle: describeTrigger(r.draft.trigger, catalog),
      stepCount: flattenSteps(r.draft.steps).length,
      nextRunAt:
        r.status === "active" && r.draft.trigger.kind === "schedule"
          ? iso(nextScheduledRun(r.draft.trigger, now))
          : null,
      owner: { id: r.ownerId ?? "", name: name(r.ownerId) ?? "Former member" },
      runAs: r.runAsUserId ? { id: r.runAsUserId, name: name(r.runAsUserId)! } : null,
      activeVersion: r.activeVersion,
      lastRunAt: iso(r.lastRunAt),
      lastRunStatus: r.lastRunStatus,
      runsToday: runsToday.filter((run) => run.automationId === r.id).length,
      updatedAt: r.updatedAt.toISOString(),
    })),
    approvalsWaiting: pending
      .filter((a) => approverAllowed(a.approvers, scope.principal))
      .map((a) => ({
        id: a.id,
        automationId: a.automationId,
        automationName: rows.find((r) => r.id === a.automationId)?.name ?? "",
        runId: a.runId,
        message: a.message,
        createdAt: a.createdAt.toISOString(),
      })),
    canManage: can(scope.principal, "automations.manage"),
  };
}

export async function automationDetail(
  scope: Scope,
  automationId: string,
): Promise<AutomationDetail> {
  const row = await getAutomation(scope, automationId);
  const [catalog, versions, revisions, members] = await Promise.all([
    buildCatalog(scope),
    scope.db.one((q) =>
      q.select(automationVersions, {
        where: and(
          eq(automationVersions.automationId, row.id),
          eq(automationVersions.kind, "published"),
        ),
        orderBy: [desc(automationVersions.version)],
      }),
    ),
    scope.db.one((q) =>
      q.select(automationDraftRevisions, {
        where: eq(automationDraftRevisions.automationId, row.id),
        orderBy: [desc(automationDraftRevisions.revision)],
        limit: 30,
      }),
    ),
    scope.ctx.accounts().members(scope.db),
  ]);
  const { issues } = validate(scope, row.draft, catalog);
  const name = (id: string | null) =>
    id ? (members.find((m) => m.id === id)?.name ?? "Former member") : null;
  const active = versions.find((v) => v.version === row.activeVersion);
  const manage = can(scope.principal, "automations.manage");
  return {
    automation: {
      id: row.id,
      name: row.name,
      status: row.status,
      statusReason: row.statusReason,
      owner: { id: row.ownerId ?? "", name: name(row.ownerId) ?? "Former member" },
      runAs: row.runAsUserId ? { id: row.runAsUserId, name: name(row.runAsUserId)! } : null,
      activeVersion: row.activeVersion,
      draftRevision: row.draftRevision,
      lastRunAt: iso(row.lastRunAt),
      lastRunStatus: row.lastRunStatus,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
    draft: row.draft,
    issues,
    activeDefinition: active?.definition ?? null,
    draftMatchesActive: Boolean(
      active && JSON.stringify(active.definition) === JSON.stringify(row.draft),
    ),
    versions: versions.map((v) => ({
      version: v.version,
      publishedBy: name(v.publishedBy),
      notes: v.notes,
      draftRevision: v.draftRevision,
      createdAt: v.createdAt.toISOString(),
      definition: v.definition,
    })),
    revisions: revisions.map((r) => ({
      revision: r.revision,
      source: r.source,
      author: name(r.authorId),
      summary: r.summary,
      createdAt: r.createdAt.toISOString(),
      definition: r.definition,
    })),
    webhook: manage ? await webhookUrl(scope, row.id) : null,
    nextRunAt:
      row.status === "active" && active?.definition.trigger.kind === "schedule"
        ? iso(nextScheduledRun(active.definition.trigger, new Date()))
        : null,
    catalog,
    canManage: manage,
  };
}

// ---------- publishing ----------

/**
 * Copies the validated draft into the next immutable version and makes it live, running as the
 * publisher. Runs already started keep the version they pinned.
 */
export async function publishAutomation(
  scope: Scope,
  input: { automationId: string; revision: number; notes?: string },
): Promise<{ version: number }> {
  requirePermission(scope.principal, "automations.manage");
  const [row, [latest]] = await scope.db.batch(
    (q) => [
      q.first(automations, eq(automations.id, input.automationId)),
      q.select(automationVersions, {
        where: and(
          eq(automationVersions.automationId, input.automationId),
          eq(automationVersions.kind, "published"),
        ),
        orderBy: [desc(automationVersions.version)],
        limit: 1,
      }),
    ],
    "automation.publish.read",
  );
  if (!row) throw new ActionError("not_found", "That automation doesn't exist.");
  const catalog = await buildCatalog(scope);
  const { version, definition, triggerKey, versionRow, automationChange } = publication({
    automation: row,
    reviewedRevision: input.revision,
    checked: validate(scope, row.draft, catalog),
    latestVersion: latest?.version ?? null,
    publisherId: scope.principal.userId,
    notes: input.notes,
    now: new Date(),
  });
  await scope.db.batch((q) => [
    q.insert(automationVersions, { automationId: row.id, ...versionRow }),
    q.update(automations, automationChange, eq(automations.id, row.id)),
  ]);
  if (definition.trigger.kind === "webhook") await ensureWebhook(scope, row.id);
  scope.ctx.log.info("automation.published", {
    automationId: row.id,
    version,
    trigger: triggerKey,
  });
  return { version };
}

export async function setPaused(
  scope: Scope,
  input: { automationId: string; paused: boolean },
): Promise<{ status: "paused" | "active" }> {
  requirePermission(scope.principal, "automations.manage");
  const row = await getAutomation(scope, input.automationId);
  const { activeVersion } = ensurePublished(row);
  const resumeIssues = input.paused
    ? null
    : validate(
        scope,
        await pinnedDefinition(scope.db, row.id, activeVersion),
        await buildCatalog(scope),
      ).issues;
  const change = pauseChange(input.paused, resumeIssues, new Date());
  await scope.db.one((q) => q.update(automations, change, eq(automations.id, row.id)));
  scope.ctx.log.info(input.paused ? "automation.paused" : "automation.resumed", {
    automationId: row.id,
  });
  return { status: input.paused ? "paused" : "active" };
}

// ---------- tests and runs ----------

type Actor = { id: string; name: string };

async function actorOf(scope: Scope): Promise<Actor> {
  const me = (await scope.ctx.accounts().members(scope.db)).find(
    (m) => m.id === scope.principal.userId,
  );
  return { id: scope.principal.userId, name: me?.name ?? "" };
}

/** A plausible trigger payload for a test (`samplePayload` in the core). */
async function sampleFor(
  scope: Scope,
  definition: AutomationDefinition,
  catalog: AutomationCatalog,
): Promise<unknown> {
  const trigger = definition.trigger;
  const [actor, latest] = await Promise.all([
    actorOf(scope),
    trigger.kind === "zapier.event" ? latestZapierPayload(scope.db, trigger) : null,
  ]);
  return samplePayload(definition, catalog, {
    actor,
    organizationId: scope.principal.organizationId,
    latestZapierPayload: latest,
    now: new Date(),
  });
}

/** A hidden, numbered-below-zero snapshot of the draft for a test run to pin. */
async function snapshotDraft(
  scope: Scope,
  row: AutomationRow,
  definition: AutomationDefinition,
): Promise<number> {
  const version = -row.draftRevision;
  await scope.db.one((q) =>
    q.drizzle
      .insert(automationVersions)
      .values({
        organizationId: q.organizationId,
        automationId: row.id,
        version,
        kind: "test",
        definition,
        draftRevision: row.draftRevision,
        publishedBy: scope.principal.userId,
        notes: "Test snapshot of the draft",
      })
      .onConflictDoNothing(),
  );
  return version;
}

/**
 * Runs the draft with the same step code as a live run, inline. Reads (read-only actions, GET
 * requests) run for real so mappings see real data; writes, email, AI, Zapier and approvals
 * return results marked simulated. Nothing changes but the run history.
 */
export async function simulateAutomation(
  scope: Scope,
  input: { automationId: string; payload?: unknown },
): Promise<RunView> {
  requirePermission(scope.principal, "automations.manage");
  const row = await getAutomation(scope, input.automationId);
  const catalog = await buildCatalog(scope);
  const { definition } = validate(scope, row.draft, catalog);
  if (!definition)
    throw new ActionError("invalid_input", "The draft isn't a valid automation yet.");
  const payload = input.payload ?? (await sampleFor(scope, definition, catalog));
  ensurePayloadSize(payload, "The sample payload is too large.");
  const version = await snapshotDraft(scope, row, definition);
  const { run } = await createRunRecord(scope.db, {
    automation: row,
    version,
    definition,
    mode: "simulated",
    triggerKind: definition.trigger.kind,
    triggerEventId: `sim:${uuidv7()}`,
    triggerPayload: payload,
    runAsUserId: scope.principal.userId,
    startedBy: scope.principal.userId,
    chainDepth: 0,
  });
  const startedAt = new Date();
  await markRunStatus(scope.db, run.id, { status: "running", startedAt });
  const context: RunContext = {
    ctx: scope.ctx,
    db: scope.db,
    runId: run.id,
    organizationId: scope.principal.organizationId,
    automationId: row.id,
    runAs: { userId: scope.principal.userId, role: scope.principal.role },
    chainDepth: 0,
    mode: "simulated",
  };
  const at: TemplateScope = {
    trigger: payload,
    steps: {},
    run: { id: run.id, startedAt: startedAt.toISOString() },
  };
  const frame: RunFrame = { currentStepId: null };
  const engine: RunEngine = {
    simulated: true,
    unit: (_name, _config, work) => work(),
    sleepUntil: async () => undefined,
    approval: async (node, values) => {
      const output = { approved: true, decidedBy: null, note: "Simulated approval" };
      await recordStepStart(scope.db, run.id, node.id);
      await recordStepOutcome(scope.db, run.id, node.id, {
        status: "simulated",
        simulated: true,
        input: { approvers: node.approvers, message: approvalMessage(node, values) },
        output,
      });
      return { status: "approved", decidedBy: null, note: output.note };
    },
  };
  try {
    await executeSteps(engine, context, definition.steps, at, frame);
    await finishRun(scope, run.id, { status: "succeeded" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = error instanceof StepFailure ? error.hint : null;
    if (frame.currentStepId)
      await recordStepOutcome(scope.db, run.id, frame.currentStepId, {
        status: "failed",
        error: message,
        ...(hint ? { hint } : {}),
      });
    await finishRun(scope, run.id, {
      status: error instanceof RunStopped ? error.status : "failed",
      error: message,
      hint,
    });
  }
  const [view] = await runViews(scope.db, [await getRun(scope.db, run.id)], {
    ...scope.principal,
    canSeeData: true,
  });
  return view!;
}

/** A clearly labeled test with real effects, run durably from a snapshot of the current draft. */
export async function liveTestAutomation(
  scope: Scope,
  input: { automationId: string; revision: number; payload?: unknown },
): Promise<{ runId: string }> {
  requirePermission(scope.principal, "automations.manage");
  const row = await getAutomation(scope, input.automationId);
  const catalog = await buildCatalog(scope);
  const definition = liveTestDefinition(row, input.revision, validate(scope, row.draft, catalog));
  const payload = input.payload ?? (await sampleFor(scope, definition, catalog));
  const version = await snapshotDraft(scope, row, definition);
  const started = await startRun(scope, {
    automation: row,
    version,
    definition,
    mode: "live_test",
    triggerKind: definition.trigger.kind,
    triggerEventId: `tst:${uuidv7()}`,
    triggerPayload: payload,
    runAsUserId: scope.principal.userId,
    startedBy: scope.principal.userId,
    chainDepth: 0,
  });
  return { runId: started.runId };
}

export async function runManually(
  scope: Scope,
  input: { automationId: string; fields: Record<string, unknown> },
): Promise<{ runId: string }> {
  requirePermission(scope.principal, "automations.manage");
  const row = await getAutomation(scope, input.automationId);
  const { activeVersion, runAsUserId } = ensureRunnable(row);
  const definition = await pinnedDefinition(scope.db, row.id, activeVersion);
  ensureManualRun(definition, input.fields);
  if (!(await withinRateLimit(scope, row, definition)))
    throw new ActionError("rate_limited", "This automation has used its runs for this hour.");
  const payload = { fields: input.fields, actor: await actorOf(scope) };
  ensurePayloadSize(payload, "The fields are too large.");
  const { runId } = await startRun(scope, {
    automation: row,
    version: activeVersion,
    definition,
    mode: "live",
    triggerKind: "manual",
    triggerEventId: `man:${uuidv7()}`,
    triggerPayload: payload,
    runAsUserId,
    startedBy: scope.principal.userId,
    chainDepth: 0,
  });
  return { runId };
}

export async function listRuns(scope: Scope, automationId: string, limit = 30): Promise<RunView[]> {
  await getAutomation(scope, automationId);
  return runViews(scope.db, await recentRuns(scope.db, automationId, limit), {
    ...scope.principal,
    canSeeData: can(scope.principal, "automations.manage"),
  });
}

export async function runDetail(scope: Scope, runId: string): Promise<RunView> {
  const run = await getRun(scope.db, runId);
  const [view] = await runViews(scope.db, [run], {
    ...scope.principal,
    canSeeData: can(scope.principal, "automations.manage"),
  });
  return view!;
}

/** Records an allowed approver's decision, then wakes the run, which re-reads it from Postgres. */
export async function decideApproval(
  scope: Scope,
  input: { runId: string; approvalId: string; decision: "approved" | "rejected"; note?: string },
): Promise<{ status: "approved" | "rejected" }> {
  const approval = await scope.db.one((q) =>
    q.first(
      automationApprovals,
      and(eq(automationApprovals.id, input.approvalId), eq(automationApprovals.runId, input.runId)),
    ),
  );
  if (!approval) throw new ActionError("not_found", "That approval doesn't exist.");
  const decision = approvalDecision(approval, scope.principal, input, new Date());
  const decided = await scope.db.one((q) =>
    q.update(
      automationApprovals,
      decision,
      and(eq(automationApprovals.id, approval.id), eq(automationApprovals.status, "pending")),
    ),
  );
  if (!decided.length)
    throw new ActionError("conflict", "Someone else decided this approval first.");
  const instance = await scope.ctx.env.AUTOMATION_WORKFLOW.get(approval.runId).catch(() => null);
  await instance
    ?.sendEvent({ type: approvalEventType(approval.stepId), payload: { approvalId: approval.id } })
    .catch((error: unknown) =>
      scope.ctx.log.warn("automation.approval_event_failed", { runId: approval.runId, error }),
    );
  scope.ctx.log.info("automation.approval_decided", {
    runId: approval.runId,
    decision: input.decision,
  });
  return { status: input.decision };
}

export async function cancelRun(scope: Scope, runId: string): Promise<{ status: "cancelled" }> {
  requirePermission(scope.principal, "automations.manage");
  const run = await getRun(scope.db, runId);
  ensureCancellable(run);
  await (
    await scope.ctx.env.AUTOMATION_WORKFLOW.get(run.id).catch(() => null)
  )
    ?.terminate()
    .catch(() => undefined);
  await scope.db.one((q) =>
    q.update(
      automationApprovals,
      { status: "expired" },
      and(eq(automationApprovals.runId, run.id), eq(automationApprovals.status, "pending")),
    ),
  );
  await finishRun(scope, run.id, { status: "cancelled", error: "Cancelled by a person." });
  return { status: "cancelled" };
}

// ---------- for the Automation Builder ----------

const LOOKUP_OUTPUT_BYTES = 8_000;

/**
 * A read-only lookup for the Builder, so it finds real ids instead of asking: only read actions
 * this person may run, run as them.
 */
export async function lookupForBuilder(
  scope: Scope,
  input: { actionId: string; input: unknown },
): Promise<{ output: unknown; truncated: boolean }> {
  const action = findAction(input.actionId);
  if (!action || !action.readOnly || action.webOnly)
    throw new ActionError(
      "forbidden",
      `${input.actionId} isn't a lookup (read) action you can use.`,
    );
  const output = await runAction(scope.ctx, action, input.input ?? {}, {
    ...scope.principal,
    emailVerified: true,
    scopes: ALL_SCOPES,
    caller: "assistant",
  });
  const text = JSON.stringify(output ?? null);
  return text.length > LOOKUP_OUTPUT_BYTES
    ? { output: `${text.slice(0, LOOKUP_OUTPUT_BYTES)}…`, truncated: true }
    : { output, truncated: false };
}

export async function builderContext(
  scope: Scope,
  automationId: string,
): Promise<AutomationBuilderContext> {
  const row = await getAutomation(scope, automationId);
  const [catalog, members, organization] = await Promise.all([
    buildCatalog(scope),
    scope.ctx.accounts().members(scope.db),
    scope.db.one((q) => q.first(organizations)),
  ]);
  const { issues } = validate(scope, row.draft, catalog);
  return {
    automation: {
      id: row.id,
      name: row.name,
      status: row.status,
      activeVersion: row.activeVersion,
      draftRevision: row.draftRevision,
    },
    draft: row.draft,
    issues,
    catalog,
    organization: { id: scope.principal.organizationId, name: organization?.name ?? "" },
    user: {
      id: scope.principal.userId,
      name: members.find((m) => m.id === scope.principal.userId)?.name ?? "",
      role: scope.principal.role,
    },
    canEdit: can(scope.principal, "automations.manage"),
  };
}

/** Runs referenced by the Builder's `recent_runs`, with step data (managers only). */
export async function builderRuns(scope: Scope, automationId: string): Promise<RunView[]> {
  return listRuns(scope, automationId, 5);
}
