import pg from "pg";
import type { PgClientLike } from "./driver";

/**
 * A `pg` client for one request through Hyperdrive (or the local Docker Postgres). Hyperdrive
 * terminates TLS and pools connections itself, so the Worker opens a plain client per request
 * and closes it when the request ends.
 */
export function createPgClient(connectionString: string): PgClientLike {
  return new pg.Client({ connectionString, application_name: "build-template" }) as PgClientLike;
}
