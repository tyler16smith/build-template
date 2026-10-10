import { neon } from "@neondatabase/serverless";
import { settingsStatement, type SqlDatabase, type SqlResult } from "./driver";

/**
 * The data layer over Neon's HTTP driver. Each `statements` call is one HTTPS request that
 * carries the transaction settings (`app.organization_id` for row-level security) and every
 * statement together, so a page's reads cost one round trip, and calls made together with
 * `Promise.all` run in parallel instead of queueing on one connection.
 *
 * The HTTP API only runs statements known in advance. Work that reads and then decides what to
 * write needs `interactive` (Hyperdrive + `pg`), a connection that holds a transaction open.
 */
export function neonHttpDatabase(
  connectionString: string,
  options: { interactive?: () => SqlDatabase } = {},
): SqlDatabase {
  const sql = neon(connectionString, { fullResults: true });
  let interactive: SqlDatabase | null = null;
  return {
    async statements(statements, settings) {
      const setup = settingsStatement(settings);
      const queries = [...(setup ? [setup] : []), ...statements].map((s) =>
        sql.query(s.sql, [...s.params], { arrayMode: s.arrayMode ?? false, fullResults: true }),
      );
      // Each query keeps its own `arrayMode`; the transaction's default doesn't override it.
      const results = await sql.transaction(
        queries as unknown as Parameters<typeof sql.transaction>[0],
      );
      return results.slice(setup ? 1 : 0).map((result): SqlResult => {
        const full = result as unknown as { rows: unknown[]; rowCount: number | null };
        return {
          rows: full.rows as Record<string, unknown>[] | unknown[][],
          rowCount: full.rowCount ?? full.rows.length,
        };
      });
    },
    transaction(work, settings) {
      if (!options.interactive)
        return Promise.reject(new Error("This work needs an interactive Postgres connection."));
      interactive ??= options.interactive();
      return interactive.transaction(work, settings);
    },
    async close() {
      await interactive?.close?.();
      interactive = null;
    },
  };
}
