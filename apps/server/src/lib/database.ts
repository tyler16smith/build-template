import {
  createPgClient,
  neonHttpDatabase,
  pgDatabase,
  type SqlDatabase,
  type SqlResult,
  type SqlSession,
  type SqlStatement,
  type TransactionSettings,
} from "@template/db";
import type { Env } from "../env";

/**
 * The request's connection, by environment:
 * - **deployed:** Neon's HTTP driver (`DATABASE_URL`, as `app_runtime`) for batches, one request
 *   each; Hyperdrive + `pg` for interactive transactions;
 * - **local:** `pg` straight to the Docker Postgres through Hyperdrive's `localConnectionString`;
 * - **tests:** a SQL proxy to PGlite in the test runner (`TEST_SQL`).
 */
export function sqlDatabase(env: Env): SqlDatabase {
  if (env.TEST_SQL && env.ENVIRONMENT === "test") return proxyDatabase(env.TEST_SQL);
  const hyperdrive = env.HYPERDRIVE;
  const interactive = () => {
    if (!hyperdrive) throw new Error("No HYPERDRIVE binding for interactive transactions");
    return pgDatabase(() => createPgClient(hyperdrive.connectionString));
  };
  if (env.DATABASE_URL) return neonHttpDatabase(env.DATABASE_URL, { interactive });
  return interactive();
}

type ProxyError = { message: string; code?: string; constraint?: string };

class ProxiedDatabaseError extends Error {
  code?: string;
  constraint?: string;
  constructor(error: ProxyError) {
    super(error.message);
    this.code = error.code;
    this.constraint = error.constraint;
  }
}

/**
 * The Worker side of the test SQL proxy: the same `SqlDatabase` contract over a service binding
 * to the test runner, which holds PGlite. Tests exercise the real Worker, end to end.
 */
export function proxyDatabase(binding: Fetcher): SqlDatabase {
  const call = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await binding.fetch(`http://sql${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as
      { ok: true; value: T } | { ok: false; error: ProxyError };
    if (!result.ok) throw new ProxiedDatabaseError(result.error);
    return result.value;
  };
  return {
    statements: (statements: readonly SqlStatement[], settings?: TransactionSettings) =>
      call<SqlResult[]>("/statements", { statements, settings }),
    async transaction<T>(
      work: (session: SqlSession) => Promise<T>,
      settings?: TransactionSettings,
    ): Promise<T> {
      const { tx } = await call<{ tx: string }>("/begin", { settings });
      try {
        const result = await work({
          query: (sql, params, options) =>
            call<SqlResult>("/query", { tx, sql, params, arrayMode: options?.arrayMode ?? false }),
        });
        await call("/commit", { tx });
        return result;
      } catch (error) {
        await call("/rollback", { tx }).catch(() => undefined);
        throw error;
      }
    },
  };
}
