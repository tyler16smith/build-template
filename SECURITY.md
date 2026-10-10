# Security

The template handles sign-in, sessions, OAuth for MCP clients, and organization isolation with
row-level security, so security reports are taken seriously.

## Reporting a vulnerability

Report it privately through GitHub: the repository's **Security** tab → **Report a
vulnerability**. Please don't open a public issue, pull request or discussion about it.

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a
reply within a week. Once a fix is ready, we'll publish an advisory and credit you unless you'd
rather we didn't.

## Scope

In scope: the code in this repository, especially authentication and sessions (`packages/auth`,
`apps/server/src/routes`), OAuth and `/mcp`, tenant isolation (`packages/db`, the migrations'
RLS policies), the Assistant and automations running actions as a person, inbound hooks, and
secret handling (`apps/server/src/lib/seal.ts`, log redaction).

Out of scope: apps built from the template (report those to their owners), and deployments you
don't own. Don't test against anyone else's deployment.

## Supported versions

Only `main` is supported. Apps built from the template should merge template fixes from
`upstream` (README, "Your own template, then an app").
