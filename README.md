# Build Template

A working single-app foundation on Cloudflare Workers and Neon Postgres. People can sign up
(email or Google), verify their email, sign in, edit their profile, delete their account, and
connect Claude or ChatGPT over MCP with OAuth. Every page has Ask AI (an Assistant that uses the
app's own actions), and automations are built by describing them in chat, then run durably on
Cloudflare Workflows, with Zapier as the bridge to everything else. Auth, data, tenancy,
deployment, MCP, AI and observability are done; a product adds features on top.

- **Why and how:** [`SPEC.md`](SPEC.md). **Rules for agents (and people):** [`AGENTS.md`](AGENTS.md).
- **Adding a feature:** [`docs/adding-a-module.md`](docs/adding-a-module.md).
- **UI:** [`packages/ui/GUIDE.md`](packages/ui/GUIDE.md).
- **The Assistant, automations and Zapier:** [`specs/ai.md`](specs/ai.md).

```
apps/server     the one Worker: static assets, /api, OAuth, /mcp, the agents, the Workflow
apps/web        the SPA (routes and wiring)
packages/       contracts · db · auth · api-client · ui · screens · tooling
e2e/            Playwright, locally and against staging
```

MIT licensed ([`LICENSE`](LICENSE)). Contributions to the template are welcome
([`CONTRIBUTING.md`](CONTRIBUTING.md)); to build your own app, see **Your own template, then an
app** below.

## Quickstart

Running it locally needs nothing but Node 24, pnpm 10, Docker and
[mkcert](https://github.com/FiloSottile/mkcert). Cloudflare, Neon and GitHub setup is only for
deploying.

```bash
git clone https://github.com/tyler16smith/build-template.git && cd build-template
```

```bash
brew install mkcert && mkcert -install
```

```bash
echo "127.0.0.1 app.local.private" | sudo tee -a /etc/hosts
```

```bash
pnpm install && pnpm dev
```

Open https://app.local.private and sign up, or load the demo data (below) and sign in as
`bea@threepigs.example`.

## Your own template, then an app

1. **Your own template, once:** fork this repository (or clone it and push it to a repository
   you own, keeping this one as the `upstream` remote). Pull template improvements in with
   `git fetch upstream && git merge upstream/main`.
2. **A new repository per app**, made from your template (GitHub's "Use this template", or clone
   and push to a new remote). Not a fork: a fork of a public repository is public. Run
   `pnpm rename` there (**Setup**) and build the product in that copy.

## Local development

Needs Node 24 and pnpm 10, plus Docker unless you use the Neon database for local development.

```bash
pnpm install
```

```bash
pnpm dev
```

`pnpm dev` starts Postgres in Docker (`build-template-postgres`, port 5434), applies the
migrations, and runs `wrangler dev` (port 8787) and Vite. Open https://app.local.private; Vite proxies the
Worker's paths, so it's one origin, as in production.
The first run copies `apps/server/.dev.vars.example` to `apps/server/.dev.vars`.

**HTTPS locally:** once per machine, install [mkcert](https://github.com/FiloSottile/mkcert) and
point the host name at your machine:

```bash
brew install mkcert && mkcert -install
```

```bash
echo "127.0.0.1 app.local.private" | sudo tee -a /etc/hosts
```

`pnpm dev` then makes a certificate for `app.local.private` in `.certs/` (git-ignored) and Vite
serves it on port 443. macOS lets a non-root process bind 443 only on all interfaces, so the dev
server is reachable from your network too. Other apps from this template use the same host name, so run one at a time:
they share the port and the `__Host-session` cookie.

**Environment variables:** [`.env.example`](.env.example) lists every one. Copy it to `.env` for
the tooling (`pnpm dev`, `pnpm db:*`, `pnpm logs`, `pnpm e2e`). The Worker's own secrets go in
`apps/server/.dev.vars`. With `LOCAL_DATABASE_MIGRATOR_URL` and `LOCAL_DATABASE_URL` set in `.env`
(the `build-template-local` Neon project), `pnpm dev` uses that database instead of Docker.

- **Demo data:** `pnpm db:seed --env local` loads Three Pigs Construction (sign in as
  `bea@threepigs.example`; Wolfgang, `wolf@huffandpuff.example`, is in all three demo
  companies), Big Bad Demolition Co. and Huff & Puff Testing. The password is `DEMO_PASSWORD`
  in `.dev.vars`.
- **Ask AI:** put `ANTHROPIC_API_KEY` in `apps/server/.dev.vars` (Workers AI isn't bound
  locally). Without it the Assistant and the Automation Builder say AI isn't set up.
- **Email:** nothing is sent locally. Every message shows at https://app.local.private/dev/mail
  (in the sidebar under Development), with a button that opens its link.
- **New migration:** edit `packages/db/src/schema.ts`, then `pnpm db:new <name>`, review the
  file, `pnpm db:migrate --env local`.

| Command                          | What it does                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                      | Every package's tests. Postgres is PGlite in process; no Docker                                                                    |
| `pnpm test:db`                   | The isolation and role tests on real Postgres logins (`TEST_DATABASE_URL`, `TEST_RUNTIME_URL`; `pnpm db:local` creates `app_test`) |
| `pnpm e2e`                       | Playwright against `pnpm dev` (`pnpm --filter @template/e2e exec playwright install chromium` once)                                |
| `pnpm typecheck` · `pnpm format` | TypeScript and Prettier                                                                                                            |
| `pnpm check:migrations`          | The migration rule on new migrations, and forced RLS on every tenant table                                                         |
| `pnpm check:boundaries`          | Package dependency rules                                                                                                           |
| `pnpm check:permissions`         | No organization id in an action's input, no role comparison outside `permissions.ts`                                               |
| `pnpm org:restore <id> --env …`  | Restore a deleted organization within its 30 days (operators)                                                                      |
| `pnpm build`                     | The deployable bundle in `build/` (web assets, Worker, migrations, commit)                                                         |
| `pnpm logs --env staging`        | The Worker's log lines (see Observability)                                                                                         |

To test against real roles locally:

```bash
TEST_DATABASE_URL=postgres://app_migrator:template-local@127.0.0.1:5434/app_test TEST_RUNTIME_URL=postgres://app_runtime:template-local@127.0.0.1:5434/app_test pnpm test:db
```

## Environments

| Environment  | Worker                   | Database                               | Deployed by                         |
| ------------ | ------------------------ | -------------------------------------- | ----------------------------------- |
| `local`      | `wrangler dev`           | Docker, or Neon `build-template-local` | `pnpm dev`                          |
| `staging`    | `build-template-staging` | Neon `build-template-staging` (demo)   | GitHub Actions, every push to main  |
| `production` | `build-template`         | Neon `build-template-prod`             | `pnpm promote` or the GitHub button |

Until there's a domain, both deployed Workers are on workers.dev
(`https://build-template-staging.<your-subdomain>.workers.dev` and
`https://build-template.<your-subdomain>.workers.dev`). Each deploys to the Cloudflare account in
its GitHub environment's `CLOUDFLARE_ACCOUNT_ID`, so staging and production can be separate
accounts.

**Pull requests** run the checks only. **Push to `main`** runs `.github/workflows/staging.yml`:
format, typecheck, tests, migration and boundary checks, the role tests on a Postgres container,
then, once deploys are turned on (**GitHub**, below), one build (uploaded as the run's
artifact), staging migration and demo seed, deploy (tagged with the commit), and smoke, e2e and
the speed budgets against staging. Only a run where everything passed can be promoted.

**Promote:** `pnpm promote` (or **Run workflow** on `promote` in GitHub's Actions tab) takes the
latest successful staging run's artifact, migrates production with its migrations, deploys it
with the same commit tag, and runs the read-only smoke checks. It never rebuilds.

**Rollback:** `pnpm rollback` (or the `rollback` workflow) runs `wrangler rollback` on
production. Migrations aren't rolled back: they're expand-only, so the previous Worker works
against the current schema.

## Setup (once per copy)

In the product's own repository (**Your own template, then an app**):

```bash
pnpm rename --name "Trades Pro" --scope @trades --domain tradespro.com
```

It rewrites the package scope, Worker names, datasets, domains and app name, and prints the
resources to create. `--domain` is optional: without it the product stays on workers.dev under
its new names, and you run `pnpm rename` again with `--domain` once there is one (a renamed copy
renames from its current name). In detail:

### Neon

1. Create three projects in **AWS US West (Oregon), `aws-us-west-2`** (it can't move later):
   `build-template-local` (optional: Docker works too), `build-template-staging` and
   `build-template-prod`. They're never reset from each other.
2. In each, in the SQL editor as the owner:

   ```sql
   CREATE ROLE app_migrator LOGIN PASSWORD '<random>';
   CREATE ROLE app_runtime LOGIN PASSWORD '<random>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
   GRANT app_migrator TO current_user;
   CREATE DATABASE app OWNER app_migrator;
   GRANT CONNECT ON DATABASE app TO app_runtime;
   ```

   Then, connected to `app`: `ALTER SCHEMA public OWNER TO app_migrator; REVOKE CREATE ON SCHEMA
public FROM PUBLIC;`. `app_migrator` runs migrations (CI only, the **direct** URL);
   `app_runtime` is all the Worker ever uses (the **pooled** URL).

3. Migrate each once and mark staging (and local) for demo data:

   ```bash
   DATABASE_MIGRATOR_URL='<staging direct app_migrator URL>' pnpm db:migrate --env staging
   ```

   ```bash
   DATABASE_MIGRATOR_URL='<staging direct app_migrator URL>' pnpm db:allow-demo --env staging
   ```

### Cloudflare

Put each id in `apps/server/wrangler.jsonc` under `env.staging` and `env.production`, in place
of the `<...-id>` placeholders:

- KV for OAuth: `wrangler kv namespace create build-template-oauth-staging` (and `-production`).
- Hyperdrive, caching off, as `app_runtime`:
  `wrangler hyperdrive create build-template-staging --connection-string "<staging app_runtime URL>" --caching-disabled`.
- `account_id`: none in the file. Wrangler uses `CLOUDFLARE_ACCOUNT_ID` (GitHub, below).
- `APP_ORIGIN`: replace `your-subdomain` with your workers.dev subdomain.
- Domains: none yet, so `"workers_dev": true`. With a domain, set it to `false`, add
  `"routes": [{ "pattern": "staging.<domain>", "custom_domain": true }]` (`app.<domain>` for
  production) and change `APP_ORIGIN` to match.
- Rate limiting namespaces and the Analytics Engine datasets need no setup.
- Placement is pinned to `aws:us-west-2`, next to the database.

Worker secrets, per environment (`wrangler secret put <NAME> --env staging`, from `apps/server`):

| Secret                                     | Value                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| `SESSION_PEPPER`                           | `openssl rand -base64 32`, different per environment                          |
| `DATABASE_URL`                             | Neon `app_runtime` pooled URL (one-request batches over HTTP)                 |
| `RESEND_API_KEY`, `MAIL_FROM`              | Resend, with the domain verified. Until then only `.example` mail works       |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional (below)                                                              |
| `ANTHROPIC_API_KEY`                        | Claude for the Assistant (below); without it, Workers AI                      |
| `CONNECTION_ENCRYPTION_KEY`                | `openssl rand -base64 32`: seals Zapier hook URLs and webhook signing secrets |
| `TEST_MAIL_SECRET`                         | Staging only: lets e2e read mail sent to `.example` addresses                 |

### GitHub

Environments `staging` and `production`, each with secrets `CLOUDFLARE_API_TOKEN` (Workers
deploy), `CLOUDFLARE_ACCOUNT_ID`, `DATABASE_MIGRATOR_URL` (that project's direct `app_migrator`
URL); staging also `STAGING_DEMO_PASSWORD` and `TEST_MAIL_SECRET`. Variables: `STAGING_URL`
(staging) and `PRODUCTION_URL` (production), the apps' origins. Then the repository variable
`DEPLOY_ENABLED` = `true` turns on the build, deploy and verify jobs; until then a push to `main`
runs only the checks. Add a required reviewer to
`production` when more people join.

### Continue with Google (optional)

Off until both secrets are set; no code change or redeploy of new code is needed.

1. Google Cloud console → APIs & Services → Credentials → Create OAuth client ID → Web
   application.
2. Authorized redirect URIs: each environment's `APP_ORIGIN` + `/auth/google/callback` (today the
   workers.dev URLs). Google refuses `app.local.private` (it isn't a public domain), so test
   Google sign-in on staging.
3. `wrangler secret put GOOGLE_CLIENT_ID --env staging` and `GOOGLE_CLIENT_SECRET` (locally, in
   `.dev.vars`). The sign-in, sign-up and consent screens show **Continue with Google**; delete
   either secret and it disappears and `/auth/google/*` returns 404.

## AI

The Assistant (Ask AI, bottom right of every page, ⌘/Ctrl+J), the Automation Builder and the
`ai.generate` automation step use the models in `AI_MODELS` (a var; comma-separated ids from
`KNOWN_MODELS` in `packages/contracts/src/ai.ts`, default first). Unset, that's Claude Sonnet 5.5,
Opus 5.5 and Haiku 4.5.

1. AI Gateway: Cloudflare dashboard → AI → AI Gateway → Create, named `build-template-staging`
   and `build-template` (the `AI_GATEWAY_ID` var in `wrangler.jsonc`; `pnpm rename` renames them). Every call is logged there
   with the organization, surface and request id as metadata.
2. `wrangler secret put ANTHROPIC_API_KEY --env staging` (and production). Without it the
   Assistant uses Workers AI's Llama 4 Scout through the `AI` binding.
3. Each organization gets $20 a month and 500 requests a day by default. An owner changes the
   default model, budget and cap on the Profile page (AI). Spend is in `ai_usage`.

The agents are Durable Objects in this Worker (`AssistantAgent`, `AutomationAgent`) and
automation runs are a Workflow (`AutomationRunWorkflow`); `wrangler deploy` creates both. The
five-minute cron starts due schedules and retries Zapier events.

### Zapier

Automations → Zapier (owners and admins):

- **Inbound** (an event in another app starts an automation): create a connection, copy its URL
  and its secret (shown once). In the Zap, use **Webhooks by Zapier → POST** to that URL,
  Payload Type json, header `x-webhook-secret: <secret>`, and a body with `eventType` (and
  `provider`, `externalId`, `data`). The Automation Builder's `zapier_setup` writes the exact
  Zap for an automation.
- **Outbound** (an automation sends data to another app): in Zapier, **Webhooks by Zapier →
  Catch Hook**, then add its URL here as an outbound hook and use it in a **Send to Zapier**
  step.

## MCP

The MCP URL is `<origin>/mcp` (shown on the home and profile pages). Claude: Settings →
Connectors → Add custom connector. ChatGPT: Settings → Apps & Connectors → Create, with OAuth.
Each opens the consent screen, which signs the person in first if needed.

Manual check with the MCP Inspector (locally, with `pnpm dev` running):

```bash
npx @modelcontextprotocol/inspector
```

Choose "Streamable HTTP", URL `https://app.local.private/mcp`, then **Connect**: it registers,
sends you to the consent screen, and lists `profile_get` and `profile_update`. Disconnect it
from the profile page and the next call is refused. `apps/server/test/mcp.test.ts` runs the same
flow in CI.

## Observability

- Every response has an `x-request-id`; error bodies carry it as `requestId` and the app shows
  it for unexpected errors. Every log line has it, plus the version tag (the commit).
- `pnpm logs --env staging --request <id>` (or `--fingerprint <f>`, `--level error`,
  `--since 6h`) reads Workers Logs. Needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`
  with Workers Observability read.
- `GET /api/health` returns `{ ok, version, commit }` after a `SELECT 1` as `app_runtime`.
- Analytics Engine gets one point per request, action, MCP call, slow statement (≥ 200 ms),
  cron run, agent turn (`agent`: `assistant` or `automation_builder`) and live automation step
  (`automation`: `<automation>:<step>`), in the order `METRIC_SCHEMA` fixes
  (`packages/contracts/src/metrics.ts`). A failed automation run logs once at `error` with a
  fingerprint, so it groups like any other error.
- Invocation logs are off: they'd record cookies, bearer tokens and OAuth codes.
