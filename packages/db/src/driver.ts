/**
 * The smallest surface the data layer needs from a Postgres driver, so the same code runs on
 * Neon's HTTP driver and `pg` over Hyperdrive in production, `pg` against Docker in development
 * and PGlite in tests. Ported from Custombase (`platform-sdk/src/worker/postgres/driver.ts`),
 * with array-mode rows added because Drizzle maps result rows by position.
 */
export type SqlResult = { rows: Record<string, unknown>[] | unknown[][]; rowCount: number };

export type QueryOptions = {
  /** Rows as arrays of values in column order (what Drizzle maps), not objects. */
  arrayMode?: boolean;
};

export interface SqlSession {
  query(sql: string, params?: readonly unknown[], options?: QueryOptions): Promise<SqlResult>;
}

/**
 * Transaction-local settings, applied with `set_config(name, value, true)` before any statement
 * runs, so they last only for that transaction (`app.organization_id` for row-level security).
 */
export type TransactionSettings = Readonly<Record<string, string>>;

export type SqlStatement = { sql: string; params: readonly unknown[]; arrayMode?: boolean };

export interface SqlDatabase {
  /** Runs `work` inside `BEGIN … COMMIT` on one connection, rolling back if it throws. */
  transaction<T>(
    work: (session: SqlSession) => Promise<T>,
    settings?: TransactionSettings,
  ): Promise<T>;
  /**
   * Runs statements known in advance in one transaction, in one round trip (Neon's HTTP driver),
   * rolling back if any fails. Optional: without it the data layer uses `transaction`.
   */
  statements?(
    statements: readonly SqlStatement[],
    settings?: TransactionSettings,
  ): Promise<SqlResult[]>;
  /** Releases the connection; called once the request is done. */
  close?(): Promise<void>;
}

/** `settings` as one parameterized statement, or null when there are none. */
export function settingsStatement(settings: TransactionSettings | undefined): SqlStatement | null {
  const entries = Object.entries(settings ?? {});
  if (!entries.length) return null;
  return {
    sql: `SELECT ${entries.map((_, i) => `set_config($${2 * i + 1}, $${2 * i + 2}, true)`).join(", ")}`,
    params: entries.flat(),
  };
}

/** Applies `settings` with one parameterized statement, for drivers that can't send them with `BEGIN`. */
export async function applySettings(
  session: SqlSession,
  settings: TransactionSettings | undefined,
): Promise<void> {
  const statement = settingsStatement(settings);
  if (statement) await session.query(statement.sql, statement.params);
}

const SETTING_NAME = /^[a-z_]+(\.[a-z_]+)?$/;
const SETTING_VALUE = /^[A-Za-z0-9_.:+-]{0,128}$/;

/**
 * `BEGIN` and the settings in one round trip. The simple protocol that allows two statements
 * can't bind parameters, so names and values are limited to characters that can't end a literal.
 * They come from the verified request context (an organization id), never from input.
 */
export function beginSql(settings: TransactionSettings | undefined): string {
  const entries = Object.entries(settings ?? {});
  if (!entries.length) return "BEGIN";
  for (const [name, value] of entries)
    if (!SETTING_NAME.test(name) || !SETTING_VALUE.test(value))
      throw new Error(`Refusing transaction setting ${JSON.stringify(name)}`);
  return `BEGIN; SELECT ${entries.map(([name, value]) => `set_config('${name}', '${value}', true)`).join(", ")}`;
}

/** The parts of a `pg.Client` this file uses, so `pg` stays out of this file's imports. */
export type PgClientLike = {
  connect(): Promise<unknown>;
  query(
    config: string | { text: string; values?: unknown[]; rowMode?: "array" },
    params?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
  end(): Promise<void>;
};

/**
 * One connection per request, opened on first use. Hyperdrive pools the real connections, so a
 * Worker never keeps a client between requests, and nothing may rely on session state.
 *
 * Without a native one-request path, `statements` runs in one transaction on this connection:
 * locally that costs nothing, and in production batches go to Neon's HTTP driver instead.
 */
export function pgDatabase(createClient: () => PgClientLike): SqlDatabase {
  let client: PgClientLike | null = null;
  let connecting: Promise<PgClientLike> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const connection = () =>
    (connecting ??= (async () => {
      const created = createClient();
      await created.connect();
      client = created;
      return created;
    })());
  const run = async (
    sql: string,
    params?: readonly unknown[],
    options?: QueryOptions,
  ): Promise<SqlResult> => {
    const result = await (
      await connection()
    ).query({
      text: sql,
      values: params as unknown[] | undefined,
      ...(options?.arrayMode ? { rowMode: "array" as const } : {}),
    });
    return {
      rows: result.rows as Record<string, unknown>[] | unknown[][],
      rowCount: result.rowCount ?? 0,
    };
  };
  const database: SqlDatabase = {
    transaction<T>(
      work: (session: SqlSession) => Promise<T>,
      settings?: TransactionSettings,
    ): Promise<T> {
      let begin: string;
      try {
        begin = beginSql(settings);
      } catch (error) {
        return Promise.reject(error);
      }
      // One client runs one transaction at a time; concurrent calls wait their turn.
      const next = queue.then(async () => {
        await (await connection()).query(begin);
        try {
          const result = await work({ query: run });
          await run("COMMIT");
          return result;
        } catch (error) {
          await run("ROLLBACK").catch(() => undefined);
          throw error;
        }
      });
      queue = next.catch(() => undefined);
      return next;
    },
    statements: (statements, settings) => runInTransaction(database, statements, settings),
    async close() {
      const open = client;
      client = null;
      connecting = null;
      await open?.end().catch(() => undefined);
    },
  };
  return database;
}

/** `statements` on a driver without a one-request path: one transaction, one by one. */
export function runInTransaction(
  database: Pick<SqlDatabase, "transaction">,
  statements: readonly SqlStatement[],
  settings?: TransactionSettings,
): Promise<SqlResult[]> {
  return database.transaction(async (session) => {
    const results: SqlResult[] = [];
    for (const s of statements)
      results.push(await session.query(s.sql, s.params, { arrayMode: s.arrayMode }));
    return results;
  }, settings);
}
