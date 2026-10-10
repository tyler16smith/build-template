# Data layer

The schema, the migrations and `TenantDb`. It's the only package that imports Drizzle, `pg` or the
Neon driver. The root `AGENTS.md` rules for data and tenancy apply. The reasons are in `SPEC.md`,
"Data model", "Tenant isolation" and "Request path and speed budget".

## Queries

Handlers get `ctx.db`, a `TenantDb` for the caller's organization. Every helper adds
`organization_id`. Row-level security checks it again inside Postgres, in the same round trip.

| Need                                 | Use                                                                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| One statement                        | `ctx.db.one((q) => q.first(table, where))`                                                                                  |
| Several reads, or several writes     | `ctx.db.batch((q) => [q.select(a), q.count(b, where), q.update(c, set, where)])`: one request to Neon                       |
| Read, decide, then write, atomically | `ctx.db.transaction(async (q) => { … })`: only when a concurrent write could change the decision. It costs more round trips |
| Joins and aggregates                 | `q.drizzle.select(…).from(…).where(and(q.owned(table), …))`, with `q.owned(table)` for **every** tenant table in the query  |

- **Round trips are the budget.** A Neon round trip is about 40 ms. A read endpoint makes one
  round trip, and a write makes one more. A query inside a loop is a bug: batch it, or use one
  `inArray` query.
- **This package holds no business rules.** It stores and fetches. Decisions belong in the
  module's core (`apps/server/AGENTS.md`). A query helper whose `where` encodes a rule ("jobs
  that are overdue") takes its inputs (`now`) as arguments.
- Identity tables (`users`, `auth_identities`, `sessions`, `email_tokens`) are reached only
  through `@template/auth`. Reads across organizations go only through the `SECURITY DEFINER`
  functions in `0003`.

## Schema changes

The steps are in the root `AGENTS.md` and `docs/adding-a-module.md`: change `src/schema.ts`, run
`pnpm db:new <name>`, review the file, and add `SELECT enable_tenant_rls('<table>')` to a new
tenant table.

**Expand and contract.** Deploys run migrations before the new Worker goes live, while the
previous Worker keeps serving, and it can be rolled back to. So every migration must work with
the code that's live now. `pnpm check:migrations` enforces this (`src/node/rules.ts`):

- **Expand:** new tables. New columns that are nullable or have a default. Indexes on an existing
  table with `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, in a file whose first line is
  `-- no-transaction`. A new `NOT NULL` on an existing column is a `NOT VALID` check constraint
  that's validated afterwards.
- **Contract,** in a later release once no live code uses it: drops, renames and type changes.
  The file needs a `-- contract: <why nothing uses it>` header.
- **Renaming a column:**
  1. Add the new column.
  2. Write to both columns, and backfill the new one.
  3. Read from the new column.
  4. Drop the old column in a later release.
- Migrations are numbered and append-only. Never edit one that has run.

## Seeds and tests

- Every new table gets demo rows in `packages/tooling/src/seed.ts`. Use fixed ids, upsert, and
  write in the demo companies' voice.
- `test/database.test.ts` runs the row-level security probes on every tenant table, new ones
  included. `pnpm test:db` runs them on real Postgres logins (see the README).
