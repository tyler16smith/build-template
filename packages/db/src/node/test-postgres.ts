import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import pg from "pg";
import { Database } from "../database";
import {
  applySettings,
  pgDatabase,
  runInTransaction,
  type SqlDatabase,
  type SqlResult,
  type SqlSession,
} from "../driver";
import {
  grantRuntime,
  migrate,
  readMigrations,
  RUNTIME_ROLE,
  type MigrationConnection,
  type MigrationFile,
} from "./migrations";

/**
 * A real Postgres with the migrations applied, for tests (ported from Custombase's
 * `test-postgres.ts`). PGlite in process by default, so `pnpm test` needs no Docker.
 *
 * - `runtime` connects the way the Worker does: as `app_runtime`, which owns nothing and is
 *   subject to row-level security.
 * - `owner` is for seeding and inspection. On PGlite it's a superuser and bypasses row-level
 *   security; on a real database it's `app_migrator`, and FORCE ROW LEVEL SECURITY applies.
 *
 * With `TEST_DATABASE_URL` (the migrator) and `TEST_RUNTIME_URL` (the runtime role, logged in as
 * itself) the same tests run against a real Postgres: CI's service container, where roles are
 * real logins and `SET ROLE` can't be undone (`pnpm test:db`).
 */
export type TestPostgres = {
  pg: PGlite | null;
  connection: MigrationConnection;
  /** As `app_runtime`, what the Worker gets. Batches run like Neon's HTTP driver (one transaction). */
  runtime: SqlDatabase;
  owner: SqlDatabase;
  /** `runtime` as the data layer. */
  db: Database;
  /** Whether `runtime` is a real login (a real Postgres), not `SET ROLE` from a superuser. */
  loggedIn: boolean;
  close(): Promise<void>;
};

export function pgliteConnection(pglite: PGlite): MigrationConnection {
  return {
    exec: async (sql) => {
      await pglite.exec(sql);
    },
    query: async (sql, params) => {
      const result = await pglite.query<Record<string, unknown>>(sql, params as unknown[]);
      return { rows: result.rows };
    },
  };
}

function session(tx: Pick<PGlite, "query">): SqlSession {
  return {
    async query(sql, params, options) {
      const result = await tx.query<Record<string, unknown>>(sql, params as unknown[], {
        rowMode: options?.arrayMode ? "array" : "object",
      });
      return {
        rows: result.rows as SqlResult["rows"],
        rowCount: result.affectedRows ?? result.rows.length,
      };
    },
  };
}

/** PGlite as a `SqlDatabase`, entering `role` with `SET LOCAL ROLE` in every transaction. */
export function pgliteDatabase(pglite: PGlite, role: string | null): SqlDatabase {
  const database: SqlDatabase = {
    transaction: (work, settings) =>
      pglite.transaction(async (tx) => {
        if (role) await tx.exec(`SET LOCAL ROLE "${role}"`);
        await applySettings(session(tx), settings);
        return work(session(tx));
      }),
    statements: (statements, settings) => runInTransaction(database, statements, settings),
  };
  return database;
}

export async function createPglite(): Promise<PGlite> {
  return PGlite.create({ extensions: { citext } });
}

export async function createTestPostgres(
  options: { files?: MigrationFile[] } = {},
): Promise<TestPostgres> {
  const files = options.files ?? readMigrations();
  const migratorUrl = process.env.TEST_DATABASE_URL;
  const runtimeUrl = process.env.TEST_RUNTIME_URL;
  if (migratorUrl && runtimeUrl) return realPostgres(files, migratorUrl, runtimeUrl);
  const pglite = await createPglite();
  const connection = pgliteConnection(pglite);
  await pglite.exec(
    `CREATE ROLE ${RUNTIME_ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  await migrate(connection, files);
  await grantRuntime(connection, RUNTIME_ROLE);
  const runtime = pgliteDatabase(pglite, RUNTIME_ROLE);
  return {
    pg: pglite,
    connection,
    runtime,
    owner: pgliteDatabase(pglite, null),
    db: new Database(runtime),
    loggedIn: false,
    close: () => pglite.close(),
  };
}

async function realPostgres(
  files: MigrationFile[],
  migratorUrl: string,
  runtimeUrl: string,
): Promise<TestPostgres> {
  const client = new pg.Client({ connectionString: migratorUrl });
  await client.connect();
  const connection: MigrationConnection = {
    exec: async (sql) => {
      await client.query(sql);
    },
    query: async (sql, params) => ({ rows: (await client.query(sql, params)).rows }),
  };
  await migrate(connection, files);
  await grantRuntime(connection, RUNTIME_ROLE);
  const runtime = pgDatabase(() => new pg.Client({ connectionString: runtimeUrl }));
  const owner = pgDatabase(() => new pg.Client({ connectionString: migratorUrl }));
  return {
    pg: null,
    connection,
    runtime,
    owner,
    db: new Database(runtime),
    loggedIn: true,
    close: async () => {
      await runtime.close?.();
      await owner.close?.();
      await client.end();
    },
  };
}

/** Deletes every row (between tests), as the owner, leaving the schema. */
export async function truncateAll(test: TestPostgres): Promise<void> {
  await test.connection.exec(
    "TRUNCATE users, organizations, sessions, email_tokens, auth_identities, memberships CASCADE",
  );
}
