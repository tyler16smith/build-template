import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT } from "./shared";

/**
 * `pnpm rename --name "Trades Pro" --scope @trades [--domain tradespro.com]`: makes a copy of the
 * template into a product. Rewrites the package scope, every Worker, database and dataset name, the
 * app name in pages and email, the domains and the README, then prints what to create (SPEC.md,
 * "Starting a product from the template"). SPEC.md and specs/ keep their history.
 *
 * Without --domain the product stays on workers.dev under its new Worker names; run it again with
 * --domain once there is one. This file is rewritten too, so a renamed product renames from its
 * current name.
 */
export type RenameOptions = { name: string; scope: string; domain?: string };

export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function replacements(options: RenameOptions): [string, string][] {
  const slug = slugOf(options.name);
  const scope = options.scope.replace(/^@?/, "@").replace(/\/$/, "");
  const domains: [string, string][] = options.domain
    ? [
        // The template's placeholder workers.dev origins; a product gets its domain.
        ["build-template-staging.your-subdomain.workers.dev", `staging.${options.domain}`],
        ["build-template.your-subdomain.workers.dev", `app.${options.domain}`],
      ]
    : [];
  return [
    ["@template/", `${scope}/`],
    ...domains,
    // Every other name derives from these: Workers, Neon projects, KV, datasets, gateways.
    ["build_template", slug.replace(/-/g, "_")],
    ["build-template", slug],
    ["Build Template", options.name],
  ];
}

const SKIP = new Set([
  "node_modules",
  ".git",
  "build",
  "dist",
  ".wrangler",
  "specs",
  "playwright-report",
  "test-results",
]);
const TEXT = /\.(ts|tsx|mts|mjs|js|json|jsonc|md|yml|yaml|html|css|sql|example|svg)$|^\.dev\.vars/;

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files(path, out);
    else if (TEXT.test(entry) && entry !== "SPEC.md" && entry !== "pnpm-lock.yaml") out.push(path);
  }
  return out;
}

export function rename(options: RenameOptions, root = ROOT): string[] {
  if (!options.name || !options.scope)
    throw new Error('Usage: pnpm rename --name "<Product>" --scope @<product> [--domain <domain>]');
  if (!/^@?[a-z0-9][a-z0-9-]*$/.test(options.scope)) throw new Error("--scope looks like @trades");
  if (options.domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(options.domain))
    throw new Error("--domain looks like tradespro.com");
  const pairs = replacements(options);
  const changed: string[] = [];
  for (const file of files(root)) {
    const before = readFileSync(file, "utf8");
    let after = before;
    for (const [from, to] of pairs) after = after.split(from).join(to);
    if (after !== before) {
      writeFileSync(file, after);
      changed.push(relative(root, file));
    }
  }
  return changed;
}

export function nextSteps(options: RenameOptions): string {
  const slug = slugOf(options.name);
  const { domain } = options;
  const staging = domain ? `staging.${domain}` : `${slug}-staging.<account>.workers.dev`;
  const app = domain ? `app.${domain}` : `${slug}.<account>.workers.dev`;
  const hosts = domain
    ? `   - Custom domains: ${staging} and ${app}: in each environment set
     "workers_dev": false and add "routes": [{ "pattern": "<host>", "custom_domain": true }].
   Resend: verify ${domain} and pick MAIL_FROM (e.g. "${options.name} <hello@${domain}>").`
    : `   - No domain yet: the Workers serve on workers.dev. Set APP_ORIGIN in each environment to your
     account's subdomain (replace your-subdomain), and run pnpm rename again with --domain once
     there is one.
   Resend: verify a domain you own and pick MAIL_FROM.`;
  return `
${options.name} is renamed. Now:

1. pnpm install   (package names changed, so the lockfile changes)
2. Create, then put their ids in apps/server/wrangler.jsonc (env.staging and env.production),
   in place of the <...-id> placeholders:
   Cloudflare
   - KV namespaces:   wrangler kv namespace create ${slug}-oauth-staging   (and -production)
   - Neon projects in AWS US West (Oregon), aws-us-west-2: ${slug}-staging and ${slug}-prod (and
     ${slug}-local, optional). In each create the roles (README, "Neon"):  app_migrator (owner, DDL)
     and  app_runtime (DML only).
   - Hyperdrive (caching off), one per environment, as app_runtime:
       wrangler hyperdrive create ${slug}-staging --connection-string "<staging app_runtime URL>" --caching-disabled
${hosts}
   Google (optional): an OAuth client with redirect URIs
     https://${staging}/auth/google/callback
     https://${app}/auth/google/callback
3. Worker secrets, per environment (wrangler secret put <NAME> --env staging|production):
   SESSION_PEPPER, DATABASE_URL (Neon app_runtime, pooled), RESEND_API_KEY, MAIL_FROM,
   GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (optional), TEST_MAIL_SECRET (staging only)
4. GitHub environment secrets ("staging" and "production"):
   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, DATABASE_MIGRATOR_URL (Neon app_migrator, direct),
   and for staging: STAGING_DEMO_PASSWORD, TEST_MAIL_SECRET. Then the repository variable
   DEPLOY_ENABLED=true, which turns on the deploy jobs.
5. Once: pnpm db:allow-demo --env staging   (with DATABASE_MIGRATOR_URL set to staging's)
6. Push to main. Staging deploys; pnpm promote puts it in production.
`;
}
