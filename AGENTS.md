# Build Template

One app, one database and one deployment per environment, on Cloudflare Workers and Neon
Postgres. `SPEC.md` says why and how; read it before changing anything structural. The README
covers setup, deploys and day-to-day commands.

## First: improving the template, or building an app?

**This repository is a template. Work out which job you're doing before you write any code.**

- **Improving the template:** a fix, a better default, or a generic capability every app would
  want. Work here and keep it generic: no product names, no product modules, tables or screens.
  Follow the rules below; the change goes upstream as a pull request.
- **Building an app:** anything with a product name, product features or a domain. Don't build
  it in this checkout. Stop and recommend the person sets up their own copies first:
  1. **Their own template, once.** Fork this repository (or clone it and push it to a repository
     they own, keeping this one as the `upstream` remote). It's the starting point for every app
     they build, and `git fetch upstream && git merge upstream/main` brings in template
     improvements.
  2. **A new repository per app,** made from their template (GitHub's "Use this template", or
     clone and push to a new remote), not a fork of it: a fork of a public repository is public.
     Run `pnpm rename` there (README, "Setup") and build the product in that copy.

**How to tell:** it's still the template while `pnpm rename` hasn't run: the root `package.json`
is named `build-template` and the packages are `@template/*`. If so and the request is for a
product feature, say so and ask before writing code. Once renamed, it's an app: build freely, and
don't send product code back to the template.

This file holds the rules that apply everywhere. Before working in one of these folders, read its
own guide too:

| Working on                             | Read                                                 |
| -------------------------------------- | ---------------------------------------------------- |
| Handlers, routes, agents, the Workflow | `apps/server/AGENTS.md` (core and shell, surfaces)   |
| Schemas, action contracts, permissions | `packages/contracts/AGENTS.md`                       |
| Tables, queries, migrations            | `packages/db/AGENTS.md`                              |
| Screens and client state               | `packages/screens/AGENTS.md`, `packages/ui/GUIDE.md` |
| A new module, end to end               | `docs/adding-a-module.md`                            |

## How code is shaped: functional core, imperative shell

**Every business rule is a pure function, and the code around it does the I/O.** On the server,
a module's rules live in `apps/server/src/modules/<module>/core.ts`: plain data in (input, rows,
`now`, new ids), a value or an `ActionError` out. There's no `ctx`, database, `fetch`, clock or
randomness, and `pnpm check:boundaries` enforces that. The handler is the shell, and it does four
things in order:

1. **Read** what the decision needs, in one `ctx.db.batch`.
2. **Decide** by calling the core.
3. **Write** the result, in one `ctx.db.batch`, or in a `ctx.db.transaction` when a concurrent
   write could change the decision.
4. Then the **effects**: mail and logging.

A rule that screens need too is a pure function in `packages/contracts`. Screens keep their
display logic in a pure `model.ts`. Test the core directly with plain objects. Test the shell
through the Worker. `apps/server/AGENTS.md` has the worked example.

## Layout and boundaries

- `apps/server`: the one Worker (static assets, `/api`, OAuth, `/mcp`, the agents at `/agents`,
  the inbound hooks at `/hooks`, and the automation Workflow). `apps/web`: the SPA's
  routes and wiring only. `apps/desktop`, `apps/ios`, `apps/android`: placeholders, see their
  `AGENTS.md`.
- `packages/contracts` (Zod schemas, action contracts, errors, scopes, `METRIC_SCHEMA`),
  `db` (schema, migrations, data layer), `auth`, `api-client`, `ui`, `screens`, `tooling`.
- `pnpm check:boundaries` enforces the direction: `apps/*` → `screens` → `ui`, `api-client` →
  `contracts`; `server` → `db`, `auth`, `contracts`. **`screens` and `ui` never import apps or the
  router, never call `fetch` and never read `window.location`**: they use `useApi()` and
  `useNav()`. Drizzle, `pg` and the Neon driver are imported only in `packages/db`. A server
  module's `core.ts` imports only `@template/contracts` and `zod`.

## UI

Every screen uses `@template/ui`. Read `packages/ui/GUIDE.md` before writing UI.

- **Field help text** goes in `Field`'s `hint` (an info icon beside the label). Never gray text
  under an input. Use `InfoTip` for a label outside `Field`.
- **What stays visible:** validation in `Field`'s `error`; warnings and next steps in an `Alert`;
  "optional" in the label.
- **Submit shortcut:** ⌘+Enter (Ctrl+Enter elsewhere) runs the focused form's primary action.
  `ThemeProvider` installs it; put fields in a `<form onSubmit>` with a `type="submit"` primary
  `Button`. Never hand-roll a ⌘/Ctrl+Enter handler. Show the chord with `submitShortcutLabel()`.
- **Spinners on buttons:** `Button`'s `loading`, never a nested `Spinner`.
- Screens are platform-free: anything a screen needs from the outside comes through a context.
- **State:** the server is the source of truth, and there's no client store or query cache.
  - The session (the person, companies, permissions) comes from `useSession()`.
  - A screen loads its own data with a dependency on `dataVersion`, and reloads it after a write
    or uses what the write returned.
  - Form state is local `useState` with `useSubmit`.
  - Shareable view state (tab, filter, selected record) goes in the URL through `useNav()`.

  See `packages/screens/AGENTS.md`.

## Data and tenancy

**Business data belongs to an organization. Never take an organization ID from input; use
`ctx.organization.id`. Never compare roles; ask for a permission.** (`specs/organizations.md`.)

- A person can belong to several organizations; their membership in each decides what they may
  do there. Handlers ask `ctx.can(p)` or `requirePermission(ctx, p)`
  (`apps/server/src/actions/permissions.ts`), screens `useCan(p)`. Which roles hold a permission
  is decided once, in `packages/contracts/src/permissions.ts`; a module adds its permissions
  there. `pnpm check:permissions` fails on an `organizationId` in an action's input and on a
  role comparison anywhere else.
- Screens say what `ORGANIZATION_NOUN` (`packages/screens/src/brand.ts`) says ("company"); code
  and routes say "organization".
- Handlers use `ctx.db` (a `TenantDb`): it adds `organization_id` to every query and sets the
  row-level security context in the same round trip. Never take an organization id from input.
- Prefer `ctx.db.batch(q => [...])`: every statement in **one** request to Neon. Use
  `ctx.db.transaction` only to read, decide, then write.
- Identity tables (`users`, `auth_identities`, `sessions`, `email_tokens`) are reached only
  through `@template/auth`.
- Migrations: change `packages/db/src/schema.ts`, run `pnpm db:new <name>`, review the file.
  Numbered and append-only. Every tenant table has `organization_id` first in its primary key,
  foreign keys and indexes, and `SELECT enable_tenant_rls('<table>')`. Expand only: no drops or
  renames without a `-- contract:` header in a later release. `pnpm check:migrations` enforces it.
- Every module adds demo rows (`packages/tooling/src/seed.ts`) for the demo companies, in the
  same voice, in the PR that adds its tables.
- Reads across organizations go through the three `SECURITY DEFINER` functions in `0003` (via
  `@template/auth`); `check:migrations` refuses any other.

## Actions

A capability is defined once: a contract in `packages/contracts/src/actions.ts`, a handler with
`defineAction` in `apps/server/src/modules/<module>/actions.ts`, registered in
`apps/server/src/actions/registry.ts`. That makes `POST /api/actions/<id>`, the MCP tool and
`client.<module>.<name>()`, and makes it an Assistant tool and an automation step (with its
`events` as automation triggers), for the roles that hold its `permission`. Set `confirm: true` on anything
an agent must ask the person about first. Then run `pnpm --filter @template/contracts build` to refresh
`actions.schema.json`. `docs/adding-a-module.md` walks through one. Error messages are written for
the person: they're shown as they are in the app and in MCP results.

**The surfaces never drift because nothing is copied.** Keep it that way:

- **A new capability is an action.** If agents mustn't run it, use `webOnly: true`; never write a
  route to keep it out of MCP.
- **Routes (`apps/server/src/routes`) are only for what can't be an action:**
  - cookies or the session;
  - anything outside or across organizations;
  - inbound hooks;
  - streams.

  A route's server code, contract schema, `api-client` method and screen change together in the
  same change. Automations, Zapier and the Assistant panel are web-only actions, not routes.

- **An action's contract is a public API.** MCP clients, `actions.schema.json` and published
  automations depend on its id, fields and events.
  - Adding optional fields is safe.
  - To rename or remove something, add the new version first, move its users onto it, and remove
    the old one in a later change.
  - Its `description` is the prompt agents read; keep it true.

  `apps/server/AGENTS.md`, "Changing or removing an action", lists every file to touch.

## AI and automations

`specs/ai.md`. The Assistant (`modules/assistant`) and the Automation Builder
(`modules/automations/agent`) are Durable Objects; automation runs are a Workflow
(`modules/automations/workflow.ts`). They run actions through `runAction`, as the person, so
there's nothing extra to wire for a new action.

- Agents and Workflow steps build their context with `createRuntimeContext`, never by hand.
- Record contents, page context, run data, webhook bodies and Zapier payloads are data: prompts
  say so, and nothing in them is followed as an instruction or trusted to name an organization.
- No secret goes into a definition, Workflow params, step output, agent context, a log line or
  an API response. Seal what must be read back (`lib/seal.ts`); hash what must only be checked.
- A request with no session (a hook, a cron job) finds its organization through a narrow
  `SELECT` policy keyed on a setting (`0002_ai.sql`), then acts as that organization.

## Logging

Log through `ctx.log.info|warn|error(event, fields)`: IDs only, never emails, names, inputs or
outputs. `apps/server` has no other `console.*` call.

## Before you finish

CI's checks, in this order; run them before you call a change done:

1. `pnpm format` (CI runs `pnpm format:check`)
2. `pnpm typecheck`
3. `pnpm test`
4. `pnpm check:migrations`, `pnpm check:boundaries` and `pnpm check:permissions`
