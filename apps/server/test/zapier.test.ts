import {
  ZAPIER_SECRET_HEADER,
  type AutomationDetail,
  type RunView,
  type ZapierConnectionView,
  type ZapierEventView,
} from "@template/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { Browser, call, ORIGIN, resetDatabase, signUp } from "./helpers";

beforeEach(resetDatabase);

async function inbound(browser: Browser, name = "Huff & Puff Testing (via Zapier)") {
  const { status, body } = await browser.act<{
    connection: ZapierConnectionView;
    secret: string;
  }>("zapier.create", { direction: "inbound", name });
  expect(status).toBe(200);
  return body;
}

function deliver(url: string, secret: string | null, body: unknown, headers: HeadersInit = {}) {
  return call(
    new Request(url, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(secret ? { [ZAPIER_SECRET_HEADER]: secret } : {}),
        ...headers,
      },
    }),
  );
}

const event = {
  provider: "hubspot",
  eventType: "deal.closed_won",
  externalId: "deal_1",
  data: { dealName: "Brick Production II", amount: "1000000" },
};

async function automationOn(browser: Browser, connectionId: string) {
  const { body } = await browser.act<{ id: string }>("automations.create", { name: "Deal won" });
  const detail = (await browser.act<AutomationDetail>("automations.get", { automationId: body.id }))
    .body;
  const saved = await browser.act("automations.saveDraft", {
    automationId: body.id,
    baseRevision: detail.automation.draftRevision,
    definition: {
      schemaVersion: 1,
      name: "Deal won",
      trigger: {
        kind: "zapier.event",
        connectionId,
        provider: "hubspot",
        eventType: "deal.closed_won",
      },
      steps: [
        {
          id: "keep",
          name: "Keep the deal",
          kind: "map",
          fields: { deal: "{{trigger.data.dealName}}" },
        },
      ],
    },
  });
  expect(saved.status).toBe(200);
  const published = await browser.act("automations.publish", {
    automationId: body.id,
    revision: detail.automation.draftRevision + 1,
  });
  expect(published.status).toBe(200);
  return body.id;
}

async function runsOf(browser: Browser, id: string, count = 1): Promise<RunView[]> {
  for (let i = 0; i < 100; i++) {
    const runs = (await browser.act<{ runs: RunView[] }>("automations.runs", { automationId: id }))
      .body.runs;
    if (runs.filter((r) => r.status === "succeeded").length >= count) return runs;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("No run finished");
}

describe("Zapier inbound", () => {
  it("shows the secret once, keeps only a hint, and gives the URL", async () => {
    const { browser } = await signUp();
    const { connection, secret } = await inbound(browser);
    expect(secret).toMatch(/^zap_/);
    expect(connection.url).toBe(`${ORIGIN}/hooks/zapier/${connection.id}/events`);
    const listed = (await browser.act<{ connections: ZapierConnectionView[] }>("zapier.list")).body
      .connections;
    expect(listed).toMatchObject([{ id: connection.id, hint: secret.slice(-4) }]);
    expect(JSON.stringify(listed)).not.toContain(secret);
  });

  it("refuses a missing or wrong secret, a bad body and an unknown connection", async () => {
    const { browser } = await signUp();
    const { connection, secret } = await inbound(browser);
    expect((await deliver(connection.url!, null, event)).status).toBe(401);
    expect((await deliver(connection.url!, `${secret}x`, event)).status).toBe(401);
    expect((await deliver(connection.url!, secret, "not json")).status).toBe(400);
    expect((await deliver(connection.url!, secret, { data: {} })).status).toBe(422);
    expect(
      (
        await deliver(
          `${ORIGIN}/hooks/zapier/0199d5a0-0000-7000-8000-000000000999/events`,
          secret,
          event,
        )
      ).status,
    ).toBe(404);
  });

  it("starts the automation once, ignoring a duplicate delivery", async () => {
    const { browser } = await signUp();
    const { connection, secret } = await inbound(browser);
    const id = await automationOn(browser, connection.id);
    const first = await deliver(connection.url!, secret, event);
    expect(first.status).toBe(202);
    const duplicate = await deliver(connection.url!, secret, event);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ duplicate: true });
    const [run] = await runsOf(browser, id);
    expect(run!.steps.find((s) => s.stepId === "keep")!.output).toEqual({
      deal: "Brick Production II",
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(
      (await browser.act<{ runs: RunView[] }>("automations.runs", { automationId: id })).body.runs,
    ).toHaveLength(1);
    const events = (
      await browser.act<{ events: ZapierEventView[] }>("zapier.events", {
        connectionId: connection.id,
      })
    ).body.events;
    expect(events).toMatchObject([{ eventType: "deal.closed_won", deliveries: 2 }]);
  });

  it("takes the organization from the connection, never from the body", async () => {
    const pigs = await signUp(new Browser(), "Bea Brickley");
    const wolves = await signUp(new Browser(), "Rex Howler");
    const { connection, secret } = await inbound(pigs.browser);
    const wolfSession = (
      await wolves.browser.json<{ profile: { organization: { id: string } } }>("/api/session")
    ).body;
    const sent = await deliver(connection.url!, secret, {
      ...event,
      organizationId: wolfSession.profile.organization.id,
    });
    expect(sent.status).toBe(202);
    const wolvesSee = (
      await wolves.browser.act<{ connections: ZapierConnectionView[] }>("zapier.list")
    ).body.connections;
    expect(wolvesSee).toEqual([]);
    const events = (
      await pigs.browser.act<{ events: ZapierEventView[] }>("zapier.events", {
        connectionId: connection.id,
      })
    ).body.events;
    expect(events).toHaveLength(1);
    expect(
      (await wolves.browser.act("zapier.events", { connectionId: connection.id })).status,
    ).toBe(404);
  });

  it("records a test event and says what it would start, without starting it", async () => {
    const { browser } = await signUp();
    const { connection } = await inbound(browser);
    const id = await automationOn(browser, connection.id);
    const { body } = await browser.act<ZapierEventView>("zapier.sendTestEvent", {
      connectionId: connection.id,
      body: event,
    });
    expect(body).toMatchObject({ status: "test", runs: [{ automationId: id, runId: null }] });
    expect(
      (await browser.act<{ runs: RunView[] }>("automations.runs", { automationId: id })).body.runs,
    ).toEqual([]);
  });

  it("stops the automations that use a deleted connection", async () => {
    const { browser } = await signUp();
    const { connection } = await inbound(browser);
    const id = await automationOn(browser, connection.id);
    const removed = await browser.act("zapier.delete", { connectionId: connection.id });
    expect(removed.body).toEqual({ stoppedAutomations: 1 });
    const detail = (await browser.act<AutomationDetail>("automations.get", { automationId: id }))
      .body;
    expect(detail.automation.status).toBe("failed");
  });
});

describe("Zapier outbound", () => {
  it("accepts only Catch Hook URLs and never returns the URL", async () => {
    const { browser } = await signUp();
    const bad = await browser.act("zapier.create", {
      direction: "outbound",
      url: "https://evil.example/hooks/catch/1/2/",
    });
    expect(bad.status).toBe(400);
    const url = "https://hooks.zapier.com/hooks/catch/123456/abcdef/";
    const good = await browser.act<{ connection: ZapierConnectionView; secret: null }>(
      "zapier.create",
      { direction: "outbound", name: "Sheets", url },
    );
    expect(good.status).toBe(200);
    expect(good.body.secret).toBeNull();
    const listed = await browser.act("zapier.list");
    expect(JSON.stringify(listed.body)).not.toContain("abcdef/");
  });

  it("simulates a zapier.send step without posting anything", async () => {
    const { browser } = await signUp();
    const hook = (
      await browser.act<{ connection: ZapierConnectionView }>("zapier.create", {
        direction: "outbound",
        name: "Sheets",
        url: "https://hooks.zapier.com/hooks/catch/1/2/",
      })
    ).body.connection;
    const { body } = await browser.act<{ id: string }>("automations.create");
    await browser.act("automations.saveDraft", {
      automationId: body.id,
      baseRevision: 1,
      definition: {
        schemaVersion: 1,
        name: "To Sheets",
        trigger: { kind: "manual" },
        steps: [
          {
            id: "send",
            name: "Add a row",
            kind: "zapier.send",
            connectionId: hook.id,
            body: { who: "{{trigger.actor.name}}" },
          },
        ],
      },
    });
    const run = await browser.act<RunView>("automations.simulate", { automationId: body.id });
    expect(run.body.steps.find((s) => s.stepId === "send")).toMatchObject({
      status: "simulated",
      input: { hook: "Sheets" },
    });
  });
});
