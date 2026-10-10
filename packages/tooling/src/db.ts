import { Database, environmentMarkers, pgDatabase, type SqlDatabase } from "@template/db";
import {
  grantRuntime,
  migrate,
  MIGRATOR_ROLE,
  readMigrations,
  RUNTIME_ROLE,
  type MigrationConnection,
} from "@template/db/node";
import pg from "pg";
import { run, type Env } from "./shared";

/**
 * Local Postgres in Docker with the same two roles as each Neon branch: `app_migrator` owns the
 * schema (DDL; CI and `pnpm db:migrate` only) and `app_runtime` has DML only (the Worker).
 */
export const LOCAL_POSTGRES = {
  container: "build-template-postgres",
  image: "postgres:17",
  port: 5434,
  password: "template-local",
  database: "app",
};

export const TEST_DATABASE = "app_test";

export function localUrl(role: string, database = LOCAL_POSTGRES.database): string {
  const { password, port } = LOCAL_POSTGRES;
  return `postgres://${role}:${password}@127.0.0.1:${port}/${database}`;
}

/**
 * A local database other than Docker (the `build-template-local` Neon project): set both in the
 * root `.env`. `LOCAL_DATABASE_URL` is what the Worker uses, as app_runtime.
 */
export function localNeon(): { migrator: string; runtime: string } | null {
  const migrator = process.env.LOCAL_DATABASE_MIGRATOR_URL;
  const runtime = process.env.LOCAL_DATABASE_URL;
  if (!migrator && !runtime) return null;
  if (!migrator || !runtime)
    throw new Error("Set both LOCAL_DATABASE_MIGRATOR_URL and LOCAL_DATABASE_URL, or neither");
  return { migrator, runtime };
}

/** The migrator's direct (unpooled) URL for an environment. Deployed ones come from CI secrets. */
export function migratorUrl(env: Env): string {
  if (env === "local") return localNeon()?.migrator ?? localUrl(MIGRATOR_ROLE);
  const url = process.env.DATABASE_MIGRATOR_URL;
  if (!url)
    throw new Error(
      `Set DATABASE_MIGRATOR_URL to the ${env} branch's direct (unpooled) URL for ${MIGRATOR_ROLE}. CI reads it from the GitHub ${env} environment.`,
    );
  return url;
}

export async function connect(url: string): Promise<pg.Client & MigrationConnection> {
  const client = new pg.Client({
    connectionString: url,
    application_name: "build-template-tooling",
  });
  await client.connect();
  return Object.assign(client, {
    exec: async (sql: string) => {
      await client.query(sql);
    },
  }) as pg.Client & MigrationConnection;
}

export async function dbLocal(log: (line: string) => void = console.log): Promise<void> {
  const { container, image, port, password, database } = LOCAL_POSTGRES;
  const running = run("docker", ["ps", "-q", "-f", `name=^${container}$`], {
    allowFailure: true,
    quiet: true,
  }).stdout.trim();
  if (!running) {
    const exists = run("docker", ["ps", "-aq", "-f", `name=^${container}$`], {
      allowFailure: true,
      quiet: true,
    }).stdout.trim();
    if (exists) run("docker", ["start", container], { quiet: true });
    else
      run(
        "docker",
        [
          "run",
          "-d",
          "--name",
          container,
          "-e",
          `POSTGRES_PASSWORD=${password}`,
          "-p",
          `127.0.0.1:${port}:5432`,
          "-v",
          `${container}:/var/lib/postgresql/data`,
          image,
        ],
        { quiet: true },
      );
    log(`started ${container} on 127.0.0.1:${port}`);
  }
  const admin = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  let client: pg.Client | null = null;
  for (let attempt = 0; attempt < 60 && !client; attempt++) {
    try {
      client = await connect(admin);
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!client) throw new Error(`Postgres in ${container} didn't start`);
  try {
    const role = (name: string) =>
      client!.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]);
    if (!(await role(MIGRATOR_ROLE)).rows.length)
      await client.query(`CREATE ROLE "${MIGRATOR_ROLE}" LOGIN PASSWORD '${password}'`);
    // "app" for pnpm dev; "app_test" for pnpm test:db, which empties tables between tests.
    for (const name of [database, TEST_DATABASE])
      if (!(await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rows.length)
        await client.query(`CREATE DATABASE "${name}" OWNER "${MIGRATOR_ROLE}"`);
    if (!(await role(RUNTIME_ROLE)).rows.length)
      await client.query(
        `CREATE ROLE "${RUNTIME_ROLE}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
      );
    for (const name of [database, TEST_DATABASE])
      await client.query(`GRANT CONNECT ON DATABASE "${name}" TO "${RUNTIME_ROLE}"`);
  } finally {
    await client.end();
  }
  for (const name of [database, TEST_DATABASE]) {
    const owned = await connect(`postgres://postgres:${password}@127.0.0.1:${port}/${name}`);
    try {
      await owned.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
      await owned.query(`ALTER SCHEMA public OWNER TO "${MIGRATOR_ROLE}"`);
      // citext is a trusted extension on Neon; locally the superuser installs it once.
      await owned.query(`CREATE EXTENSION IF NOT EXISTS citext`);
    } finally {
      await owned.end();
    }
  }
  log(`local database "${database}" ready: ${MIGRATOR_ROLE} (owner), ${RUNTIME_ROLE} (DML only)`);
}

/** `dir`: the migrations to apply (promote passes the staging build's copy). */
export async function dbMigrate(
  env: Env,
  log: (line: string) => void = console.log,
  dir?: string,
): Promise<void> {
  const client = await connect(migratorUrl(env));
  try {
    const applied = await migrate(client, readMigrations(dir), { log });
    if (!applied.length) log("no migrations to apply");
    if (!(await grantRuntime(client)))
      log(`warning: the ${RUNTIME_ROLE} role doesn't exist on ${env}; create it (README, "Setup")`);
  } finally {
    await client.end();
  }
}

export const DEMO_MARKER = "demo_data_allowed";

/** As the migrator, for the seed and the marker (it owns the tables; forced RLS still applies). */
export function migratorDatabase(env: Env): { database: Database; sql: SqlDatabase } {
  const sql = pgDatabase(() => new pg.Client({ connectionString: migratorUrl(env) }) as never);
  return { database: new Database(sql), sql };
}

/** Marks a database as one demo data may go into. Run once on local and staging, never production. */
export async function allowDemo(env: Env): Promise<void> {
  if (env === "production") throw new Error("Demo data never goes into production.");
  const { database } = migratorDatabase(env);
  try {
    await database.one((d) =>
      d.insert(environmentMarkers).values({ name: DEMO_MARKER }).onConflictDoNothing(),
    );
  } finally {
    await database.close();
  }
  console.log(`${env}: demo data allowed`);
}
