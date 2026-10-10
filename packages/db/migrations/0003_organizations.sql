-- Organizations: members, invitations, roles and switching (specs/organizations.md).
--
-- Reviewed additions: the foreign keys to organizations below are checked under its forced
-- row-level security (as in 0001), so the setting must exist for this transaction.
SELECT set_config('app.organization_id', '00000000-0000-0000-0000-000000000000', true);--> statement-breakpoint
CREATE TABLE "organization_invites" (
	"organization_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"email" "citext" NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"send_count" integer DEFAULT 1 NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_invites_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "organization_invites_role" CHECK ("organization_invites"."role" IN ('admin', 'member'))
);
--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "invited_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "last_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "slug" "citext";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "logo_url" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- cross-tenant index: organization_invites_token: the invitation page finds an invite by its token before it knows the organization.
CREATE UNIQUE INDEX "organization_invites_token" ON "organization_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_invites_pending" ON "organization_invites" USING btree ("organization_id","email") WHERE "organization_invites"."accepted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "organization_invites_sent" ON "organization_invites" USING btree ("organization_id","last_sent_at");--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "memberships" VALIDATE CONSTRAINT "memberships_invited_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "organizations" VALIDATE CONSTRAINT "organizations_created_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_organization_id_organizations_id_fk";--> statement-breakpoint

-- Reviewed additions (not generated).
SELECT enable_tenant_rls('organization_invites');--> statement-breakpoint

-- Reads that cross organizations. Row-level security scopes everything to one organization, but
-- three reads happen before one is chosen. Each is a SECURITY DEFINER function owned by the
-- migrator, with a pinned search_path, returning only what it's named for, and each checks the
-- caller's own app.user_id where it can. @template/auth is the only caller, and
-- check:migrations allows exactly these names.
--
-- The tables' row-level security is forced, so it binds their owner too: these SELECT-only
-- policies let the functions (which run as the owner) read across organizations. app_runtime
-- never matches them.
CREATE POLICY definer_reads ON organizations FOR SELECT USING (current_user = 'app_migrator');--> statement-breakpoint
CREATE POLICY definer_reads ON memberships FOR SELECT USING (current_user = 'app_migrator');--> statement-breakpoint
CREATE POLICY definer_reads ON organization_invites FOR SELECT USING (current_user = 'app_migrator');--> statement-breakpoint

-- The person's live organizations, most recently opened first: /api/session, the switcher,
-- sign-in and the fallback when an organization goes away. Only their own (app.user_id).
CREATE FUNCTION member_organizations(p_user_id uuid)
RETURNS TABLE (id uuid, name text, slug citext, role text, last_opened_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.id, o.name, o.slug, m.role, m.last_opened_at
  FROM memberships m
  JOIN organizations o ON o.id = m.organization_id AND o.deleted_at IS NULL
  WHERE m.user_id = p_user_id
    AND p_user_id = nullif(current_setting('app.user_id', true), '')::uuid
  ORDER BY m.last_opened_at DESC NULLS LAST, m.created_at
$$;--> statement-breakpoint

-- A pending, unexpired invite by its token's hash, with its organization's and inviter's names:
-- /invite/:token and accepting it. The hash is the proof.
CREATE FUNCTION invite_by_token(p_token_hash text)
RETURNS TABLE (organization_id uuid, id uuid, email citext, role text, expires_at timestamptz,
               organization_name text, invited_by_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.organization_id, i.id, i.email, i.role, i.expires_at, o.name, u.name
  FROM organization_invites i
  JOIN organizations o ON o.id = i.organization_id AND o.deleted_at IS NULL
  LEFT JOIN users u ON u.id = i.invited_by_user_id
  WHERE i.token_hash = p_token_hash AND i.accepted_at IS NULL AND i.expires_at > now()
$$;--> statement-breakpoint

-- Pending invites to an address, for /onboarding: only the caller's own email, and only once
-- it's verified.
CREATE FUNCTION invites_for_email(p_email citext)
RETURNS TABLE (organization_id uuid, id uuid, role text, expires_at timestamptz,
               organization_name text, invited_by_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.organization_id, i.id, i.role, i.expires_at, o.name, u.name
  FROM organization_invites i
  JOIN organizations o ON o.id = i.organization_id AND o.deleted_at IS NULL
  JOIN users me ON me.id = nullif(current_setting('app.user_id', true), '')::uuid
    AND me.email = p_email AND me.email_verified_at IS NOT NULL
  LEFT JOIN users u ON u.id = i.invited_by_user_id
  WHERE i.email = p_email AND i.accepted_at IS NULL AND i.expires_at > now()
  ORDER BY i.created_at
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION member_organizations(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION invite_by_token(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION invites_for_email(citext) FROM PUBLIC;--> statement-breakpoint

-- The daily cleanup job finds deleted organizations past their restore window, and old invites,
-- in every organization. Like 0002's job policies: SELECT only, keyed on app.job, a plain
-- indexed condition. Each row is then removed as its own organization, under tenant_isolation.
CREATE POLICY cleanup_job ON organizations FOR SELECT
  USING (current_setting('app.job', true) = 'organization-cleanup' AND deleted_at IS NOT NULL);--> statement-breakpoint
-- cross-tenant index: organization_invites_expiry: the daily cleanup finds expired and accepted invites in every organization.
CREATE INDEX "organization_invites_expiry" ON "organization_invites" USING btree ("expires_at");--> statement-breakpoint
CREATE POLICY cleanup_job ON organization_invites FOR SELECT
  USING (current_setting('app.job', true) = 'organization-cleanup');--> statement-breakpoint

-- The last-owner backstop. The actions lock the organization row, count owners, then write; this
-- catches anything that skipped that: at commit, a live organization with members and no owner
-- fails the transaction. It runs as the caller, under row-level security.
CREATE FUNCTION memberships_keep_an_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  org uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN org := OLD.organization_id; ELSE org := NEW.organization_id; END IF;
  IF EXISTS (SELECT 1 FROM organizations o WHERE o.id = org AND o.deleted_at IS NULL)
     AND EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = org)
     AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = org AND m.role = 'owner') THEN
    RAISE EXCEPTION 'organization % needs at least one owner', org
      USING ERRCODE = '23514', CONSTRAINT = 'memberships_one_owner';
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER memberships_one_owner AFTER UPDATE OR DELETE ON memberships
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memberships_keep_an_owner();
