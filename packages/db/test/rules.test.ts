import { describe, expect, it } from "vitest";
import { judgeMigration, readMigrations } from "../src/node";

const ok = (sql: string) => expect(judgeMigration(sql)).toMatchObject({ ok: true });
const fails = (sql: string, reason: RegExp) => {
  const verdict = judgeMigration(sql);
  expect(verdict.ok).toBe(false);
  if (!verdict.ok) expect(verdict.reason).toMatch(reason);
};

describe("judgeMigration", () => {
  it("passes every committed migration", () => {
    for (const file of readMigrations())
      expect([file.name, judgeMigration(file.sql)]).toEqual([
        file.name,
        { ok: true, contract: null },
      ]);
  });

  it("accepts a well-formed tenant table", () => {
    ok(`
      CREATE TABLE jobs (
        organization_id uuid NOT NULL REFERENCES organizations (id),
        id uuid NOT NULL,
        customer_id uuid NOT NULL,
        assigned_to uuid REFERENCES users (id),
        title text NOT NULL,
        PRIMARY KEY (organization_id, id),
        FOREIGN KEY (organization_id, customer_id) REFERENCES customers (organization_id, id)
      );
      CREATE INDEX jobs_customer ON jobs (organization_id, customer_id);
      SELECT enable_tenant_rls('jobs');`);
  });

  it("refuses a tenant table without RLS", () => {
    fails(
      `CREATE TABLE jobs (organization_id uuid NOT NULL, id uuid NOT NULL, PRIMARY KEY (organization_id, id));`,
      /enable_tenant_rls/,
    );
  });

  it("refuses a table without organization_id", () => {
    fails(
      `CREATE TABLE jobs (id uuid PRIMARY KEY); SELECT enable_tenant_rls('jobs');`,
      /organization_id/,
    );
  });

  it("refuses keys and indexes that don't start with organization_id", () => {
    fails(
      `CREATE TABLE jobs (organization_id uuid NOT NULL, id uuid NOT NULL, PRIMARY KEY (id, organization_id)); SELECT enable_tenant_rls('jobs');`,
      /PRIMARY KEY must start with organization_id/,
    );
    fails(
      `CREATE TABLE jobs (organization_id uuid NOT NULL, id uuid NOT NULL, title text, PRIMARY KEY (organization_id, id)); CREATE INDEX jobs_title ON jobs (title); SELECT enable_tenant_rls('jobs');`,
      /must start with organization_id/,
    );
    fails(
      `CREATE TABLE jobs (organization_id uuid NOT NULL, id uuid NOT NULL, customer_id uuid REFERENCES customers (id), PRIMARY KEY (organization_id, id)); SELECT enable_tenant_rls('jobs');`,
      /composite FOREIGN KEY/,
    );
  });

  it("flags destructive statements unless the file is a contract", () => {
    fails(`ALTER TABLE jobs DROP COLUMN title;`, /drops/);
    fails(`ALTER TABLE jobs RENAME COLUMN title TO name;`, /renames/);
    fails(`ALTER TABLE jobs ADD COLUMN notes text NOT NULL;`, /NOT NULL column without a default/);
    ok(`-- contract: the Worker stopped reading title in v12\nALTER TABLE jobs DROP COLUMN title;`);
  });

  it("needs CONCURRENTLY for an index on an existing table", () => {
    fails(`CREATE INDEX jobs_title ON jobs (organization_id, title);`, /CONCURRENTLY/);
    fails(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_title ON jobs (organization_id, title);`,
      /no-transaction/,
    );
    ok(
      `-- no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_title ON jobs (organization_id, title);`,
    );
  });

  it("refuses long locks on existing tables", () => {
    fails(`ALTER TABLE jobs ALTER COLUMN title SET NOT NULL;`, /SET NOT NULL/);
    fails(`ALTER TABLE jobs ADD CONSTRAINT jobs_title CHECK (title <> '');`, /NOT VALID/);
    ok(`ALTER TABLE jobs ADD CONSTRAINT jobs_title CHECK (title <> '') NOT VALID;`);
  });

  it("allows only the named SECURITY DEFINER functions, each with a pinned search_path", () => {
    fails(
      `CREATE FUNCTION all_jobs() RETURNS SETOF jobs LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT * FROM jobs $$;`,
      /SECURITY DEFINER function all_jobs/,
    );
    fails(
      `CREATE OR REPLACE FUNCTION member_organizations(p uuid) RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;`,
      /search_path/,
    );
    ok(
      `CREATE FUNCTION member_organizations(p uuid) RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT 1 $$;`,
    );
    // An ordinary function (a trigger) runs as its caller, under row-level security.
    ok(
      `CREATE FUNCTION keep_owner() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;`,
    );
  });
});
