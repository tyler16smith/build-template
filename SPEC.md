# Build Template: a single-app foundation on Workers and Neon

Status: the code for all four rollout phases is built and runs locally. Deploying it needs the
Neon project, the Cloudflare resources and the GitHub secrets (README, "Setup"); the
measurements and exit checks that need staging are listed in **Implementation notes**.

## Why

Most products need the same foundation before their first feature: sign-up and sign-in, an
organization with members and roles, a database where one company never sees another's rows,
deploys, logs, and now an MCP server and an AI assistant. Building that well takes weeks, and
it's the part that's hardest to fix later.

`build-template` is that foundation as **one app, one database and one deployment** per
environment, on Cloudflare Workers and Neon Postgres. It is a working app, not an empty
scaffold. A person can sign up (with email or Google), sign in, edit their profile, invite their
team, ask the Assistant, build automations, and connect Claude or ChatGPT to it over MCP with
OAuth. To start a product, copy it into a new repository, run one rename script and build
features there (README, "Setup"). The template itself stays generic and has no product name.

Many of the patterns here were first built and proven in Custombase, a multi-tenant app platform
by the same author. Where this spec or the code says "ported from Custombase", that's where an
idea came from; nothing here depends on it.

## Goals

1. **Working end to end on day one:** sign up, verify email, sign in (password or Google), reset
   password, edit profile, delete account, connect an MCP client through OAuth, and revoke that
   connection.
2. **Fast and cheap:** one Worker, one origin and one database per environment. No
   service-to-service hops and no cross-origin handoffs. Every request makes as few database
   round trips as possible.
3. **Ready to scale without a rewrite:** tenant (organization) isolation, enforced by both the
   data layer and Postgres row-level security, exists from the first migration, even though the
   UI shows only one person.
4. **Shared UI:** screens live in packages, so a desktop app later is a thin shell around code
   that already exists.
5. **One definition per capability:** an action is written once and served as an HTTP endpoint,
   an MCP tool and a typed client call.
6. **Push to ship:** a push to `main` tests, migrates and deploys staging. One command (or a
   button in GitHub) promotes the last good staging build to production.

## Non-goals (for now)

- Customization by end users, per-tenant code, a builder or an app catalog.
- Uptime alerts, automatic rollback, an error dashboard and an SRE agent. v1 builds the hooks they
  need (see **Observability**); they get their own spec.
- Billing, teams UI, invitations, roles UI and file uploads. The spec reserves room for each one
  (see **Room to grow**) but builds none of them. (Invitations, members and roles have since been
  built: `specs/organizations.md`.)
- Desktop, iOS and Android apps. Each is a folder with a one-paragraph `AGENTS.md` and nothing
  else.
- Preview environments per pull request. Work happens on `main`.

## Decisions

| Area             | Decision                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository       | `build-template`. pnpm workspaces, TypeScript, Prettier, Vitest, Playwright                                                                                             |
| Hosting          | **One Cloudflare Worker** (`apps/server`) serves the web app's static assets, `/api`, the OAuth endpoints and `/mcp`, all on one origin                                 |
| Databases        | **Three, one per environment:** local Postgres (Docker) for development, and a Neon project with two branches, `staging` and `production`. PGlite in unit tests         |
| Tenant isolation | **Both:** a central data-access layer scopes every query to the organization, and Postgres RLS is the backstop on every tenant table, for reads and writes              |
| Connectivity     | Through the ported `SqlDatabase` interface: Neon's HTTP driver for batches (tenant context + queries in one request), Hyperdrive + `pg` for interactive transactions    |
| Queries          | Drizzle ORM for typed queries. No raw string SQL outside the `db` package                                                                                               |
| Migrations       | Drizzle schema → `drizzle-kit generate` → reviewed, numbered, append-only `.sql` files, committed. Applied by a small runner over the direct (unpooled) Neon URL        |
| Web auth         | First-party sessions: opaque token in a `__Host-` cookie, hashed in Postgres. Ported from Custombase's `auth.ts`. Email and password, plus Google when it's configured  |
| MCP and app auth | OAuth 2.1 with `@cloudflare/workers-oauth-provider` (PKCE, dynamic client registration, client ID metadata documents). Future native clients use the same server        |
| MCP transport    | `@modelcontextprotocol/sdk` streamable HTTP at `/mcp`, in the same Worker                                                                                               |
| API framework    | Hono                                                                                                                                                                    |
| Web              | React 19, Vite, Tailwind 4, TanStack Router. Single-page app served as Worker static assets                                                                             |
| UI               | `packages/ui` (design system, ported from `@custombase/ui`) and `packages/screens` (feature screens that don't depend on a platform)                                    |
| Contracts        | `packages/contracts`: Zod schemas and the action registry, shared by server, web, MCP and future clients                                                                |
| Email            | Resend, behind a `Mailer` interface. In development, emails are written to the console and shown at `/dev/mail`                                                         |
| Rate limiting    | Workers Rate Limiting bindings on sign-in, sign-up, password reset, Google callback and OAuth registration                                                              |
| Telemetry        | Workers Logs (structured, redacted, invocation logs off), plus Analytics Engine for request, action and slow-query metrics. No paid log provider. See **Observability** |
| Delivery         | GitHub Actions. Push to `main` → test, migrate and deploy **staging**. `pnpm promote` or a GitHub button → the last successful staging build goes to **production**     |

### Why one Worker

Custombase separates control-api, MCP, gateway and app Workers because they have different
trust boundaries and per-business origins. A single app doesn't need that. Using one Worker:

- removes the service-binding hop and the cross-origin sign-in handoff (`issueHandoff` /
  `redeemHandoff`);
- lets the OAuth consent page reuse the web session cookie directly, so someone who is already
  signed in approves with one click;
- means one deploy, one log stream and one set of bindings.

We can split it later, for example moving MCP into its own Worker if its load profile
diverges. The code is structured by module (below), so a split means moving folders, not
rewriting them.

### Why Drizzle

All the code in an app built from this template is written by its own team (or its agents), so a
typed query builder is the right tool. Drizzle compiles to plain parameterized SQL with no runtime
engine, so it costs nothing on the hot path. It has drivers for both Neon HTTP (including
`batch`) and `node-postgres`.

## Repository layout

```
build-template/
  apps/
    server/          Cloudflare Worker: static assets, /api, OAuth, /mcp
    web/             Vite SPA: routes, the API client wiring and nothing else
    desktop/         AGENTS.md only
    ios/             AGENTS.md only
    android/         AGENTS.md only
  packages/
    contracts/       Zod schemas, error codes, action registry types, OAuth scopes
    db/              Drizzle schema, migrations, migration runner, data-access layer, test Postgres
    auth/            Password hashing, session tokens, email tokens, Google OIDC. No Hono
    api-client/      Typed client for actions and auth endpoints (fetch-based, no DOM)
    ui/              Design system: tokens, components, ThemeProvider, GUIDE.md
    screens/         Feature screens (SignIn, SignUp, Profile, ConnectedApps, Consent)
    tooling/         CLI: dev, db:local, db:migrate, check:migrations, promote, rename, logs
  e2e/               Playwright tests (run locally and against staging)
  .github/workflows/ staging.yml, promote.yml
  specs/             This spec and future ones
  AGENTS.md          Rules for agents (and people)
```

Dependency direction (enforced by `check:boundaries` in `tooling`): `apps/*` → `screens` → `ui`,
`api-client` → `contracts`. `server` → `db`, `auth`, `contracts`. **`screens` and `ui` never
import from `apps/*`, never call `fetch` directly and never read `window.location`.** They get an
API client and a navigation function through a React context. That rule is what makes a desktop
shell cheap later.

## Data model

Every table except the identity tables (`users`, `auth_identities`, `sessions`, `email_tokens`)
belongs to an organization. Most products serve companies with several people in them, so
tenancy is designed in from the first migration. Adding tenancy to a live schema
later is the expensive mistake this avoids.

```
users                 id (uuid v7), email (citext, unique), email_verified_at,
                      password_hash (nullable: Google-only accounts have none),
                      name, title (job title, optional), avatar_url, created_at, updated_at,
                      deleted_at
auth_identities       provider ('google'), provider_user_id, user_id, email, created_at
                      PK (provider, provider_user_id)
organizations         id, name, created_at
memberships           organization_id, user_id, role ('owner' | 'admin' | 'member'), created_at
                      PK (organization_id, user_id)
sessions              token_hash (PK), user_id, organization_id, created_at, expires_at,
                      last_seen_at, user_agent
email_tokens          token_hash (PK), user_id, purpose ('verify' | 'reset' | 'change_email'),
                      new_email, expires_at, used_at
```

- Sign-up creates the person only; `/onboarding` then creates their organization and `owner`
  membership, or an invitation brings them into one (`specs/organizations.md`).
- **Tenant tables:** `organization_id` comes first in the primary key, the foreign keys and the
  indexes, as Custombase's `business_id` rule requires. The template has no tenant tables yet
  besides `memberships`. The first product feature (customers, jobs) adds them, and
  `check:migrations` enforces the rule (ported from `pnpm cb check:migrations`). A migration
  that creates a tenant table without enabling RLS and its policy fails the check.
- IDs are UUID v7: they sort by time, so indexes stay compact, and they're safe to expose.

## Tenant isolation

Two layers, so that a forgotten filter in new code (a report, a background job, an integration,
code an agent wrote) doesn't become a cross-customer leak.

**1. The data-access layer (primary).** Handlers never get a raw database. They get `ctx.db`,
which the request pipeline builds only after it has authenticated the person and checked their
membership in the organization. Every query goes through it, and it adds the organization filter
itself, so queries stay explicit about tenant scope and use the tenant indexes. The filter is
the right organization because the pipeline chose it from the verified session or token, never
from input.

**2. Row-level security (backstop).** Every tenant table runs `SELECT enable_tenant_rls('<table>')`
(ported from Custombase's `cb_enable_tenant_rls`), which turns on RLS, forces it for the table
owner too, and adds one policy:

```sql
USING (organization_id = current_setting('app.organization_id')::uuid)
WITH CHECK (organization_id = current_setting('app.organization_id')::uuid)
```

- **Keep the policy narrow:** it checks the organization boundary and nothing else. No
  membership lookups or function calls inside policies, so Postgres evaluates it as a plain
  indexed condition on the row. Feature permissions (roles) stay in application code.
- **Restricted role:** the Worker connects as `app_runtime`, which has DML only, isn't the table
  owner, isn't a superuser and doesn't have `BYPASSRLS`. Migrations run as `app_migrator`. A
  test proves `app_runtime` can't `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `SET ROLE` or bypass
  RLS.
- **Tenant context is set in the same round trip as the queries, never in its own request.**
  `app.organization_id` is set with `set_config(…, true)`, so it's local to the transaction and
  can't leak through a connection pool.
  - **Batches (the default path):** `ctx.db.batch(…)` sends `set_config` and every statement
    known in advance to Neon's HTTP endpoint as one transaction in **one request**. A page that
    needs five reads issues one batch, not five transactions.
  - **Interactive transactions** (read, decide, then write): `ctx.db.transaction(…)` uses
    Hyperdrive + `pg`, and sends `BEGIN` + `set_config` in one round trip, as Custombase's
    driver already does (`packages/platform-sdk/src/worker/postgres/driver.ts`).
- **Identity tables** aren't tenant tables. Only the auth code in `packages/auth` touches them,
  through its own narrow functions.

**Proof (tests in CI):**

- **Isolation test:** seed two organizations and run every action as organization A. Nothing
  from B may be returned or changed. Run it again with the data layer's filter switched off:
  RLS alone must still block every case.
- **Policy test:** any tenant table without a forced RLS policy fails `check:migrations`.

**Measured, not assumed:** phase 1 runs the same tenant-filtered workload with RLS on and off,
with identical batching and connections, and records the difference here. If a policy shows a
real cost, we fix the policy or the index. Removing RLS needs an explicit decision recorded in
this spec.

## Request path and speed budget

The ~40 ms round trip to Neon measured in Custombase dominates everything else, so the design
counts network round trips rather than blaming individual features for latency.

- **Region:** the Neon project is in **AWS US West (Oregon), `aws-us-west-2`**, the closest
  Neon region to the first customers in Utah. (Neon has no San Jose region: its only AWS West
  region is Oregon. A Neon project's region can't change after creation, so we choose it once,
  at setup.)
- **Placement:** the Worker's `placement.region` is pinned to `aws:us-west-2`, next to the
  database. Phase 1 also compares Neon HTTP with Hyperdrive from the placed Worker, and finds out
  why Custombase's placed Worker still paid ~40 ms per trip.
- **Session check costs at most one query, and is usually free:** a validated session is cached
  per isolate for 60 seconds (keyed by token hash). Sign-out and password change delete the row,
  and the cached entry expires within a minute. Sliding renewal (`renewSession`, ported) only
  writes once half the idle window has passed.
- **One round trip per read endpoint:** `GET /api/session` reads user, membership and
  organization in one statement. Pages load their data in one batch.
- **Static assets** come from Workers Static Assets with `run_worker_first` limited to `/api/*`,
  `/auth/*`, `/mcp`, `/authorize`, `/token`, `/register` and `/.well-known/*`. All other paths
  serve the SPA without running the Worker.
- **Initial data:** `GET /api/session` returns the user, organization and enabled sign-in
  methods in one call. The web app makes no waterfall of fetches.

Budgets, checked by the smoke step against staging on every deploy (each phase can tighten
them):

| Measure                                 | Budget                            |
| --------------------------------------- | --------------------------------- |
| `GET /api/session`, warm, p50           | ≤ 60 ms from a US client          |
| `profile.update`, p50                   | ≤ 90 ms                           |
| MCP `tools/call` for `profile_get`, p50 | ≤ 80 ms                           |
| Web first load (JS, gzipped)            | ≤ 150 KB; routes beyond auth lazy |

## Authentication

Ported from `apps/control-api/src/auth.ts` and `lib/crypto.ts`, without the multi-origin and
beta-access parts.

- **Sign up:** name, email, password (at least 10 characters, checked against a short list of
  common passwords). Sends a verification email and signs the person in straight away. Unverified
  accounts can use the app, and an `Alert` asks them to verify. Whether MCP access requires a
  verified email is a config flag, on by default.
- **Sign in:** email and password. Failed attempts and unknown emails take the same time (the
  dummy-hash check already in `login`). Rate limited per IP and per email.
- **Passwords:** PBKDF2-SHA256 through WebCrypto, with the iteration count stored in the hash
  (`pbkdf2$<iterations>$<salt>$<hash>`) so it can be raised later. We use the highest count
  Workers allows at an acceptable CPU cost (measured in phase 1).
- **Sessions:** a random 32-byte token in the `__Host-session` cookie, set with `Secure`,
  `HttpOnly`, `SameSite=Lax` and `Path=/`. Only `HMAC(token, SESSION_PEPPER)` is stored. The
  session lasts 30 days idle with a 90-day cap, the same as Custombase.
- **CSRF:** every non-GET `/api` request must carry an `Origin` that matches the app's origin,
  on top of `SameSite=Lax`.
- **Email flows:** verify, reset password and change email. Each uses a single-use hashed token
  (`email_tokens`), valid for 1 hour (24 hours for verify). A reset revokes all of that user's
  sessions and OAuth grants.
- **Sign out:** deletes this session. "Sign out everywhere" on the profile page deletes all of
  them.

### Continue with Google

Built and tested in v1, and **off until it's configured.** When `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` are both set for an environment, `GET /api/session` lists `google` among
the enabled sign-in methods, and the sign-in, sign-up and OAuth consent screens show a
**Continue with Google** button. Without them the button isn't rendered, and `/auth/google/*`
returns 404. Turning it on means setting two secrets, with no code change and no redeploy of
new code.

- **Flow:** `/auth/google/start` creates `state`, a PKCE verifier and a `nonce`, keeps them in a
  short-lived signed `__Host-google` cookie, and redirects to Google with the `openid email
profile` scopes. `/auth/google/callback` checks `state`, exchanges the code, and verifies the
  ID token (signature against Google's cached JWKS, `iss`, `aud`, `exp` and `nonce`).
- **Matching an account:**
  - A known `(google, sub)` in `auth_identities` signs that user in.
  - Otherwise, if Google says the email is verified and a user with that email exists, the
    identity is linked to that user and they're signed in. Their email counts as verified.
  - Otherwise a new user, organization and membership are created, with name and avatar from
    Google and the email already verified.
  - An unverified Google email is refused, with a message to use email and password instead.
- **Return path:** the start URL takes a same-origin `returnTo` (validated as Custombase's
  handoff validates `returnPath`), so Google sign-in in the middle of the MCP consent flow lands
  back on the consent screen.
- **Profile:** shows "Signed in with Google" when linked. A Google-only account can **set a
  password** (it has none to confirm), and can unlink Google only once a password exists.
- **Setup docs:** the README covers creating the Google OAuth client and the redirect URIs for
  each environment (staging and production; Google refuses the local `app.local.private`).
- **Later, not in v1:** Apple sign-in and passkeys. Each is a new `provider` value in
  `auth_identities` and a new pair of routes. Sessions don't change.

## MCP and OAuth

This is the centerpiece. It is ported from `apps/mcp` (`index.ts`, `connect.ts`,
`resources.ts`) and simplified, because there is one resource instead of one per business.

**Endpoints (same origin):**

| Path                                      | Purpose                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `/.well-known/oauth-authorization-server` | Authorization server metadata                                             |
| `/.well-known/oauth-protected-resource`   | Resource metadata for `/mcp` (the `WWW-Authenticate` header points to it) |
| `/register`                               | Dynamic client registration (rate limited)                                |
| `/authorize`                              | Starts the flow and redirects to the consent screen                       |
| `/oauth/consent`                          | SPA route that renders `ConsentScreen` from `packages/screens`            |
| `/token`                                  | Code and refresh-token exchange                                           |
| `/mcp`                                    | Streamable HTTP MCP server (bearer token required)                        |

**Flow:**

1. The client (Claude, ChatGPT, Cursor or the MCP Inspector) calls `/mcp`, gets a 401 with
   resource metadata, discovers the authorization server and registers (or identifies itself
   with a client ID metadata document; `clientIdMetadataDocumentEnabled` and the
   `global_fetch_strictly_public` flag, as in Custombase).
2. `/authorize` parses the request and stores it in KV under a 10-minute consent handle (as
   `rememberConsent` does today). It redirects to `/oauth/consent?handle=…`.
3. If the person isn't signed in, the consent route shows sign in (password or Google) or sign up
   first, then returns. The handle survives the detour.
4. The consent screen shows the client's name, its icon if it provides one, the redirect host
   (so a look-alike client is visible) and the requested scopes as checkboxes, with read always
   on. The person picks **Allow** or **Cancel**. Allow is the form's primary submit button,
   so ⌘/Ctrl+Enter works through the submit shortcut ported with `packages/ui`.
5. The server completes the authorization with `props = { userId, organizationId, scopes }`
   and redirects back to the client.
6. On every `/mcp` call, the token's grant is checked as live (`grantIsLive`, ported, so
   revocation is immediate despite KV list lag), and the membership is checked again. MCP tool
   calls go through the same `ctx.db`, so RLS applies to them exactly as to the web app.

**Scopes:** `profile:read`, `profile:write`. Each future module adds its own pair
(`jobs:read`, `jobs:write`). Tokens: 1-hour access, 30-day refresh, refresh rotates.

**Tools in v1:** `profile_get` and `profile_update` (name and job title; email changes need the
verification flow in the browser). Tool annotations mark `profile_get` as `readOnlyHint`.

**Connected apps:** a section of the profile page lists live grants (client name, scopes, when
it connected, last used) with a **Disconnect** button that revokes the grant and its tokens.
An empty state explains how to connect. It shows the MCP URL with a copy button, plus short
steps for Claude and ChatGPT.

**Testing:** an integration test runs the full flow (register → authorize → consent →
token → `tools/list` → `tools/call` → revoke → 401) against the Worker in
`@cloudflare/vitest-pool-workers`. The README documents a manual check with the MCP Inspector.

## Actions: one definition, three surfaces

Custombase's published actions idea, in miniature. An action is declared once in
`apps/server/src/modules/<module>/actions.ts`:

```ts
export const updateProfile = defineAction({
  id: "profile.update",
  description: "Change the signed-in person's name or job title.",
  input: ProfileUpdateInput, // from @template/contracts
  output: Profile,
  scope: "profile:write",
  handler: async (ctx, input) => {
    /* ctx.user, ctx.organization, ctx.membership, ctx.db */
  },
});
```

The registry turns each action into:

- `POST /api/actions/profile.update` for the web app and future clients (session cookie or
  bearer token),
- an MCP tool `profile_update` with JSON Schema generated from the Zod input,
- a typed method `client.profile.update(input)` in `packages/api-client`, with types inferred
  from contracts and no code generation.

The registry also writes `contracts/actions.schema.json` (every action's input and output as
JSON Schema) at build time, so a future Swift or Kotlin client can generate its types from it.

Errors use one shape (`{ code, message }`, with codes from contracts, as Custombase's
`ActionError`). Messages are written for the person, because they are shown as-is in the UI
and MCP tool results.

Auth endpoints (sign in, sign up, reset, Google) are plain routes rather than actions, because
they set cookies and aren't exposed to MCP.

### The Assistant and automations

`specs/ai.md` adds the Ask AI Assistant, chat-first automations and Zapier on top of this
registry. What they rely on here:

- **Contracts say how agents may use an action.** Beside `readOnly`, an action contract can set
  `confirm: true` (an agent always asks the person before running it, and MCP marks it
  `destructiveHint`), `permission` (who may run it, through `rolePermissions`; the Assistant and
  the automation catalog offer it to those roles only, and `runAction` refuses everyone else) and
  `events: { id, title, when? }[]`:
  named events a successful call emits, which start automations. `profile.update` asks first
  and declares `profile.updated`.
- **`Caller` includes `"assistant"` and `"automation"`** beside `web`, `mcp` and `api`.
- **One function builds `ActionContext`** from a verified person, organization and role. The
  request pipeline, an Assistant turn (a Durable Object, no request) and an automation step (a
  Workflow, no request) all call it through `runAction`, so tenant scope is decided in one place
  and validation, permissions, row-level security, logs and metrics are the same everywhere.

## The profile page (the CRUD example)

It shows the patterns every feature will copy:

- **Create:** sign-up (password or Google) creates the user, organization and membership in one
  transaction.
- **Read:** `/profile` loads from `GET /api/session` with no extra fetch.
- **Update:** name and job title (inline save), and email (needs the current password, and sends a
  verification link to the new address; the old address gets a notice).
- **Delete:** "Delete account" in a destructive confirmation dialog. It soft-deletes
  immediately (`deleted_at`, all sessions and grants revoked). A scheduled Worker cron
  hard-deletes the account after 30 days.
- **Also on the page:** change or set password, Google link status, sign out everywhere, and
  connected apps (above).
- **UI rules from Custombase:** `Field` with `hint` (never gray helper text), `Alert` for the
  unverified-email notice, `Button loading`, one primary button per form, and ⌘/Ctrl+Enter to
  submit.

Other web routes in v1: `/sign-in`, `/sign-up`, `/forgot-password`, `/reset-password`,
`/verify-email`, `/oauth/consent`, `/` (a placeholder home with the app shell: sidebar, account
menu and dark mode). Plus `/dev/mail` in local development only, opened from the account menu.

## Shared UI and future clients

- **`packages/ui`** is a copy of `@custombase/ui` at the time of the copy (tokens, components,
  `ThemeProvider`, the submit shortcut, `GUIDE.md`), with Custombase-specific pieces removed
  (per-business accent theming becomes a single brand accent). After that the packages evolve
  separately. We don't build a shared package across repositories.
  - **The chat primitives come with it:** `chat.tsx` (`ChatThread`, `ChatMessage`, `ChatSteps`,
    `ShimmerText`, `ChatWelcome`, `ChatComposer`, `ModelPicker`, `ChatApproval`, `ChatError`),
    with the `side-panel.tsx`, `markdown.tsx` and `copy-button.tsx` it uses. They're part of the
    design system (Custombase's `specs/chat-experience.md`), not Custombase-specific, and the
    Assistant and the Automation Builder are built from them.
  - **The app shell has an Ask AI slot:** a bottom-right slot and a right-hand side-panel region
    (`SidePanel`, push on desktop, overlay on narrow screens). Both render nothing in v1.
- **`packages/screens`** holds every screen as a component that receives its data and actions
  through `useApi()` and its navigation through `useNav()`. `apps/web` provides both through
  TanStack Router and the fetch client. A desktop shell would provide its own versions and reuse
  every screen.
- **Native mobile, if it happens, means Swift and Kotlin.** They won't reuse React screens.
  They'll reuse the server, the OAuth flow (PKCE with a custom-scheme redirect, with no private
  API) and the generated `actions.schema.json`.
- **Shells:** `apps/desktop`, `apps/ios` and `apps/android` each contain only an `AGENTS.md`
  that says, in substance: _"This is where the <desktop / iOS / Android> app will be built if we
  decide to build one. Nothing is here yet. Don't add projects, dependencies or CI jobs until it
  is scheduled."_ They aren't workspace members.

## Local development

- `pnpm dev`: starts local Postgres (Docker, as `pnpm cb db:local` does), migrates it, and runs
  `wrangler dev` for the server and Vite for the web app. Vite proxies `/api`, `/auth`, `/mcp`
  and OAuth paths to the Worker, so there's one origin from the browser's point of view.
  Locally, the Worker connects to Postgres directly (no Hyperdrive, no Neon HTTP), through the
  same `SqlDatabase` interface.
- `pnpm db:migrate --env local|staging|production` and `pnpm db:new <name>` (generates the next
  numbered migration from the Drizzle schema).
- `pnpm db:seed` loads the demo data (see **Demo data**) into the local database.
- `pnpm test` runs unit and integration tests on PGlite (ported `test-postgres.ts`), with no
  Docker needed. The isolation and role tests run on the local Docker Postgres in CI, because
  they need real roles.
- `pnpm e2e` runs Playwright against `pnpm dev`. In CI the same suite runs against staging.

## Environments, deployment and CI

**Three environments, three databases:**

| Environment  | Worker                   | Database                          | Who deploys                             |
| ------------ | ------------------------ | --------------------------------- | --------------------------------------- |
| `local`      | `wrangler dev`           | Docker Postgres on the laptop     | You, with `pnpm dev`                    |
| `staging`    | `build-template-staging` | Neon branch `staging` (demo data) | GitHub Actions, on every push to `main` |
| `production` | `build-template`         | Neon branch `production`          | `pnpm promote` or the GitHub button     |

Both Neon branches live in the one Neon project in `aws-us-west-2`. They're created empty and
never reset from each other. Staging gets the demo data. Production never does. Each deployed environment
has its own Hyperdrive config (caching off), `OAUTH_KV` namespace, Rate Limiting bindings,
Analytics Engine dataset and cron trigger (account cleanup). Each Neon branch has the two roles
`app_migrator` (DDL, direct URL, CI only) and `app_runtime` (DML only, no `BYPASSRLS`).

**Secrets** per environment, set with `wrangler secret` (Worker) and GitHub environment
secrets (CI): `SESSION_PEPPER`, `RESEND_API_KEY`, `MAIL_FROM`, the runtime and migrator Neon
URLs, and optionally `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. `.dev.vars.example` lists
them all.

**Push to `main` → staging (`.github/workflows/staging.yml`):**

1. `format:check` → `typecheck` → `test` → `check:migrations` → `check:boundaries` →
   `check:permissions`.
2. Isolation and role tests against a Postgres service container.
3. Build the web app and the Worker bundle once. Upload them, with the migrations folder and the
   commit SHA, as the run's artifact.
4. Migrate the staging database (`app_migrator`), then run `pnpm db:seed --env staging`.
5. Deploy that bundle to the staging Worker.
6. Smoke and e2e against staging: `/api/health` reports this run's commit, Playwright (sign up
   → verify via a test mail hook → profile update → delete), the OAuth + MCP flow, and the speed
   budgets.
7. Only if every step passed is the run marked successful. That makes it **promotable**.

Runs queue rather than cancel each other (`concurrency: staging`, `cancel-in-progress: false`),
so every push either reaches staging in order or fails visibly.

**Promote → production (`.github/workflows/promote.yml`):**

- Triggered by `workflow_dispatch`: the **Run workflow** button in GitHub's Actions tab, or
  `pnpm promote` locally (which runs `gh workflow run promote.yml` and follows the run in the
  terminal).
- It finds the **latest successful** `staging.yml` run on `main`, and downloads its artifact.
  It never rebuilds, so production gets exactly the bundle staging tested.
- It migrates the production database with that run's migrations, deploys the bundle to the
  production Worker, and runs the read-only smoke checks (no sign-ups in production).
- It uses the GitHub `production` environment, which holds the production secrets. A required
  approval can be turned on there later if more people join.
- **Rollback:** `pnpm rollback` (or the same button on a `rollback.yml` workflow) runs
  `wrangler rollback` on the production Worker. Migrations aren't rolled back. They must be
  backward compatible with the code that's already live (expand, then contract), so the
  previous Worker version always works against the current schema. `check:migrations` flags
  destructive statements (`DROP COLUMN`, `RENAME`, `SET NOT NULL` without a default) for review.

## Observability

The goal: we hear about a production failure before a customer reports it, and can find the
exact request, error and commit behind it, without paying for a log provider. v1 builds the
hooks that are expensive to add to a live app later: request IDs, one redacting logger, error
fingerprints, a version on every log line and metric, a health route and a fixed metrics schema.
Uptime alerts, a watched promotion with automatic rollback, longer history and an SRE agent come
next (see **Room to grow**), and they build on these hooks.

Most of this is ported from Custombase's reliability work (`docs/reliability.md`,
`apps/control-api/src/reliability`). It's simpler here because there's one app and we write all
of its code, so there's no per-business log isolation to enforce.

- **Request ID:** the pipeline assigns one to every request (UUID v7) before anything else runs.
  It's on `ctx`, in every log line and metric, in an `x-request-id` response header and in every
  error body (`{ code, message, requestId }`). A person, a support email or an MCP client can
  quote it, and we can find the request from it.
- **One structured logger:** `ctx.log.info | warn | error(event, fields)` writes one JSON line
  with the request ID, route or action ID, organization ID, user ID, version, duration and error
  code. It logs IDs, never emails or names. `apps/server` has no other `console.*` call, and
  `check:boundaries` enforces that.
- **Redaction:** the logger drops credential-named keys (`password`, `token`, `secret`,
  `authorization`, `cookie`, `code`, `state`, `verifier`). In free text it replaces bearer
  tokens, JWT-like and key-like strings, email addresses and URL query strings. It's ported from
  Custombase's `reliability/redact.ts`. Action inputs and outputs are never logged. A unit test
  logs a password, a session token, an OAuth code and an email, and checks that none of them
  appear in the output.
- **Workers Logs:** `observability.enabled` with `head_sampling_rate = 1` (one app at low
  volume; lower it when traffic warrants). **Invocation logs are off.** They record request
  metadata, and this Worker receives session cookies, bearer tokens and OAuth codes. Custombase
  hit the same problem (`docs/reliability.md`, Log evidence). Phase 1 checks this against current
  Cloudflare docs and on staging, and records here that no header value reaches Workers Logs.
- **Errors:**
  - The pipeline catches an unhandled error. It logs it once at `error`, with the stack and a
    **fingerprint**: a hash of the error name, the first stack frame in our code and the route or
    action ID, with no IDs or values in it. The person gets
    `{ code: "internal", message, requestId }`.
  - Expected outcomes (validation, not found, permission denied, rate limited) log at `info`
    and never count as failures, as in Custombase's availability rules.
  - The fingerprint is how errors get grouped, deduplicated and alerted on later.
- **Version on everything:**
  - The Worker has the version metadata binding, and CI deploys with the commit SHA as the
    version tag.
  - Every log line and metric carries that tag, so an error leads straight to a commit.
  - Promote and rollback keep the original tag, so production shows which staging build it is
    running.
- **Health route:** `GET /api/health`, with no auth and no tenant data. It runs `SELECT 1` as
  `app_runtime` and returns `{ ok, version, commit }`. The deploy smoke checks it, and the uptime
  probe will call it later.
- **Metrics (Analytics Engine):**
  - One data point per API request, action call, MCP tool call and cron run, plus one per slow
    statement.
  - The schema is fixed and written once in `packages/contracts` (`METRIC_SCHEMA`), ported from
    Custombase's `reliability/latency.ts`:
    - index: organization ID;
    - blobs: kind (`request` | `action` | `mcp` | `query` | `job`), route, action, query or job
      name, outcome (`ok` | `expected_error` | `failure`), error code, version tag, MCP client
      name, error fingerprint (empty unless the outcome is `failure`) and request ID;
    - doubles: duration in ms, HTTP status and database round trips.
  - A slow statement takes 200 ms or more. `SqlDatabase` records it with the query's name, never
    its SQL parameters.
  - Adding a field means appending a blob or double, never reordering them.
- **Browser errors:** `apps/web` reports `window.onerror`, `unhandledrejection` and its React
  error boundary to `POST /api/client-errors` (same origin, rate limited, size capped). The
  server logs them through the same redacting logger with `source: "browser"`. `screens` and `ui`
  don't call `fetch`, so the reporter lives in `apps/web`.
- **Auth events:** sign-in failures, rate-limit hits, password resets, email changes and OAuth
  grants and revocations log at `info` with the user ID when one is known (never the email), so
  abuse shows up.
- **Looking at it in v1:**
  - Cloudflare's Workers Observability view is the dashboard: you can query it by request ID,
    fingerprint or version.
  - `pnpm logs --env staging|production [--request <id>] [--fingerprint <f>] [--since 1h]`
    queries the Workers Logs telemetry API from a terminal. It is built for people now and for
    agents later. Its Cloudflare token is a local and CI secret, never a Worker secret.
- **Retention:** Workers Logs keeps 7 days on Workers Paid; Analytics Engine keeps about three
  months. Anything longer comes later (see **Room to grow**).

## Demo data: Three Pigs Construction

Local and staging come with an organization worth clicking through: a construction company run by
three pigs, with three projects (Straw MVP, Stick Upgrade and Brick Production) and a wolf they've
hired to stress test all of them.

**How it works:**

- `pnpm db:seed --env local|staging` loads it. It refuses `--env production`, and it also checks
  for a `demo_data_allowed` marker row, which only the local and staging databases have. Both
  checks have to pass, so a mistyped connection string can't seed production.
- It's idempotent. Every demo row has a fixed UUID and is upserted, so it runs on every staging
  deploy, restores anything a test or a click-through changed, and never touches other rows.
- Demo accounts share one password: `STAGING_DEMO_PASSWORD`, a GitHub secret for staging, and the
  `.dev.vars.example` value locally. It's never committed for staging, because staging is on the
  internet. Demo emails use the reserved `threepigs.example`, `bigbad.example` and `huffandpuff.example` domains, so no
  email ever reaches a real inbox.
- e2e tests sign up their own throwaway users (`e2e+<run>@threepigs.example`) and delete them at
  the end, so they never depend on, or damage, the demo accounts.

**The template seeds** (organizations, members, invites and automations):

**Organization: Three Pigs Construction** (all `@threepigs.example`)

| Name                | Email                      | Role   | Job title                                                           |
| ------------------- | -------------------------- | ------ | ------------------------------------------------------------------- |
| Bea Brickley        | `bea`                      | owner  | Founder. Lead on Brick Production. Measures twice, mortars once     |
| Hank Hayes          | `hank`                     | admin  | Lead on Straw MVP. Shipped it in an afternoon. It shows             |
| Stu Sticksworth     | `stu`                      | member | Lead on Stick Upgrade. "Twigs are just lightweight lumber"          |
| Mortimer Trowel     | `mort`                     | member | Masonry, Brick Production. Has opinions about grout                 |
| Clem Chimney        | `clem`                     | member | Chimneys and flues. Keeps a pot boiling at the bottom, just in case |
| Polly Planks        | `polly`                    | member | Carpentry, Stick Upgrade. Quietly adding nails                      |
| Sid Sparks          | `sid`                      | member | Electrical. Wired the straw house. Regrets it                       |
| Wolfgang Huffington | `wolf@huffandpuff.example` | member | Stress testing, all three projects. Huffs, puffs, files the report  |

Two invites are pending: `mama@threepigs.example` (admin, sent three times) and
`goldilocks@threebears.example` (expired).

**Organization: Big Bad Demolition Co.** (`@bigbad.example`): a second, small organization (Rex
Howler, owner, and Rita Redhood). It exists so the isolation story is visible on staging: sign in
as Bea, and nothing from Big Bad ever shows up, through the web app or through MCP.

**Organization: Huff & Puff Testing:** Wolfgang's own company, where he's the only owner. He's
also in the other two (a member at Three Pigs, an admin at Big Bad), so signing in as him shows
the company switcher, and deleting his account is refused by the last-owner rule.

**As modules arrive, the seed grows in the same voice.** Every new module adds demo rows for
both organizations in the same pull request that adds its tables, so staging always shows every
feature with data. Examples to set the tone:

- **Projects:** "Straw MVP (status: blown down, rebuilding)", "Stick Upgrade (in review)",
  "Brick Production (live, chimney pending)".
- **Jobs:** "Stress test the Straw MVP. Assigned: Wolfgang. Estimate: one huff"; "Replace the
  front door with something that isn't hay"; "Add a lid to the pot under the chimney. Declined,
  'it's a feature'".
- **Invoices:** "Emergency re-thatching, after hours, ×3".
- **Reviews:** "The house was lovely but I couldn't get in. 2 stars. — W. Huffington"

## Starting a product from the template

1. Copy `build-template` into a new repository (a copy, not a GitHub fork, so the histories stay
   separate).
2. `pnpm rename --name "<Product>" --scope @<product> [--domain <domain>]` rewrites the package
   scope, Worker names, cookie and KV names, page titles and the README. Without a domain the
   product stays on workers.dev; run it again with `--domain` later. It then prints the
   Cloudflare, Neon, Resend and (optionally) Google resources to create, and the GitHub secrets
   to set.
3. Push to `main`. Staging deploys.

Improvements to the base land in `build-template` first, and products copy them in by hand when
they want them. There's no automatic syncing between the repositories.

## Room to grow (designed for, not built)

| Later need             | Where it goes                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Teams and roles        | Built: invitations, members, roles and permissions, switching (`specs/organizations.md`)                                                                                                      |
| Feature modules        | `apps/server/src/modules/<name>` (schema, actions, MCP scopes) + `packages/screens/<name>`                                                                                                    |
| Files (photos on jobs) | One R2 bucket, keys prefixed by organization, signed upload URLs                                                                                                                              |
| Background work        | Queues (notifications, imports). Multi-step jobs are automations on Workflows (below). Jobs get the same `ctx.db` and RLS                                                                     |
| Billing                | Stripe on the organization. Webhooks into a Queue                                                                                                                                             |
| SMS                    | The `Mailer` pattern becomes `Messenger`, with Twilio for texts                                                                                                                               |
| Native apps            | Swift and Kotlin against the same actions and OAuth, types generated from `actions.schema.json`                                                                                               |
| Uptime and alerts      | A separate watcher Worker probes every minute; push and email when it's down or a new error or error-rate jump appears                                                                        |
| Watched promotion      | After promote, a 10-minute bake rolls back automatically on a regression (Custombase's bake rules)                                                                                            |
| Longer history         | Hourly and daily rollups in the watcher's D1; Logpush to R2 if raw logs are ever needed past 7 days                                                                                           |
| Error dashboard        | An operator page behind Cloudflare Access: uptime, incidents, error groups by fingerprint, deploys                                                                                            |
| SRE agent              | Reproduces the bug as a failing test, fixes it in a PR that CI and the staging e2e prove, auto-merges under a narrow policy (staging only) and reports. Production still goes through promote |

`specs/build-template-observability.md` (which moves to `specs/observability.md` in the new
repository) designs the last five rows. It builds on the hooks in **Observability** and doesn't
change them.

## Rollout

1. **Foundation:** repo, tooling, `contracts`, `db` (schema, runner, data-access layer with
   `batch` and `transaction`, RLS helper, PGlite tests), `ui` port, Worker that serves the SPA,
   local dev, both workflows. Neon project with `staging` and `production` branches and roles.
   Observability hooks: request ID, redacting logger, error fingerprints, version metadata,
   `/api/health`, `METRIC_SCHEMA` and its writer, Workers Logs config, `pnpm logs`.
   **Exit:** `pnpm dev` works. A push deploys the shell to staging, and `pnpm promote` puts it in
   production. Neon HTTP and Hyperdrive round trips and the RLS on/off comparison are measured and
   recorded in this spec. On staging, `pnpm logs --request <id>` finds a request's log lines, which
   carry the commit, and no header value appears in Workers Logs.
2. **Auth:** sign up, sign in, sessions, email flows, rate limits, `/api/session`, profile CRUD
   via the action registry, isolation and role tests, then Continue with Google behind its
   config check, auth events and the browser error reporter. **Exit:** e2e passes on staging.
   Google sign-in works on staging with real credentials and disappears when they're removed. The
   budgets hold. After an e2e run, staging's logs contain no password, session token, OAuth code
   or email address.
3. **OAuth and MCP:** authorization server, consent screen, `/mcp`, tools generated from
   actions, connected apps, revocation. **Exit:** Claude and ChatGPT both connect to staging
   and call `profile_get`. The full-flow integration test passes.
4. **Docs and copying:** `AGENTS.md` (root and the three shells), `GUIDE.md`, the README
   (setup, Google, promote, rollback), the `rename` script, and a "how to add a module" guide
   with a worked example. **Exit:** copying the template into a new repository, renaming it and
   deploying it to a new Cloudflare account and Neon project takes under an hour, following only
   the README.

## Implementation notes (v1)

What building v1 decided or found, beyond the sections above.

**Done and checked locally:** `pnpm dev` (Docker Postgres, migrations, `wrangler dev`, Vite);
sign up, verify, sign in, reset, change email and password, delete and the 30-day purge; the
profile through the action registry; OAuth + MCP end to end (`apps/server/test/mcp.test.ts`
runs the real Worker in `@cloudflare/vitest-pool-workers`, and `e2e/tests/mcp.spec.ts` uses the
real consent screen); isolation with the data layer's filter on and off, and the runtime role's
limits, on PGlite and on real Postgres logins (`pnpm test:db`); `check:migrations`,
`check:boundaries`; the build artifact validates against `wrangler deploy --dry-run --env
staging`. Round trips measured locally: `GET /api/session` 1, `profile.update` 1, sign-in 2,
sign-up 1 (user, organization, membership, verify token and session in one batch).

**Needs staging (phase 1 and 2 exits), not yet done:** Neon HTTP and Hyperdrive round trips from
the placed Worker; the RLS on/off comparison; the PBKDF2 CPU cost on a Worker (Workers caps
PBKDF2 at 100,000 iterations, which v1 uses); confirming no header value reaches Workers Logs;
Google sign-in with real credentials; Claude and ChatGPT connecting to staging; the speed budgets
(`E2E_BUDGETS=1` in `staging.yml` checks them on every deploy).

**Decisions made while building:**

- **`memberships` has a second, read-only policy,** `own_memberships`: a person can read their
  own memberships in every organization (`user_id = app.user_id`). Sign-in has to find which
  organization to open before one is set. It's a plain indexed condition (`memberships_user`),
  applies to `SELECT` only, and writes still need the organization. `check:migrations` accepts
  the `user_id` index because the migration names it (`-- cross-tenant index: …`).
- **`organizations` is the tenant root:** its policy compares `id`, not `organization_id`.
- **Batches through Drizzle:** `Database.batch` builds Drizzle queries against a recording
  driver, then sends them all through `SqlDatabase.statements` in one request (Drizzle's
  `pg-proxy` driver has no batch). `TenantDb` (`ctx.db`) wraps it with `select`, `first`,
  `count`, `insert`, `update` and `delete` helpers that add the organization filter, plus
  `q.drizzle` and `q.owned(table)` for joins.
- **`GET /api/session` reads everything in one statement** by setting the tenant context from the
  session row inside the same batch (`contextFromSession`).
- **The MCP membership check is cached per isolate for 60 seconds,** like sessions. Grant
  revocation stays immediate (`grantIsLive` reads the grant record on every call).
- **Worker tests reach PGlite through a service binding:** `TEST_SQL` runs the same
  `SqlDatabase` contract against PGlite in the test runner, entered as `app_runtime`, so the
  Worker under test is the real one and needs no Docker.
- **The compatibility date is 2026-08-20,** the newest the test runtime supports; raise it with
  `@cloudflare/vitest-pool-workers`.
- **The web app's first load is 142 KB of JavaScript, gzipped** (budget 150 KB, checked by
  `apps/web` `build`). Signed-in screens are a lazy chunk; `ui` keeps `Select`, tooltips and the
  loading and error states in their own modules so the sign-in page doesn't load the app shell.
- **Custombase's cross-app pieces were dropped from `ui`:** `?search-all=` hand-off between apps
  and origin checks on links (they read `window.location`, which `ui` never does).

## Open questions

None right now. Decisions made in review: RLS stays on reads and writes as the backstop to the
data-access layer; there's no product name yet (copy `build-template`); native mobile means Swift
and Kotlin, later; three databases with push-to-staging and promote-to-production; Google
sign-in is built and shown only when configured; Neon in `aws-us-west-2`; staging carries the
Three Pigs demo data.
