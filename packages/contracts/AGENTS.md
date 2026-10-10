# Contracts

The base package. Everything else imports it, and it imports no other workspace package. It
holds:

- **Zod schemas** (`schemas.ts`, `ai.ts`, `automations.ts`, `zapier.ts`). Every request and
  response shape, shared by server, client and screens. Validation messages are written for the
  person.
- **Action contracts** (`actions.ts`), one per capability. Web-only actions with large views use
  `trusted<T>()` as their output, typed but not checked at run time. The server, the MCP tools, the API
  client, the Assistant, automations and `actions.schema.json` are all derived from them.
  `apps/server/AGENTS.md` says when to add, change or remove one, and what breaks.
- **Scopes, permissions, errors, limits and `METRIC_SCHEMA`.** Which roles hold a permission is
  decided only in `permissions.ts`.
- **Pure rules that the screens and the server share**, such as `roleCan`, `permissionsOf`,
  `flattenSteps` and `describeTrigger`. A rule both sides need goes here once, so they can't
  disagree.

Everything here is pure. It does no I/O, takes no time or randomness it isn't given (except
`uuidv7()`, which the shell calls), and has no React.

After changing an action contract, run `pnpm --filter @template/contracts build` to regenerate
`actions.schema.json`, and update the tool-name list in `test/contracts.test.ts`. Tests fail
while either is stale. Native clients generate their types from that file, so a breaking change
to a contract is a breaking change for them too.
