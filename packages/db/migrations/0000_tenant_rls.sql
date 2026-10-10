-- Row-level security for tenant tables (SPEC.md, "Tenant isolation"). The data layer already
-- adds organization_id to every query; this is the backstop. Every tenant transaction first
-- runs set_config('app.organization_id', <organization>, true). Without that setting
-- current_setting raises, so a statement that forgot it fails instead of seeing every
-- organization. The policy checks the organization boundary and nothing else: no lookups or
-- function calls, so Postgres evaluates it as a plain indexed condition on the row.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE FUNCTION enable_tenant_rls(target regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (organization_id = current_setting(''app.organization_id'')::uuid) WITH CHECK (organization_id = current_setting(''app.organization_id'')::uuid)',
    target
  );
END
$$;
