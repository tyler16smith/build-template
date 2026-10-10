import type {
  AutomationDefinitionInput,
  AutomationDetail,
  AutomationList,
  DraftSaveResult,
  RunView,
  SessionView,
} from "@template/contracts";
import { Database } from "@template/db";
import { beforeEach, describe, expect, it } from "vitest";
import { createRuntimeContext } from "../src/lib/context";
import { sqlDatabase } from "../src/lib/database";
import { scopeFor } from "../src/modules/automations/context";
import { once, type RunContext } from "../src/modules/automations/interpreter";
import { createRunRecord } from "../src/modules/automations/runs";
import { Browser, call, env, mailTo, ORIGIN, resetDatabase, signUp, testEmail } from "./helpers";

beforeEach(resetDatabase);

async function create(browser: Browser, name = "Straw MVP reminder") {
  const { status, body } = await browser.act<{ id: string }>("automations.create", { name });
  expect(status).toBe(200);
  return body.id;
}

async function detail(browser: Browser, id: string) {
  return (await browser.act<AutomationDetail>("automations.get", { automationId: id })).body;
}

async function save(browser: Browser, id: string, definition: AutomationDefinitionInput) {
  const { draft, automation } = await detail(browser, id);
  void draft;
  return browser.act<DraftSaveResult & { error?: { message: string } }>("automations.saveDraft", {
    automationId: id,
    baseRevision: automation.draftRevision,
    definition,
    summary: "test",
  });
}

async function publish(browser: Browser, id: string) {
  const { automation } = await detail(browser, id);
  return browser.act<{ version: number }>("automations.publish", {
    automationId: id,
    revision: automation.draftRevision,
  });
}

/** Polls a run until it's finished (the Workflow runs on its own). */
async function waitForRun(browser: Browser, automationId: string, done = 1): Promise<RunView[]> {
  for (let i = 0; i < 100; i++) {
    const { body } = await browser.act<{ runs: RunView[] }>("automations.runs", { automationId });
    const finished = body.runs.filter((r) =>
      ["succeeded", "failed", "rejected"].includes(r.status),
    );
    if (finished.length >= done) return body.runs;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The run didn't finish");
}

const reminder = (to: string): AutomationDefinitionInput => ({
  schemaVersion: 1,
  name: "Straw MVP reminder",
  trigger: { kind: "app.event", eventId: "profile.updated" },
  steps: [
    {
      id: "remind_lou",
      name: "Remind Lou",
      kind: "email.send",
      to,
      subject: "Check the Straw MVP",
      body: "{{trigger.actor.name}} changed their profile. It's always the straw one.",
    },
  ],
});

describe("automation drafts", () => {
  it("start empty, save with a revision, and refuse a stale save", async () => {
    const { browser } = await signUp();
    const id = await create(browser);
    const first = await detail(browser, id);
    expect(first.automation).toMatchObject({ status: "draft", draftRevision: 1 });
    expect(first.issues.some((i) => i.message === "Add at least one step.")).toBe(true);

    const saved = await save(browser, id, reminder("clem@threepigs.example"));
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ revision: 2, issues: [] });

    // A save from an older revision (the chat, say, while the editor saved) is a conflict.
    const stale = await browser.act("automations.saveDraft", {
      automationId: id,
      baseRevision: 1,
      definition: reminder("x@threepigs.example"),
    });
    expect(stale.status).toBe(409);
  });

  it("refuse an unknown action, a reference to a later step and unknown fields", async () => {
    const { browser } = await signUp();
    const id = await create(browser);
    const unknownAction = await save(browser, id, {
      schemaVersion: 1,
      name: "Bad",
      trigger: { kind: "manual" },
      steps: [{ id: "x", name: "X", kind: "action", actionId: "wolf.huff", input: {} }],
    });
    expect(unknownAction.status).toBe(400);
    const forward = await save(browser, id, {
      schemaVersion: 1,
      name: "Bad",
      trigger: { kind: "manual" },
      steps: [
        {
          id: "first",
          name: "First",
          kind: "email.send",
          to: "{{steps.second.output.to}}",
          subject: "s",
          body: "b",
        },
        { id: "second", name: "Second", kind: "map", fields: { to: "a@b.example" } },
      ],
    });
    expect(forward.status).toBe(400);
    const extra = await save(browser, id, {
      schemaVersion: 1,
      name: "Bad",
      trigger: { kind: "manual" },
      steps: [],
      surprise: true,
    } as never);
    expect(extra.status).toBe(400);
  });
});

describe("publishing and running", () => {
  it("refuses to publish with problems, and publishes a valid draft as version 1", async () => {
    const { browser } = await signUp();
    const id = await create(browser);
    expect((await publish(browser, id)).status).toBe(400);
    await save(browser, id, reminder("clem@threepigs.example"));
    const published = await publish(browser, id);
    expect(published.body).toEqual({ version: 1 });
    const list = (await browser.act<AutomationList>("automations.list")).body;
    expect(list.automations).toMatchObject([
      { id, status: "active", activeVersion: 1, triggerTitle: "When: Profile updated" },
    ]);
  });

  it("starts from an action's event and runs on the Workflow, sending the email once", async () => {
    const { browser } = await signUp(new Browser(), "Bea Brickley");
    const clem = testEmail("clem");
    const id = await create(browser);
    await save(browser, id, reminder(clem));
    await publish(browser, id);

    const updated = await browser.json("/api/actions/profile.update", {
      json: { title: "Founder" },
    });
    expect(updated.status).toBe(200);
    const [run] = await waitForRun(browser, id);
    expect(run).toMatchObject({ status: "succeeded", mode: "live", triggerKind: "app.event" });
    expect(run!.steps.map((s) => [s.stepId, s.status])).toEqual([
      ["trigger", "succeeded"],
      ["remind_lou", "succeeded"],
    ]);
    const mail = await mailTo(clem);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.text).toContain("Bea Brickley changed their profile");
  });

  it("keeps a started run on its pinned version when a new one is published", async () => {
    const { browser } = await signUp();
    const clem = testEmail("clem");
    const id = await create(browser);
    await save(browser, id, reminder(clem));
    await publish(browser, id);
    await browser.json("/api/actions/profile.update", { json: { title: "One" } });
    await save(browser, id, { ...reminder(clem), name: "Version two" });
    expect((await publish(browser, id)).body).toEqual({ version: 2 });
    const [run] = await waitForRun(browser, id);
    expect(run!.version).toBe(1);
  });

  it("simulates the draft: reads run, writes and email are only simulated", async () => {
    const { browser } = await signUp();
    const id = await create(browser);
    await save(browser, id, {
      schemaVersion: 1,
      name: "Simulated",
      trigger: { kind: "manual" },
      steps: [
        { id: "me", name: "Read my profile", kind: "action", actionId: "profile.get", input: {} },
        {
          id: "rename",
          name: "Rename me",
          kind: "action",
          actionId: "profile.update",
          input: { title: "Overlord" },
        },
        {
          id: "tell",
          name: "Tell me",
          kind: "email.send",
          to: "{{steps.me.output.email}}",
          subject: "Hi",
          body: "Hello {{steps.me.output.name}}",
        },
      ],
    });
    const { status, body } = await browser.act<RunView>("automations.simulate", {
      automationId: id,
    });
    expect(status).toBe(200);
    expect(body.status).toBe("succeeded");
    expect(body.steps.map((s) => [s.stepId, s.status])).toEqual([
      ["trigger", "succeeded"],
      ["me", "succeeded"],
      ["rename", "simulated"],
      ["tell", "simulated"],
    ]);
    const session = (await browser.json<SessionView>("/api/session")).body;
    expect(session.profile!.title).toBeNull();
    expect((body.steps[3]!.input as { to: string[] }).to).toEqual([session.profile!.email]);
  });

  it("records an effect once: a retried step doesn't repeat it", async () => {
    const { browser } = await signUp();
    const id = await create(browser);
    await save(browser, id, reminder("clem@threepigs.example"));
    const session = (await browser.json<SessionView>("/api/session")).body.profile!;
    const ctx = createRuntimeContext(env, { source: "workflow", route: "test" });
    const scope = scopeFor(
      ctx,
      { organizationId: session.organization!.id, userId: session.id, role: "owner" },
      "test",
    );
    const { run } = await createRunRecord(scope.db, {
      automation: { id },
      version: 1,
      definition: { ...(await detail(browser, id)).draft },
      mode: "live",
      triggerKind: "manual",
      triggerEventId: "test-once",
      triggerPayload: {},
      runAsUserId: session.id,
      startedBy: null,
      chainDepth: 0,
    });
    const runContext: RunContext = {
      ctx,
      db: scope.db,
      runId: run.id,
      organizationId: session.organization!.id,
      automationId: id,
      runAs: { userId: session.id, role: "owner" },
      chainDepth: 0,
      mode: "live",
    };
    let sent = 0;
    const effect = async () => ({ sent: ++sent });
    expect(await once(runContext, "remind_lou", effect)).toEqual({ sent: 1 });
    expect(await once(runContext, "remind_lou", effect)).toEqual({ sent: 1 });
    expect(sent).toBe(1);
    ctx.close();
  });
});

describe("approvals", () => {
  it("wait for an allowed approver, and a decline stops the run", async () => {
    const { browser } = await signUp(new Browser(), "Bea Brickley");
    const id = await create(browser, "Ship the Stick Upgrade");
    await save(browser, id, {
      schemaVersion: 1,
      name: "Ship the Stick Upgrade",
      trigger: { kind: "manual" },
      steps: [
        {
          id: "ask_bea",
          name: "Ask Bea",
          kind: "approval",
          approvers: { roles: ["owner"] },
          message: "Ship the Stick Upgrade?",
        },
        { id: "note", name: "Note", kind: "map", fields: { reopened: true } },
      ],
    });
    await publish(browser, id);
    const started = await browser.act<{ runId: string }>("automations.run", {
      automationId: id,
      fields: {},
    });
    expect(started.status).toBe(200);
    const runId = started.body.runId;

    let approvalId = "";
    for (let i = 0; i < 100 && !approvalId; i++) {
      const run = (await browser.act<RunView>("automations.getRun", { runId })).body;
      approvalId = run.approvals[0]?.id ?? "";
      if (!approvalId) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(approvalId).not.toBe("");
    const list = (await browser.act<AutomationList>("automations.list")).body;
    expect(list.approvalsWaiting).toMatchObject([{ runId, message: "Ship the Stick Upgrade?" }]);

    const declined = await browser.act("automations.decideApproval", {
      runId,
      approvalId,
      decision: "rejected",
      note: "No.",
    });
    expect(declined.status).toBe(200);
    const [run] = await waitForRun(browser, id);
    expect(run).toMatchObject({ status: "rejected" });
    expect(run!.steps.find((s) => s.stepId === "note")!.status).toBe("skipped");
  });
});

describe("webhook triggers", () => {
  async function sign(secret: string, timestamp: string, body: string) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${body}`),
    );
    return `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  it("start a run from a signed body, once per delivery, and refuse a bad signature", async () => {
    const { browser } = await signUp();
    const id = await create(browser, "Webhook");
    await save(browser, id, {
      schemaVersion: 1,
      name: "Webhook",
      trigger: { kind: "webhook", fields: [{ key: "ticket", label: "Ticket", required: true }] },
      steps: [
        { id: "keep", name: "Keep", kind: "map", fields: { ticket: "{{trigger.body.ticket}}" } },
      ],
    });
    await publish(browser, id);
    const { url, secret } = (
      await browser.act<{ url: string; secret: string }>("automations.webhook", {
        automationId: id,
      })
    ).body;
    const body = JSON.stringify({ ticket: "STRAW-1" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const post = async (signature: string) =>
      call(
        new Request(url, {
          method: "POST",
          body,
          headers: {
            "x-webhook-timestamp": timestamp,
            "x-webhook-signature": signature,
            "x-webhook-delivery": "delivery-1",
          },
        }),
      );
    expect((await post("sha256=00")).status).toBe(401);
    const accepted = await post(await sign(secret, timestamp, body));
    expect(accepted.status).toBe(202);
    const again = await post(await sign(secret, timestamp, body));
    expect(await again.json()).toMatchObject({ ok: true, duplicate: true });
    const [run] = await waitForRun(browser, id);
    expect(run!.status).toBe("succeeded");
  });
});

describe("tenant isolation", () => {
  it("keeps every automation route inside the person's organization", async () => {
    const pigs = await signUp(new Browser(), "Bea Brickley");
    const wolves = await signUp(new Browser(), "Rex Howler");
    const id = await create(pigs.browser);
    await save(pigs.browser, id, reminder("clem@threepigs.example"));
    await publish(pigs.browser, id);
    const wolf = wolves.browser;
    expect((await wolf.act<AutomationList>("automations.list")).body.automations).toEqual([]);
    const automationId = id;
    for (const [action, input] of [
      ["automations.get", { automationId }],
      ["automations.delete", { automationId }],
      [
        "automations.saveDraft",
        { automationId, baseRevision: 2, definition: reminder("x@bigbad.example") },
      ],
      ["automations.publish", { automationId, revision: 2 }],
      ["automations.setPaused", { automationId, paused: true }],
      ["automations.simulate", { automationId }],
      ["automations.run", { automationId, fields: {} }],
      ["automations.runs", { automationId }],
      ["automations.webhook", { automationId }],
    ] as const) {
      const response = await wolf.act(action, input);
      expect([403, 404], action).toContain(response.status);
    }
    // A wolf's own profile change doesn't start the pigs' automation.
    await wolf.json("/api/actions/profile.update", { json: { title: "Demolition" } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(
      (await pigs.browser.act<{ runs: RunView[] }>("automations.runs", { automationId: id })).body
        .runs,
    ).toEqual([]);
  });

  it("refuses requests from another origin and without a session", async () => {
    const { browser } = await signUp();
    const cross = await browser.fetch("/api/actions/automations.create", {
      json: { name: "x" },
      headers: { origin: "https://evil.example" },
    });
    expect(cross.status).toBe(403);
    const anonymous = await call(
      new Request(`${ORIGIN}/api/actions/automations.list`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(anonymous.status).toBe(401);
  });
});

describe("the database layer", () => {
  it("is reachable for the tests", async () => {
    const database = new Database(sqlDatabase(env));
    await database.ping();
    await database.close();
  });
});
