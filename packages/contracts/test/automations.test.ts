import { describe, expect, it } from "vitest";
import {
  automationDefinitionSchema,
  describeTrigger,
  diffDefinitions,
  estimateCostUsd,
  evaluateConditions,
  findModel,
  flattenSteps,
  nextScheduledRun,
  normalizeZapierBody,
  resolveValue,
  mayRun,
  scheduleMatches,
  zapierHookUrlProblem,
  zapierTriggerKeys,
  type AutomationDefinition,
  type TemplateScope,
} from "../src";

const scope: TemplateScope = {
  trigger: {
    data: { title: "Straw House", lines: [{ name: "Straw" }, { name: "Twine" }], count: 2 },
  },
  steps: { lookup: { output: { email: "clem@threepigs.example" } } },
  run: { id: "run_1", startedAt: "2026-10-06T08:00:00.000Z" },
};

describe("templates", () => {
  it("keep a whole reference's type and interpolate inside text", () => {
    expect(resolveValue("{{trigger.data.count}}", scope)).toBe(2);
    expect(resolveValue("Fix the {{trigger.data.title | lower}}", scope)).toBe(
      "Fix the straw house",
    );
    expect(resolveValue('{{trigger.data.lines | pluck:name | join:", "}}', scope)).toBe(
      "Straw, Twine",
    );
    expect(resolveValue("{{run.startedAt | addDays:1 | date}}", scope)).toBe("2026-10-07");
  });

  it("never re-scan substituted text, so data can't inject references", () => {
    const hostile: TemplateScope = {
      ...scope,
      trigger: { data: { note: "{{steps.lookup.output.email}}" } },
    };
    expect(resolveValue("Note: {{trigger.data.note}}", hostile)).toBe(
      "Note: {{steps.lookup.output.email}}",
    );
  });

  it("evaluate conditions", () => {
    expect(evaluateConditions([{ path: "trigger.data.count", op: "gte", value: 2 }], scope)).toBe(
      true,
    );
    expect(
      evaluateConditions(
        [
          { path: "trigger.data.title", op: "contains", value: "Straw" },
          { path: "trigger.data.missing", op: "exists" },
        ],
        scope,
        "any",
      ),
    ).toBe(true);
  });
});

const definition = (steps: unknown[]): AutomationDefinition =>
  automationDefinitionSchema.parse({
    schemaVersion: 1,
    name: "Test",
    trigger: { kind: "app.event", eventId: "profile.updated" },
    steps,
  });

describe("definitions", () => {
  it("parse the step kinds, with defaults", () => {
    const parsed = definition([
      { id: "find", name: "Find", kind: "action", actionId: "profile.get" },
      {
        id: "check",
        name: "Check",
        kind: "branch",
        conditions: [{ path: "steps.find.output.title", op: "notExists" }],
        then: [
          {
            id: "send",
            name: "Send",
            kind: "zapier.send",
            body: { who: "{{trigger.actor.name}}" },
          },
        ],
      },
    ]);
    expect(parsed.steps[0]).toMatchObject({ kind: "action", input: {} });
    expect(parsed.steps[1]).toMatchObject({ kind: "branch", match: "all", else: [] });
    expect(flattenSteps(parsed.steps).map((f) => [f.step.id, f.depth])).toEqual([
      ["find", 0],
      ["check", 0],
      ["send", 1],
    ]);
  });

  it("reject unknown fields, step kinds and bad ids", () => {
    expect(
      automationDefinitionSchema.safeParse({
        schemaVersion: 1,
        name: "x",
        trigger: { kind: "manual" },
        steps: [{ id: "x", name: "X", kind: "gmail.send" }],
      }).success,
    ).toBe(false);
    expect(
      automationDefinitionSchema.safeParse({
        schemaVersion: 1,
        name: "x",
        trigger: { kind: "manual", extra: true },
        steps: [],
      }).success,
    ).toBe(false);
    expect(
      automationDefinitionSchema.safeParse({
        schemaVersion: 1,
        name: "x",
        trigger: { kind: "manual" },
        steps: [{ id: "Bad Id", name: "X", kind: "map", fields: {} }],
      }).success,
    ).toBe(false);
  });

  it("diff by step id", () => {
    const before = definition([{ id: "a", name: "A", kind: "map", fields: { x: 1 } }]);
    const after = definition([
      { id: "a", name: "A", kind: "map", fields: { x: 2 } },
      { id: "b", name: "B", kind: "map", fields: {} },
    ]);
    const diff = diffDefinitions(before, after);
    expect(diff.added.map((s) => s.id)).toEqual(["b"]);
    expect(diff.changed).toEqual([{ id: "a", name: "A", kind: "map", fields: ["fields"] }]);
  });

  it("describe triggers in plain words", () => {
    expect(
      describeTrigger({
        kind: "zapier.event",
        connectionId: null,
        provider: "hubspot",
        eventType: "deal.closed_won",
        when: [],
      }),
    ).toBe("When a Zapier event arrives: hubspot · deal.closed_won");
  });
});

describe("schedules", () => {
  const monday8 = {
    kind: "schedule" as const,
    frequency: "weekly" as const,
    time: "08:00",
    minute: 0,
    weekdays: [1],
    dayOfMonth: 1,
    timezone: "America/New_York",
  };

  it("match the local minute in the schedule's time zone", () => {
    // 2026-10-05 is a Monday; 08:00 in New York is 12:00 UTC (daylight time).
    expect(scheduleMatches(monday8, new Date("2026-10-05T12:00:00Z"))).toBe(true);
    expect(scheduleMatches(monday8, new Date("2026-10-05T08:00:00Z"))).toBe(false);
  });

  it("find the next run", () => {
    expect(nextScheduledRun(monday8, new Date("2026-10-06T00:00:00Z"))?.toISOString()).toBe(
      "2026-10-12T12:00:00.000Z",
    );
  });
});

describe("Zapier events", () => {
  const receivedAt = "2026-10-06T00:00:00.000Z";

  it("normalize a hand-built body and drop an organization it names", () => {
    const result = normalizeZapierBody(
      {
        provider: "HubSpot",
        event_type: "Deal Closed Won",
        external_id: 42,
        organizationId: "someone-else",
        data__deal__name: "Brick Production II",
      },
      { receivedAt },
    );
    expect(result).toEqual({
      ok: true,
      event: {
        provider: "hubspot",
        eventType: "deal_closed_won",
        externalId: "42",
        occurredAt: receivedAt,
        data: { deal: { name: "Brick Production II" } },
        idempotencySeed: "fields|hubspot|deal_closed_won|42|",
      },
    });
  });

  it("need an event type", () => {
    expect(normalizeZapierBody({ data: {} }, { receivedAt })).toMatchObject({ ok: false });
  });

  it("offer each event to the exact and the open trigger keys", () => {
    expect(zapierTriggerKeys("hubspot", "deal.won")).toEqual([
      "zapier.event:hubspot:deal.won",
      "zapier.event:hubspot:*",
      "zapier.event:*:deal.won",
      "zapier.event:*:*",
    ]);
  });

  it("accept only Catch Hook URLs for outbound hooks", () => {
    expect(zapierHookUrlProblem("https://hooks.zapier.com/hooks/catch/1/abc/")).toBeNull();
    expect(zapierHookUrlProblem("http://hooks.zapier.com/hooks/catch/1/abc/")).not.toBeNull();
    expect(
      zapierHookUrlProblem("https://hooks.zapier.com.evil.example/hooks/catch/1/"),
    ).not.toBeNull();
  });
});

describe("AI models and roles", () => {
  it("price a turn from the model's rates", () => {
    expect(estimateCostUsd(findModel("claude-sonnet-5-5")!, 1_000_000, 100_000)).toBeCloseTo(3);
  });

  it("let every role run an action unless it names a permission", () => {
    expect(mayRun({}, "member")).toBe(true);
    expect(mayRun({ permission: "automations.manage" }, "member")).toBe(false);
    expect(mayRun({ permission: "automations.manage" }, "admin")).toBe(true);
  });
});
