-- Reviewed addition: the foreign keys to organizations below are checked under its forced
-- row-level security, whose policy reads app.organization_id. As the migrator (not a superuser)
-- that setting must exist, so it's set to no organization for this transaction.
SELECT set_config('app.organization_id', '00000000-0000-0000-0000-000000000000', true);--> statement-breakpoint
CREATE TABLE "ai_conversations" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"id" text NOT NULL,
	"kind" text DEFAULT 'assistant' NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_conversations_organization_id_user_id_id_pk" PRIMARY KEY("organization_id","user_id","id")
);
--> statement-breakpoint
CREATE TABLE "ai_settings" (
	"organization_id" uuid NOT NULL,
	"default_model" text,
	"monthly_budget_usd" double precision,
	"daily_requests" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_settings_organization_id_pk" PRIMARY KEY("organization_id")
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"organization_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"user_id" uuid,
	"surface" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "automation_approvals" (
	"organization_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"approvers" jsonb NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "automation_approvals_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "automation_approvals_step" UNIQUE("organization_id","run_id","step_id")
);
--> statement-breakpoint
CREATE TABLE "automation_draft_revisions" (
	"organization_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"source" text NOT NULL,
	"author_id" uuid,
	"summary" text NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_draft_revisions_organization_id_automation_id_revision_pk" PRIMARY KEY("organization_id","automation_id","revision")
);
--> statement-breakpoint
CREATE TABLE "automation_effects" (
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"key" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_effects_organization_id_run_id_key_pk" PRIMARY KEY("organization_id","run_id","key")
);
--> statement-breakpoint
CREATE TABLE "automation_run_steps" (
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"hint" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "automation_run_steps_organization_id_run_id_step_id_pk" PRIMARY KEY("organization_id","run_id","step_id")
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"organization_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"trigger_kind" text NOT NULL,
	"trigger_event_id" text NOT NULL,
	"trigger_payload" jsonb,
	"run_as_user_id" uuid NOT NULL,
	"started_by" uuid,
	"chain_depth" integer DEFAULT 0 NOT NULL,
	"current_step_id" text,
	"error" text,
	"fix_hint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "automation_runs_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "automation_runs_event" UNIQUE("organization_id","automation_id","trigger_event_id")
);
--> statement-breakpoint
CREATE TABLE "automation_versions" (
	"organization_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"definition" jsonb NOT NULL,
	"draft_revision" integer NOT NULL,
	"published_by" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_versions_organization_id_automation_id_version_pk" PRIMARY KEY("organization_id","automation_id","version")
);
--> statement-breakpoint
CREATE TABLE "automation_webhooks" (
	"organization_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"sealed" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_webhooks_organization_id_automation_id_pk" PRIMARY KEY("organization_id","automation_id")
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"organization_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"status_reason" text,
	"owner_id" uuid,
	"draft" jsonb NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"active_version" integer,
	"run_as_user_id" uuid,
	"trigger_key" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_run_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "automations_status" CHECK ("automations"."status" IN ('draft', 'active', 'paused', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "zapier_connections" (
	"organization_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"direction" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"secret_hash" text,
	"sealed_url" text,
	"hint" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_provider" text,
	"last_event_type" text,
	CONSTRAINT "zapier_connections_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "zapier_connections_direction" CHECK ("zapier_connections"."direction" IN ('inbound', 'outbound')),
	CONSTRAINT "zapier_connections_status" CHECK ("zapier_connections"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "inbound_events" (
	"organization_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" text DEFAULT '' NOT NULL,
	"event_type" text NOT NULL,
	"external_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"test" boolean DEFAULT false NOT NULL,
	"deliveries" integer DEFAULT 1 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"runs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "inbound_events_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "inbound_events_dedupe" UNIQUE("organization_id","connection_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_approvals" ADD CONSTRAINT "automation_approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_approvals" ADD CONSTRAINT "automation_approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_approvals" ADD CONSTRAINT "automation_approvals_organization_id_run_id_automation_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."automation_runs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_draft_revisions" ADD CONSTRAINT "automation_draft_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_draft_revisions" ADD CONSTRAINT "automation_draft_revisions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_draft_revisions" ADD CONSTRAINT "automation_draft_revisions_organization_id_automation_id_automations_organization_id_id_fk" FOREIGN KEY ("organization_id","automation_id") REFERENCES "public"."automations"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_effects" ADD CONSTRAINT "automation_effects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_effects" ADD CONSTRAINT "automation_effects_organization_id_run_id_automation_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."automation_runs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_run_steps" ADD CONSTRAINT "automation_run_steps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_run_steps" ADD CONSTRAINT "automation_run_steps_organization_id_run_id_automation_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."automation_runs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_run_as_user_id_users_id_fk" FOREIGN KEY ("run_as_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_organization_id_automation_id_automations_organization_id_id_fk" FOREIGN KEY ("organization_id","automation_id") REFERENCES "public"."automations"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_organization_id_automation_id_automations_organization_id_id_fk" FOREIGN KEY ("organization_id","automation_id") REFERENCES "public"."automations"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_webhooks" ADD CONSTRAINT "automation_webhooks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_webhooks" ADD CONSTRAINT "automation_webhooks_organization_id_automation_id_automations_organization_id_id_fk" FOREIGN KEY ("organization_id","automation_id") REFERENCES "public"."automations"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_run_as_user_id_users_id_fk" FOREIGN KEY ("run_as_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zapier_connections" ADD CONSTRAINT "zapier_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zapier_connections" ADD CONSTRAINT "zapier_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_organization_id_connection_id_zapier_connections_organization_id_id_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "public"."zapier_connections"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_conversations_recent" ON "ai_conversations" USING btree ("organization_id","user_id","last_message_at");--> statement-breakpoint
CREATE INDEX "ai_usage_recent" ON "ai_usage" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_approvals_status" ON "automation_approvals" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "automation_runs_recent" ON "automation_runs" USING btree ("organization_id","automation_id","created_at");--> statement-breakpoint
CREATE INDEX "automations_trigger" ON "automations" USING btree ("organization_id","trigger_key","status");--> statement-breakpoint
CREATE INDEX "inbound_events_recent" ON "inbound_events" USING btree ("organization_id","connection_id","received_at");--> statement-breakpoint

-- Reviewed additions (not generated): tenant row-level security for every new table.
SELECT enable_tenant_rls('ai_conversations');--> statement-breakpoint
SELECT enable_tenant_rls('ai_usage');--> statement-breakpoint
SELECT enable_tenant_rls('ai_settings');--> statement-breakpoint
SELECT enable_tenant_rls('automations');--> statement-breakpoint
SELECT enable_tenant_rls('automation_draft_revisions');--> statement-breakpoint
SELECT enable_tenant_rls('automation_versions');--> statement-breakpoint
SELECT enable_tenant_rls('automation_runs');--> statement-breakpoint
SELECT enable_tenant_rls('automation_run_steps');--> statement-breakpoint
SELECT enable_tenant_rls('automation_effects');--> statement-breakpoint
SELECT enable_tenant_rls('automation_approvals');--> statement-breakpoint
SELECT enable_tenant_rls('automation_webhooks');--> statement-breakpoint
SELECT enable_tenant_rls('zapier_connections');--> statement-breakpoint
SELECT enable_tenant_rls('inbound_events');--> statement-breakpoint

-- Requests that arrive without a session (a Zapier delivery, a signed webhook) and the cron jobs
-- have to find which organization a row belongs to before they can act as it. Like
-- own_memberships in 0001, each is a SELECT-only policy keyed on a setting the caller sets for
-- that one lookup, and a plain indexed condition. Everything after the lookup runs with the
-- organization set, under tenant_isolation.
--
-- cross-tenant index: zapier_connections_inbound: find an inbound connection by the id in its URL.
CREATE UNIQUE INDEX "zapier_connections_inbound" ON "zapier_connections" USING btree ("id");--> statement-breakpoint
CREATE POLICY inbound_lookup ON zapier_connections FOR SELECT
  USING (direction = 'inbound' AND id = nullif(current_setting('app.zapier_connection', true), '')::uuid);--> statement-breakpoint

-- cross-tenant index: automation_webhooks_token: find a webhook trigger by the token in its URL.
CREATE UNIQUE INDEX "automation_webhooks_token" ON "automation_webhooks" USING btree ("token_hash");--> statement-breakpoint
CREATE POLICY token_lookup ON automation_webhooks FOR SELECT
  USING (token_hash = nullif(current_setting('app.webhook_token', true), ''));--> statement-breakpoint

-- cross-tenant index: automations_schedules: the five-minute cron lists active schedules.
CREATE INDEX "automations_schedules" ON "automations" USING btree ("trigger_key", "status");--> statement-breakpoint
CREATE POLICY schedule_job ON automations FOR SELECT
  USING (current_setting('app.job', true) = 'automation-schedules' AND trigger_key = 'schedule' AND status = 'active');--> statement-breakpoint

-- cross-tenant index: inbound_events_pending: the cron retries undispatched events and purges old ones.
CREATE INDEX "inbound_events_pending" ON "inbound_events" USING btree ("received_at");--> statement-breakpoint
CREATE POLICY events_job ON inbound_events FOR SELECT
  USING (current_setting('app.job', true) = 'zapier-events');--> statement-breakpoint

-- Account deletion: the cleanup job finds a person's conversations in every organization, so it
-- can delete their Durable Objects' messages before the rows go.
-- cross-tenant index: ai_conversations_user: a person's conversations across organizations.
CREATE INDEX "ai_conversations_user" ON "ai_conversations" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY own_conversations ON ai_conversations FOR SELECT
  USING (current_setting('app.job', true) = 'account-cleanup' AND user_id = nullif(current_setting('app.user_id', true), '')::uuid);
