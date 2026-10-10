import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  automationRuns,
  automations,
  Database,
  eq,
  memberships,
  organizationInvites,
  organizations,
  users,
  zapierConnections,
} from "@template/db";
import { createTestPostgres } from "@template/db/node";
import { describe, expect, it } from "vitest";
import { boundaryProblems } from "../src/checks";
import {
  organizationInputProblems,
  organizationKeys,
  roleComparisonProblems,
} from "../src/permissions";
import { buildQuery, parseSince, scriptName } from "../src/logs";
import { nextSteps, rename, slugOf } from "../src/rename";
import { DEMO, seedDemo } from "../src/seed";

describe("check:permissions", () => {
  it("fails on an organizationId in an action's input, at any depth", () => {
    expect(organizationInputProblems()).toEqual([]);
    const input = {
      type: "object",
      properties: {
        name: { type: "string" },
        filter: {
          type: "object",
          properties: { organization_id: { type: "string" } },
        },
        items: { type: "array", items: { type: "object", properties: { organizationId: {} } } },
      },
    };
    expect(organizationKeys(input)).toEqual(["filter.organization_id", "items.organizationId"]);
    expect(organizationInputProblems({ "jobs.list": { input } })).toHaveLength(2);
  });

  it("fails on a role comparison outside permissions.ts", () => {
    const file = "apps/server/src/modules/jobs/actions.ts";
    for (const code of [
      `if (ctx.membership.role === "admin") {}`,
      `const owner = "owner" === profile.role;`,
      `if (roles.includes("admin")) {}`,
      `if (["owner", "admin"].includes(member.role)) {}`,
      `switch (ctx.membership.role) {}`,
      `const can = role !== 'member';`,
    ])
      expect(roleComparisonProblems(file, code), code).toHaveLength(1);
    expect(roleComparisonProblems(file, `if (ctx.can("members.manage")) {}`)).toEqual([]);
    expect(roleComparisonProblems(file, `if (message.role === "assistant") {}`)).toEqual([]);
    expect(roleComparisonProblems(file, `// role === "owner" in a comment`)).toEqual([]);
    // The one file that decides, the seed and tests may.
    for (const exempt of [
      "packages/contracts/src/permissions.ts",
      "packages/tooling/src/seed.ts",
      "apps/server/test/members.test.ts",
    ])
      expect(roleComparisonProblems(exempt, `role === "owner"`)).toEqual([]);
  });
});

describe("check:boundaries", () => {
  it("keeps screens and ui away from fetch, window.location and apps", () => {
    expect(
      boundaryProblems("packages/screens/src/x.tsx", `const r = await fetch("/api");`),
    ).toHaveLength(1);
    expect(boundaryProblems("packages/ui/src/x.tsx", `window.location.assign("/")`)).toHaveLength(
      1,
    );
    expect(
      boundaryProblems(
        "packages/screens/src/x.tsx",
        `import { router } from "@tanstack/react-router";`,
      ),
    ).toHaveLength(1);
    expect(
      boundaryProblems(
        "packages/screens/src/x.tsx",
        `// fetch( in a comment is fine\nimport { useApi } from "./context";`,
      ),
    ).toEqual([]);
  });

  it("keeps SQL drivers in the db package and console calls in the logger", () => {
    expect(
      boundaryProblems("apps/server/src/x.ts", `import { sql } from "drizzle-orm";`),
    ).toHaveLength(1);
    expect(boundaryProblems("packages/db/src/x.ts", `import { sql } from "drizzle-orm";`)).toEqual(
      [],
    );
    expect(boundaryProblems("apps/server/src/routes/x.ts", `console.log("hi")`)).toHaveLength(1);
    expect(boundaryProblems("apps/server/src/lib/log.ts", `console.log(line)`)).toEqual([]);
  });

  it("keeps a module's core pure", () => {
    const core = "apps/server/src/modules/customers/core.ts";
    expect(
      boundaryProblems(
        core,
        `import { ActionError } from "@template/contracts";\nexport const due = (now: Date) => new Date(now.getTime() + 1);`,
      ),
    ).toEqual([]);
    expect(boundaryProblems(core, `import { customers } from "@template/db";`)).toHaveLength(1);
    expect(boundaryProblems(core, `import { getRun } from "./service";`)).toHaveLength(1);
    expect(boundaryProblems(core, `import { rank } from "./core/rank";`)).toEqual([]);
    expect(
      boundaryProblems(
        "apps/server/src/modules/customers/core/rank.ts",
        `import { x } from "./y";`,
      ),
    ).toEqual([]);
    expect(
      boundaryProblems(
        "apps/server/src/modules/customers/core/rank.ts",
        `import { x } from "../y";`,
      ),
    ).toHaveLength(1);
    for (const impure of [
      `export async function load() {}`,
      `const at = new Date();`,
      `const at = Date.now();`,
      `const id = uuidv7();`,
      `ctx.log.info("x");`,
      `await fetch(url);`,
    ])
      expect(boundaryProblems(core, impure)).toHaveLength(1);
    // The shell next to it may do all of that.
    expect(
      boundaryProblems("apps/server/src/modules/customers/actions.ts", `const at = new Date();`),
    ).toEqual([]);
  });

  it("keeps api-client on contracts only", () => {
    expect(
      boundaryProblems("packages/api-client/src/index.ts", `import { z } from "zod";`),
    ).toHaveLength(1);
    expect(
      boundaryProblems(
        "packages/api-client/src/index.ts",
        `import { PATHS } from "@template/contracts";`,
      ),
    ).toEqual([]);
  });
});

describe("pnpm logs", () => {
  it("pins the Worker and narrows with a needle", () => {
    const query = buildQuery({
      script: "build-template-staging",
      from: 1,
      to: 2,
      requestId: "r-1",
      level: "error",
    });
    expect(query.parameters.filters[0]).toMatchObject({
      key: "$metadata.service",
      operation: "eq",
      value: "build-template-staging",
    });
    expect(query.parameters.needle).toMatchObject({ value: "r-1" });
    expect(query.dry).toBe(true);
    expect(scriptName("staging")).toBe("build-template-staging");
    expect(scriptName("production")).toBe("build-template");
    expect(parseSince("2h", 10_000_000)).toBe(10_000_000 - 7_200_000);
    expect(() => parseSince("30d")).toThrow();
  });
});

describe("pnpm rename", () => {
  const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), "rename-"));
    mkdirSync(join(dir, "apps"));
    writeFileSync(
      join(dir, "apps/wrangler.jsonc"),
      `{"name": "build-template-staging", "origin": "https://build-template-staging.your-subdomain.workers.dev", "dataset": "build_template_staging", "APP_NAME": "Build Template"}`,
    );
    writeFileSync(
      join(dir, "package.json"),
      `{"name": "build-template", "dependencies": {"@template/db": "workspace:*"}}`,
    );
    writeFileSync(
      join(dir, "README.md"),
      "Neon `build-template-prod`, KV `build-template-oauth-staging`, Worker `build-template`",
    );
    return dir;
  };

  it("rewrites scope, names and domains", () => {
    const dir = fixture();
    const changed = rename({ name: "Trades Pro", scope: "@trades", domain: "tradespro.com" }, dir);
    expect(changed.sort()).toEqual(["README.md", "apps/wrangler.jsonc", "package.json"]);
    expect(readFileSync(join(dir, "apps/wrangler.jsonc"), "utf8")).toBe(
      `{"name": "trades-pro-staging", "origin": "https://staging.tradespro.com", "dataset": "trades_pro_staging", "APP_NAME": "Trades Pro"}`,
    );
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(
      `{"name": "trades-pro", "dependencies": {"@trades/db": "workspace:*"}}`,
    );
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe(
      "Neon `trades-pro-prod`, KV `trades-pro-oauth-staging`, Worker `trades-pro`",
    );
    expect(slugOf("Trades Pro!")).toBe("trades-pro");
  });

  it("keeps workers.dev without a domain", () => {
    const dir = fixture();
    rename({ name: "Trades Pro", scope: "@trades" }, dir);
    expect(readFileSync(join(dir, "apps/wrangler.jsonc"), "utf8")).toContain(
      `"origin": "https://trades-pro-staging.your-subdomain.workers.dev"`,
    );
    expect(nextSteps({ name: "Trades Pro", scope: "@trades" })).toContain("No domain yet");
  });
});

describe("pnpm db:seed", () => {
  it("refuses production and unmarked databases, and is idempotent", async () => {
    const test = await createTestPostgres();
    try {
      const owner = new Database(test.owner);
      await expect(seedDemo(owner, "production", "demo-password-1")).rejects.toThrow(
        /never runs on production/,
      );
      await expect(seedDemo(owner, "staging", "demo-password-1")).rejects.toThrow(/marker/);
      await test.connection.exec(
        `INSERT INTO environment_markers (name) VALUES ('demo_data_allowed')`,
      );
      await seedDemo(owner, "local", "demo-password-1");
      await owner.one((d) =>
        d.update(users).set({ name: "Changed" }).where(eq(users.id, DEMO[0]!.people[0]!.id)),
      );
      await seedDemo(owner, "local", "demo-password-1");
      const [bea] = await owner.one((d) =>
        d.select().from(users).where(eq(users.id, DEMO[0]!.people[0]!.id)),
      );
      expect(bea?.name).toBe("Bea Brickley");
      const rows = await owner.one((d) => d.select().from(memberships));
      expect(rows).toHaveLength(12);
      // Wolfgang is in all three companies: a member, an admin and the only owner.
      const wolf = rows.filter((m) => m.userId === "0199d5a0-0000-7000-8000-00000000012d");
      expect(wolf.map((m) => m.role).sort()).toEqual(["admin", "member", "owner"]);
      const companies = await owner.one((d) => d.select().from(organizations));
      expect(companies.map((o) => o.slug).sort()).toEqual([
        "big-bad-demolition-co",
        "huff-and-puff-testing",
        "three-pigs-construction",
      ]);
      const invites = await owner.one((d) => d.select().from(organizationInvites));
      expect(
        invites.map((i) => [i.email, i.role, i.sendCount, i.expiresAt > new Date()]).sort(),
      ).toEqual([
        ["goldilocks@threebears.example", "member", 1, false],
        ["mama@threepigs.example", "admin", 3, true],
      ]);
      // The owner role bypasses row-level security here, so each query names the organization.
      const pigs = DEMO[0]!.id;
      const demoAutomations = await owner.one((d) =>
        d.select().from(automations).where(eq(automations.organizationId, pigs)),
      );
      expect(demoAutomations.map((a) => a.name).sort()).toEqual([
        "Is the Straw MVP still standing?",
        "Monday stress test report",
        "Ship the Stick Upgrade",
      ]);
      const runs = await owner.one((d) =>
        d.select().from(automationRuns).where(eq(automationRuns.organizationId, pigs)),
      );
      expect(runs.map((r) => r.status).sort()).toEqual(["rejected", "succeeded", "succeeded"]);
      const zapier = await owner.one((d) =>
        d.select().from(zapierConnections).where(eq(zapierConnections.organizationId, pigs)),
      );
      expect(zapier.map((c) => c.name)).toEqual(["Huff & Puff Testing (via Zapier)"]);
    } finally {
      await test.close();
    }
  });
});
