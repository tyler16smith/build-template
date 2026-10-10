import { uuidv7 } from "@template/contracts";
import type { SqlDatabase, SqlSession } from "../driver";
import { MIGRATOR_ROLE } from "./migrations";
import { IDENTITY_TABLES, TENANT_ROOT } from "./rules";

/**
 * Checks of a database that hold on PGlite in the unit tests and on a real Postgres in CI
 * (ported from Custombase's `database-checks.ts`): what `app_runtime` may do, and that row-level
 * security alone keeps organizations apart. Each returns failures as sentences; empty means it
 * passed. Output never includes row data.
 */

/** Statements `app_runtime` must never be able to run. */
export const FORBIDDEN_FOR_RUNTIME: { label: string; sql: (table: string) => string }[] = [
  { label: "CREATE TABLE", sql: () => `CREATE TABLE runtime_probe (id text)` },
  { label: "CREATE SCHEMA", sql: () => `CREATE SCHEMA runtime_probe` },
  {
    label: "CREATE FUNCTION",
    sql: () => `CREATE FUNCTION runtime_probe() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
  },
  { label: "ALTER TABLE", sql: (t) => `ALTER TABLE "${t}" ADD COLUMN probe text` },
  {
    label: "DISABLE ROW LEVEL SECURITY",
    sql: (t) => `ALTER TABLE "${t}" DISABLE ROW LEVEL SECURITY`,
  },
  {
    label: "NO FORCE ROW LEVEL SECURITY",
    sql: (t) => `ALTER TABLE "${t}" NO FORCE ROW LEVEL SECURITY`,
  },
  { label: "DROP POLICY", sql: (t) => `DROP POLICY tenant_isolation ON "${t}"` },
  { label: "DROP TABLE", sql: (t) => `DROP TABLE "${t}"` },
  { label: "TRUNCATE", sql: (t) => `TRUNCATE "${t}"` },
  { label: "read schema_migrations", sql: () => `SELECT 1 FROM schema_migrations LIMIT 1` },
  { label: "write schema_migrations", sql: () => `DELETE FROM schema_migrations` },
  {
    label: "write environment_markers",
    sql: () => `INSERT INTO environment_markers (name) VALUES ('runtime_probe')`,
  },
];

class AllowedProbe extends Error {}
class Rollback extends Error {
  constructor(readonly problems: string[]) {
    super("rollback");
  }
}

/** Tenant tables: every table in `public` except the identity tables and `schema_migrations`. */
export async function tenantTables(database: SqlDatabase): Promise<string[]> {
  const { rows } = await database.transaction((s) =>
    s.query(
      `SELECT c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
       ORDER BY c.relname`,
    ),
  );
  return (rows as Record<string, unknown>[])
    .map((r) => String(r.table))
    .filter((t) => !(IDENTITY_TABLES as readonly string[]).includes(t));
}

/**
 * Every tenant table has `organization_id` (the root: `id`), forced row-level security and the
 * `tenant_isolation` policy. Run as the owner.
 */
export async function tenantPolicyProblems(owner: SqlDatabase): Promise<string[]> {
  const tables = await tenantTables(owner);
  const { rows } = await owner.transaction((s) =>
    s.query(
      `SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped) AS has_tenant,
              EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS has_policy
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
      [tables],
    ),
  );
  const problems: string[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const missing = [
      !row.has_tenant && row.table !== TENANT_ROOT && "organization_id",
      !row.enabled && "ROW LEVEL SECURITY",
      !row.forced && "FORCE ROW LEVEL SECURITY",
      !row.has_policy && "the tenant_isolation policy",
    ].filter(Boolean);
    if (missing.length) problems.push(`${String(row.table)} is missing ${missing.join(", ")}`);
  }
  return problems;
}

/**
 * What `app_runtime` must not be able to do. `loggedIn: false` when it was entered with
 * `SET ROLE` from a superuser (PGlite): Postgres then allows switching back, so the role-switch
 * checks only mean something on a real login.
 */
export async function runtimeRoleProblems(
  runtime: SqlDatabase,
  tables: string[],
  options: { loggedIn: boolean; switchTo?: string[] },
): Promise<string[]> {
  const problems: string[] = [];
  const table = tables[0];
  if (!table) return ["No tenant tables to check"];
  const attempt = (sql: string) =>
    runtime
      .transaction(async (session) => {
        await session.query(sql);
        throw new AllowedProbe();
      })
      .then(
        () => ({ allowed: false }),
        (error) => ({ allowed: error instanceof AllowedProbe }),
      );
  for (const check of FORBIDDEN_FOR_RUNTIME)
    if ((await attempt(check.sql(table))).allowed)
      problems.push(`The runtime role can ${check.label}`);
  if (options.loggedIn)
    for (const role of options.switchTo ?? [MIGRATOR_ROLE]) {
      if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`Invalid role ${role}`);
      const exists = await runtime.transaction((s) =>
        s.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role]),
      );
      if (!exists.rows.length) {
        problems.push(`Couldn't check SET ROLE ${role}: the role doesn't exist here`);
        continue;
      }
      for (const [label, sql] of [
        ["SET ROLE", `SET ROLE "${role}"`],
        ["SET SESSION AUTHORIZATION", `SET SESSION AUTHORIZATION "${role}"`],
      ] as const)
        if ((await attempt(sql)).allowed) problems.push(`The runtime role can ${label} ${role}`);
    }
  const role = await runtime.transaction((s) =>
    s.query(
      `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user`,
    ),
  );
  const flags = (role.rows[0] ?? {}) as Record<string, unknown>;
  for (const flag of ["rolsuper", "rolbypassrls", "rolcreaterole", "rolcreatedb"])
    if (flags[flag]) problems.push(`The runtime role has ${flag}`);
  const owned = await runtime.transaction((s) =>
    s.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = current_user`,
    ),
  );
  for (const row of owned.rows as Record<string, unknown>[])
    problems.push(`The runtime role owns ${String(row.relname)}`);
  const memberships = await runtime.transaction((s) =>
    s.query(
      `SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = current_user`,
    ),
  );
  for (const row of memberships.rows as Record<string, unknown>[])
    problems.push(`The runtime role is a member of ${String(row.rolname)}`);
  return problems;
}

/** The SQLSTATE of a row the policy's WITH CHECK refused. */
const RLS_VIOLATION = "42501";

type ProbeResult =
  { ok: true; rows: Record<string, unknown>[]; count: number } | { ok: false; code: string | null };

/** Runs `sql` in a savepoint and always rolls it back: a probe never changes anything. */
async function probe(session: SqlSession, sql: string, params?: unknown[]): Promise<ProbeResult> {
  await session.query("SAVEPOINT probe");
  try {
    const result = await session.query(sql, params);
    return { ok: true, rows: result.rows as Record<string, unknown>[], count: result.rowCount };
  } catch (error) {
    return { ok: false, code: (error as { code?: string }).code ?? null };
  } finally {
    await session.query("ROLLBACK TO SAVEPOINT probe");
    await session.query("RELEASE SAVEPOINT probe");
  }
}

const actAs = (session: SqlSession, organizationId: string) =>
  session.query(
    `SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', '', true)`,
    [organizationId],
  );

const tenantColumn = (table: string) => (table === TENANT_ROOT ? "id" : "organization_id");

/**
 * Seeds one row per organization in every tenant table, as the runtime role with the tenant
 * context set, so the probes have rows to aim at. Run inside a transaction that's rolled back.
 * Every uuid column of an organization's rows holds that organization's probe id (so child rows
 * point at their own parent), columns that reference `users` hold a probe person, and text
 * columns limited by `IN (…)` take the first choice. Returns the tables it couldn't seed.
 */
export async function seedProbeRows(
  session: SqlSession,
  tables: string[],
  organizations: readonly string[],
): Promise<string[]> {
  const columns = (
    await session.query(
      `SELECT c.relname AS table, a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull AS not_null, a.atthasdef AS has_default,
              (a.attidentity <> '' OR a.attgenerated <> '') AS generated
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY c.relname, a.attnum`,
      [tables],
    )
  ).rows as Record<string, unknown>[];
  const constraints = (
    await session.query(
      `SELECT c.relname AS table, k.contype AS type, p.relname AS parent, pg_get_constraintdef(k.oid) AS definition
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       LEFT JOIN pg_class p ON p.oid = k.confrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1) AND k.contype IN ('c', 'f')`,
      [tables],
    )
  ).rows as Record<string, unknown>[];
  const ordered: string[] = [];
  const visit = (table: string, path: Set<string>) => {
    if (ordered.includes(table) || path.has(table)) return;
    path.add(table);
    for (const k of constraints)
      if (k.table === table && k.type === "f" && tables.includes(String(k.parent)))
        visit(String(k.parent), path);
    ordered.push(table);
  };
  for (const table of tables) visit(table, new Set());
  const userColumns = new Set(
    constraints
      .filter((k) => k.type === "f" && k.parent === "users")
      .flatMap((k) => {
        const local = /FOREIGN KEY \(([^)]*)\)/.exec(String(k.definition))?.[1] ?? "";
        return local.split(",").map((c) => `${String(k.table)}.${c.trim().replace(/"/g, "")}`);
      }),
  );

  const failed: string[] = [];
  const probeUser = uuidv7();
  await session.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, 'RLS probe')`, [
    probeUser,
    `rls-probe-${probeUser}@probe.example`,
  ]);
  for (const table of ordered) {
    const fill = columns.filter(
      (c) =>
        c.table === table &&
        !c.generated &&
        (c.column === tenantColumn(table) || (c.not_null && !c.has_default)),
    );
    const checks = constraints
      .filter((k) => k.table === table && k.type === "c")
      .map((k) => String(k.definition));
    for (const organization of organizations) {
      const values = fill.map((c) => {
        const column = String(c.column);
        if (column === tenantColumn(table)) return organization;
        if (userColumns.has(`${table}.${column}`)) return probeUser;
        return probeValue(column, String(c.type), checks, organization);
      });
      await actAs(session, organization);
      const insert = `INSERT INTO "${table}" (${fill.map((c) => `"${String(c.column)}"`).join(", ")}) VALUES (${fill.map((c, i) => `$${i + 1}::${String(c.type)}`).join(", ")})`;
      await session.query("SAVEPOINT seed");
      try {
        await session.query(insert, values);
        await session.query("RELEASE SAVEPOINT seed");
      } catch (error) {
        await session.query("ROLLBACK TO SAVEPOINT seed");
        await session.query("RELEASE SAVEPOINT seed");
        failed.push(
          `Couldn't seed a probe row in ${table} (${(error as { code?: string }).code ?? "error"})`,
        );
        break;
      }
    }
  }
  return failed;
}

function probeValue(column: string, type: string, checks: string[], organization: string): unknown {
  if (/^(text|character|varchar|citext)/.test(type)) {
    const check = checks.find((c) => new RegExp(`\\b${column}\\b`).test(c));
    return check?.match(/'((?:[^']|'')*)'/)?.[1]?.replace(/''/g, "'") ?? `probe-${organization}`;
  }
  if (type === "uuid") return organization;
  if (/^(integer|bigint|smallint|numeric|double|real)/.test(type)) return 0;
  if (type === "boolean") return false;
  if (/^timestamp/.test(type)) return new Date().toISOString();
  if (type === "date") return "2000-01-01";
  if (/^jsonb?$/.test(type)) return "{}";
  return null;
}

/**
 * The row-security probes for one table, in an open transaction: as organization A, reading,
 * updating and deleting never reach B's rows; moving A's rows to B and inserting a row for B are
 * refused by WITH CHECK (SQLSTATE 42501); and with no organization set, nothing is readable.
 */
export async function rowSecurityProblemsIn(
  session: SqlSession,
  table: string,
  organizations: readonly [string, string],
): Promise<string[]> {
  const [a, b] = organizations;
  const column = tenantColumn(table);
  const problems: string[] = [];
  await actAs(session, a);
  const visible = await probe(
    session,
    `SELECT ${column}::text AS org, count(*)::int AS n FROM "${table}" GROUP BY ${column}`,
  );
  if (!visible.ok) return [`A can't read ${table} (${visible.code})`];
  if (!visible.rows.some((r) => r.org === a)) problems.push(`A can't see its own ${table}`);
  if (visible.rows.some((r) => r.org !== a))
    problems.push(`A can see another organization's ${table}`);

  const updated = await probe(
    session,
    `UPDATE "${table}" SET ${column} = ${column} WHERE ${column} = $1`,
    [b],
  );
  if (updated.ok && updated.count) problems.push(`A updated B's ${table}`);

  const deleted = await probe(session, `DELETE FROM "${table}" WHERE ${column} = $1`, [b]);
  if (deleted.ok && deleted.count) problems.push(`A deleted B's ${table}`);

  if (table !== TENANT_ROOT) {
    const moved = await probe(
      session,
      `UPDATE "${table}" SET ${column} = $1 WHERE ${column} = $2`,
      [b, a],
    );
    if (moved.ok && moved.count) problems.push(`A moved its ${table} rows to B`);
    else if (!moved.ok && moved.code !== RLS_VIOLATION)
      problems.push(
        `Moving A's ${table} rows to B failed for another reason than RLS (${moved.code})`,
      );
  }

  const inserted = await probe(
    session,
    table === TENANT_ROOT
      ? `INSERT INTO organizations (id, name) VALUES ($1, 'probe')`
      : `INSERT INTO "${table}" SELECT (jsonb_populate_record(NULL::"${table}", to_jsonb(t) || jsonb_build_object('${column}', $1::text))).* FROM "${table}" t WHERE ${column} = $2 LIMIT 1`,
    table === TENANT_ROOT ? [uuidv7()] : [b, a],
  );
  if (inserted.ok && inserted.count)
    problems.push(`A inserted a ${table} row for another organization`);
  else if (!inserted.ok && inserted.code !== RLS_VIOLATION)
    problems.push(
      `Inserting a ${table} row for B failed for another reason than RLS (${inserted.code})`,
    );

  // A transaction that never set an organization (or a pooled connection after one that did).
  await session.query(
    `SELECT set_config('app.organization_id', '00000000-0000-0000-0000-000000000000', true)`,
  );
  const unscoped = await probe(session, `SELECT 1 FROM "${table}" LIMIT 1`);
  if (unscoped.ok && unscoped.rows.length)
    problems.push(`A transaction without an organization can read ${table}`);
  return problems;
}

/** Every tenant table's probes against throwaway rows, in one transaction that's rolled back. */
export async function seededRowSecurityProblems(
  runtime: SqlDatabase,
  tables: string[],
  organizations: readonly [string, string] = [uuidv7(), uuidv7()],
): Promise<string[]> {
  return runtime
    .transaction(async (session) => {
      const problems = await seedProbeRows(session, tables, organizations);
      for (const table of tables)
        problems.push(...(await rowSecurityProblemsIn(session, table, organizations)));
      throw new Rollback(problems);
    })
    .catch((error) => {
      if (error instanceof Rollback) return error.problems;
      throw error;
    });
}
