import type { PGlite, Transaction } from "@electric-sql/pglite";
import {
  createPglite,
  grantRuntime,
  migrate,
  pgliteConnection,
  RUNTIME_ROLE,
} from "@template/db/node";

/**
 * The test runner's side of the SQL proxy (`src/lib/database.ts`, `proxyDatabase`). PGlite runs
 * here, in Node, with the migrations applied; the Worker under test reaches it through the
 * `TEST_SQL` service binding. Every transaction enters `app_runtime` with `SET LOCAL ROLE`, so
 * row-level security applies exactly as it does to the deployed Worker.
 *
 * PGlite is one connection, so transactions run one at a time: an interactive transaction holds
 * the connection from `/begin` until `/commit` or `/rollback`.
 */
type Settings = Record<string, string> | undefined;
type Statement = { sql: string; params: unknown[]; arrayMode?: boolean };

export async function createSqlProxy() {
  const pglite: PGlite = await createPglite();
  await pglite.exec(
    `CREATE ROLE ${RUNTIME_ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  const connection = pgliteConnection(pglite);
  await migrate(connection);
  await grantRuntime(connection);

  let queue: Promise<unknown> = Promise.resolve();
  const open = new Map<
    string,
    { tx: Transaction; finish: (commit: boolean) => void; run: Promise<unknown> }
  >();
  let next = 0;

  /** Runs `work` in a transaction once every earlier one finished. */
  function exclusive<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const run = queue.then(() => pglite.transaction(work));
    queue = run.catch(() => undefined);
    return run;
  }

  async function enter(tx: Transaction, settings: Settings) {
    await tx.exec(`SET LOCAL ROLE "${RUNTIME_ROLE}"`);
    const entries = Object.entries(settings ?? {});
    if (entries.length)
      await tx.query(
        `SELECT ${entries.map((_, i) => `set_config($${2 * i + 1}, $${2 * i + 2}, true)`).join(", ")}`,
        entries.flat(),
      );
  }

  async function query(tx: Transaction, s: Statement) {
    const result = await tx.query<Record<string, unknown>>(s.sql, s.params, {
      rowMode: s.arrayMode ? "array" : "object",
    });
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }

  async function handle(path: string, body: Record<string, unknown>): Promise<unknown> {
    switch (path) {
      case "/statements":
        return exclusive(async (tx) => {
          await enter(tx, body.settings as Settings);
          const results = [];
          for (const s of body.statements as Statement[]) results.push(await query(tx, s));
          return results;
        });
      case "/begin": {
        const id = `tx${++next}`;
        await new Promise<void>((started, failed) => {
          const run = exclusive(async (tx) => {
            await enter(tx, body.settings as Settings);
            // Held open until /commit or /rollback settles it.
            const commit = await new Promise<boolean>((finish) => {
              open.set(id, { tx, finish, run });
              started();
            });
            if (!commit) await tx.rollback();
          });
          run.catch(failed);
        });
        return { tx: id };
      }
      case "/query": {
        const entry = open.get(String(body.tx));
        if (!entry) throw new Error("No such transaction");
        return query(entry.tx, body as unknown as Statement);
      }
      case "/commit":
      case "/rollback": {
        const entry = open.get(String(body.tx));
        if (!entry) throw new Error("No such transaction");
        open.delete(String(body.tx));
        entry.finish(path === "/commit");
        // Answer once this transaction settled, so the next request sees its writes.
        await entry.run.catch(() => undefined);
        return { ok: true };
      }
      case "/reset":
        await exclusive((tx) =>
          tx.exec(
            "TRUNCATE users, organizations, sessions, email_tokens, auth_identities, memberships CASCADE",
          ),
        );
        return { ok: true };
      default:
        throw new Error(`Unknown SQL proxy path ${path}`);
    }
  }

  /** A miniflare service binding: the Worker's `env.TEST_SQL.fetch(...)` lands here. */
  async function fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      const body = (await request.json()) as Record<string, unknown>;
      return Response.json({ ok: true, value: await handle(path, body) });
    } catch (error) {
      const e = error as { message?: string; code?: string; constraint?: string };
      return Response.json({
        ok: false,
        error: { message: e.message ?? String(error), code: e.code, constraint: e.constraint },
      });
    }
  }

  return { fetch, pglite };
}
