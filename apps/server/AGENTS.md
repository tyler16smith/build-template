# Server

The one Worker. The root `AGENTS.md` rules apply here. This file covers how backend code is
shaped and how to keep the surfaces in sync. `docs/adding-a-module.md` walks through a whole
module.

## How a call runs

Every way in ends at `runAction` (`src/actions/registry.ts`): `POST /api/actions/<id>`
(`src/routes/api.ts`), an MCP `tools/call` (`src/mcp/server.ts`), an Assistant tool
(`src/modules/assistant/tools.ts`) and an automation `action` step
(`src/modules/automations/interpreter.ts`). `runAction` checks the scope and the permission,
parses the input, builds the `ActionContext`, runs the handler, parses the output, dispatches the
action's events, then writes one log line and one metric. Handlers never repeat any of that, and
nothing calls a handler directly.

## Functional core, imperative shell

**Business rules are pure functions. The code around them does the I/O.** Most bugs live in
decisions, and a pure decision can be tested exhaustively with plain objects, with no Worker,
database or mocks.

- **The core** is in `src/modules/<module>/core.ts`, or a `core/` folder when it grows. It takes
  plain data (input, rows, `now`, new ids) and returns a value: the record to write, the view to
  return, the emails to send, the next state. Or it throws an `ActionError` with a message for the
  person. It is synchronous and deterministic. `pnpm check:boundaries` holds it to that. It may
  import only `@template/contracts`, `zod` and its own `core/` files. It may not use `async`,
  `await` or `ctx`. It may not call `new Date()`, `Date.now()`, `Math.random()`, `crypto.*`,
  `uuidv7()` or `fetch`.
- **The shell** is the handler (or route, Workflow step or Durable Object method). It does the
  following in order, and decides nothing itself:
  1. **Read** everything the decision needs in one `ctx.db.batch` round trip.
  2. **Decide** by calling the core with plain data, plus `new Date()` and `uuidv7()` when the
     core needs a time or an id.
  3. **Write** what the core returned in one `ctx.db.batch` round trip. When a concurrent write
     could change the decision, read, decide and write inside one `ctx.db.transaction`. The core
     call is the same.
  4. **Effects** come last: `ctx.sendMail`, `ctx.revokeConnections`, `ctx.log`. Events dispatch
     on their own after the handler returns.

  An `if` in a handler can branch on the result of I/O (no row → `not_found`). It can't hold a
  business rule (an archived customer can't get new jobs). A business rule goes in the core.

- **Type the core's inputs structurally**, with its own small types or contract types, never
  `@template/db` row types. A Drizzle row with those fields passes as it is, so the shell maps
  nothing.
- **Pure code the browser also needs goes in `packages/contracts`**, so the screen and the
  server can't disagree. That covers which transitions a status allows, a price calculation, or
  how to describe a trigger. Examples: `roleCan` and `permissionsOf` (`permissions.ts`),
  `flattenSteps` and `describeTrigger` (`automations.ts`). Contracts is already pure and
  imported by both.

```ts
// src/modules/customers/core.ts: the rule, with plain data in and a decision out
import { ActionError } from "@template/contracts";

export function archive(customer: { status: "active" | "archived"; openJobs: number }, now: Date) {
  if (customer.status === "archived")
    throw new ActionError("conflict", "This customer is already archived.");
  if (customer.openJobs > 0)
    throw new ActionError(
      "conflict",
      `Finish or cancel this customer's ${customer.openJobs} open jobs first.`,
    );
  return { status: "archived" as const, archivedAt: now, updatedAt: now };
}

// src/modules/customers/actions.ts: the shell (read, decide, write, effects)
export const archiveCustomer = defineAction({
  ...customersArchive,
  handler: async (ctx, input) => {
    const [customer, openJobs] = await ctx.db.batch((q) => [
      q.first(customers, eq(customers.id, input.customerId)),
      q.count(jobs, and(eq(jobs.customerId, input.customerId), eq(jobs.status, "open"))),
    ]);
    if (!customer) throw new ActionError("not_found", "That customer doesn't exist.");
    const change = archive({ ...customer, openJobs }, new Date());
    const [row] = await ctx.db.one((q) =>
      q.update(customers, change, eq(customers.id, customer.id)),
    );
    ctx.log.info("customer.archived", { customerId: customer.id });
    return toCustomer(row!); // core.ts: row → contract shape
  },
});
```

The same shape holds outside handlers:

- **Workflow steps** (`modules/automations/workflow.ts`): decisions come from step outputs, so
  replays decide the same way. Effects run inside `step.do` through `once()`.
- **Agents**: tools are actions, so the rules stay in the actions' cores. A prompt builder is a
  pure function of the context it's given.

**Existing code.** `profile` and `organization` are thin shells over `@template/auth`, which holds
their rules. `automations/core.ts`, `zapier/core.ts` and `assistant/core.ts` hold those modules'
rules, each tested in `test/<module>.core.test.ts`. They're the reference for a real module. The
automations step runtime (`interpreter.ts`, `executor.ts`) and the definition checks
(`validate.ts`) were ported whole. Their pure functions (`validateDefinition`, `delayEnd`, which
is given `now`, `allowedHttpUrl`) stay where they are for now. When you change one, move it into
`core.ts`. New modules start with a `core.ts`.

**Modules with their own services.** Automations, Zapier and the Assistant take a `Scope`. Their
actions build one with `scopeOf(ctx)` (`modules/automations/context.ts`), which reads
`ctx.runtime`. New modules don't need either: they use `ctx` itself.

**Tests.** Test the core directly, every branch, with plain objects
(`test/<module>.core.test.ts`). Test the shell once per path through the Worker
(`Browser` in `test/helpers.ts`) and over MCP. Include a second organization that never sees
the rows and a role that's refused.

## One capability, every surface

### Action or route?

Make it an **action** by default: anything a person does inside their organization. The contract
gives it the API endpoint, the MCP tool, `client.<module>.<name>()`, the Assistant tool, the
automation step and trigger, and `actions.schema.json` for native clients. Nothing is copied, so
nothing drifts.

- If agents mustn't run it, set `webOnly: true`. It stays an action, checked the same way. Never
  write a route to keep something out of MCP.
- If an agent should ask the person first, set `confirm: true`. If not every member may run it,
  set `permission`.

Make it a **route** (`src/routes/`) only when it can't be an action:

- it sets cookies or changes the session (auth, switching or creating a company, accepting an
  invitation);
- it works outside or across organizations;
- it's an inbound hook (`/hooks`, which is signed, with no session);
- it streams (`/agents`).

A route has no generator, so you keep its parts in step in the same change: the route (parse the
body with `body(c, Schema)`), the Zod schema in `packages/contracts`, the method and its types in
`packages/api-client/src/index.ts`, the screen, and a server test.

The routes today are auth, creating and switching companies, invitations before joining, the
person's connected apps (`/api/connections`, across companies), OAuth, `/hooks` and `/agents`.
Automations, Zapier and the Assistant panel are web-only actions
(`modules/<module>/actions.ts`).

- **A large view** that's too big to mirror in Zod (an automation's detail, its catalog) can use
  `trusted<T>()` from contracts as its output. It's typed but not checked at run time. Use it
  only on web-only actions; every other output is a real schema.
- **A body over 16 KB** (an automation definition) needs `maxInputBytes` on its contract.

### Adding an action

The steps are in `docs/adding-a-module.md`. In short:

1. Contract and `ACTIONS` entry: `packages/contracts/src/actions.ts`.
2. Scope: `scopes.ts`. Permission and its roles: `permissions.ts`, plus its refusal in
   `src/actions/permissions.ts`.
3. Handler and core: `src/modules/<module>/`.
4. Registry entry: `src/actions/registry.ts`.
5. The tool-name list in `packages/contracts/test/contracts.test.ts`.
6. `pnpm --filter @template/contracts build` to regenerate `actions.schema.json`.
7. The screen.
8. Seeds.
9. Tests.

### Changing or removing an action

An action's contract is a public API. MCP clients cache its tool name and schema. Native clients
generate types from `actions.schema.json`. Published automations store its id, map inputs onto
its input fields, read its output fields as `trigger.data`, and start on its event ids.

- **Safe:** add an optional input field or an output field, loosen validation, or make the
  description more accurate.
- **Breaking:** rename or remove the action, an event, an input or an output field; make an
  input required; tighten validation; or change what a field means. Expand, then contract:
  1. Add the new action or field next to the old one.
  2. Move the screens, seeds and any automations onto it.
  3. Remove the old one in a later change.

  Tell the person which published automations could break. Publish validates a definition, but
  a run whose action or field has since gone fails at that step.

- **Who can reach it:** a change to `scope`, `permission`, `confirm`, `readOnly` or `webOnly`
  changes who can call it and how agents treat it. Say so in the PR.
- **The description is the prompt.** `title` and `description` are what Claude and ChatGPT read
  to decide whether to call the tool. Update them whenever its behavior changes.

To remove an action, remove all of these:

- the contract and its `ACTIONS` entry;
- the handler and its registry entry;
- its name in the tool-name test;
- its permission, if nothing else uses it;
- its client calls (typecheck finds them);
- seeded automations and events in `packages/tooling/src/seed-automations.ts`;
- tests, docs and specs that mention it.

Then regenerate `actions.schema.json`. Search for every spelling: `rg "customers\.archive|customers_archive|customer\.archived"`.

### What catches drift, and what doesn't

These checks catch it:

- `registryProblems()` (`test/pipeline.test.ts`): a contract with no handler, or a handler with
  no contract.
- The `actions.schema.json` and tool-name tests in `packages/contracts`.
- Typecheck, through the client's types, which come from `ActionId`.
- `pnpm check:permissions`.
- The per-role tool list in `test/organizations.test.ts`.

Nothing catches these, so check them yourself:

- route-based endpoints drifting from their client methods and screens;
- descriptions that no longer match behavior;
- seeds and specs that name a changed action or event.
