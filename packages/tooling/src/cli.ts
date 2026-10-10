import { resolve } from "node:path";
import { Accounts } from "@template/auth";
import { createInterface } from "node:readline/promises";
import { checkBoundaries, checkMigrations } from "./checks";
import { allowDemo, dbLocal, dbMigrate, migratorDatabase } from "./db";
import { dev } from "./dev";
import { formatEvent, parseSince, queryLogs, scriptName } from "./logs";
import { checkPermissions } from "./permissions";
import { nextSteps, rename } from "./rename";
import { DEMO, seedDemo } from "./seed";
import { devVars, envOption, flag, option, positional, ROOT, run, step } from "./shared";

const HELP = `Usage: pnpm <command>

  dev                                    Postgres (Docker or LOCAL_DATABASE_URL), migrations, wrangler dev and Vite
  db:local                               Start local Postgres with the app_migrator and app_runtime roles
  db:migrate --env local|staging|production [--migrations <dir>]
                                         Apply migrations (deployed: DATABASE_MIGRATOR_URL)
  db:new <name>                          Write the next migration from the Drizzle schema, for review
  db:seed --env local|staging            Load the demo data (refuses production and unmarked databases)
  db:allow-demo --env local|staging      Mark a database as one demo data may go into (once)
  check:migrations [--base <ref>]        The migration rule on migrations added since <ref> (origin/main)
  check:boundaries                       Package dependency rules
  check:permissions                      No organization in action inputs, no role comparisons
  org:restore <organization id> --env local|staging|production
                                         Restore a deleted organization within 30 days (operators)
  logs --env staging|production [--request <id>] [--fingerprint <f>] [--level error] [--since 1h]
                                         The Worker's log lines (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN)
  promote                                Deploy the last successful staging build to production (GitHub)
  rollback                               Roll production back to the previous Worker version (GitHub)
  rename --name "<Product>" --scope @<product> [--domain <domain>]
                                         Turn a copy of the template into a product
`;

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/** Runs a GitHub Actions workflow on main and follows it in the terminal. */
async function dispatch(workflow: string): Promise<void> {
  const started = Date.now();
  run("gh", ["workflow", "run", workflow, "--ref", "main"]);
  let id = "";
  for (let attempt = 0; attempt < 20 && !id; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    const runs = JSON.parse(
      run(
        "gh",
        ["run", "list", "--workflow", workflow, "--limit", "5", "--json", "databaseId,createdAt"],
        {
          quiet: true,
        },
      ).stdout,
    ) as { databaseId: number; createdAt: string }[];
    id = String(runs.find((r) => Date.parse(r.createdAt) >= started - 5000)?.databaseId ?? "");
  }
  if (!id) throw new Error(`Couldn't find the ${workflow} run; see the Actions tab`);
  run("gh", ["run", "watch", id, "--exit-status"]);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "dev":
      return dev();
    case "db:local":
      return dbLocal();
    case "db:migrate": {
      // Relative to the repository root (the CLI runs from packages/tooling).
      const dir = option(args, "--migrations");
      return dbMigrate(envOption(args), console.log, dir ? resolve(ROOT, dir) : undefined);
    }
    case "db:new": {
      const [name] = positional(args);
      if (!name || !/^[a-z0-9_]+$/.test(name))
        throw new Error("Usage: pnpm db:new <name> (lowercase, digits, _)");
      run("pnpm", ["--filter", "@template/db", "exec", "drizzle-kit", "generate", "--name", name]);
      console.log(
        "\nReview the new file in packages/db/migrations. For a tenant table, add SELECT enable_tenant_rls('<table>');\nthen run pnpm check:migrations.",
      );
      return;
    }
    case "db:allow-demo":
      return allowDemo(envOption(args));
    case "db:seed": {
      const env = envOption(args);
      if (env === "production") throw new Error("The demo seed never runs on production.");
      const password =
        process.env.DEMO_PASSWORD ??
        process.env.STAGING_DEMO_PASSWORD ??
        (env === "local" ? devVars().DEMO_PASSWORD : undefined);
      const { database } = migratorDatabase(env);
      try {
        const { people } = await seedDemo(database, env, password ?? "");
        console.log(`${env}: demo data loaded (${people} memberships in ${DEMO.length} companies)`);
      } finally {
        await database.close();
      }
      return;
    }
    case "check:migrations": {
      const base = option(args, "--base") ?? "origin/main";
      return checkMigrations({ base: base === "none" ? null : base });
    }
    case "check:boundaries":
      return checkBoundaries();
    case "check:permissions":
      return checkPermissions();
    case "org:restore": {
      const [organizationId] = positional(args);
      if (!organizationId || !/^[0-9a-f-]{36}$/i.test(organizationId))
        throw new Error("Usage: pnpm org:restore <organization id> --env local|staging|production");
      const env = envOption(args);
      if (!(await confirm(`Restore organization ${organizationId} on ${env}?`))) return;
      const { database } = migratorDatabase(env);
      try {
        const restored = await new Accounts(database, "").organizations.restore(organizationId);
        console.log(
          restored
            ? `${env}: restored ${organizationId}. Its members can open it again; reconnect their apps and resume automations by hand.`
            : `${env}: ${organizationId} isn't deleted, or its 30 days are over and it's gone.`,
        );
      } finally {
        await database.close();
      }
      return;
    }
    case "logs": {
      const env = envOption(args);
      if (env === "local") throw new Error("Locally, the logs are in the pnpm dev terminal.");
      const level = option(args, "--level");
      const events = await queryLogs({
        script: scriptName(env),
        from: parseSince(option(args, "--since")),
        to: Date.now(),
        requestId: option(args, "--request"),
        fingerprint: option(args, "--fingerprint"),
        level: level === "error" || level === "warn" || level === "info" ? level : undefined,
        limit: Number(option(args, "--limit") ?? 100),
      });
      for (const event of events) console.log(formatEvent(event));
      if (!events.length) console.log("No log lines matched.");
      return;
    }
    case "promote":
      step("Promote the last successful staging build to production");
      if (!(await confirm("Deploy it to production?"))) return;
      return dispatch("promote.yml");
    case "rollback":
      step("Roll production back to the previous Worker version");
      if (!flag(args, "--yes") && !(await confirm("Roll production back?"))) return;
      return dispatch("rollback.yml");
    case "rename": {
      const options = {
        name: option(args, "--name") ?? "",
        scope: option(args, "--scope") ?? "",
        domain: option(args, "--domain"),
      };
      const changed = rename(options);
      console.log(`rewrote ${changed.length} files under ${ROOT}`);
      console.log(nextSteps(options));
      return;
    }
    default:
      console.log(HELP);
      if (command && command !== "help") process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
