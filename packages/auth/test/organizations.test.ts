import { ActionError, type Role } from "@template/contracts";
import {
  aiConversations,
  and,
  Database,
  eq,
  memberOrganizations,
  memberships,
  organizationInvites,
  organizations,
  tenantSettings,
  users,
  violatedConstraint,
} from "@template/db";
import { createTestPostgres, truncateAll, type TestPostgres } from "@template/db/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  Accounts,
  clearSessionCache,
  DELETED_ORGANIZATION_RETENTION_MS,
  INVITE_RESEND_MS,
  INVITE_RETENTION_MS,
  INVITE_TTL_MS,
} from "../src";

const PEPPER = "test-pepper";
let test: TestPostgres;
let owner: Database;
// Real time: the invite lookup in 0003 compares expires_at with the database's now().
const START = Date.now();
let now = START;
const clock = () => now;
let accounts: Accounts;

beforeAll(async () => {
  test = await createTestPostgres();
  owner = new Database(test.owner);
});
afterAll(() => test.close());
beforeEach(async () => {
  await truncateAll(test);
  clearSessionCache();
  now = START;
  accounts = new Accounts(test.db, PEPPER, clock);
});

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ActionError) return error.code;
    throw error;
  }
  return "ok";
}

async function message(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ActionError) return error.message;
    throw error;
  }
  return "ok";
}

let people = 0;

/** A signed-up person with a session (and no company yet). */
async function person(name: string) {
  const email = `${name.toLowerCase().replace(/\W+/g, ".")}${++people}@threepigs.example`;
  const signed = await accounts.signUp({ name, email, password: "brick-by-brick" }, null);
  const sessionHash = await accounts.sessions.hash(signed.session.token);
  return { ...signed, email, name, sessionHash };
}

type Person = Awaited<ReturnType<typeof person>>;

/** `who` creates a company and owns it. */
async function company(who: Person, name: string) {
  return accounts.organizations.create(who.userId, { name }, who.sessionHash);
}

/** `who` joins `organizationId` as `role`, through an invitation `by` sent. */
async function join(by: Person, organizationId: string, who: Person, role: "admin" | "member") {
  const { token } = await accounts.organizations.createInvite(
    { organizationId, userId: by.userId },
    { email: who.email, role },
  );
  now += INVITE_RESEND_MS;
  return accounts.organizations.acceptInvite(who.userId, token, who.sessionHash);
}

const as = (who: Person, organizationId: string) => ({ organizationId, userId: who.userId });

async function roles(organizationId: string): Promise<Record<string, Role>> {
  const rows = await owner.one(
    (d) =>
      d
        .select({ userId: memberships.userId, role: memberships.role })
        .from(memberships)
        .where(eq(memberships.organizationId, organizationId)),
    { "app.organization_id": organizationId },
  );
  return Object.fromEntries(rows.map((r) => [r.userId, r.role]));
}

describe("creating and switching", () => {
  it("lists the person's companies, most recently opened first, and switches only into theirs", async () => {
    const wolf = await person("Wolfgang Huffington");
    const bea = await person("Bea Brickley");
    const pigs = await company(bea, "Three Pigs Construction");
    await join(bea, pigs.id, wolf, "member");
    now += 1000;
    const huffPuff = await company(wolf, "Huff & Puff Testing");
    expect(huffPuff.slug).toBe("huff-and-puff-testing");

    const listed = await accounts.organizations.list(wolf.userId);
    expect(listed.map((o) => [o.name, o.role])).toEqual([
      ["Huff & Puff Testing", "owner"],
      ["Three Pigs Construction", "member"],
    ]);

    now += 1000;
    await accounts.organizations.switch(wolf.userId, wolf.sessionHash, pigs.id);
    const details = await accounts.sessions.details(wolf.session.token);
    expect(details?.identity).toMatchObject({ organizationId: pigs.id, role: "member" });
    expect(details?.organizations[0]?.id).toBe(pigs.id);

    const wolves = await company(await person("Rex Howler"), "Big Bad Demolition Co.");
    expect(
      await code(accounts.organizations.switch(wolf.userId, wolf.sessionHash, wolves.id)),
    ).toBe("not_a_member");
  });

  it("gives a clashing slug a number, and refuses one chosen by hand", async () => {
    const a = await company(await person("A"), "Mos Eisley Plumbing");
    const b = await company(await person("B"), "Mos Eisley Plumbing");
    expect([a.slug, b.slug]).toEqual(["mos-eisley-plumbing", "mos-eisley-plumbing-2"]);
    const c = await person("C");
    expect(
      await code(
        accounts.organizations.create(c.userId, { name: "Other", slug: "mos-eisley-plumbing" }),
      ),
    ).toBe("conflict");
  });

  it("only lists a person's own companies, whoever asks", async () => {
    const bea = await person("Bea Brickley");
    await company(bea, "Three Pigs Construction");
    const spy = await person("Spy");
    // The definer read checks app.user_id: asking for someone else's list returns nothing.
    const rows = await test.db.one((d) => memberOrganizations(d, bea.userId), {
      "app.organization_id": "00000000-0000-0000-0000-000000000000",
      "app.user_id": spy.userId,
    });
    expect(rows).toEqual([]);
  });
});

describe("invitations", () => {
  it("accepts only for the invited email, once, and verifies that email", async () => {
    const bea = await person("Bea Brickley");
    const org = await company(bea, "Three Pigs Construction");
    const clem = await person("Clem Chimney");
    const imposter = await person("Imposter");
    const { invite, token } = await accounts.organizations.createInvite(as(bea, org.id), {
      email: clem.email,
      role: "member",
    });
    expect(invite).toMatchObject({
      email: clem.email,
      role: "member",
      sendCount: 1,
      expired: false,
    });
    expect(invite.invitedBy.name).toBe("Bea Brickley");

    const preview = await accounts.organizations.previewInvite(token);
    expect(preview).toMatchObject({
      organizationName: "Three Pigs Construction",
      invitedByName: "Bea Brickley",
      role: "member",
    });
    expect(await accounts.organizations.previewInvite("not-a-token")).toBeNull();

    expect(
      await message(accounts.organizations.acceptInvite(imposter.userId, token, null)),
    ).toMatch(/This invitation is for .*You're signed in as/);

    const accepted = await accounts.organizations.acceptInvite(
      clem.userId,
      token,
      clem.sessionHash,
    );
    expect(accepted).toMatchObject({ joined: true, role: "member" });
    const details = await accounts.sessions.details(clem.session.token);
    expect(details?.identity).toMatchObject({ organizationId: org.id, role: "member" });
    expect(details?.profile.emailVerified).toBe(true);

    // A token works once.
    expect(await code(accounts.organizations.acceptInvite(clem.userId, token, null))).toBe(
      "not_found",
    );
    expect(await accounts.organizations.invites(as(bea, org.id))).toEqual([]);
  });

  it("refuses someone already in, resends a pending one (old link dead), and expires", async () => {
    const bea = await person("Bea Brickley");
    const org = await company(bea, "Three Pigs Construction");
    const mort = await person("Mortimer Trowel");
    expect(
      await code(
        accounts.organizations.createInvite(as(bea, org.id), {
          email: bea.email,
          role: "member",
        }),
      ),
    ).toBe("conflict");

    const first = await accounts.organizations.createInvite(as(bea, org.id), {
      email: mort.email,
      role: "member",
    });
    // Again within a minute: refused.
    expect(
      await code(
        accounts.organizations.createInvite(as(bea, org.id), {
          email: mort.email,
          role: "member",
        }),
      ),
    ).toBe("rate_limited");
    now += INVITE_RESEND_MS;
    const again = await accounts.organizations.createInvite(as(bea, org.id), {
      email: mort.email,
      role: "admin",
    });
    expect(again.resent).toBe(true);
    expect(again.invite).toMatchObject({ id: first.invite.id, sendCount: 2, role: "admin" });
    expect(await accounts.organizations.previewInvite(first.token)).toBeNull();

    now += INVITE_RESEND_MS;
    const resent = await accounts.organizations.resendInvite(as(bea, org.id), first.invite.id);
    expect(resent.invite.sendCount).toBe(3);
    expect(await accounts.organizations.previewInvite(again.token)).toBeNull();

    now += INVITE_TTL_MS + 1000;
    expect(await accounts.organizations.previewInvite(resent.token)).toBeNull();
    expect(await code(accounts.organizations.acceptInvite(mort.userId, resent.token, null))).toBe(
      "not_found",
    );
    const [expired] = await accounts.organizations.invites(as(bea, org.id));
    expect(expired?.expired).toBe(true);
  });

  it("revokes, and stops after 10 a minute from one person", async () => {
    const bea = await person("Bea Brickley");
    const org = await company(bea, "Three Pigs Construction");
    const sent = await accounts.organizations.createInvite(as(bea, org.id), {
      email: "mama@threepigs.example",
      role: "admin",
    });
    await accounts.organizations.revokeInvite(as(bea, org.id), sent.invite.id);
    expect(await accounts.organizations.previewInvite(sent.token)).toBeNull();
    expect(await code(accounts.organizations.revokeInvite(as(bea, org.id), sent.invite.id))).toBe(
      "not_found",
    );
    // The revoked one is gone, so it doesn't count: 10 more, then the 11th is refused.
    for (let i = 0; i < 10; i++)
      await accounts.organizations.createInvite(as(bea, org.id), {
        email: `piglet${i}@threepigs.example`,
        role: "member",
      });
    expect(
      await code(
        accounts.organizations.createInvite(as(bea, org.id), {
          email: "piglet-ten@threepigs.example",
          role: "member",
        }),
      ),
    ).toBe("rate_limited");
  });

  it("offers pending invitations to a verified email, and joins without the link", async () => {
    const bea = await person("Bea Brickley");
    const org = await company(bea, "Three Pigs Construction");
    const sid = await person("Sid Sparks");
    await accounts.organizations.createInvite(as(bea, org.id), {
      email: sid.email,
      role: "member",
    });
    // Not verified yet: nothing offered.
    expect(await accounts.organizations.pendingInvites(sid.userId, sid.email)).toEqual([]);
    await owner.one((d) =>
      d
        .update(users)
        .set({ emailVerifiedAt: new Date(now) })
        .where(eq(users.id, sid.userId)),
    );
    const [pending] = await accounts.organizations.pendingInvites(sid.userId, sid.email);
    expect(pending).toMatchObject({
      organization: { id: org.id, name: "Three Pigs Construction" },
      invitedBy: "Bea Brickley",
    });
    // Someone else can't see or take it.
    const other = await person("Other");
    expect(await accounts.organizations.pendingInvites(other.userId, sid.email)).toEqual([]);
    expect(
      await code(accounts.organizations.joinPending(other.userId, sid.email, pending!.id, null)),
    ).toBe("not_found");
    const joined = await accounts.organizations.joinPending(
      sid.userId,
      sid.email,
      pending!.id,
      sid.sessionHash,
    );
    expect(joined.joined).toBe(true);
    expect((await roles(org.id))[sid.userId]).toBe("member");
  });
});

describe("roles and the last-owner rule", () => {
  async function team() {
    const bea = await person("Bea Brickley");
    const org = await company(bea, "Three Pigs Construction");
    const hank = await person("Hank Hayes");
    const hamlet = await person("Hamlet Hogsworth");
    const stu = await person("Stu Sticksworth");
    await join(bea, org.id, hank, "admin");
    await join(bea, org.id, hamlet, "admin");
    await join(bea, org.id, stu, "member");
    return { org, bea, hank, hamlet, stu };
  }

  it("keeps at least one owner: no demoting, removing or leaving as the last one", async () => {
    const { org, bea, hank } = await team();
    expect(
      await message(accounts.organizations.changeRole(as(bea, org.id), bea.userId, "admin")),
    ).toBe("Three Pigs Construction needs at least one owner. Make someone else an owner first.");
    expect(await code(accounts.organizations.leave(as(bea, org.id)))).toBe("conflict");
    expect(await code(accounts.organizations.removeMember(as(hank, org.id), bea.userId))).toBe(
      "forbidden",
    );

    // With a second owner, the first may step down.
    await accounts.organizations.changeRole(as(bea, org.id), hank.userId, "owner");
    await accounts.organizations.changeRole(as(bea, org.id), bea.userId, "admin");
    expect(await roles(org.id)).toMatchObject({ [bea.userId]: "admin", [hank.userId]: "owner" });
  });

  it("lets only one of two owners stepping down at once succeed", async () => {
    const { org, bea, hank } = await team();
    await accounts.organizations.changeRole(as(bea, org.id), hank.userId, "owner");
    const outcomes = await Promise.all([
      code(accounts.organizations.changeRole(as(bea, org.id), bea.userId, "admin")),
      code(accounts.organizations.changeRole(as(hank, org.id), hank.userId, "admin")),
    ]);
    expect(outcomes.sort()).toEqual(["conflict", "ok"]);
    const owners = Object.values(await roles(org.id)).filter((r) => r === "owner");
    expect(owners).toHaveLength(1);
  });

  it("fails a write that skipped the checks, at commit (the trigger)", async () => {
    const { org, bea } = await team();
    const error = await test.db
      .one(
        (d) =>
          d.update(memberships).set({ role: "member" }).where(eq(memberships.userId, bea.userId)),
        tenantSettings(as(bea, org.id)),
      )
      .catch((e: unknown) => e);
    expect(violatedConstraint(error)).toBe("memberships_one_owner");
    expect((await roles(org.id))[bea.userId]).toBe("owner");
  });

  it("lets admins promote members, but not touch other admins or owners", async () => {
    const { org, bea, hank, hamlet, stu } = await team();
    await accounts.organizations.changeRole(as(hank, org.id), stu.userId, "admin");
    expect(
      await code(accounts.organizations.changeRole(as(hank, org.id), hamlet.userId, "member")),
    ).toBe("forbidden");
    expect(
      await code(accounts.organizations.changeRole(as(hank, org.id), bea.userId, "admin")),
    ).toBe("forbidden");
    expect(
      await code(accounts.organizations.changeRole(as(hank, org.id), stu.userId, "owner")),
    ).toBe("forbidden");
    // Members change nobody; anyone may lower their own role.
    expect(
      await code(accounts.organizations.changeRole(as(stu, org.id), hank.userId, "member")),
    ).toBe("forbidden");
    expect(
      await code(accounts.organizations.changeRole(as(hank, org.id), hank.userId, "member")),
    ).toBe("ok");
  });

  it("reads the actor's role in the transaction, not from a cached session", async () => {
    const { org, bea, hank, stu } = await team();
    await accounts.sessions.details(hank.session.token);
    await accounts.organizations.changeRole(as(bea, org.id), hank.userId, "member");
    // Her cached session still says admin; the change reads the database.
    expect(await code(accounts.organizations.removeMember(as(hank, org.id), stu.userId))).toBe(
      "forbidden",
    );
  });
});

describe("removing and leaving", () => {
  it("removes someone, ending their sessions in that company only", async () => {
    const bea = await person("Bea Brickley");
    const pigs = await company(bea, "Three Pigs Construction");
    const wolf = await person("Wolfgang Huffington");
    const huffPuff = await company(wolf, "Huff & Puff Testing");
    await join(bea, pigs.id, wolf, "member");
    const elsewhere = await accounts.signIn(
      { email: wolf.email, password: "brick-by-brick" },
      null,
    );
    await accounts.organizations.switch(
      wolf.userId,
      await accounts.sessions.hash(elsewhere.session.token),
      huffPuff.id,
    );

    const removed = await accounts.organizations.removeMember(as(bea, pigs.id), wolf.userId);
    expect(removed).toMatchObject({ userId: wolf.userId, role: "member" });
    // The session that had Three Pigs open is gone; the Huff & Puff one carries on.
    expect(await accounts.sessions.details(wolf.session.token)).toBeNull();
    expect((await accounts.sessions.details(elsewhere.session.token))?.identity).toMatchObject({
      organizationId: huffPuff.id,
      role: "owner",
    });
    expect(await accounts.organizations.list(wolf.userId)).toHaveLength(1);
  });

  it("moves a session whose company went away to the next one, and says so once", async () => {
    const bea = await person("Bea Brickley");
    const pigs = await company(bea, "Three Pigs Construction");
    const wolf = await person("Wolfgang Huffington");
    const huffPuff = await company(wolf, "Huff & Puff Testing");
    await join(bea, pigs.id, wolf, "member");
    // The membership goes behind the session's back (another isolate removed him).
    await owner.one(
      (d) =>
        d
          .delete(memberships)
          .where(and(eq(memberships.userId, wolf.userId), eq(memberships.organizationId, pigs.id))),
      { "app.organization_id": pigs.id },
    );
    clearSessionCache();
    const details = await accounts.sessions.details(wolf.session.token);
    expect(details?.identity).toMatchObject({
      organizationId: huffPuff.id,
      movedFrom: pigs.id,
    });
    expect((await accounts.sessions.details(wolf.session.token))?.identity.movedFrom).toBe(
      undefined,
    );
  });

  it("leaves, and the next request opens the person's other company", async () => {
    const bea = await person("Bea Brickley");
    const pigs = await company(bea, "Three Pigs Construction");
    const clem = await person("Clem Chimney");
    await join(bea, pigs.id, clem, "member");
    expect(await accounts.organizations.leave(as(clem, pigs.id))).toBeNull();
    const details = await accounts.sessions.details(clem.session.token);
    expect(details?.identity.organizationId).toBeNull();
    expect(await message(accounts.organizations.leave(as(bea, pigs.id)))).toMatch(
      /only member .* Delete the company instead/,
    );
  });

  it("transfers ownership: they become owner, you become admin", async () => {
    const bea = await person("Bea Brickley");
    const org = await company(bea, "Three Pigs Construction");
    const hank = await person("Hank Hayes");
    await join(bea, org.id, hank, "admin");
    expect(await code(accounts.organizations.transferOwnership(as(hank, org.id), bea.userId))).toBe(
      "forbidden",
    );
    await accounts.organizations.transferOwnership(as(bea, org.id), hank.userId);
    expect(await roles(org.id)).toEqual({ [bea.userId]: "admin", [hank.userId]: "owner" });
  });
});

describe("deleting a company", () => {
  it("cuts everyone off at once, can be restored for 30 days, then leaves nothing behind", async () => {
    const bea = await person("Bea Brickley");
    const org = await company(bea, "Three Pigs Construction");
    const clem = await person("Clem Chimney");
    await join(bea, org.id, clem, "member");
    await test.db.one(
      (d) =>
        d
          .insert(aiConversations)
          .values({ organizationId: org.id, userId: clem.userId, id: "chat-1" }),
      tenantSettings(as(clem, org.id)),
    );
    await accounts.organizations.createInvite(as(bea, org.id), {
      email: "mama@threepigs.example",
      role: "admin",
    });

    expect(await code(accounts.organizations.softDelete(as(clem, org.id), org.name))).toBe(
      "forbidden",
    );
    expect(await code(accounts.organizations.softDelete(as(bea, org.id), "Wrong"))).toBe(
      "invalid_input",
    );
    const deleted = await accounts.organizations.softDelete(
      as(bea, org.id),
      "three pigs construction",
    );
    expect(deleted.memberIds.sort()).toEqual([bea.userId, clem.userId].sort());
    expect(deleted.next).toBeNull();
    expect((await accounts.sessions.details(clem.session.token))?.identity.organizationId).toBe(
      null,
    );
    expect(await accounts.organizations.list(clem.userId)).toEqual([]);
    expect(await code(accounts.profile(as(clem, org.id)))).toBe("not_found");

    expect(await accounts.organizations.restore(org.id)).toBe(true);
    expect(await accounts.organizations.list(clem.userId)).toHaveLength(1);
    await accounts.organizations.softDelete(as(bea, org.id), org.name);

    const purged: string[] = [];
    expect(await accounts.organizations.purgeDeleted()).toEqual([]);
    now += DELETED_ORGANIZATION_RETENTION_MS + 1000;
    expect(
      await accounts.organizations.purgeDeleted(50, {
        beforeRemove: async (id) => {
          purged.push(id);
        },
      }),
    ).toEqual([org.id]);
    expect(purged).toEqual([org.id]);
    // Nothing of it is left, in any table.
    const left = await test.connection.query(
      `SELECT c.relname AS t FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attname = 'organization_id'`,
    );
    for (const { t } of left.rows) {
      const rows = await test.connection.query(
        `SELECT count(*)::int AS n FROM "${String(t)}" WHERE organization_id = $1`,
        [org.id],
      );
      expect([t, rows.rows[0]?.n]).toEqual([t, 0]);
    }
    const orgRows = await test.connection.query(`SELECT 1 FROM organizations WHERE id = $1`, [
      org.id,
    ]);
    expect(orgRows.rows).toEqual([]);
    expect(await accounts.organizations.restore(org.id)).toBe(false);
  });

  it("refuses to delete the account of a company's last owner, and takes solo companies with it", async () => {
    const wolf = await person("Wolfgang Huffington");
    const huffPuff = await company(wolf, "Huff & Puff Testing");
    const pip = await person("Pip Puffer");
    await join(wolf, huffPuff.id, pip, "member");
    const solo = await company(wolf, "Wolfgang's Wind Tunnel");
    const { blockers, alone } = await accounts.organizations.soleOwnerships(wolf.userId);
    expect(blockers.map((o) => o.id)).toEqual([huffPuff.id]);
    expect(alone.map((o) => o.id)).toEqual([solo.id]);
    expect(await message(accounts.deleteAccount(wolf.userId, "brick-by-brick"))).toMatch(
      /only owner of Huff & Puff Testing/,
    );
    await accounts.organizations.changeRole(as(wolf, huffPuff.id), pip.userId, "owner");
    await accounts.deleteAccount(wolf.userId, "brick-by-brick");
    const [soloRow] = await owner.one(
      (d) => d.select().from(organizations).where(eq(organizations.id, solo.id)),
      { "app.organization_id": solo.id },
    );
    expect(soloRow?.deletedAt).not.toBeNull();
  });
});

describe("invitation cleanup", () => {
  it("removes accepted and expired invitations after 90 days, and keeps the rest", async () => {
    const bea = await person("Bea Brickley");
    const org = await company(bea, "Three Pigs Construction");
    const clem = await person("Clem Chimney");
    await join(bea, org.id, clem, "member");
    await accounts.organizations.createInvite(as(bea, org.id), {
      email: "goldilocks@threebears.example",
      role: "member",
    });
    expect(await accounts.organizations.purgeInvites()).toBe(0);
    now += INVITE_RETENTION_MS + INVITE_TTL_MS + 60_000;
    const fresh = await accounts.organizations.createInvite(as(bea, org.id), {
      email: "mama@threepigs.example",
      role: "admin",
    });
    expect(await accounts.organizations.purgeInvites()).toBe(2);
    const left = await owner.one(
      (d) =>
        d
          .select({ id: organizationInvites.id })
          .from(organizationInvites)
          .where(eq(organizationInvites.organizationId, org.id)),
      { "app.organization_id": org.id },
    );
    expect(left.map((r) => r.id)).toEqual([fresh.invite.id]);
  });
});
