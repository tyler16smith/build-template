import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The migration runner (ported from Custombase's `platform-sdk/src/node/migrations.ts`), shared
 * by `pnpm db:migrate` (over the direct, unpooled URL as `app_migrator`) and the tests (PGlite):
 *
 * - files are `NNNN_name.sql` in `packages/db/migrations`, applied in order, append-only;
 * - an advisory lock keeps two runs from overlapping;
 * - `schema_migrations` records each file and its checksum, and a changed applied file stops
 *   the run before anything else happens;
 * - each file runs in its own transaction, except one whose first line is `-- no-transaction`
 *   (`CREATE INDEX CONCURRENTLY`), whose statements run one by one;
 * - every file runs under `lock_timeout` (5 s) and `statement_timeout` (60 s), so a migration
 *   that waits on a lock fails instead of queueing every request behind it;
 * - a no-transaction file that failed half-way can run again: its indexes are
 *   `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, and an INVALID index a failed build left behind is
 *   dropped just before its statement runs again.
 *
 * drizzle-kit writes `--> statement-breakpoint` between statements; to Postgres it's a comment.
 */

export type MigrationFile = {
  /** `0001_init`, without `.sql`. */
  name: string;
  sql: string;
  checksum: string;
  transactional: boolean;
};

/** A direct (unpooled) connection: `exec` runs a whole file; `query` binds parameters. */
export interface MigrationConnection {
  exec(sql: string): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export type AppliedMigration = { name: string; durationMs: number };

export const MIGRATION_NAME = /^(\d{4})_[a-z0-9_]+$/;
/** `pg_advisory_lock` key for migrations. */
export const MIGRATION_LOCK_KEY = "7161124058829906293";
export const MIGRATION_LOCK_TIMEOUT_MS = 5_000;
export const MIGRATION_STATEMENT_TIMEOUT_MS = 60_000;

/** `packages/db/migrations`. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

/** A file runs outside a transaction only when its first line is `-- no-transaction`. */
export function isNoTransaction(sql: string): boolean {
  const first = sql.replace(/^﻿/, "").split("\n", 1)[0] ?? "";
  return /^\s*--\s*no-transaction\b/.test(first);
}

export function checksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

export function migrationFile(name: string, sql: string): MigrationFile {
  if (!MIGRATION_NAME.test(name))
    throw new Error(`Migration ${name}.sql must be named NNNN_name.sql (lowercase, digits, _)`);
  return { name, sql, checksum: checksum(sql), transactional: !isNoTransaction(sql) };
}

export function readMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const seen = new Set<string>();
  return files.map((file) => {
    const name = file.slice(0, -4);
    const number = name.slice(0, 4);
    if (seen.has(number)) throw new Error(`Two migrations are numbered ${number}`);
    seen.add(number);
    return migrationFile(name, readFileSync(join(dir, file), "utf8"));
  });
}

/**
 * A file's statements, split at semicolons outside string literals, quoted identifiers,
 * dollar-quoted bodies and comments. Comments are removed; empty statements are dropped.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      current += " ";
      continue;
    }
    if (ch === "'" || ch === '"') {
      const escapes = ch === "'" && /[eE]/.test(sql[i - 1] ?? "") && !/\w/.test(sql[i - 2] ?? "");
      let j = i + 1;
      while (j < n) {
        if (escapes && sql[j] === "\\") j += 2;
        else if (sql[j] === ch && sql[j + 1] === ch) j += 2;
        else if (sql[j] === ch) break;
        else j++;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? "")) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        const stop = end === -1 ? n : end + tag[0].length;
        current += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/** The index a `CREATE [UNIQUE] INDEX CONCURRENTLY [IF NOT EXISTS] <name>` statement builds. */
export function concurrentIndexName(statement: string): string | null {
  const match =
    /^\s*create\s+(?:unique\s+)?index\s+concurrently\s+(?:if\s+not\s+exists\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(
      statement,
    );
  return match?.[1] ?? null;
}

export class MigrationRefused extends Error {
  override name = "MigrationRefused";
}

/** Checks what has run against what's on disk, and returns what still has to run. */
export function pendingMigrations(
  files: MigrationFile[],
  applied: { name: string; checksum: string }[],
): MigrationFile[] {
  const onDisk = new Map(files.map((f) => [f.name, f]));
  for (const row of applied) {
    const file = onDisk.get(row.name);
    if (!file)
      throw new MigrationRefused(
        `Migration ${row.name} has run but its file is gone. Migrations are append-only: restore the file.`,
      );
    if (file.checksum !== row.checksum)
      throw new MigrationRefused(
        `Migration ${row.name} changed after it ran. Never edit a migration that has run: put the change in a new numbered file.`,
      );
  }
  const done = new Set(applied.map((a) => a.name));
  const pending = files.filter((f) => !done.has(f.name));
  for (const file of pending) {
    const later = applied.find((a) => a.name > file.name);
    if (later)
      throw new MigrationRefused(
        `Migration ${file.name} sorts before ${later.name}, which has already run. Number new migrations after the last one.`,
      );
  }
  return pending;
}

export async function migrate(
  connection: MigrationConnection,
  files: MigrationFile[] = readMigrations(),
  options: {
    log?: (line: string) => void;
    lockTimeoutMs?: number;
    statementTimeoutMs?: number;
  } = {},
): Promise<AppliedMigration[]> {
  const log = options.log ?? (() => undefined);
  const locked = await connection.query("SELECT pg_try_advisory_lock($1::bigint) AS locked", [
    MIGRATION_LOCK_KEY,
  ]);
  if (!locked.rows[0]?.locked)
    throw new MigrationRefused("Another migration run holds the lock on this database.");
  try {
    await connection.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL
    )`);
    const { rows } = await connection.query(
      "SELECT name, checksum FROM schema_migrations ORDER BY name",
    );
    const pending = pendingMigrations(files, rows as { name: string; checksum: string }[]);
    const applied: AppliedMigration[] = [];
    const lockTimeout = `${Math.round(options.lockTimeoutMs ?? MIGRATION_LOCK_TIMEOUT_MS)}ms`;
    const statementTimeout = `${Math.round(options.statementTimeoutMs ?? MIGRATION_STATEMENT_TIMEOUT_MS)}ms`;
    for (const file of pending) {
      const started = performance.now();
      const record = () =>
        connection.query(
          "INSERT INTO schema_migrations (name, checksum, duration_ms) VALUES ($1, $2, $3)",
          [file.name, file.checksum, Math.round(performance.now() - started)],
        );
      if (file.transactional) {
        await connection.exec("BEGIN");
        try {
          await connection.exec(
            `SET LOCAL lock_timeout = '${lockTimeout}'; SET LOCAL statement_timeout = '${statementTimeout}'`,
          );
          await connection.exec(file.sql);
          await record();
          await connection.exec("COMMIT");
        } catch (error) {
          await connection.exec("ROLLBACK").catch(() => undefined);
          throw new MigrationRefused(
            `Migration ${file.name} failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else {
        await connection.exec(
          `SET lock_timeout = '${lockTimeout}'; SET statement_timeout = '${statementTimeout}'`,
        );
        try {
          for (const statement of splitStatements(file.sql)) {
            await dropInvalidIndex(connection, concurrentIndexName(statement));
            await connection.exec(statement);
          }
          await record();
        } catch (error) {
          throw new MigrationRefused(
            `Migration ${file.name} (no-transaction) failed part-way; fix the cause and run again: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          await connection
            .exec("RESET lock_timeout; RESET statement_timeout")
            .catch(() => undefined);
        }
      }
      const durationMs = Math.round(performance.now() - started);
      applied.push({ name: file.name, durationMs });
      log(`applied ${file.name} in ${durationMs} ms`);
    }
    return applied;
  } finally {
    await connection.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]);
  }
}

async function dropInvalidIndex(connection: MigrationConnection, name: string | null) {
  if (!name) return;
  const { rows } = await connection.query(
    `SELECT 1 FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = $1 AND n.nspname = current_schema() AND NOT i.indisvalid`,
    [name],
  );
  if (rows.length) await connection.exec(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
}

/** The role the Worker connects as: DML only, owns nothing, no `BYPASSRLS`. */
export const RUNTIME_ROLE = "app_runtime";
/** The role migrations run as (CI only): owns every table. */
export const MIGRATOR_ROLE = "app_migrator";

/** Tables the runtime role may only read. */
const READ_ONLY_FOR_RUNTIME = ["environment_markers"];

/**
 * What `app_runtime` may do after a migration run: read and write rows of every table except
 * `schema_migrations` (nothing) and `environment_markers` (read only), and call the
 * `SECURITY DEFINER` reads (`DEFINER_FUNCTIONS`: the migration rule allows no others). It owns
 * nothing, so it can't ALTER, DROP or TRUNCATE.
 */
export async function grantRuntime(connection: MigrationConnection, runtimeRole = RUNTIME_ROLE) {
  if (!/^[a-z_][a-z0-9_]*$/.test(runtimeRole)) throw new Error(`Invalid role ${runtimeRole}`);
  const exists = await connection.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [runtimeRole]);
  if (!exists.rows.length) return false;
  await connection.exec(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await connection.exec(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${runtimeRole}"`,
  );
  await connection.exec(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO "${runtimeRole}"`);
  await connection.exec(`REVOKE ALL ON schema_migrations FROM "${runtimeRole}"`);
  for (const table of READ_ONLY_FOR_RUNTIME)
    await connection.exec(`REVOKE INSERT, UPDATE, DELETE ON "${table}" FROM "${runtimeRole}"`);
  await connection.exec(`REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM "${runtimeRole}"`);
  const definers = await connection.query(
    `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef`,
  );
  for (const row of definers.rows)
    await connection.exec(`GRANT EXECUTE ON FUNCTION ${String(row.signature)} TO "${runtimeRole}"`);
  return true;
}
