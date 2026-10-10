# Adding a module

A module is a feature with its own tables, actions, scopes and screens: customers, jobs,
invoices. This walks through **customers** end to end. Each step names the file and the rule
that applies. The profile module (`apps/server/src/modules/profile`) is the smallest working
example.

## 1. The table (`packages/db/src/schema.ts`)

Customers belong to an organization, so `organization_id` comes first in the primary key, every
foreign key and every index.

```ts
export const customers = pgTable(
  "customers",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    id: uuid("id").notNull(),
    name: text("name").notNull(),
    phone: text("phone"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    index("customers_name").on(t.organizationId, t.name),
  ],
);
```

Add it to `schema` at the bottom of the file. A table with an `organizationId` column is a tenant
table to the data layer automatically.

## 2. The migration

```bash
pnpm db:new customers
```

This writes `packages/db/migrations/0002_customers.sql` from the schema diff. Review it, then
add the row-level security line by hand at the end:

```sql
SELECT enable_tenant_rls('customers');
```

`pnpm check:migrations` refuses a tenant table without it, a key or index that doesn't start
with `organization_id`, a lock-taking change to an existing table, or a drop or rename (expand
first; contract in a later release with a `-- contract:` header). Apply it locally with
`pnpm db:migrate --env local`. Migrations are append-only: never edit one that has run.

## 3. Scopes (`packages/contracts/src/scopes.ts`)

```ts
export const SCOPES = {
  "profile:read": "See your name, job title, email and company",
  "profile:write": "Change your name and job title",
  "customers:read": "See your company's customers",
  "customers:write": "Add and change customers",
} as const;
```

Read scopes go in `ALWAYS_GRANTED` only if every connection should have them.

## 4. Contracts (`packages/contracts/src/schemas.ts` and `actions.ts`)

```ts
// schemas.ts
export const Customer = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
});
export const CustomerList = z.object({ customers: z.array(Customer) });
export const CustomerCreateInput = z.object({
  name: z.string().trim().min(1, "Enter the customer's name.").max(200),
  phone: z.string().trim().max(40).optional(),
});

// actions.ts
export const customersList = defineActionContract({
  id: "customers.list",
  title: "List customers",
  description: "List the company's customers, newest first.",
  input: z.object({}),
  output: CustomerList,
  scope: "customers:read",
  readOnly: true,
});

export const customersCreate = defineActionContract({
  id: "customers.create",
  title: "Add a customer",
  description: "Add a customer to the company.",
  input: CustomerCreateInput,
  output: Customer,
  scope: "customers:write",
  readOnly: false,
  events: [{ id: "customer.created", title: "Customer added" }],
});

export const ACTIONS = {
  // …
  [customersList.id]: customersList,
  [customersCreate.id]: customersCreate,
} as const;
```

Set `confirm: true` on anything an agent must ask the person about first (deleting, sending
money or messages), and `permission: "jobs.assign"` when not every member may run it: add the
permission to `PERMISSIONS` and to the roles that get it in `packages/contracts/src/permissions.ts`
(never a role check in a handler or a screen; `pnpm check:permissions` refuses one). An action
with `events` can start automations: `customer.created` above appears as a trigger in the
Automation Builder, with the action's output as `trigger.data`. Then `pnpm --filter @template/contracts build` refreshes
`actions.schema.json`, and the new tool names go in the list in
`packages/contracts/test/contracts.test.ts` (tests fail while either is stale).

Write `description` for a model deciding whether to call the tool. MCP clients and the Assistant
read it as their instructions.

## 5. The core (`apps/server/src/modules/customers/core.ts`)

The module's rules are pure functions: plain data in, a value or an `ActionError` out
(`apps/server/AGENTS.md`, "Functional core, imperative shell"). No `ctx`, no database, no clock:
the handler passes `now` and new ids in. `pnpm check:boundaries` keeps it that way.

```ts
import type { Customer, CustomerCreateInput } from "@template/contracts";

/** The row for a new customer: trimmed, with an empty phone stored as null. */
export function newCustomer(
  input: CustomerCreateInput,
  ids: { id: string; createdBy: string },
): { id: string; name: string; phone: string | null; createdBy: string } {
  return { ...ids, name: input.name, phone: input.phone || null };
}

/** A row as the contract shows it. */
export function toCustomer(row: { id: string; name: string; phone: string | null }): Customer {
  return { id: row.id, name: row.name, phone: row.phone };
}
```

A rule that refuses (a customer with open jobs can't be archived) throws `ActionError` from here;
`apps/server/AGENTS.md` has that example. Test the core directly with plain objects (`apps/server/test/customers.core.test.ts`), every branch.

## 6. Handlers (`apps/server/src/modules/customers/actions.ts`)

Handlers are the shell: read, call the core, write, then log. They get `ctx.db`, already scoped
to the caller's organization (`ctx.organization.id`; never an id from input). Every helper adds
`organization_id` itself and row-level security checks it again inside Postgres. To shape output
by what the caller may do, use `ctx.can("jobs.assign")`; to refuse, `requirePermission(ctx,
"jobs.assign")` (the registry already refuses an action's own `permission`).

```ts
import { customersCreate, customersList, uuidv7 } from "@template/contracts";
import { customers, desc } from "@template/db";
import { defineAction } from "../../actions/define";
import { newCustomer, toCustomer } from "./core";

export const listCustomers = defineAction({
  ...customersList,
  handler: async (ctx) => {
    const rows = await ctx.db.one((q) =>
      q.select(customers, { orderBy: [desc(customers.createdAt)], limit: 200 }),
    );
    return { customers: rows.map(toCustomer) };
  },
});

export const createCustomer = defineAction({
  ...customersCreate,
  handler: async (ctx, input) => {
    const [row] = await ctx.db.one((q) =>
      q.insert(customers, newCustomer(input, { id: uuidv7(), createdBy: ctx.user.id })),
    );
    ctx.log.info("customer.created", { customerId: row!.id });
    return toCustomer(row!);
  },
});
```

- Several reads for one page: `ctx.db.batch((q) => [q.select(a), q.count(b), q.first(c, where)])`,
  one round trip.
- Read, decide, write: `ctx.db.transaction(async (q) => { … await q.first(…) … })`.
- Joins: `q.drizzle` with `q.owned(table)` in every table's condition.
- Log IDs only (`customerId`), never names, phone numbers or inputs.

Register them in `apps/server/src/actions/registry.ts`:

```ts
[listCustomers.id]: listCustomers as unknown as ServerAction,
[createCustomer.id]: createCustomer as unknown as ServerAction,
```

That's every surface: `POST /api/actions/customers.create`, the MCP tools `customers_list`
and `customers_create` (listed only for connections with the scope),
`client.customers.create(input)` in `@template/api-client` (typed from the contract), the
Assistant's tools, and the Automation Builder's steps and triggers.

## 7. Demo data (`packages/tooling/src/seed.ts`)

Add customers for the demo companies, with fixed ids, upserted, in the same voice:

```ts
{ id: id(1001), organizationId: id(1), name: "Mother Hubbard (cupboard refit; currently bare)" },
{ id: id(1002), organizationId: id(1), name: "The Crooked Man (crooked house, keep it crooked)" },
{ id: id(1003), organizationId: id(1), name: "Jack and Jill (hilltop well, handrail urgently)" },
{ id: id(2001), organizationId: id(2), name: "Gingerbread Cottage (teardown, mind the oven)" },
```

Insert them inside each organization's batch, after `setContext(d, { organizationId })`, with
`onConflictDoUpdate` on the primary key.

## 8. The screen (`packages/screens/src/customers/customers.tsx`)

Screens use `useApi()` and `useNav()`, never `fetch` or `window.location`, and the UI rules in
`packages/ui/GUIDE.md` (`Field` with `hint`, one primary submit button per form, `Button
loading`). Call `useAssistantPageContext({ title, summary, selection })` so Ask AI knows
what's on screen (only what the screen shows), and list `dataVersion` from `useSession()` in the
effect that loads its data, so it re-reads after the Assistant changes something. Export it
from `packages/screens/src/app-entry.ts`, add a nav item in
`packages/screens/src/app/layout.tsx`, and a route under `app` in `apps/web/src/router.tsx` (it
loads lazily with the rest of the signed-in screens).

State follows `packages/screens/AGENTS.md`. Load the list with `useLoad(() => api.customers.list(),
key)`, then after a create, add the returned customer or reload. Keep form fields in local state
with `useSubmit`, and put the selected customer in the URL. Display logic (sorting, labels, empty
states) goes in a pure `customers/model.ts`.

## 9. Tests

- `apps/server/test/customers.core.test.ts`: the core's functions, every branch, with plain
  objects.
- `apps/server/test/`: call the actions through the Worker (`Browser` in `test/helpers.ts`) and
  over MCP, including a second organization that must never see the rows.
- `packages/db/test/database.test.ts` runs the row-level security probes on every tenant table,
  new ones included, with no changes.
- `e2e/tests/`: the screen's main path.

Then run the checks in `AGENTS.md`, "Before you finish".

Changing or removing an action later is a change to a public API. Follow
`apps/server/AGENTS.md`, "Changing or removing an action".
