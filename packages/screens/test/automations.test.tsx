import { createApiClient } from "@template/api-client";
import {
  emptyDefinition,
  type AutomationCatalog,
  type AutomationDefinition,
  type SessionView,
} from "@template/contracts";
import { ThemeProvider } from "@template/ui";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiProvider, NavProvider, SessionProvider } from "../src";
import {
  availablePaths,
  blankStep,
  describeStep,
  effectsOf,
  issuesFor,
  newStepId,
} from "../src/automations/model";
import {
  decodeStepChoice,
  encodeStepChoice,
  filterPickerItems,
  stepItems,
} from "../src/automations/pickers";
import { runDuration, versionLabel } from "../src/automations/run-views";
import { AutomationStartView, startSuggestions } from "../src/automations/start";
import { triggerFromChoice } from "../src/automations/step-editor";

const catalog: AutomationCatalog = {
  triggers: [
    {
      kind: "app.event",
      title: "When: Profile updated",
      description: "Someone changed their profile.",
      eventId: "profile.updated",
      actionId: "profile.update",
      payloadPaths: [{ path: "trigger.data.name", type: "string", description: "Their name" }],
    },
    { kind: "manual", title: "Run manually", description: "" },
    { kind: "schedule", title: "On a schedule", description: "" },
    { kind: "webhook", title: "Incoming webhook", description: "" },
    {
      kind: "zapier.event",
      title: "Zapier event received",
      description: "",
      connections: [{ id: "zc1", name: "HubSpot deals", status: "active", connected: true }],
      seen: [
        {
          connectionId: "zc1",
          provider: "hubspot",
          eventType: "deal.closed_won",
          lastSeenAt: "2026-10-01T00:00:00.000Z",
          dataPaths: [{ path: "trigger.data.amount", type: "number" }],
        },
      ],
    },
  ],
  logic: [
    { kind: "forEach", title: "For each item", description: "" },
    { kind: "delay", title: "Wait", description: "" },
  ],
  actions: [
    {
      kind: "action",
      actionId: "profile.update",
      title: "Update profile",
      description: "Changes a profile.",
      readOnly: false,
      confirm: false,
      inputSchema: {},
      outputSchema: {},
      outputPaths: [{ path: "id", type: "string" }],
    },
    {
      kind: "action",
      actionId: "profile.get",
      title: "Get profile",
      description: "Reads a profile.",
      readOnly: true,
      confirm: false,
      inputSchema: {},
      outputSchema: {},
      outputPaths: [{ path: "name", type: "string" }],
    },
  ],
  builtinActions: [
    {
      kind: "notify",
      title: "Email members",
      description: "",
      outputPaths: [{ path: "notified", type: "number" }],
      status: "ready",
      statusReason: null,
    },
    {
      kind: "zapier.send",
      title: "Send to Zapier",
      description: "",
      outputPaths: [{ path: "status", type: "number" }],
      status: "unavailable",
      statusReason: "Zapier isn't set up on this deployment yet.",
    },
  ],
  zapierHooks: [{ id: "zh1", name: "Google Sheets", status: "active", connected: false }],
  members: [{ id: "u1", name: "Leia Organa", role: "owner" }],
};

const definition: AutomationDefinition = {
  ...emptyDefinition("Profile follow-up"),
  trigger: { kind: "app.event", eventId: "profile.updated", when: [] },
  steps: [
    { id: "get_profile", name: "Get profile", kind: "action", actionId: "profile.get", input: {} },
    {
      id: "each",
      name: "Each line",
      kind: "forEach",
      items: "{{trigger.data.lines}}",
      maxItems: 10,
      steps: [
        {
          id: "tell",
          name: "Tell the owners",
          kind: "notify",
          to: { roles: ["owner"] },
          subject: "Changed",
          body: "",
        },
      ],
    },
    {
      id: "to_sheets",
      name: "Add a row",
      kind: "zapier.send",
      connectionId: "zh1",
      body: { name: "{{trigger.data.name}}" },
    },
  ],
};

describe("automation model", () => {
  it("describes steps in plain words from the catalog", () => {
    const [get, each, sheets] = definition.steps;
    expect(describeStep(get!, catalog)).toBe("Get profile");
    expect(describeStep(each!, catalog)).toBe("Each item in {{trigger.data.lines}} (up to 10)");
    expect(describeStep(sheets!, catalog)).toBe("Google Sheets · name");
    expect(
      describeStep(
        {
          id: "a",
          name: "A",
          kind: "approval",
          approvers: { userIds: ["u1"] },
          message: "",
          timeoutHours: 1,
        },
        catalog,
      ),
    ).toBe("Leia Organa decides");
    expect(
      describeStep(
        { id: "x", name: "X", kind: "action", actionId: "jobs.gone", input: {} },
        catalog,
      ),
    ).toBe("jobs.gone (not available)");
  });

  it("offers the trigger, earlier steps, the loop item and the run to a step", () => {
    const groups = availablePaths(definition, catalog, "tell");
    expect(groups.map((g) => g.group)).toEqual([
      "Trigger",
      "Current item (Each line)",
      "Get profile",
      "Run",
    ]);
    expect(groups[2]!.paths[0]!.path).toBe("steps.get_profile.output.name");
    // After the loop, its own results are offered, but not the steps inside it.
    const after = availablePaths(definition, catalog, "to_sheets").map((g) => g.group);
    expect(after).toContain("Each line");
    expect(after).not.toContain("Tell the owners");
    // The trigger's own conditions see only the trigger.
    expect(availablePaths(definition, catalog, null)).toHaveLength(1);
  });

  it("puts fields seen on recent Zapier events first", () => {
    const zapier: AutomationDefinition = {
      ...definition,
      trigger: {
        kind: "zapier.event",
        connectionId: "zc1",
        provider: "hubspot",
        eventType: "",
        when: [],
      },
    };
    const paths = availablePaths(zapier, catalog, null)[0]!.paths.map((p) => p.path);
    expect(paths[0]).toBe("trigger.data.amount");
    expect(paths).not.toContain("trigger.data");
    expect(paths).toContain("trigger.eventType");
  });

  it("makes new steps with unique ids", () => {
    expect(newStepId(definition, "each")).toBe("each_2");
    const step = blankStep("action", definition, catalog);
    expect(step).toMatchObject({
      kind: "action",
      actionId: "profile.update",
      id: "update_profile",
    });
    expect(blankStep("zapier.send", definition, catalog)).toMatchObject({ connectionId: "zh1" });
  });

  it("lists every real effect", () => {
    expect(effectsOf(definition, catalog)).toEqual([
      "Tell the owners: emails any owner",
      "Add a row: posts to Zapier (Google Sheets)",
    ]);
  });

  it("splits issues between the trigger and steps", () => {
    const issues = [
      { severity: "error" as const, message: "Pick an event", path: "trigger.eventId" },
      { severity: "warning" as const, message: "Slow", stepId: "tell", path: "steps.1.steps.0" },
    ];
    expect(issuesFor(issues, null).map((i) => i.message)).toEqual(["Pick an event"]);
    expect(issuesFor(issues, "tell").map((i) => i.message)).toEqual(["Slow"]);
  });

  it("keeps fields when switching between manual and webhook triggers", () => {
    const manual = {
      kind: "manual" as const,
      fields: [{ key: "email", label: "Email", type: "email" as const, required: true }],
    };
    expect(triggerFromChoice("webhook", manual)).toEqual({
      kind: "webhook",
      fields: manual.fields,
    });
    expect(triggerFromChoice("app.event:profile.updated", manual)).toEqual({
      kind: "app.event",
      eventId: "profile.updated",
      when: [],
    });
  });

  it("labels runs", () => {
    expect(versionLabel(3)).toBe("v3");
    expect(versionLabel(-7)).toBe("draft r7");
    expect(runDuration({ startedAt: null, finishedAt: null })).toBe("—");
    expect(
      runDuration({
        startedAt: "2026-10-06T10:00:00.000Z",
        finishedAt: "2026-10-06T10:00:02.500Z",
      }),
    ).toBe("2.5 s");
  });
});

describe("step picker", () => {
  it("round-trips action choices and explains unavailable steps", () => {
    const choice = { kind: "action" as const, actionId: "profile.update" };
    expect(decodeStepChoice(encodeStepChoice(choice))).toEqual(choice);
    const items = stepItems(catalog, { insideLoop: true });
    expect(items.find((i) => i.id === "forEach")?.disabledReason).toBe(
      "Not available inside a For each.",
    );
    expect(items.find((i) => i.id === "zapier.send")?.disabledReason).toMatch(/Zapier/);
    // Actions that change data come before lookups.
    expect(items.filter((i) => i.group === "Actions").map((i) => i.label)).toEqual([
      "Update profile",
      "Get profile",
    ]);
  });

  it("finds steps by any word", () => {
    const groups = filterPickerItems(stepItems(catalog, { insideLoop: false }), "update");
    expect(groups[0]!.items[0]!.label).toBe("Update profile");
    expect(filterPickerItems(stepItems(catalog, { insideLoop: false }), "zzz")).toEqual([]);
  });
});

const session: SessionView = {
  profile: null,
  organizations: [],
  permissions: [],
  account: null,
  signInMethods: ["password"],
  mcpRequiresVerifiedEmail: true,
  mcpUrl: "https://app.test/mcp",
  environment: "test",
};

function render(children: ReactNode) {
  return renderToString(
    <ThemeProvider>
      <ApiProvider
        client={createApiClient({
          fetch: (() => Promise.reject(new Error("no network"))) as never,
        })}
      >
        <NavProvider nav={{ path: "/automations/new", navigate() {}, openExternal() {} }}>
          <SessionProvider initial={session}>{children}</SessionProvider>
        </NavProvider>
      </ApiProvider>
    </ThemeProvider>,
  );
}

describe("automation start screen", () => {
  it("suggests automations built from the catalog's events", () => {
    const suggestions = startSuggestions(catalog);
    expect(suggestions[0]).toBe("When “Profile updated” happens, email the owners");
    expect(suggestions).toContain("When a deal closes in HubSpot (through Zapier), email the team");
    expect(startSuggestions(null)).toContain(
      "Every Monday at 9am, email me a summary of last week",
    );
  });

  it("renders the composer, suggestions, the blank start and event shortcuts", () => {
    const html = render(
      <AutomationStartView
        catalog={catalog}
        loading={false}
        busy={null}
        onCreate={() => {}}
        onBack={() => {}}
      />,
    );
    expect(html).toContain("Describe what should happen");
    expect(html).toContain("Start from a blank automation");
    expect(html).toContain("When “Profile updated” happens, email the owners");
    expect(html).toContain("profile.updated");
  });
});
