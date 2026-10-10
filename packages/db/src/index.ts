// Worker-safe exports. Node-only code (the migration runner, test Postgres) is `@template/db/node`.
export * from "./schema";
export {
  applySettings,
  beginSql,
  pgDatabase,
  runInTransaction,
  settingsStatement,
  type PgClientLike,
  type QueryOptions,
  type SqlDatabase,
  type SqlResult,
  type SqlSession,
  type SqlStatement,
  type TransactionSettings,
} from "./driver";
export { neonHttpDatabase } from "./neon-http";
export { createPgClient } from "./pg";
export {
  contextForEmail,
  contextFromSession,
  Database,
  inviteByToken,
  invitesForEmail,
  memberOrganizations,
  ownOrganizations,
  NO_ORGANIZATION,
  ORGANIZATION_SETTING,
  setContext,
  TenantDb,
  tenantColumn,
  tenantSettings,
  USER_SETTING,
  type DatabaseOptions,
  type Drizzle,
  type Executable,
  type InviteLookupRow,
  type MemberOrganizationRow,
  type PendingInviteRow,
  type QueryName,
  type Scoped,
  type StatementTiming,
  type TenantContext,
  type TenantOptions,
} from "./database";
export { increment, keepOr } from "./expressions";
export { errorClass, sqlState, translateDatabaseError, violatedConstraint } from "./errors";
export type { PgColumn } from "drizzle-orm/pg-core";
// Query helpers, re-exported so other packages use the same drizzle-orm instance.
export {
  and,
  asc,
  desc,
  eq,
  count,
  sum,
  max,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  or,
} from "drizzle-orm";
