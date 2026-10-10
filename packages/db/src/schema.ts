import { sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type {
  AiSurface,
  ApprovalStatus,
  Approvers,
  AutomationDefinition,
  AutomationStatus,
  DraftSource,
  RunMode,
  RunStatus,
  StepRunStatus,
  TriggerKind,
  ZapierConnectionStatus,
  ZapierDirection,
  ZapierEvent,
  ZapierEventRun,
  ZapierEventStatus,
} from "@template/contracts";
import {
  boolean,
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * The database, as Drizzle sees it. Change it here, then `pnpm db:new <name>` writes the next
 * numbered migration for review (`packages/db/migrations`).
 *
 * Two kinds of table:
 * - **Identity tables** (`users`, `auth_identities`, `sessions`, `email_tokens`) belong to a
 *   person, not an organization. Only `packages/auth` touches them.
 * - **Tenant tables** belong to an organization: `organization_id` first in the primary key,
 *   every foreign key and every index, and `SELECT enable_tenant_rls('<table>')` in the
 *   migration. `pnpm check:migrations` enforces both. `organizations` is the tenant itself
 *   (its `id` is the organization id).
 */

/** Case-insensitive text: `Bea@ThreePigs.example` and `bea@threepigs.example` are one email. */
export const citext = customType<{ data: string }>({ dataType: () => "citext" });

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
};

// ---------------------------------------------------------------- identity

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: citext("email").notNull().unique(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  /** Null for an account that only signs in with Google. */
  passwordHash: text("password_hash"),
  name: text("name").notNull(),
  title: text("title"),
  avatarUrl: text("avatar_url"),
  ...timestamps,
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /** Set when the person deletes their account; the cleanup cron removes the row 30 days later. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const authIdentities = pgTable(
  "auth_identities",
  {
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.providerUserId] }),
    index("auth_identities_user").on(t.userId),
    check("auth_identities_provider", sql`${t.provider} IN ('google')`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    /** HMAC of the cookie's token with `SESSION_PEPPER`; the token itself is never stored. */
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * The organization this browser has open, or null (a person with no company yet, sent to
     * `/onboarding`). It authorizes nothing by itself: every request checks the membership.
     */
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    ...timestamps,
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user").on(t.userId)],
);

export const EMAIL_TOKEN_PURPOSES = ["verify", "reset", "change_email"] as const;
export type EmailTokenPurpose = (typeof EMAIL_TOKEN_PURPOSES)[number];

export const emailTokens = pgTable(
  "email_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose").$type<EmailTokenPurpose>().notNull(),
    /** The address a `change_email` token moves the account to. */
    newEmail: citext("new_email"),
    ...timestamps,
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [
    index("email_tokens_user").on(t.userId),
    check("email_tokens_purpose", sql`${t.purpose} IN ('verify', 'reset', 'change_email')`),
  ],
);

/**
 * Marks a database as one demo data may be loaded into (`pnpm db:allow-demo`, run once on the
 * local and staging databases). `pnpm db:seed` refuses a database without the row.
 */
export const environmentMarkers = pgTable("environment_markers", {
  name: text("name").primaryKey(),
  ...timestamps,
});

// ---------------------------------------------------------------- tenant

/**
 * A company. Its `id` (UUID v7, `newOrganizationId()`) is created once and never reused: it's the
 * company's id everywhere outside this database too (`specs/organizations.md`).
 */
export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    /** Display only for now; links use the id. Null for companies made before slugs. */
    slug: citext("slug"),
    /** Reserved: fills in once file uploads exist. */
    logoUrl: text("logo_url"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Soft-deleted: members lost access; the cleanup cron removes it for good after 30 days. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("organizations_slug").on(t.slug),
    index("organizations_deleted")
      .on(t.deletedAt)
      .where(sql`${t.deletedAt} IS NOT NULL`),
  ],
);

export const ROLES = ["owner", "admin", "member"] as const;
export type MembershipRole = (typeof ROLES)[number];

export const memberships = pgTable(
  "memberships",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<MembershipRole>().notNull(),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Orders the switcher, and picks the organization a new session opens. */
    lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
    ...timestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId] }),
    index("memberships_user").on(t.userId),
    check("memberships_role", sql`${t.role} IN ('owner', 'admin', 'member')`),
  ],
);

/**
 * An invitation to join an organization. Only the token's HMAC is stored. Accepted invites are
 * kept (who invited whom); revoking deletes the row; the cleanup cron removes expired and
 * accepted ones after 90 days.
 */
export const organizationInvites = pgTable(
  "organization_invites",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    id: uuid("id").notNull(),
    email: citext("email").notNull(),
    /** `admin` or `member`: ownership is given to someone already in the organization. */
    role: text("role").$type<"admin" | "member">().notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }).notNull().defaultNow(),
    sendCount: integer("send_count").notNull().default(1),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    // The invitation page looks an invite up by its token before it knows the organization.
    uniqueIndex("organization_invites_token").on(t.tokenHash),
    uniqueIndex("organization_invites_pending")
      .on(t.organizationId, t.email)
      .where(sql`${t.acceptedAt} IS NULL`),
    index("organization_invites_sent").on(t.organizationId, t.lastSentAt),
    index("organization_invites_expiry").on(t.expiresAt),
    check("organization_invites_role", sql`${t.role} IN ('admin', 'member')`),
  ],
);

// ---------------------------------------------------------------- AI (specs/ai.md)

const org = () =>
  uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" });
const at = (name: string) => timestamp(name, { withTimezone: true });

/** One Assistant conversation's index row. Its messages live in the Durable Object. */
export const aiConversations = pgTable(
  "ai_conversations",
  {
    organizationId: org(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The id the browser chose; the Durable Object is `<organization>:<user>:<id>`. */
    id: text("id").notNull(),
    kind: text("kind").$type<"assistant">().notNull().default("assistant"),
    title: text("title"),
    ...timestamps,
    lastMessageAt: at("last_message_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId, t.id] }),
    index("ai_conversations_recent").on(t.organizationId, t.userId, t.lastMessageAt),
  ],
);

/** One row per model call that cost something: an Assistant turn, a Builder turn, an AI step. */
export const aiUsage = pgTable(
  "ai_usage",
  {
    organizationId: org(),
    id: uuid("id").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    surface: text("surface").$type<AiSurface>().notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    index("ai_usage_recent").on(t.organizationId, t.createdAt),
  ],
);

/** The organization's AI policy. No row means the defaults (`AI_LIMITS`). */
export const aiSettings = pgTable(
  "ai_settings",
  {
    organizationId: org(),
    defaultModel: text("default_model"),
    monthlyBudgetUsd: doublePrecision("monthly_budget_usd"),
    dailyRequests: integer("daily_requests"),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.organizationId] })],
);

// ---------------------------------------------------------------- automations

export const automations = pgTable(
  "automations",
  {
    organizationId: org(),
    id: uuid("id").notNull(),
    name: text("name").notNull(),
    status: text("status").$type<AutomationStatus>().notNull().default("draft"),
    statusReason: text("status_reason"),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    draft: jsonb("draft").$type<AutomationDefinition>().notNull(),
    draftRevision: integer("draft_revision").notNull().default(1),
    activeVersion: integer("active_version"),
    /** The publisher: runs act as them, and their membership is rechecked on every run. */
    runAsUserId: uuid("run_as_user_id").references(() => users.id, { onDelete: "set null" }),
    /** What dispatch looks automations up by: `app.event:profile.updated`, `schedule`. */
    triggerKey: text("trigger_key"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastRunAt: at("last_run_at"),
    lastRunStatus: text("last_run_status").$type<RunStatus>(),
    ...timestamps,
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    index("automations_trigger").on(t.organizationId, t.triggerKey, t.status),
    check("automations_status", sql`${t.status} IN ('draft', 'active', 'paused', 'failed')`),
  ],
);

const automationRef = (t: { organizationId: PgColumn; automationId: PgColumn }) =>
  foreignKey({
    columns: [t.organizationId, t.automationId],
    foreignColumns: [automations.organizationId, automations.id],
  }).onDelete("cascade");

/** Every save of a draft, by chat, the editor or the system. */
export const automationDraftRevisions = pgTable(
  "automation_draft_revisions",
  {
    organizationId: org(),
    automationId: uuid("automation_id").notNull(),
    revision: integer("revision").notNull(),
    source: text("source").$type<DraftSource>().notNull(),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    summary: text("summary").notNull(),
    definition: jsonb("definition").$type<AutomationDefinition>().notNull(),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.automationId, t.revision] }),
    automationRef(t),
  ],
);

/** Immutable published versions (1, 2, …) and hidden test snapshots (negative numbers). */
export const automationVersions = pgTable(
  "automation_versions",
  {
    organizationId: org(),
    automationId: uuid("automation_id").notNull(),
    version: integer("version").notNull(),
    kind: text("kind").$type<"published" | "test">().notNull(),
    definition: jsonb("definition").$type<AutomationDefinition>().notNull(),
    draftRevision: integer("draft_revision").notNull(),
    publishedBy: uuid("published_by").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.automationId, t.version] }), automationRef(t)],
);

export const automationRuns = pgTable(
  "automation_runs",
  {
    organizationId: org(),
    id: uuid("id").notNull(),
    automationId: uuid("automation_id").notNull(),
    version: integer("version").notNull(),
    mode: text("mode").$type<RunMode>().notNull(),
    status: text("status").$type<RunStatus>().notNull(),
    triggerKind: text("trigger_kind").$type<TriggerKind>().notNull(),
    /** Unique per automation, so a redelivered event starts each automation once. */
    triggerEventId: text("trigger_event_id").notNull(),
    triggerPayload: jsonb("trigger_payload"),
    runAsUserId: uuid("run_as_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startedBy: uuid("started_by").references(() => users.id, { onDelete: "set null" }),
    chainDepth: integer("chain_depth").notNull().default(0),
    currentStepId: text("current_step_id"),
    error: text("error"),
    fixHint: text("fix_hint"),
    ...timestamps,
    startedAt: at("started_at"),
    finishedAt: at("finished_at"),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique("automation_runs_event").on(t.organizationId, t.automationId, t.triggerEventId),
    index("automation_runs_recent").on(t.organizationId, t.automationId, t.createdAt),
    automationRef(t),
  ],
);

const runRef = (t: { organizationId: PgColumn; runId: PgColumn }) =>
  foreignKey({
    columns: [t.organizationId, t.runId],
    foreignColumns: [automationRuns.organizationId, automationRuns.id],
  }).onDelete("cascade");

/** One row per step wherever it's nested; a step inside For each keeps its latest item. */
export const automationRunSteps = pgTable(
  "automation_run_steps",
  {
    organizationId: org(),
    runId: uuid("run_id").notNull(),
    stepId: text("step_id").notNull(),
    position: integer("position").notNull(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    status: text("status").$type<StepRunStatus>().notNull().default("pending"),
    simulated: boolean("simulated").notNull().default(false),
    attempts: integer("attempts").notNull().default(0),
    input: jsonb("input"),
    output: jsonb("output"),
    error: text("error"),
    hint: text("hint"),
    startedAt: at("started_at"),
    finishedAt: at("finished_at"),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.runId, t.stepId] }), runRef(t)],
);

/** The once-only ledger: an effect keyed `<run>:<step>` is recorded and never repeated. */
export const automationEffects = pgTable(
  "automation_effects",
  {
    organizationId: org(),
    runId: uuid("run_id").notNull(),
    key: text("key").notNull(),
    result: jsonb("result"),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.runId, t.key] }), runRef(t)],
);

export const automationApprovals = pgTable(
  "automation_approvals",
  {
    organizationId: org(),
    id: uuid("id").notNull(),
    automationId: uuid("automation_id").notNull(),
    runId: uuid("run_id").notNull(),
    stepId: text("step_id").notNull(),
    approvers: jsonb("approvers").$type<Approvers>().notNull(),
    message: text("message").notNull(),
    status: text("status").$type<ApprovalStatus>().notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: at("decided_at"),
    note: text("note"),
    ...timestamps,
    expiresAt: at("expires_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique("automation_approvals_step").on(t.organizationId, t.runId, t.stepId),
    index("automation_approvals_status").on(t.organizationId, t.status),
    runRef(t),
  ],
);

/**
 * A webhook trigger's token (hashed: the URL is the lookup key) and its signing secret (sealed,
 * because verifying a signature needs it back).
 */
export const automationWebhooks = pgTable(
  "automation_webhooks",
  {
    organizationId: org(),
    automationId: uuid("automation_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    sealed: text("sealed").notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.automationId] }), automationRef(t)],
);

// ---------------------------------------------------------------- Zapier

export const zapierConnections = pgTable(
  "zapier_connections",
  {
    organizationId: org(),
    id: uuid("id").notNull(),
    direction: text("direction").$type<ZapierDirection>().notNull(),
    name: text("name").notNull(),
    status: text("status").$type<ZapierConnectionStatus>().notNull().default("active"),
    /** Inbound: a peppered hash of the secret. */
    secretHash: text("secret_hash"),
    /** Outbound: the Catch Hook URL, sealed with the organization and connection as data. */
    sealedUrl: text("sealed_url"),
    /** The secret's or URL's last characters, to tell connections apart. */
    hint: text("hint").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
    updatedAt: at("updated_at").notNull().defaultNow(),
    lastUsedAt: at("last_used_at"),
    lastProvider: text("last_provider"),
    lastEventType: text("last_event_type"),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    check("zapier_connections_direction", sql`${t.direction} IN ('inbound', 'outbound')`),
    check("zapier_connections_status", sql`${t.status} IN ('active', 'disabled')`),
  ],
);

/** Received Zapier events: history (30 days), the dedupe record and the retry queue. */
export const zapierEvents = pgTable(
  "inbound_events",
  {
    organizationId: org(),
    id: uuid("id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    provider: text("provider").notNull().default(""),
    eventType: text("event_type").notNull(),
    externalId: text("external_id"),
    occurredAt: at("occurred_at").notNull(),
    receivedAt: at("received_at").notNull().defaultNow(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").$type<ZapierEventStatus>().notNull().default("received"),
    test: boolean("test").notNull().default(false),
    deliveries: integer("deliveries").notNull().default(1),
    attempts: integer("attempts").notNull().default(0),
    runs: jsonb("runs").$type<ZapierEventRun[]>().notNull().default([]),
    error: text("error"),
    payload: jsonb("payload").$type<ZapierEvent>().notNull(),
    processedAt: at("processed_at"),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique("inbound_events_dedupe").on(t.organizationId, t.connectionId, t.idempotencyKey),
    index("inbound_events_recent").on(t.organizationId, t.connectionId, t.receivedAt),
    foreignKey({
      columns: [t.organizationId, t.connectionId],
      foreignColumns: [zapierConnections.organizationId, zapierConnections.id],
    }).onDelete("cascade"),
  ],
);

export const schema = {
  users,
  authIdentities,
  sessions,
  emailTokens,
  environmentMarkers,
  organizations,
  memberships,
  organizationInvites,
  aiConversations,
  aiUsage,
  aiSettings,
  automations,
  automationDraftRevisions,
  automationVersions,
  automationRuns,
  automationRunSteps,
  automationEffects,
  automationApprovals,
  automationWebhooks,
  zapierConnections,
  zapierEvents,
};

export type User = typeof users.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type OrganizationInviteRow = typeof organizationInvites.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type EmailToken = typeof emailTokens.$inferSelect;
export type AuthIdentity = typeof authIdentities.$inferSelect;
export type AutomationRow = typeof automations.$inferSelect;
export type AutomationRunRow = typeof automationRuns.$inferSelect;
export type ZapierConnectionRow = typeof zapierConnections.$inferSelect;
export type ZapierEventRow = typeof zapierEvents.$inferSelect;
