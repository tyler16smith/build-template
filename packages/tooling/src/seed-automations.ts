import {
  automationDefinitionSchema,
  type AutomationDefinitionInput,
  type ZapierEvent,
} from "@template/contracts";
import {
  automationApprovals,
  automationDraftRevisions,
  automationRuns,
  automationRunSteps,
  automations,
  automationVersions,
  zapierConnections,
  zapierEvents,
  type Database,
  type Drizzle,
  type Executable,
} from "@template/db";

/**
 * Automations demo data (`specs/ai.md`, "Demo data"): published versions with a few past runs,
 * and a Zapier inbound connection with one received test event. The template has one module
 * (profiles), so the triggers are the profile event, a schedule and a manual run; a product
 * swaps in its own events ("Job completed") when it adds them.
 */
const id = (n: number) => `0199d5a0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

type DemoAutomation = {
  id: string;
  ownerId: string;
  definition: AutomationDefinitionInput;
  triggerKey: string;
  runs: DemoRun[];
};

type DemoRun = {
  id: string;
  status: "succeeded" | "rejected";
  triggerKind: "app.event" | "schedule" | "manual";
  triggerPayload: Record<string, unknown>;
  hoursAgo: number;
  steps: { stepId: string; status: "succeeded" | "rejected" | "skipped"; output?: unknown }[];
  approval?: { id: string; stepId: string; decidedBy: string; note: string; message: string };
};

const BEA = id(101);
const HANK = id(102);
const STU = id(103);
const REX = id(201);

const PIGS: DemoAutomation[] = [
  {
    id: id(3001),
    ownerId: BEA,
    triggerKey: "app.event:profile.updated",
    definition: {
      schemaVersion: 1,
      name: "Is the Straw MVP still standing?",
      description:
        "When anyone changes their profile, email Hank to check the Straw MVP is still standing. It usually isn't.",
      trigger: { kind: "app.event", eventId: "profile.updated" },
      steps: [
        {
          id: "remind_hank",
          name: "Remind Hank",
          kind: "email.send",
          to: "hank@threepigs.example",
          subject: "Check the Straw MVP",
          body: "{{trigger.actor.name}} just updated their profile.\n\nPlease check the Straw MVP is still standing. Someone was breathing near it.",
        },
      ],
    },
    runs: [
      {
        id: id(3101),
        status: "succeeded",
        triggerKind: "app.event",
        triggerPayload: {
          event: "profile.updated",
          actor: { id: id(301), name: "Wolfgang Huffington" },
          caller: "web",
        },
        hoursAgo: 26,
        steps: [{ stepId: "remind_hank", status: "succeeded", output: { sent: 1 } }],
      },
    ],
  },
  {
    id: id(3002),
    ownerId: BEA,
    triggerKey: "schedule",
    definition: {
      schemaVersion: 1,
      name: "Monday stress test report",
      description: "Every Monday at 08:00, email Bea the week's stress test results from Wolfgang.",
      trigger: {
        kind: "schedule",
        frequency: "weekly",
        weekdays: [1],
        time: "08:00",
        timezone: "UTC",
      },
      steps: [
        {
          id: "tell_bea",
          name: "Email Bea",
          kind: "notify",
          to: { userIds: [BEA] },
          subject: "This week's stress test results",
          body: "Straw MVP: blown down (one huff). Stick Upgrade: blown down (one huff, one puff). Brick Production: still standing; tester winded.\n\nWolfgang asks to retest the chimney.",
        },
      ],
    },
    runs: [
      {
        id: id(3102),
        status: "succeeded",
        triggerKind: "schedule",
        triggerPayload: { scheduledFor: "2026-10-05T08:00:00.000Z", timezone: "UTC" },
        hoursAgo: 30,
        steps: [{ stepId: "tell_bea", status: "succeeded", output: { notified: 1 } }],
      },
    ],
  },
  {
    id: id(3003),
    ownerId: BEA,
    triggerKey: "manual",
    definition: {
      schemaVersion: 1,
      name: "Ship the Stick Upgrade",
      description:
        "When someone asks to ship the Stick Upgrade, require Bea's approval before Stu is told. (She declines.)",
      trigger: {
        kind: "manual",
        fields: [{ key: "reason", label: "Why ship it now", type: "text", required: true }],
      },
      steps: [
        {
          id: "ask_bea",
          name: "Ask Bea",
          kind: "approval",
          approvers: { userIds: [BEA] },
          message: "Ship the Stick Upgrade? Reason: {{trigger.fields.reason}}",
          timeoutHours: 72,
        },
        {
          id: "tell_stu",
          name: "Tell Stu",
          kind: "email.send",
          to: "stu@threepigs.example",
          subject: "The Stick Upgrade is approved",
          body: "Bea approved shipping the Stick Upgrade. Lightweight lumber, as you said.",
        },
      ],
    },
    runs: [
      {
        id: id(3103),
        status: "rejected",
        triggerKind: "manual",
        triggerPayload: {
          fields: { reason: "It survived the first huff" },
          actor: { id: STU, name: "Stu Sticksworth" },
        },
        hoursAgo: 50,
        steps: [
          { stepId: "ask_bea", status: "rejected", output: { approved: false } },
          { stepId: "tell_stu", status: "skipped" },
        ],
        approval: {
          id: id(3201),
          stepId: "ask_bea",
          decidedBy: BEA,
          note: "Not until it survives the puff. Brick or nothing.",
          message: "Ship the Stick Upgrade? Reason: It survived the first huff",
        },
      },
    ],
  },
];

const DEMOLITION: DemoAutomation[] = [
  {
    id: id(4001),
    ownerId: REX,
    triggerKey: "schedule",
    definition: {
      schemaVersion: 1,
      name: "Morning lung warm-up",
      description: "Every day at 06:00, remind Rex to warm up before the first demolition.",
      trigger: { kind: "schedule", frequency: "daily", time: "06:00", timezone: "UTC" },
      steps: [
        {
          id: "remind_rex",
          name: "Remind Rex",
          kind: "email.send",
          to: "rex@bigbad.example",
          subject: "Warm up",
          body: "Huff. Puff. Hydrate. First site is at 07:00.",
        },
      ],
    },
    runs: [],
  },
];

const ZAPIER = {
  connection: id(3301),
  event: id(3302),
};

/** Upserts one organization's automations, versions, past runs and (Three Pigs) Zapier demo rows. */
export function automationRows(
  d: Drizzle,
  organizationId: string,
  now: Date,
): Executable<unknown>[] {
  const list = organizationId === id(1) ? PIGS : organizationId === id(2) ? DEMOLITION : [];
  const at = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  const rows: Executable<unknown>[] = [];
  for (const automation of list) {
    const definition = automationDefinitionSchema.parse(automation.definition);
    const lastRun = automation.runs.at(-1);
    const values = {
      organizationId,
      id: automation.id,
      name: definition.name,
      status: "active" as const,
      statusReason: null,
      ownerId: automation.ownerId,
      draft: definition,
      draftRevision: 1,
      activeVersion: 1,
      runAsUserId: automation.ownerId,
      triggerKey: automation.triggerKey,
      consecutiveFailures: 0,
      lastRunAt: lastRun ? at(lastRun.hoursAgo) : null,
      lastRunStatus: lastRun?.status ?? null,
      updatedAt: now,
    };
    rows.push(
      d
        .insert(automations)
        .values(values)
        .onConflictDoUpdate({ target: [automations.organizationId, automations.id], set: values }),
      d
        .insert(automationDraftRevisions)
        .values({
          organizationId,
          automationId: automation.id,
          revision: 1,
          source: "system",
          authorId: automation.ownerId,
          summary: "Demo automation",
          definition,
        })
        .onConflictDoUpdate({
          target: [
            automationDraftRevisions.organizationId,
            automationDraftRevisions.automationId,
            automationDraftRevisions.revision,
          ],
          set: { definition },
        }),
      d
        .insert(automationVersions)
        .values({
          organizationId,
          automationId: automation.id,
          version: 1,
          kind: "published",
          definition,
          draftRevision: 1,
          publishedBy: automation.ownerId,
          notes: "Demo data",
        })
        .onConflictDoUpdate({
          target: [
            automationVersions.organizationId,
            automationVersions.automationId,
            automationVersions.version,
          ],
          set: { definition },
        }),
    );
    for (const run of automation.runs) {
      const started = at(run.hoursAgo);
      const finished = new Date(started.getTime() + 4_000);
      rows.push(
        d
          .insert(automationRuns)
          .values({
            organizationId,
            id: run.id,
            automationId: automation.id,
            version: 1,
            mode: "live",
            status: run.status,
            triggerKind: run.triggerKind,
            triggerEventId: `demo:${run.id}`,
            triggerPayload: run.triggerPayload,
            runAsUserId: automation.ownerId,
            startedBy: null,
            chainDepth: 0,
            error:
              run.status === "rejected" ? `Rejected at “Ask Bea”: ${run.approval?.note}` : null,
            createdAt: started,
            startedAt: started,
            finishedAt: finished,
          })
          .onConflictDoNothing(),
        ...run.steps.map((step, position) =>
          d
            .insert(automationRunSteps)
            .values({
              organizationId,
              runId: run.id,
              stepId: step.stepId,
              position,
              kind: definition.steps.find((s) => s.id === step.stepId)?.kind ?? "map",
              name: definition.steps.find((s) => s.id === step.stepId)?.name ?? step.stepId,
              status: step.status,
              attempts: step.status === "skipped" ? 0 : 1,
              output: step.output ?? null,
              startedAt: step.status === "skipped" ? null : started,
              finishedAt: finished,
            })
            .onConflictDoNothing(),
        ),
      );
      if (run.approval)
        rows.push(
          d
            .insert(automationApprovals)
            .values({
              organizationId,
              id: run.approval.id,
              automationId: automation.id,
              runId: run.id,
              stepId: run.approval.stepId,
              approvers: { userIds: [run.approval.decidedBy] },
              message: run.approval.message,
              status: "rejected",
              decidedBy: run.approval.decidedBy,
              decidedAt: finished,
              note: run.approval.note,
              createdAt: started,
              expiresAt: new Date(started.getTime() + 72 * 3_600_000),
            })
            .onConflictDoNothing(),
        );
    }
  }
  if (organizationId === id(1)) {
    const payload: ZapierEvent = {
      id: ZAPIER.event,
      provider: "huff_and_puff",
      eventType: "stress_test.completed",
      organizationId,
      connectionId: ZAPIER.connection,
      connectionName: "Huff & Puff Testing (via Zapier)",
      externalId: "stress_test_3",
      occurredAt: at(20).toISOString(),
      receivedAt: at(20).toISOString(),
      data: {
        subject: "Stress test: Brick Production",
        result: "Still standing after three huffs and two puffs",
        reportedBy: "Wolfgang Huffington",
      },
    };
    rows.push(
      d
        .insert(zapierConnections)
        .values({
          organizationId,
          id: ZAPIER.connection,
          direction: "inbound",
          name: "Huff & Puff Testing (via Zapier)",
          // No secret works until an admin regenerates one: the demo never ships a usable secret.
          secretHash: "demo-no-secret",
          hint: "demo",
          createdBy: BEA,
        })
        .onConflictDoNothing(),
      d
        .insert(zapierEvents)
        .values({
          organizationId,
          id: ZAPIER.event,
          connectionId: ZAPIER.connection,
          provider: payload.provider,
          eventType: payload.eventType,
          externalId: payload.externalId,
          occurredAt: at(20),
          receivedAt: at(20),
          idempotencyKey: "demo-test-event",
          status: "test",
          test: true,
          payload,
        })
        .onConflictDoNothing(),
    );
  }
  return rows;
}
