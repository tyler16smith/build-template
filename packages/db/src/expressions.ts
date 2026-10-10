import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * Expressions for `update(...).set(...)` that the query helpers can't say with plain values,
 * so callers outside this package never write SQL themselves.
 */

/** `column + by`: counters (attempts, deliveries) without a read first. */
export function increment(column: PgColumn, by = 1): SQL {
  return sql`${column} + ${by}`;
}

/** Keeps the column's value when it has one: `coalesce(column, value)`. */
export function keepOr(column: PgColumn, value: unknown): SQL {
  return sql`coalesce(${column}, ${value})`;
}
