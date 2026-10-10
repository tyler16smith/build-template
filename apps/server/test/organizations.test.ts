import { beforeEach, describe, expect, it } from "vitest";
import {
  ACTIONS,
  ALL_SCOPES,
  mayRun,
  ORGANIZATION_HEADER,
  type ActionId,
  type Member,
  type Role,
  type SessionView,
} from "@template/contracts";
import { visibleActions } from "../src/mcp";
import { Browser, mailTo, resetDatabase, signUp, testEmail, verify } from "./helpers";
import { connect, exchange, registerClient, rpc } from "./oauth";

beforeEach(resetDatabase);

type Failure = { error: { code: string; message: string } };

function act<T = unknown>(
  browser: Browser,
  id: ActionId,
  input: unknown = {},
  headers: Record<string, string> = {},
) {
  return browser.json<T & Partial<Failure>>(`/api/actions/${id}`, { json: input, headers });
}

async function session(browser: Browser): Promise<SessionView> {
  return (await browser.json<SessionView>("/api/session")).body;
}

/** The token in the newest invitation mailed to `to` (its link is `/invite/<token>`). */
async function inviteToken(to: string): Promise<string> {
  const mail = (await mailTo(to)).find((m) => m.link?.includes("/invite/"));
  if (!mail?.link) throw new Error(`No invitation mailed to ${to}`);
  return decodeURIComponent(new URL(mail.link).pathname.replace(/^\/invite\//, ""));
}

/** Signs up someone with no company of their own, and brings them in through an invitation. */
async function invite(owner: Browser, name: string, role: "admin" | "member") {
  const email = testEmail(name.split(" ")[0]!.toLowerCase());
  const sent = await act(owner, "invites.create", { email, role });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  const browser = new Browser();
  const signed = await browser.json("/api/auth/sign-up", {
    json: { name, email, password: "brick-by-brick" },
  });
  expect(signed.status).toBe(200);
  const accepted = await browser.json<SessionView>("/api/invites/accept", {
    json: { token: await inviteToken(email) },
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const me = accepted.body.profile!;
  return { browser, email, userId: me.id };
}

describe("onboarding", () => {
  it("signs up into no company, refuses actions until one is named, then opens it", async () => {
    const { browser } = await signUp(new Browser(), "Bea Brickley", null);
    const before = await session(browser);
    expect(before.profile).toMatchObject({ name: "Bea Brickley", organization: null, role: null });
    expect(before.organizations).toEqual([]);
    expect(before.permissions).toEqual([]);
    const refused = await act<Failure>(browser, "profile.get");
    expect([refused.status, refused.body.error?.code]).toEqual([403, "no_organization"]);
    expect((await act<Failure>(browser, "automations.list")).body.error?.code).toBe(
      "no_organization",
    );

    const created = await browser.json<SessionView>("/api/organizations", {
      json: { name: "Three Pigs Construction" },
    });
    expect(created.status).toBe(200);
    expect(created.body.profile?.organization).toMatchObject({
      name: "Three Pigs Construction",
      slug: "three-pigs-construction",
    });
    expect(created.body.profile?.role).toBe("owner");
    expect(created.body.permissions).toContain("organization.delete");
    const org = await act<{ name: string; role: Role }>(browser, "organization.get");
    expect(org.body).toMatchObject({ name: "Three Pigs Construction", role: "owner" });
  });
});

describe("invitations", () => {
  it("invites by email, lands the person in the company as a member, and they can't invite", async () => {
    const { browser: bea } = await signUp(new Browser(), "Bea Brickley", "Three Pigs Construction");
    const email = testEmail("clem");
    const sent = await act<{ email: string; resent: boolean }>(bea, "invites.create", {
      email,
      role: "member",
    });
    expect(sent.body).toMatchObject({ email, resent: false });
    const mail = (await mailTo(email)).find((m) => m.link?.includes("/invite/"));
    expect(mail?.subject).toBe("Bea Brickley invited you to Three Pigs Construction");
    expect(mail?.text).toContain(
      "You've been invited to join Three Pigs Construction as a member.",
    );
    expect(mail?.text).toMatch(/This link expires on \d+ \w+\./);

    const token = await inviteToken(email);
    const preview = await new Browser().json(`/api/invites/${encodeURIComponent(token)}`);
    expect(preview.body).toMatchObject({
      organization: { name: "Three Pigs Construction" },
      invitedBy: "Bea Brickley",
      role: "member",
      email,
    });

    // Signed in as someone else: refused, and nothing changes.
    const { browser: other } = await signUp(new Browser(), "Clem Gmail", null);
    const wrong = await other.json<Failure>("/api/invites/accept", { json: { token } });
    expect([wrong.status, wrong.body.error.message]).toEqual([
      403,
      expect.stringMatching(/This invitation is for/),
    ]);

    const clem = new Browser();
    await clem.json("/api/auth/sign-up", {
      json: { name: "Clem Chimney", email, password: "brick-by-brick" },
    });
    const accepted = await clem.json<SessionView>("/api/invites/accept", { json: { token } });
    expect(accepted.body.profile).toMatchObject({
      emailVerified: true,
      role: "member",
      organization: { name: "Three Pigs Construction" },
    });
    expect(accepted.body.permissions).toEqual([]);
    const forbidden = await act<Failure>(clem, "invites.create", {
      email: testEmail("mama"),
      role: "admin",
    });
    expect([forbidden.status, forbidden.body.error?.code]).toEqual([403, "forbidden"]);
    const members = await act<{ members: Member[] }>(clem, "members.list");
    expect(members.body.members.map((m) => [m.name, m.role, m.you])).toEqual([
      ["Bea Brickley", "owner", false],
      ["Clem Chimney", "member", true],
    ]);
    // The link worked once.
    expect((await clem.json("/api/invites/accept", { json: { token } })).status).toBe(404);
  });

  it("lists, resends (the old link stops) and revokes", async () => {
    const { browser: bea } = await signUp(new Browser(), "Bea Brickley", "Three Pigs Construction");
    const email = testEmail("mama");
    const sent = await act<{ id: string }>(bea, "invites.create", { email, role: "admin" });
    const first = await inviteToken(email);
    const listed = await act<{ invites: { id: string; sendCount: number }[] }>(bea, "invites.list");
    expect(listed.body.invites.map((i) => i.id)).toEqual([sent.body.id]);
    // Once a minute.
    const tooSoon = await act<Failure>(bea, "invites.resend", { inviteId: sent.body.id });
    expect(tooSoon.body.error?.code).toBe("rate_limited");
    const revoked = await act(bea, "invites.revoke", { inviteId: sent.body.id });
    expect(revoked.status).toBe(200);
    expect((await new Browser().json(`/api/invites/${encodeURIComponent(first)}`)).status).toBe(
      404,
    );
  });

  it("offers invitations to a verified email on onboarding", async () => {
    const { browser: bea } = await signUp(new Browser(), "Bea Brickley", "Three Pigs Construction");
    const { browser: mort, email } = await signUp(new Browser(), "Mortimer Trowel", null);
    await act(bea, "invites.create", { email, role: "member" });
    expect((await mort.json<{ invites: unknown[] }>("/api/invites")).body.invites).toEqual([]);
    // The invitation's own link would verify it; here the sign-up link does.
    await verify(mort, email);
    const pending = await mort.json<{ invites: { id: string; organization: { name: string } }[] }>(
      "/api/invites",
    );
    expect(pending.body.invites.map((i) => i.organization.name)).toEqual([
      "Three Pigs Construction",
    ]);
    const joined = await mort.json<SessionView>("/api/invites/join", {
      json: { inviteId: pending.body.invites[0]!.id },
    });
    expect(joined.body.profile?.organization?.name).toBe("Three Pigs Construction");
  });
});

describe("switching", () => {
  it("switches between companies, each seeing only its own data, and refuses a stale tab", async () => {
    const { browser: bea } = await signUp(new Browser(), "Bea Brickley", "Three Pigs Construction");
    const wolf = await invite(bea, "Wolfgang Huffington", "member");
    const huff = await wolf.browser.json<SessionView>("/api/organizations", {
      json: { name: "Huff & Puff Testing" },
    });
    const huffId = huff.body.profile!.organization!.id;
    expect(huff.body.organizations.map((o) => [o.name, o.role])).toEqual([
      ["Huff & Puff Testing", "owner"],
      ["Three Pigs Construction", "member"],
    ]);
    const pigsId = huff.body.organizations[1]!.id;

    // Two tabs: this one loaded Huff & Puff; another switches to Three Pigs.
    const tab = { [ORGANIZATION_HEADER]: huffId };
    const switched = await wolf.browser.json<SessionView>("/api/auth/switch-organization", {
      json: { organizationId: pigsId },
    });
    expect(switched.body.profile?.organization?.id).toBe(pigsId);
    expect(switched.body.permissions).toEqual([]);

    // The stale tab's save is refused, not redirected, and nothing changed.
    const stale = await act<Failure>(
      wolf.browser,
      "organization.update",
      { name: "Huff & Puff Labs" },
      tab,
    );
    expect([stale.status, stale.body.error?.code]).toEqual([409, "organization_changed"]);
    const pigs = await act<{ name: string }>(
      wolf.browser,
      "organization.get",
      {},
      {
        [ORGANIZATION_HEADER]: pigsId,
      },
    );
    expect(pigs.body.name).toBe("Three Pigs Construction");
    const members = await act<{ members: Member[] }>(wolf.browser, "members.list");
    expect(members.body.members.map((m) => m.name).sort()).toEqual([
      "Bea Brickley",
      "Wolfgang Huffington",
    ]);

    // Back to Huff & Puff: its own data.
    await wolf.browser.json("/api/auth/switch-organization", {
      json: { organizationId: huffId },
    });
    const own = await act<{ members: Member[] }>(wolf.browser, "members.list");
    expect(own.body.members.map((m) => m.name)).toEqual(["Wolfgang Huffington"]);

    // A company they aren't in.
    const { browser: rex } = await signUp(new Browser(), "Rex Howler", "Big Bad Demolition Co.");
    const wolves = (await session(rex)).profile!.organization!.id;
    const denied = await wolf.browser.json<Failure>("/api/auth/switch-organization", {
      json: { organizationId: wolves },
    });
    expect([denied.status, denied.body.error.code]).toEqual([403, "not_a_member"]);
  });

  it("connects Claude to one company: it can't see another", async () => {
    const { browser: rex, email } = await signUp(
      new Browser(),
      "Rex Howler",
      "Big Bad Demolition Co.",
    );
    await verify(rex, email);
    const wolves = (await session(rex)).profile!.organization!.id;
    const pigs = await rex.json<SessionView>("/api/organizations", {
      json: { name: "Three Pigs Construction" },
    });
    expect(pigs.body.profile?.organization?.name).toBe("Three Pigs Construction");
    const clientId = await registerClient();
    const { code, verifier } = await connect(rex, clientId, ["profile:write"], wolves);
    const tokens = await exchange(clientId, code, verifier);
    const org = await rpc(tokens.access_token, "tools/call", {
      name: "organization_get",
      arguments: {},
    });
    expect(org.body.result.structuredContent).toMatchObject({
      id: wolves,
      name: "Big Bad Demolition Co.",
    });
    const connections = await rex.json<{ connections: { organization: { name: string } }[] }>(
      "/api/connections",
    );
    expect(connections.body.connections.map((c) => c.organization.name)).toEqual([
      "Big Bad Demolition Co.",
    ]);
  });
});

describe("members and the last-owner rule", () => {
  it("refuses demoting the last owner and admins touching owners", async () => {
    const { browser: bea } = await signUp(new Browser(), "Bea Brickley", "Three Pigs Construction");
    const beaId = (await session(bea)).profile!.id;
    const hank = await invite(bea, "Hank Hayes", "admin");
    const self = await act<Failure>(bea, "members.updateRole", { userId: beaId, role: "admin" });
    expect([self.status, self.body.error?.message]).toEqual([
      409,
      "Three Pigs Construction needs at least one owner. Make someone else an owner first.",
    ]);
    const demote = await act<Failure>(hank.browser, "members.updateRole", {
      userId: beaId,
      role: "member",
    });
    expect([demote.status, demote.body.error?.code]).toEqual([403, "forbidden"]);
    const remove = await act<Failure>(hank.browser, "members.remove", { userId: beaId });
    expect(remove.body.error?.code).toBe("forbidden");
  });

  it("cuts a removed member off: web, MCP and their connected apps", async () => {
    const { browser: bea } = await signUp(new Browser(), "Bea Brickley", "Three Pigs Construction");
    const stu = await invite(bea, "Stu Sticksworth", "member");
    const clientId = await registerClient();
    const { code, verifier } = await connect(stu.browser, clientId, []);
    const tokens = await exchange(clientId, code, verifier);
    expect((await rpc(tokens.access_token, "tools/list")).status).toBe(200);

    const removed = await act<Member>(bea, "members.remove", { userId: stu.userId });
    expect(removed.body).toMatchObject({ userId: stu.userId, name: "Stu Sticksworth" });
    // Their session in that company is gone, and so is the connection.
    expect((await session(stu.browser)).profile).toBeNull();
    expect((await rpc(tokens.access_token, "tools/list")).status).toBe(401);
  });

  it("transfers ownership, and emails both people", async () => {
    const { browser: bea, email } = await signUp(
      new Browser(),
      "Bea Brickley",
      "Three Pigs Construction",
    );
    const hank = await invite(bea, "Hank Hayes", "admin");
    const transferred = await act<{ members: Member[] }>(bea, "organization.transferOwnership", {
      userId: hank.userId,
    });
    expect(transferred.body.members.map((m) => [m.name, m.role])).toEqual([
      ["Hank Hayes", "owner"],
      ["Bea Brickley", "admin"],
    ]);
    expect((await mailTo(email))[0]?.subject).toBe("Three Pigs Construction has a new owner");
    expect((await mailTo(hank.email))[0]?.text).toMatch(/Bea Brickley made you the owner/);
  });

  it("deletes a company: members lose access at once, and the account check names it", async () => {
    const { browser: wolf } = await signUp(
      new Browser(),
      "Wolfgang Huffington",
      "Huff & Puff Testing",
    );
    const pip = await invite(wolf, "Pip Puffer", "member");
    const blockers = await wolf.json<{ organizations: { name: string }[] }>(
      "/api/auth/deletion-blockers",
    );
    expect(blockers.body.organizations.map((o) => o.name)).toEqual(["Huff & Puff Testing"]);
    const refused = await wolf.json<Failure>("/api/auth/delete-account", {
      json: { confirm: "DELETE", currentPassword: "brick-by-brick" },
    });
    expect([refused.status, refused.body.error.message]).toEqual([
      409,
      expect.stringMatching(/only owner of Huff & Puff Testing/),
    ]);

    const wrong = await act<Failure>(wolf, "organization.delete", { confirmName: "Huffy" });
    expect(wrong.body.error?.code).toBe("invalid_input");
    const deleted = await act<{ ok: true; next: null }>(wolf, "organization.delete", {
      confirmName: "Huff & Puff Testing",
    });
    expect(deleted.body).toEqual({ ok: true, next: null });
    const after = await session(pip.browser);
    expect(after.profile?.organization).toBeNull();
    expect(after.organizations).toEqual([]);
    expect((await act<Failure>(pip.browser, "members.list")).body.error?.code).toBe(
      "no_organization",
    );
  });
});

/**
 * Every action, as an owner, an admin, a member and a person in no company, against
 * `rolePermissions`. A new action without an input here fails the first test.
 */
describe("permissions", () => {
  /** An id that names nothing: permitted callers get `not_found`, the rest `forbidden`. */
  const NOWHERE = "0199d5a0-0000-7000-8000-00000000eeee";
  const INPUTS: Record<ActionId, (ids: { victim: string; self: string }) => unknown> = {
    "profile.get": () => ({}),
    "profile.update": () => ({ title: "Founder" }),
    "organization.get": () => ({}),
    "organization.update": () => ({ name: "Three Pigs Construction" }),
    "organization.transferOwnership": ({ self }) => ({ userId: self }),
    "organization.delete": () => ({ confirmName: "not the name" }),
    "members.list": () => ({}),
    "members.updateRole": ({ victim }) => ({ userId: victim, role: "member" }),
    "members.remove": ({ victim }) => ({ userId: victim }),
    "invites.list": () => ({}),
    "invites.create": () => ({ email: testEmail("recruit"), role: "member" }),
    "invites.resend": () => ({ inviteId: "0199d5a0-0000-7000-8000-00000000ffff" }),
    "invites.revoke": () => ({ inviteId: "0199d5a0-0000-7000-8000-00000000ffff" }),
    "automations.list": () => ({}),
    "automations.catalog": () => ({}),
    "automations.get": () => ({ automationId: NOWHERE }),
    "automations.create": () => ({ name: "Permission check" }),
    "automations.saveDraft": () => ({ automationId: NOWHERE, baseRevision: 1, definition: {} }),
    "automations.restore": () => ({ automationId: NOWHERE, revision: 1, baseRevision: 1 }),
    "automations.delete": () => ({ automationId: NOWHERE }),
    "automations.publish": () => ({ automationId: NOWHERE, revision: 1 }),
    "automations.setPaused": () => ({ automationId: NOWHERE, paused: true }),
    "automations.simulate": () => ({ automationId: NOWHERE }),
    "automations.liveTest": () => ({ automationId: NOWHERE, revision: 1, confirmEffects: true }),
    "automations.run": () => ({ automationId: NOWHERE, fields: {} }),
    "automations.runs": () => ({ automationId: NOWHERE }),
    "automations.getRun": () => ({ runId: NOWHERE }),
    "automations.cancelRun": () => ({ runId: NOWHERE }),
    "automations.decideApproval": () => ({
      runId: NOWHERE,
      approvalId: NOWHERE,
      decision: "approved",
    }),
    "automations.webhook": () => ({ automationId: NOWHERE }),
    "automations.rotateWebhook": () => ({ automationId: NOWHERE }),
    "zapier.list": () => ({}),
    "zapier.create": () => ({ direction: "inbound", name: "Permission check" }),
    "zapier.update": () => ({ connectionId: NOWHERE, name: "Renamed" }),
    "zapier.delete": () => ({ connectionId: NOWHERE }),
    "zapier.regenerateSecret": () => ({ connectionId: NOWHERE }),
    "zapier.events": () => ({ connectionId: NOWHERE }),
    "zapier.sendTestEvent": () => ({ connectionId: NOWHERE }),
    "zapier.sendTest": () => ({ connectionId: NOWHERE }),
    "assistant.config": () => ({}),
    "assistant.conversations": () => ({}),
    "assistant.deleteConversation": () => ({ conversationId: "nowhere" }),
    "assistant.usage": () => ({}),
    "assistant.saveSettings": () => ({
      defaultModel: "not-offered",
      monthlyBudgetUsd: 20,
      dailyRequests: 500,
    }),
    // Last: it really leaves (the owner is refused as the last owner).
    "organization.leave": () => ({}),
  };

  it("has an input for every action", () => {
    expect(Object.keys(INPUTS).sort()).toEqual(Object.keys(ACTIONS).sort());
  });

  it("lets each role run exactly what rolePermissions allows", async () => {
    const { browser: owner } = await signUp(
      new Browser(),
      "Bea Brickley",
      "Three Pigs Construction",
    );
    const ownerId = (await session(owner)).profile!.id;
    const admin = await invite(owner, "Hank Hayes", "admin");
    const member = await invite(owner, "Stu Sticksworth", "member");
    const victim = await invite(owner, "Mortimer Trowel", "member");
    const callers: [Role, Browser, string][] = [
      ["owner", owner, ownerId],
      ["admin", admin.browser, admin.userId],
      ["member", member.browser, member.userId],
    ];
    for (const [role, browser, self] of callers)
      for (const [id, input] of Object.entries(INPUTS) as [ActionId, (typeof INPUTS)[ActionId]][]) {
        const result = await act<Failure>(browser, id, input({ victim: victim.userId, self }));
        const refused = result.status === 403 && result.body.error?.code === "forbidden";
        expect([role, id, refused]).toEqual([role, id, !mayRun(ACTIONS[id], role)]);
      }
    const { browser: outsider } = await signUp(new Browser(), "Goldilocks", null);
    for (const [id, input] of Object.entries(INPUTS) as [ActionId, (typeof INPUTS)[ActionId]][]) {
      const result = await act<Failure>(outsider, id, input({ victim: victim.userId, self: "" }));
      expect([id, result.body.error?.code]).toEqual([id, "no_organization"]);
    }
  });

  it("lists to an MCP client only what the person's role may run", () => {
    const names = (role: Role) => visibleActions(ALL_SCOPES, role).map((a) => a.id);
    expect(names("member")).not.toContain("members.remove");
    expect(names("member")).toContain("members.list");
    expect(names("admin")).toContain("members.remove");
    expect(names("owner")).not.toContain("organization.delete");
  });
});
