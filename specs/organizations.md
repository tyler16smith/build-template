# Build Template organizations: members, invitations, roles and switching

Status: built (all four rollout phases in code; the staging exits still to run). It followed
`specs/ai.md`, because it changes how actions are authorized and the Assistant and automations
are built on that. It moved here from Custombase (`specs/build-template-organization.md`) when it
was picked up. **Decisions made while building** (at the end) records where the code differs from
the text above it.

## Why

`build-template` v1 already has tenancy. Every tenant table has `organization_id` first and
row-level security, every request runs inside one organization, and `memberships.role` exists.
What it doesn't have is a way for a second person to get in. Sign-up makes a one-person company
and that's where it stops: no invitations, no members screen, no switching between companies and
no rules for who can change what.

A trades business is a company with an owner, an office manager and a crew of technicians. The
product only works for them once the owner can invite the crew. This spec builds the
organization layer that every product copied from `build-template` gets for free:

```
User → Membership → Organization → App data
```

A person can belong to several organizations, and their membership in each decides what they may
do there. The layer is small and boring on purpose. It knows nothing about jobs, boards or
invoices, so the same layer works under a CRM, accounting or a trades product:

```
Organization            Organization            Organization
  └── Customers           └── Accounts            └── Contacts
      └── Jobs                └── Transactions        └── Companies
          └── Invoices            └── Reports             └── Deals
```

## Goals

1. **Business data belongs to an organization, never to a person.** This is already true in v1;
   this spec makes it the template's loudest convention and adds checks for it.
2. **Invite a crew:** an admin types an email and picks a role, the person gets a link, signs in
   or signs up, and lands in the company.
3. **Three roles, permissions in code:** `owner`, `admin` and `member`, mapped to named
   permissions in one file. Code asks `requirePermission(ctx, "members.manage")`, never
   `role === "admin"`.
4. **Belong to several companies:** a switcher in the app shell, and a session that knows which
   organization is open without trusting that as authorization.
5. **Can't be bricked:** an organization always has at least one owner.
6. **One organization ID that outlives this product:** the same ID can name the company in every
   future product we build.

## Non-goals (for now)

- Custom roles, permission editors, teams, departments, groups or per-record ACLs. The
  foundation leaves room for them (see **Room to grow**) without building any.
- A separate "personal account" model. A one-person business is an organization with one owner.
- Billing. `billing.manage` is reserved so billing slots in, but nothing uses it yet.
- Organization logos. They need file uploads, which `build-template` hasn't built yet. The
  column is reserved.
- SSO, SCIM, domain-based auto-join and audit-log screens.
- Organization IDs in URLs (see **Why the open organization lives in the session**).

## Decisions

| Area               | Decision                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model              | Four concepts: `users` (exists), `organizations`, `memberships` (exist, gain columns) and a new `organization_invites`. No member surrogate ID: `PK (organization_id, user_id)` is the uniqueness rule |
| Roles              | Exactly `owner`, `admin`, `member`. Several owners are allowed; at least one is required                                                                                                               |
| Permissions        | `packages/contracts/src/permissions.ts`: a `Permission` union and `rolePermissions`. Action contracts declare `permission` instead of `roles`. No role comparisons anywhere else                       |
| Request context    | `ctx.user.id`, `ctx.organization.id`, `ctx.membership.role`, plus `ctx.can(p)` and `requirePermission(ctx, p)`. Built only in `buildActionContext`                                                     |
| Open organization  | `sessions.organization_id` (now nullable) says which organization the web session has open. Every request re-resolves the membership; the session value alone authorizes nothing                       |
| Action inputs      | No action input may name an organization. The organization always comes from `ctx`. A check fails the build if an input schema has `organizationId`                                                    |
| Onboarding         | Sign-up creates the person only. A **Name your company** step then creates the organization and the `owner` membership. Accepting an invite skips it                                                   |
| Invites            | A hashed single-use token, 7-day expiry, resend (new token) and revoke. Accepting needs a signed-in person whose email matches the invite                                                              |
| Last owner         | Enforced in the transaction that changes or removes a membership (organization row locked), with a deferred constraint trigger as the backstop                                                         |
| Cross-tenant reads | Three named `SECURITY DEFINER` functions, used only by `@template/auth`: list my organizations, find an invite by token, list invites for a verified email                                             |
| Organization ID    | UUID v7, generated once, never reused or renumbered. It is the company's ID in logs, metrics, MCP grants, webhooks and Zapier payloads, and in any future product                                      |
| UI noun            | Code and routes say "organization". Screens say whatever `brand.ts` sets (`"company"` by default), so a product can say "workspace" or "shop" without touching screens                                 |
| Settings           | `/settings/organization` (name, slug, transfer, leave, delete) and `/settings/members` (members, roles, invites). `/invite/:token`. `/onboarding`. A switcher in the sidebar header                    |

### Why the open organization lives in the session

Two shapes work: the organization in the URL (`/<slug>/jobs`, as Linear and Slack do) or in the
session (one active organization per signed-in browser). We pick the session because:

- Every route, link and screen in v1 is already organization-free, and stays that way. A
  product's screens never build an org-prefixed path.
- Most people in a trades product belong to exactly one company. URLs that carry it are noise
  for them.
- The client calls `api.jobs.list()` and never passes an organization, which is the rule we want
  agents and new code to copy.

The cost is that two tabs share one active organization. Switching in tab B would quietly send
tab A's next save to the other company. The **organization guard** (below) closes that: tab A's
save is refused, not redirected.

### Why permissions and not role checks

A role check written today (`role === "owner" || role === "admin"`) is a decision about which
roles may do a thing, copied into every place that does it. Adding a fourth role, or moving one
ability from admin to owner, then means finding every copy. A named permission is that decision
made once:

```ts
// packages/contracts/src/permissions.ts
export const rolePermissions = {
  owner: [
    "organization.manage",
    "organization.delete",
    "organization.transfer",
    "members.manage",
    "billing.manage",
    "automations.manage",
  ],
  admin: ["organization.manage", "members.manage", "automations.manage"],
  member: [],
} as const satisfies Record<Role, readonly Permission[]>;
```

Application code then says `requirePermission(ctx, "members.manage")`. Custom roles later become
"store this map per organization" without touching a single handler.

## What changes in `build-template` v1

The organization layer is mostly a reshaping of code v1 already has.

| v1 today                                                                                                            | Becomes                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ActionContract.roles` and `roleMayRun` (`packages/contracts/src/actions.ts`)                                       | `ActionContract.permission` and `mayRun(action, role)`, reading `rolePermissions`                                      |
| `ActionContext.org` and `ActionContext.role` (`apps/server/src/actions/define.ts`)                                  | `ctx.organization` (`id`, `name`, `slug`) and `ctx.membership` (`role`), plus `ctx.can` and `requirePermission`        |
| `canManage(role)` in `apps/server/src/modules/automations/context.ts`, and the action registry's `roleMayRun` check | `requirePermission(ctx, "automations.manage")` and the registry's permission check                                     |
| Sign-up creates the user, a "<Name>'s company" organization and an owner membership in one transaction              | Sign-up creates the user. `/onboarding` creates the organization and membership                                        |
| `sessions.organization_id NOT NULL`, `ON DELETE CASCADE`                                                            | Nullable, `ON DELETE SET NULL`, so deleting an organization doesn't sign its members out of their other organizations  |
| `organizations (id, name, created_at)`                                                                              | Adds `slug`, `logo_url` (reserved), `updated_at`, `deleted_at`, `created_by_user_id`                                   |
| `memberships (organization_id, user_id, role, created_at)`                                                          | Adds `updated_at`, `invited_by_user_id`, `last_opened_at`                                                              |
| The MCP membership cache in `apps/server/src/mcp/oauth.ts` holds `role`                                             | Unchanged shape. Removing a member also revokes their grants for that organization, so the cache never outlives access |

Automation `approvers: { roles }` and `notify` `to: { roles }` stay role-based. They choose
**people** ("email the admins"), not what a caller may do, so they're not authorization.

## Data model

One new migration (the next number after the AI tables). Tenant rules as `check:migrations`
already enforces: `organization_id` first in keys and indexes, and `enable_tenant_rls`.

```
organizations           id (uuid v7), name, slug (citext, unique), logo_url (reserved, null),
                        created_by_user_id, created_at, updated_at, deleted_at
memberships             organization_id, user_id, role, invited_by_user_id, last_opened_at,
                        created_at, updated_at
                        PK (organization_id, user_id)
organization_invites    organization_id, id (uuid v7), email (citext), role,
                        token_hash (unique), invited_by_user_id, expires_at, last_sent_at,
                        send_count, accepted_at, accepted_by_user_id, created_at
                        PK (organization_id, id)
                        UNIQUE (organization_id, email) WHERE accepted_at IS NULL
sessions                organization_id becomes nullable, ON DELETE SET NULL
```

- **`organization_invites` is a tenant table** with the standard policy. `token_hash` is the
  second cross-tenant index (after `memberships_user`), marked with the same
  `-- cross-tenant index:` comment, because the invite page looks an invite up before it knows the
  organization.
- **Roles are a `CHECK`,** as `memberships_role` already is, on both `memberships.role` and
  `organization_invites.role`. Invites can't grant `owner`: ownership is given to someone already
  in the organization (see **Ownership**).
- **One pending invite per email per organization.** Inviting the same address again resends the
  existing invite instead.
- **Accepted invites are kept,** with `accepted_at` and `accepted_by_user_id`, so "who invited
  whom" stays answerable. Revoking deletes the row. A cron removes expired and accepted invites
  after 90 days.
- **Slugs:** lowercase letters, digits and hyphens, 3 to 48 characters, generated from the name
  (`three-pigs-construction`, then `-2`, `-3` on a clash) and editable. A short reserved list
  (`api`, `admin`, `settings`, `invite`, `onboarding`, `www`, …) keeps future vanity URLs and
  subdomains open. v1 uses the slug for display only; links use the ID.

### Reads that cross organizations

Row-level security scopes everything to one organization. Three reads have to happen before an
organization is chosen. Each is a `SECURITY DEFINER` function owned by `app_migrator`, with a
pinned `search_path`, returning only what it's named for. `@template/auth` is the only caller,
and `check:migrations` allowlists exactly these names: any other definer function fails it.

| Function                        | Returns                                                                      | Used by                                 |
| ------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------- |
| `member_organizations(user_id)` | `id`, `name`, `slug`, `role`, `last_opened_at` of live organizations         | `/api/session`, the switcher, fallbacks |
| `invite_by_token(token_hash)`   | The invite plus organization name and inviter name, if pending and unexpired | `/invite/:token`, accept                |
| `invites_for_email(email)`      | Pending invites to that address                                              | `/onboarding`, verified emails only     |

The existing `own_memberships` policy stays. The `organizations` policy stays exactly as it is:
no membership subquery inside a policy, as `build-template.md` requires.

## Request context

The pipeline resolves the person, then the organization, then the membership, and only then
builds the context. In code, every action sees:

```ts
ctx.user.id;
ctx.organization.id; // also name and slug
ctx.membership.role;
ctx.can("members.manage"); // boolean, for shaping output
requirePermission(ctx, "members.manage"); // throws ActionError("forbidden", …)
```

**Where the organization comes from,** per caller. None of them is ever the request body:

| Caller               | Organization                                           | Membership checked                         |
| -------------------- | ------------------------------------------------------ | ------------------------------------------ |
| Web (session cookie) | `sessions.organization_id`                             | In the same statement as the session       |
| MCP and API (token)  | The grant's `organizationId`, fixed at consent         | On every call (`verifyMembership`, exists) |
| Assistant            | The Durable Object's name, which came from the session | On every turn                              |
| Automation step      | The automation's organization and run-as person        | On every step                              |

If the membership is gone (removed, or the organization was deleted), the request is refused
with `not_a_member`. For a web session, the session also moves to the person's most recently
opened other organization, or to none, which sends them to `/onboarding`.

**Freshness.** v1 caches a validated session for 60 seconds per isolate, role included, and the
MCP membership cache does the same. That window stays for reads and ordinary writes. Actions
whose permission is `members.manage`, or any `organization.*` or `billing.*` permission, re-read
the role inside their own transaction (`requirePermission(ctx, p, { fresh: true })`), so a
demoted admin can't remove anyone in that minute. Removing a member also deletes their sessions
that have that organization open and revokes their OAuth grants for it.

### The organization guard

The web client sends `X-Organization-Id` on every action call: the organization its current page
was loaded for. If it doesn't match the session's open organization, the server refuses with
`409 organization_changed` and runs nothing. The header can only cause a refusal; it never selects
an organization. The web app then reloads into the organization that is now open, with a toast:
"You switched to Big Bad Demolition Co. in another tab." `apps/web` also posts switches on a
`BroadcastChannel`, so other tabs reload before anyone types.

### No organization in action inputs

`check:permissions` (new, in `tooling`) fails the build when:

- an action's input schema has a key named `organizationId` or `organization_id`, at any depth;
- a file outside `packages/contracts/src/permissions.ts` compares a role to a role literal
  (`role === "owner"`, `.includes("admin")` on a role, `switch (role)`).

Fixtures, the seed and tests are exempt from the second rule. The AGENTS.md rule says the same
thing in words, for the Builder and for people: "Business data belongs to an organization. Never
take an organization ID from input; use `ctx.organization.id`. Never compare roles; ask for a
permission."

## Permissions

| Permission              | Owner | Admin | Member | What it allows                                                          |
| ----------------------- | :---: | :---: | :----: | ----------------------------------------------------------------------- |
| `organization.manage`   |   ✓   |   ✓   |        | Rename the organization, change its slug                                |
| `organization.delete`   |   ✓   |       |        | Delete the organization                                                 |
| `organization.transfer` |   ✓   |       |        | Make someone an owner, transfer ownership                               |
| `members.manage`        |   ✓   |   ✓   |        | Invite, resend and revoke invites, change roles, remove members         |
| `billing.manage`        |   ✓   |       |        | Reserved for billing                                                    |
| `automations.manage`    |   ✓   |   ✓   |        | Moved from `canManage` in the AI modules: automations, Zapier, run data |

Every member can use the product, see the member list (name, email, role, job title) and leave
the organization. Those need no permission.

**Who can change whom.** `members.manage` is the gate. One more rule, in the same file as
`rolePermissions` and nowhere else (`mayChangeMember(actor, target, newRole)`):

- **Owners** can change or remove anyone, subject to the last-owner rule. Granting `owner` needs
  `organization.transfer`.
- **Admins** can invite members and admins, and promote a member to admin. They can't change or
  remove another admin or an owner, and can't grant `owner`.
- **Anyone** can lower their own role or leave, subject to the last-owner rule.

**Modules add permissions** by adding names to the `Permission` union and to the roles that get
them, in the same pull request. A trades product might add `jobs.assign` for admins, or
`invoices.void` for owners. The permissions test (below) makes sure each new permission is
granted to at least one role, and that owners hold every permission.

**What the web app sees.** `GET /api/session` returns `permissions: Permission[]` for the open
organization, and screens hide what the person can't do (`useCan("members.manage")`). That's
presentation. The registry check is the authority.

**Agents see the same thing.** MCP `tools/list`, Assistant tools and the automation catalog
already filter by role through `roleMayRun`. They switch to `mayRun`, so a member's Claude
connection never lists `members_remove`.

## Onboarding and sign-up

```
Sign up (password or Google)
    ↓
Has an invite link? ── yes ──→ Accept invite → enter that organization
    ↓ no
/onboarding: "Name your company"   (+ pending invites to a verified email)
    ↓
Organization + owner membership, one transaction, opened in the session
    ↓
Enter the app
```

- **`/onboarding`** is one field, "Company name", prefilled with "<Name>'s company", and one
  primary button, **Create company** (⌘/Ctrl+Enter submits). If the person's email is verified
  (Google, or after clicking the link) and invitations to it are pending, they're listed above
  the form: "Bea Brickley invited you to Three Pigs Construction as a member. **Join**". Joining
  skips creating a company.
- **A person with no organization** can reach only `/onboarding`, `/profile`, `/invite/:token` and
  sign out. Every action refuses with `no_organization`; the web app routes them to
  `/onboarding`.
- **MCP consent** for a person with no organization goes through `/onboarding` and back to the
  consent screen, with the handle kept, as sign-in already does.
- **Creating another organization** later is the same screen, from the switcher's **Create
  company** item. It's an auth route (`POST /api/organizations`), not an action: it isn't scoped to
  an existing organization and it changes the session.

## Switching organizations

- **The switcher** sits at the top of the sidebar: the open organization's name and initials,
  and on click, every organization the person belongs to (ordered by `last_opened_at`), their role
  in each, a check on the open one, **Create company**, and **Company settings**. With one
  organization it still shows, because the name is useful and **Create company** lives there.
- **`POST /auth/switch-organization { organizationId }`** checks the membership, sets
  `sessions.organization_id`, updates `memberships.last_opened_at`, drops the isolate's cached
  session and returns the new `/api/session` payload, in one round trip. The web app clears its
  query cache and goes to `/`.
- **Links into a specific organization** (an email about a job, an automation notice) add
  `?org=<organizationId>` to any route. If it isn't the open one and the person is a member, the
  web app switches first. If they aren't, it shows "You don't have access to that company" and
  stays put.
- **MCP connections are per organization.** The consent screen gains a company picker when the
  person has more than one, and the grant records it. Connected apps on the profile page show the
  company beside each grant. Connecting Claude to a second company is a second connection.

## Invitations

**Sending.** On `/settings/members`, **Invite member** opens a dialog: email, role (`Member` or
`Admin`, limited by `mayChangeMember`), and one primary button, **Send invite**. The server
creates the invite with a random 32-byte token, stores only `HMAC(token, SESSION_PEPPER)`, and
sends:

> **Bea Brickley invited you to Three Pigs Construction**
>
> You've been invited to join as a member. [Accept invitation](https://app.example/invite/<token>)
>
> This link expires on 13 October.

Through `Mailer` and the email templates in `apps/server/src/lib/emails.ts`, so it shows at
`/dev/mail` locally. Inviting someone who is already a member is refused with a clear message.
Inviting an address that already has a pending invite resends it.

**Pending invites** are listed under the members table: email, role, invited by, expires, and
**Resend** and **Revoke**. Resend makes a new token (the old link stops working), resets
`expires_at` to 7 days and is limited to once a minute per invite. Revoke deletes the invite, in
a confirmation dialog. Expired invites show as "Expired" with **Resend**.

**Accepting** (`/invite/:token`):

```
Open the link
    ↓
Invite found and live? ── no ──→ "This invitation has expired or was revoked. Ask Bea to send a new one."
    ↓ yes
Shows: company, inviter, role
    ↓
Signed in? ── no ──→ Sign in or sign up (email prefilled and fixed on sign-up), then back here
    ↓ yes
Signed-in email = invite email? ── no ──→ "This invitation is for clem@threepigs.example. You're signed in as clem@gmail.com." [Sign out and continue]
    ↓ yes
Accept → membership created, invite marked accepted, session opens that organization
```

- **Matching** is on the email, case-insensitive (`citext`). There's no "accept as a different
  email": an admin re-invites the right address.
- **Signing up from an invite** marks the email verified, since the person just proved they read
  that inbox. It also skips `/onboarding`.
- **Accept is one transaction:** re-check the invite (pending, unexpired, matching email), insert
  the membership (a duplicate means they're already in, so it just opens the organization) and
  set `accepted_at`. A token works once.
- **Accept is an auth route,** `POST /api/invites/accept { token }`, not an action: it runs before
  the person is in the organization and changes the session.

**Limits:** 50 invites per organization per day and 10 a minute per person (Workers Rate Limiting,
as sign-up uses), so our Resend domain can't be used to spam. Invite page lookups are rate
limited per IP. The invite email never contains anything but the organization name, the
inviter's name, the role and the link.

## Ownership

- **Several owners are allowed.** Making someone an owner is a role change that needs
  `organization.transfer`.
- **Transfer ownership** (`/settings/organization`, owners only) is one action: the chosen member
  becomes owner and the current owner becomes admin, in one transaction. It asks for
  confirmation, and both people get an email.
- **The last-owner rule.** Demoting or removing the only owner, or the only owner leaving, is refused:
  "Three Pigs Construction needs at least one owner. Make someone else an owner first." The
  check runs in `ctx.db.transaction`: lock the organization row (`SELECT … FOR UPDATE`), count
  owners, then write, so two owners demoting each other at once can't both succeed. A deferred
  constraint trigger on `memberships` is the backstop: at commit, a live organization with members
  and no owner fails the transaction. A test runs two concurrent demotions and expects one to
  fail.
- **Account deletion** (the profile page, exists) is refused while the person is the last owner of
  an organization with other members. The dialog lists those organizations and links to their
  settings. Organizations where they're the only member are deleted with the account.

## Organization settings

Settings get a left-hand nav: **Profile** (the existing `/profile`), **Company**, **Members**.

**`/settings/organization`**

- **General:** company name and slug, in a `<form>` with one **Save** button (`Field` with `hint`
  for the slug: "Used in links later. Lowercase letters, numbers and hyphens."). Needs
  `organization.manage`; others see the values read-only.
- **Leave company:** any member who isn't the last owner. Confirmation dialog.
- **Transfer ownership** (owners): pick a member, confirm.
- **Delete company** (owners): a destructive dialog that asks them to type the company name, with
  a destructive button that opts into `submitShortcut`. Soft-deletes now: every member loses
  access at once, its sessions move to another organization or to onboarding, OAuth grants and
  Zapier connections are revoked, and automations stop. Within 30 days we can restore it with
  `pnpm org:restore <id>` (operators only). After 30 days the cron deletes the row, which cascades
  through every tenant table, and first deletes the organization's Assistant and Automation
  Builder Durable Object storage. A test proves nothing of the organization survives.

**`/settings/members`**

- A table: name (with avatar), email, job title, role, and for those who may change them, a role
  `Select` and **Remove**. "You" marks the person's own row, which offers **Leave** instead.
- **Invite member** (primary button) and the pending invites list, both only with
  `members.manage`.
- Role changes save on change with a toast and undo. Remove asks first.

UI rules from Custombase apply: `Field` `hint`, never gray helper text; `Alert` for the
last-owner and "you're about to lose access" warnings; `Button loading`; one primary per form or
dialog; ⌘/Ctrl+Enter through the submit shortcut, never hand-rolled.

## Actions

All in `apps/server/src/modules/organization`, contracts in `packages/contracts`. None takes an
organization ID.

| Action                           | Permission              | MCP and Assistant | Notes                                         |
| -------------------------------- | ----------------------- | ----------------- | --------------------------------------------- |
| `organization.get`               | none                    | yes, read-only    | Name, slug, the caller's role and permissions |
| `organization.update`            | `organization.manage`   | yes               | Name, slug                                    |
| `organization.transferOwnership` | `organization.transfer` | no (`webOnly`)    | `confirm: true`                               |
| `organization.leave`             | none                    | no (`webOnly`)    | Last-owner rule                               |
| `organization.delete`            | `organization.delete`   | no (`webOnly`)    | Typed-name confirmation                       |
| `members.list`                   | none                    | yes, read-only    |                                               |
| `members.updateRole`             | `members.manage`        | yes               | `confirm: true`, `mayChangeMember`            |
| `members.remove`                 | `members.manage`        | yes               | `confirm: true`, `mayChangeMember`            |
| `invites.list`                   | `members.manage`        | yes, read-only    |                                               |
| `invites.create`                 | `members.manage`        | yes               | `confirm: true` (it sends an email)           |
| `invites.resend`                 | `members.manage`        | yes               |                                               |
| `invites.revoke`                 | `members.manage`        | yes               | `confirm: true`                               |

Events for automations: `members.joined`, `members.roleChanged`, `members.removed`. Scopes:
`organization:read` and `organization:write`, granted on the consent screen like the profile pair.

Auth routes, not actions, because they work across or outside an organization or change the
session: `POST /api/organizations` (create), `POST /auth/switch-organization`,
`GET /api/invites/:token` and `POST /api/invites/accept`.

## One organization ID across products

Every product we start from `build-template` has its own repository and its own Neon database.
If ABC Plumbing uses three of them, they should all know it as the same company:

```
organization 0192f3c4-…

Trades DB        organization_id = 0192f3c4-…
CRM DB           organization_id = 0192f3c4-…
Accounting DB    organization_id = 0192f3c4-…
```

That common ID is what later cross-product automations, combined billing, analytics,
integrations and agents will join on, without the products sharing their business tables.
Custombase already works this way: `business_id` is the same across every Custombase app and the
shared Boards Postgres.

This spec doesn't build a central identity service. It keeps the door open:

- **The ID is the ID.** `organizations.id` is a UUID v7 created by one function,
  `newOrganizationId()`. It's never reused, renumbered or derived from anything, and nothing
  parses meaning from it.
- **Creating an organization accepts an ID.** The organization service function takes an
  optional `id`, so a future central directory can create the organization once and have each
  product mirror it under the same ID. Only operator tooling and the seed pass one today.
- **The ID goes everywhere outward:** structured logs and metrics (exists), MCP grant props
  (exists), webhooks, Zapier payloads and exports, as `organizationId`. Never the slug, which can
  change.

## Observability

Plugs into `build-template.md`'s hooks with no schema change:

- The new actions write `action` metric points like every other action.
- The auth routes log `organization.created`, `organization.switched`, `invite.accepted` and
  `invite.rejected` (with the reason: expired, revoked, email mismatch, rate limited). Emails and
  tokens are redacted, as `redact.ts` already does.
- Last-owner refusals and `organization_changed` guard refusals are counted, because a burst of
  either means a UI bug.

## Demo data

The seed already has Three Pigs Construction (Bea owner, Hank admin, five members) and Big Bad
Demolition Co. It gains:

- **Slugs:** `three-pigs-construction` and `big-bad-demolition-co`.
- **A pending invite** to `mama@threepigs.example`, role admin, invited by Bea, sent three
  times. Expires in 2 days.
- **An expired invite** to `goldilocks@threebears.example`, role member, invited by Hank.
  "Expired".
- **Someone in both companies:** Wolfgang Huffington (`wolf@huffandpuff.example`), a member of
  Three Pigs ("Stress testing, all three projects. Huffs, puffs, files the report") and an admin
  at Big Bad Demolition. Signing in as Wolfgang shows the switcher, and switching proves each
  sees only its own data.
- **A third organization,** Huff & Puff Testing, where Wolfgang is the only owner. Deleting
  Wolfgang's account on staging is refused, as the last-owner rule says it should be.

## Testing

- **Permissions test:** every action, called as owner, admin, member and non-member, against
  `rolePermissions`. A new action without an expectation fails it. Owners hold every permission;
  every permission belongs to some role.
- **Isolation test (extends v1's):** seed three organizations, and run every new action and route
  as each person. Switching, invite acceptance and the guard header never expose another
  organization's rows. Run once more with the data layer's filter off, as v1 does, so RLS alone
  holds.
- **Membership changes:** last owner can't demote, leave or be removed; two concurrent demotions,
  one fails; admin can't touch an admin or owner; a removed member's next web request, MCP call
  and Assistant turn are refused, and their sessions and grants are gone.
- **Invites:** wrong email, expired, revoked, resent (old link dead), reused token, already a
  member, sign-up from invite skips onboarding and verifies the email, rate limits.
- **Guard:** switch in one tab, save in another: `409 organization_changed`, nothing written.
- **Checks:** `check:permissions` fails on a role comparison and on an `organizationId` input, and
  `check:migrations` fails on an unlisted `SECURITY DEFINER` function.
- **e2e on staging:** Bea invites a throwaway address, the e2e reads the link from the test
  mailbox, signs up, lands as a member, can't see **Invite member**, and is removed by Bea.

## Rollout

1. **Permissions and context:** `permissions.ts`, `permission` on contracts, `ctx.organization`
   and `ctx.membership`, `requirePermission` (with `fresh`), the registry check, agents and the
   automation catalog on `mayRun`, `canManage` removed, `check:permissions`, the AGENTS.md rule.
   No behavior changes for anyone yet. **Exit:** every existing test passes, the permissions test
   passes, and a grep finds no role comparison outside `permissions.ts`.
2. **Organizations and switching:** the migration, the definer functions, nullable sessions,
   `/onboarding`, `POST /api/organizations`, the switcher, `/auth/switch-organization`, the guard,
   `?org=` links, the MCP consent picker, Wolfgang and Huff & Puff Testing in the seed. **Exit:** on
   staging, Wolfgang switches between three companies in two tabs; a save in the stale tab is
   refused; Claude connected to Big Bad Demolition can't see Three Pigs.
3. **Members and invitations:** `/settings/members`, the invite email, `/invite/:token`, accept,
   resend and revoke, role changes and removal with the last-owner rule and revocation of
   sessions and grants. **Exit:** the e2e invite flow passes on staging; Hank can't demote Bea;
   Bea can't demote herself.
4. **Organization lifecycle:** `/settings/organization`, transfer, leave, delete with the 30-day
   restore window and hard delete through the Durable Objects, account deletion's last-owner check.
   **Exit:** deleting a throwaway organization on staging signs its members into their other
   companies, and after a forced cron run nothing of it is left in Postgres or the agents.

## Room to grow

| Later need                  | Where it goes                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Custom roles                | `organization_roles (organization_id, key, name, permissions[])`; `rolePermissions` becomes the built-in defaults        |
| Teams or crews              | A tenant table of teams and team members; records that need it get a `team_id`. Permissions stay organization-wide       |
| Per-record access           | A module-level rule ("technicians see only their assigned jobs") in that module's queries, not in this layer             |
| Billing                     | Stripe customer on the organization, gated by `billing.manage`                                                           |
| Logos                       | `logo_url` exists; fills in when file uploads (R2) are built                                                             |
| Org in the URL              | `?org=` already switches; a `/<slug>/…` prefix can redirect to it without changing the session model                     |
| Domain auto-join            | A verified domain on the organization; new sign-ups from it see a **Join** offer, like pending invites                   |
| SSO and SCIM                | A new `auth_identities.provider` per organization; SCIM drives `memberships` through the same actions                    |
| Central organization record | A directory service that creates organizations by ID; products mirror them (see **One organization ID across products**) |
| Audit log                   | An `organization_events` tenant table written by these actions; a screen for owners                                      |

## Open questions

- Should admins be able to invite and promote admins, or should only owners grant admin? The
  default here lets admins raise people up to their own level but not lower other admins.
- When the second product exists, does a central directory own organizations and people, or do
  products link to each other's organization IDs on demand? Either works with this spec. It
  should be decided before two products share a customer.
- Should products built on `build-template` ever share organization IDs with Custombase
  businesses, so a Custombase customer's company is the same company there?

## Decisions made while building

- **Routes.** Everything the web app calls lives under `/api`: `POST /api/organizations`,
  `POST /api/auth/switch-organization`, `GET /api/invites/:token`, `POST /api/invites/accept`,
  plus `GET /api/invites` and `POST /api/invites/join` for `/onboarding`'s pending invitations and
  `GET /api/auth/deletion-blockers` for the account deletion dialog. Each organization route
  answers with the new `/api/session` payload, so the web app needs one round trip.
- **Reads across organizations.** `organizations`, `memberships` and `organization_invites` force
  row-level security, which binds their owner too, so the three definer functions get a
  SELECT-only `definer_reads` policy (`current_user = 'app_migrator'`): `app_runtime` never
  matches it. `member_organizations` and `invites_for_email` also check `app.user_id`, so they only
  answer for the person asking. `grantRuntime` grants `EXECUTE` on them; `PUBLIC` has none.
- **The daily cleanup** finds deleted organizations and old invitations through `cleanup_job`
  SELECT policies keyed on `app.job` (as `0002`'s jobs do), then deletes each as its own
  organization.
- **Slugs.** `organizations_slug` and `organizations_deleted` are built concurrently in
  `0004_organization_slugs.sql`. Companies made before this have no slug until someone sets one
  (`organization.get` returns `slug: null`); the migration can't backfill under forced row-level
  security.
- **Invite limits** are counted in Postgres, in the transaction that sends: 50 per organization a
  day and 10 a minute per person. Invite page lookups and accepts use Workers Rate Limiting
  (`AUTH_LIMIT`).
- **Two more permissions.** `ai.manage` (owners: the Assistant's model, budget and daily cap) and
  `ai.usage` (owners and admins: AI spending) replace the role checks `specs/ai.md` left in the
  Assistant's routes.
- **Freshness.** The registry re-reads the caller's role (`requirePermission(ctx, p, { fresh: true
})`) for every action whose `permission` is `members.manage`, `organization.*` or `billing.*`;
  the membership change itself re-reads every role with the organization row locked.
- **Sessions.** Removing someone deletes their sessions in that company (they sign in again, into
  another). Leaving or deleting sets the sessions' organization to none, and the next request opens
  the person's most recently used other company. A session whose company vanished behind its back
  is moved on its next lookup, and that request is refused with `not_a_member`.
- **`members.joined`** is declared on `invites.create` as a `manual` event (`ActionEvent.manual`):
  the accept route emits it (`emitEvent`) as the new member, after the invitation is accepted, not
  when it's sent.
- **The guard** applies to actions and to the session-scoped routes (the Assistant, automations,
  Zapier). The web app's two API clients share one tracker for `X-Organization-Id`, and a
  `BroadcastChannel` reloads other tabs on a switch; a refused tab reloads with a toast.
- **Not run yet:** the e2e invite flow (`e2e/tests/organizations.spec.ts`) needs staging's test
  mailbox, and the rollout exits are staging checks.
