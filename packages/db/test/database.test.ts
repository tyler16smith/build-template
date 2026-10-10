import { uuidv7 } from "@template/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  Database,
  eq,
  memberships,
  NO_ORGANIZATION,
  organizations,
  setContext,
  users,
  type TenantDb,
} from "../src";
import {
  createTestPostgres,
  readMigrations,
  runtimeRoleProblems,
  seededRowSecurityProblems,
  tenantPolicyProblems,
  tenantTables,
  truncateAll,
  type TestPostgres,
} from "../src/node";

let test: TestPostgres;
let owner: Database;

const A = { org: uuidv7(), user: uuidv7() };
const B = { org: uuidv7(), user: uuidv7() };

/** Seeds an organization with one owner, as the owner role with the tenant context set. */
async function seedOrganization(o: { org: string; user: string }, name: string) {
  await owner.batch(
    (d) => [
      d.insert(users).values({ id: o.user, email: `${name}@example.test`, name }),
      setContext(d, { organizationId: o.org }),
      d.insert(organizations).values({ id: o.org, name }),
      d.insert(memberships).values({ organizationId: o.org, userId: o.user, role: "owner" }),
    ],
    { "app.organization_id": o.org },
  );
}

beforeAll(async () => {
  test = await createTestPostgres();
  owner = new Database(test.owner);
});

afterAll(async () => {
  await test.close();
});

beforeEach(async () => {
  await truncateAll(test);
  await seedOrganization(A, "alpha");
  await seedOrganization(B, "bravo");
});

describe("migrations", () => {
  it("are numbered and include the RLS helper first", () => {
    expect(readMigrations().map((m) => m.name)).toEqual([
      "0000_tenant_rls",
      "0001_init",
      "0002_ai",
      "0003_organizations",
      "0004_organization_slugs",
    ]);
  });

  it("give every tenant table forced RLS and its policy", async () => {
    expect(await tenantTables(test.owner)).toEqual([
      "ai_conversations",
      "ai_settings",
      "ai_usage",
      "automation_approvals",
      "automation_draft_revisions",
      "automation_effects",
      "automation_run_steps",
      "automation_runs",
      "automation_versions",
      "automation_webhooks",
      "automations",
      "inbound_events",
      "memberships",
      "organization_invites",
      "organizations",
      "zapier_connections",
    ]);
    expect(await tenantPolicyProblems(test.owner)).toEqual([]);
  });
});

describe("Database.batch", () => {
  it("runs queries in the order written, in one transaction", async () => {
    const id = uuidv7();
    const [, found] = await test.db.batch((d) => [
      d.insert(users).values({ id, email: "order@example.test", name: "Order" }),
      d.select({ name: users.name }).from(users).where(eq(users.id, id)),
    ]);
    expect(found).toEqual([{ name: "Order" }]);
  });

  it("rolls back every statement when one fails", async () => {
    const id = uuidv7();
    await expect(
      test.db.batch((d) => [
        d.insert(users).values({ id, email: "rollback@example.test", name: "R" }),
        // Duplicate email: unique violation.
        d.insert(users).values({ id: uuidv7(), email: "rollback@example.test", name: "R2" }),
      ]),
    ).rejects.toThrow();
    const rows = await test.db.one((d) => d.select().from(users).where(eq(users.id, id)));
    expect(rows).toEqual([]);
  });

  it("maps rows into Drizzle's shapes, dates included", async () => {
    const [user] = await test.db.one((d) =>
      d.select().from(users).where(eq(users.id, A.user)).limit(1),
    );
    expect(user?.email).toBe("alpha@example.test");
    expect(user?.createdAt).toBeInstanceOf(Date);
  });

  it("treats email as case-insensitive", async () => {
    const rows = await test.db.one((d) =>
      d.select({ id: users.id }).from(users).where(eq(users.email, "ALPHA@Example.Test")),
    );
    expect(rows).toEqual([{ id: A.user }]);
  });
});

function tenants(filter: boolean): { a: TenantDb } {
  return {
    a: test.db.tenant(
      { organizationId: A.org, userId: A.user },
      { unsafeSkipTenantFilter: !filter },
    ),
  };
}

describe.each([
  ["the data layer and RLS", true],
  ["RLS alone (the data layer's filter off)", false],
])("tenant isolation with %s", (_label, filter) => {
  it("reads only organization A", async () => {
    const { a } = tenants(filter);
    const [orgs, members, count] = await a.batch((q) => [
      q.select(organizations),
      q.select(memberships),
      q.count(memberships),
    ]);
    expect(orgs.map((o) => o.id)).toEqual([A.org]);
    expect(members.map((m) => m.organizationId)).toEqual([A.org]);
    expect(count).toBe(1);
  });

  it("can't update or delete B's rows", async () => {
    const { a } = tenants(filter);
    const [renamed, removed] = await a.batch((q) => [
      q.update(organizations, { name: "taken" }, eq(organizations.id, B.org)),
      q.delete(memberships, eq(memberships.organizationId, B.org)),
    ]);
    expect(renamed).toEqual([]);
    expect(removed).toEqual([]);
    const [still] = await owner.one(
      (d) => d.select().from(organizations).where(eq(organizations.id, B.org)),
      { "app.organization_id": B.org },
    );
    expect(still?.name).toBe("bravo");
  });

  it("can't insert a row for B", async () => {
    const { a } = tenants(filter);
    const attempt = a.one((q) =>
      q.insert(memberships, { organizationId: B.org, userId: A.user, role: "member" }),
    );
    if (filter) {
      // The data layer overwrites the organization with A's; A already has this membership.
      await expect(attempt).rejects.toThrow();
    } else {
      // RLS refuses the row (WITH CHECK).
      await expect(attempt).rejects.toThrow();
    }
    const rows = await owner.one(
      (d) => d.select().from(memberships).where(eq(memberships.organizationId, B.org)),
      { "app.organization_id": B.org },
    );
    expect(rows.map((r) => r.userId)).toEqual([B.user]);
  });

  it("runs interactive transactions with the same scope", async () => {
    const { a } = tenants(filter);
    const seen = await a.transaction(async (q) => {
      const rows = await q.select(memberships).execute();
      return rows.map((r) => r.organizationId);
    });
    expect(seen).toEqual([A.org]);
  });
});

describe("row-level security", () => {
  it("lets a person read their own memberships, but nobody else's, with no organization set", async () => {
    const rows = await test.db.one((d) => d.select().from(memberships), {
      "app.organization_id": NO_ORGANIZATION,
      "app.user_id": A.user,
    });
    expect(rows.map((r) => r.userId)).toEqual([A.user]);
  });

  it("refuses a tenant query with no organization set", async () => {
    await expect(test.db.one((d) => d.select().from(organizations))).rejects.toThrow();
  });

  it("holds for every tenant table (probes)", async () => {
    const tables = await tenantTables(test.owner);
    expect(await seededRowSecurityProblems(test.runtime, tables)).toEqual([]);
  });

  it("gives the runtime role DML only", async () => {
    const tables = await tenantTables(test.owner);
    expect(await runtimeRoleProblems(test.runtime, tables, { loggedIn: test.loggedIn })).toEqual(
      [],
    );
  });
});
