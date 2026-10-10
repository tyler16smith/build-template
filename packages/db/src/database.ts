import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { drizzle, type PgRemoteDatabase } from "drizzle-orm/pg-proxy";
import {
  runInTransaction,
  type SqlDatabase,
  type SqlStatement,
  type TransactionSettings,
} from "./driver";
import { memberships, organizations, schema } from "./schema";

/** Drizzle, bound to one batch or one transaction. */
export type Drizzle = PgRemoteDatabase<typeof schema>;

/** Anything with Drizzle's `execute()`: a query builder, a relational query, or `first`'s wrapper. */
export type Executable<T> = { execute(): Promise<T> };

type Results<T extends readonly Executable<unknown>[]> = {
  -readonly [K in keyof T]: T[K] extends Executable<infer R> ? R : never;
};

/**
 * One round trip's timing, for the slow-query metric. `name` says what ran (`session.details`,
 * `profile.update`): never the SQL or its parameters, which can hold personal data.
 */
export type StatementTiming = {
  name: string;
  statements: number;
  ms: number;
  kind: "batch" | "transaction";
};

/** Names a batch or transaction in timings. Defaults to the `TenantDb`'s label, else "query". */
export type QueryName = { name?: string };

export type DatabaseOptions = {
  onTiming?: (timing: StatementTiming) => void;
};

/** Settings names: row-level security reads `app.organization_id`; `app.user_id` lets a person read their own memberships. */
export const ORGANIZATION_SETTING = "app.organization_id";
export const USER_SETTING = "app.user_id";
/** Set when a transaction must see no organization's rows (the RLS cast needs a valid uuid). */
export const NO_ORGANIZATION = "00000000-0000-0000-0000-000000000000";

type Pending = {
  statement: SqlStatement;
  resolve: (result: { rows: unknown[] }) => void;
  reject: (error: unknown) => void;
};

/**
 * The whole database, with no tenant scope. Only `packages/auth`, the cleanup job, the seed and
 * the tests get one. Request handlers get a `TenantDb` (`ctx.db`) instead.
 */
export class Database {
  constructor(
    readonly sql: SqlDatabase,
    private readonly options: DatabaseOptions = {},
  ) {}

  /**
   * Runs queries known in advance as one transaction, in **one round trip** on Neon's HTTP
   * driver: `settings` (`set_config`) and every statement travel together. `build` gets a
   * Drizzle that only records; nothing runs until every query is collected.
   */
  async batch<const T extends readonly Executable<unknown>[]>(
    build: (d: Drizzle) => T,
    settings?: TransactionSettings,
    { name = "query" }: QueryName = {},
  ): Promise<Results<T>> {
    const pending: Pending[] = [];
    let registered: (() => void) | null = null;
    const d = drizzle(
      (text, params, method) =>
        new Promise((resolve, reject) => {
          pending.push({
            statement: { sql: text, params, arrayMode: method === "all" },
            resolve,
            reject,
          });
          registered?.();
        }),
      { schema },
    );
    const items = build(d);
    // Start each query only after the previous one reached the driver, so statements run in the
    // order they were written (an insert, then the read that should see it).
    const runs: Promise<unknown>[] = [];
    for (const item of items) {
      const before = pending.length;
      const run = item.execute();
      runs.push(run);
      await new Promise<void>((resolve, reject) => {
        registered = () => pending.length > before && resolve();
        registered();
        run.catch(reject);
      });
    }
    registered = null;
    if (pending.length) {
      const started = performance.now();
      try {
        const statements = pending.map((p) => p.statement);
        const results = this.sql.statements
          ? await this.sql.statements(statements, settings)
          : await runInTransaction(this.sql, statements, settings);
        pending.forEach((p, i) => p.resolve({ rows: results[i]?.rows ?? [] }));
      } catch (error) {
        for (const p of pending) p.reject(error);
      } finally {
        this.options.onTiming?.({
          name,
          statements: pending.length,
          ms: performance.now() - started,
          kind: "batch",
        });
      }
    }
    return (await Promise.all(runs)) as Results<T>;
  }

  /** One query, as a batch of one. */
  async one<T>(
    build: (d: Drizzle) => Executable<T>,
    settings?: TransactionSettings,
    name?: QueryName,
  ): Promise<T> {
    const [result] = await this.batch((d) => [build(d)] as const, settings, name);
    return result as T;
  }

  /**
   * An interactive transaction (read, decide, then write) on Hyperdrive + `pg`: `BEGIN` and the
   * settings go in one round trip, then each query is its own. Prefer `batch` when every
   * statement is known in advance.
   */
  async transaction<T>(
    work: (d: Drizzle) => Promise<T>,
    settings?: TransactionSettings,
    { name = "query" }: QueryName = {},
  ): Promise<T> {
    const started = performance.now();
    let statements = 0;
    try {
      return await this.sql.transaction(
        (session) =>
          work(
            drizzle(
              async (text, params, method) => {
                statements++;
                const result = await session.query(text, params, { arrayMode: method === "all" });
                return { rows: result.rows };
              },
              { schema },
            ),
          ),
        settings,
      );
    } finally {
      this.options.onTiming?.({
        name,
        statements,
        ms: performance.now() - started,
        kind: "transaction",
      });
    }
  }

  /** `SELECT 1`, for the health route: proves the connection and the runtime role work. */
  async ping(): Promise<void> {
    await this.one((d) => d.execute(sql`SELECT 1`), undefined, { name: "health" });
  }

  /** The data layer for one verified organization and person. */
  tenant(context: TenantContext, options: TenantOptions = {}): TenantDb {
    return new TenantDb(this, context, options);
  }

  async close(): Promise<void> {
    await this.sql.close?.();
  }
}

export type TenantContext = { organizationId: string; userId: string };

export type TenantOptions = {
  /**
   * Tests only: leave out the organization filter the data layer adds, to prove row-level
   * security alone keeps organizations apart.
   */
  unsafeSkipTenantFilter?: boolean;
  /** The name timings use when a call doesn't give one: the route or action id. */
  label?: string;
};

/** Settings for a tenant transaction. */
export function tenantSettings(context: TenantContext): TransactionSettings {
  return { [ORGANIZATION_SETTING]: context.organizationId, [USER_SETTING]: context.userId };
}

/**
 * The column that holds a tenant table's organization. Register a module's tenant tables in
 * `TENANT_TABLES` (or give them an `organizationId` column, which is found automatically).
 */
const TENANT_TABLES = new Map<PgTable, PgColumn>([
  [organizations, organizations.id],
  [memberships, memberships.organizationId],
]);

export function tenantColumn(table: PgTable): PgColumn {
  const known = TENANT_TABLES.get(table);
  if (known) return known;
  const column = (table as unknown as { organizationId?: PgColumn }).organizationId;
  if (!column) throw new Error("This table isn't a tenant table: it has no organization_id column");
  return column;
}

type Row<T extends PgTable> = T["$inferSelect"];
type TenantInsert<T extends PgTable> = Omit<T["$inferInsert"], "organizationId"> & {
  organizationId?: string;
};
type TenantUpdate<T extends PgTable> = Partial<Omit<T["$inferInsert"], "organizationId">>;

/**
 * Queries for one organization. Every method adds `organization_id = <this organization>`
 * itself (and sets it on inserts), so a handler can't forget it, and the queries use the tenant
 * indexes. Row-level security checks the same boundary inside Postgres.
 */
export type Scoped = {
  readonly organizationId: string;
  readonly userId: string;
  /**
   * Drizzle itself, for joins and aggregates the helpers don't cover. Add `q.owned(table)` to
   * every table's condition yourself; row-level security still applies.
   */
  readonly drizzle: Drizzle;
  /** `<table>.organization_id = <this organization>`. */
  owned(table: PgTable): SQL;
  select<T extends PgTable>(
    table: T,
    options?: { where?: SQL; orderBy?: (SQL | PgColumn)[]; limit?: number },
  ): Executable<Row<T>[]>;
  first<T extends PgTable>(table: T, where?: SQL): Executable<Row<T> | null>;
  count<T extends PgTable>(table: T, where?: SQL): Executable<number>;
  insert<T extends PgTable>(
    table: T,
    values: TenantInsert<T> | TenantInsert<T>[],
  ): Executable<Row<T>[]>;
  update<T extends PgTable>(table: T, set: TenantUpdate<T>, where?: SQL): Executable<Row<T>[]>;
  delete<T extends PgTable>(table: T, where?: SQL): Executable<Row<T>[]>;
};

/** `then` too, so a query in an interactive transaction can be awaited directly. */
function executable<T>(execute: () => Promise<T>): Executable<T> & PromiseLike<T> {
  return {
    execute,
    then: (onFulfilled, onRejected) => execute().then(onFulfilled, onRejected),
  };
}

function scoped(d: Drizzle, context: TenantContext, options: TenantOptions): Scoped {
  const filter = !options.unsafeSkipTenantFilter;
  const owned = (table: PgTable) => eq(tenantColumn(table), context.organizationId);
  const where = (table: PgTable, condition?: SQL) =>
    filter ? (condition ? and(owned(table), condition)! : owned(table)) : condition;
  // Drizzle's builders don't type-check over a generic table, so the helpers are typed at the
  // boundary (`Scoped`) and loosely inside.
  const db = d as unknown as {
    select: (fields?: unknown) => { from: (t: PgTable) => any };
    insert: (t: PgTable) => any;
    update: (t: PgTable) => any;
    delete: (t: PgTable) => any;
  };
  return {
    organizationId: context.organizationId,
    userId: context.userId,
    drizzle: d,
    owned,
    select(table, opts = {}) {
      let query = db.select().from(table);
      const condition = where(table, opts.where);
      if (condition) query = query.where(condition);
      if (opts.orderBy?.length) query = query.orderBy(...opts.orderBy);
      if (opts.limit !== undefined) query = query.limit(opts.limit);
      return query;
    },
    first(table, condition) {
      let query = db.select().from(table);
      const full = where(table, condition);
      if (full) query = query.where(full);
      const limited = query.limit(1);
      return executable(async () => ((await limited.execute()) as unknown[])[0] ?? null) as never;
    },
    count(table, condition) {
      let query = db.select({ n: sql<number>`count(*)::int` }).from(table);
      const full = where(table, condition);
      if (full) query = query.where(full);
      return executable(async () => Number((await query.execute())[0]?.n ?? 0));
    },
    insert(table, values) {
      const column = tenantColumn(table);
      const key = Object.entries(table).find(([, c]) => c === column)?.[0] ?? "organizationId";
      const rows = (Array.isArray(values) ? values : [values]).map((row) =>
        filter
          ? { ...row, [key]: context.organizationId }
          : { [key]: context.organizationId, ...row },
      );
      return db.insert(table).values(rows).returning();
    },
    update(table, set, condition) {
      const column = tenantColumn(table);
      const key = Object.entries(table).find(([, c]) => c === column)?.[0];
      const changes = { ...(set as Record<string, unknown>) };
      if (key) delete changes[key];
      let query = db.update(table).set(changes);
      const full = where(table, condition);
      if (full) query = query.where(full);
      return query.returning();
    },
    delete(table, condition) {
      let query = db.delete(table);
      const full = where(table, condition);
      if (full) query = query.where(full);
      return query.returning();
    },
  };
}

/**
 * `ctx.db`: the data layer the request pipeline builds once it has verified the person and their
 * membership. The organization comes from the session or token, never from input.
 */
export class TenantDb {
  readonly organizationId: string;
  readonly userId: string;

  constructor(
    private readonly database: Database,
    private readonly context: TenantContext,
    private readonly options: TenantOptions = {},
  ) {
    this.organizationId = context.organizationId;
    this.userId = context.userId;
  }

  /** Queries known in advance, with the tenant context, in one round trip. */
  private name(name?: string): QueryName {
    return { name: name ?? this.options.label ?? "query" };
  }

  batch<const T extends readonly Executable<unknown>[]>(
    build: (q: Scoped) => T,
    name?: string,
  ): Promise<Results<T>> {
    return this.database.batch(
      (d) => build(scoped(d, this.context, this.options)),
      tenantSettings(this.context),
      this.name(name),
    );
  }

  one<T>(build: (q: Scoped) => Executable<T>, name?: string): Promise<T> {
    return this.database.one(
      (d) => build(scoped(d, this.context, this.options)),
      tenantSettings(this.context),
      this.name(name),
    );
  }

  /** Read, decide, then write, with the tenant context set in the same round trip as `BEGIN`. */
  transaction<T>(work: (q: Scoped) => Promise<T>, name?: string): Promise<T> {
    return this.database.transaction(
      (d) => work(scoped(d, this.context, this.options)),
      tenantSettings(this.context),
      this.name(name),
    );
  }
}

/**
 * Sets the tenant context from a session, inside the batch that reads it: the organization and
 * person come from the `sessions` row the token hash names, so `GET /api/session` reads user,
 * membership and organization in one round trip. An unknown token sets no organization.
 */
export function contextFromSession(d: Drizzle, tokenHash: string): Executable<unknown> {
  return d.execute(sql`SELECT
      set_config('${sql.raw(ORGANIZATION_SETTING)}', coalesce((SELECT organization_id::text FROM sessions WHERE token_hash = ${tokenHash}), ${NO_ORGANIZATION}), true),
      set_config('${sql.raw(USER_SETTING)}', coalesce((SELECT user_id::text FROM sessions WHERE token_hash = ${tokenHash}), ''), true)`);
}

/** Switches the tenant context partway through a batch (sign-up, the seed, the cleanup job). */
export function setContext(d: Drizzle, context: Partial<TenantContext>): Executable<unknown> {
  return d.execute(sql`SELECT
      set_config('${sql.raw(ORGANIZATION_SETTING)}', ${context.organizationId ?? NO_ORGANIZATION}, true),
      set_config('${sql.raw(USER_SETTING)}', ${context.userId ?? ""}, true)`);
}

/**
 * Lets the person with `email` read their own memberships in this batch (sign-in: the user and
 * the organization to open, in one statement). Sets no organization.
 */
export function contextForEmail(d: Drizzle, email: string): Executable<unknown> {
  return d.execute(sql`SELECT
      set_config('${sql.raw(ORGANIZATION_SETTING)}', ${NO_ORGANIZATION}, true),
      set_config('${sql.raw(USER_SETTING)}', coalesce((SELECT id::text FROM users WHERE email = ${email}::citext), ''), true)`);
}

// ---------------------------------------------------------------- reads across organizations
// The three SECURITY DEFINER functions (`0003_organizations.sql`). `@template/auth` is their only
// caller; each needs `app.user_id` set to the person asking, where it applies.

/** A raw result's rows, whichever shape the driver returned. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  return ((result as { rows?: unknown[] } | null)?.rows ?? []) as Record<string, unknown>[];
}

const dateOrNull = (value: unknown): Date | null =>
  value === null || value === undefined ? null : new Date(value as string | Date);

export type MemberOrganizationRow = {
  id: string;
  name: string;
  slug: string | null;
  role: "owner" | "admin" | "member";
  lastOpenedAt: Date | null;
};

/** The person's live organizations, most recently opened first. Needs `app.user_id` = `userId`. */
export function memberOrganizations(
  d: Drizzle,
  userId: string,
): Executable<MemberOrganizationRow[]> {
  return memberOrganizationsOf(d, sql`${userId}::uuid`);
}

function memberOrganizationsOf(d: Drizzle, user: SQL): Executable<MemberOrganizationRow[]> {
  const query = d.execute(sql`SELECT * FROM member_organizations(${user})`);
  return executable(async () =>
    rowsOf(await query.execute()).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      slug: row.slug === null || row.slug === undefined ? null : String(row.slug),
      role: row.role as MemberOrganizationRow["role"],
      lastOpenedAt: dateOrNull(row.last_opened_at),
    })),
  );
}

/**
 * `memberOrganizations` for whoever `app.user_id` names, inside a batch that set it from a session
 * or an email: sign-in and `GET /api/session` get the list in the same round trip.
 */
export function ownOrganizations(d: Drizzle): Executable<MemberOrganizationRow[]> {
  return memberOrganizationsOf(
    d,
    sql`nullif(current_setting('${sql.raw(USER_SETTING)}', true), '')::uuid`,
  );
}

export type InviteLookupRow = {
  organizationId: string;
  id: string;
  email: string;
  role: "admin" | "member";
  expiresAt: Date;
  organizationName: string;
  invitedByName: string | null;
};

/** A pending, unexpired invite by its token's hash, or null. */
export function inviteByToken(d: Drizzle, tokenHash: string): Executable<InviteLookupRow | null> {
  const query = d.execute(sql`SELECT * FROM invite_by_token(${tokenHash})`);
  return executable(async () => {
    const row = rowsOf(await query.execute())[0];
    if (!row) return null;
    return {
      organizationId: String(row.organization_id),
      id: String(row.id),
      email: String(row.email),
      role: row.role as InviteLookupRow["role"],
      expiresAt: new Date(row.expires_at as string | Date),
      organizationName: String(row.organization_name),
      invitedByName: row.invited_by_name === null ? null : String(row.invited_by_name),
    };
  });
}

export type PendingInviteRow = Omit<InviteLookupRow, "email">;

/** Pending invites to the signed-in person's own verified email. Needs `app.user_id`. */
export function invitesForEmail(d: Drizzle, email: string): Executable<PendingInviteRow[]> {
  const query = d.execute(sql`SELECT * FROM invites_for_email(${email}::citext)`);
  return executable(async () =>
    rowsOf(await query.execute()).map((row) => ({
      organizationId: String(row.organization_id),
      id: String(row.id),
      role: row.role as PendingInviteRow["role"],
      expiresAt: new Date(row.expires_at as string | Date),
      organizationName: String(row.organization_name),
      invitedByName: row.invited_by_name === null ? null : String(row.invited_by_name),
    })),
  );
}
