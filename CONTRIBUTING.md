# Contributing

Thanks for helping improve the template. This repository is the template itself, so changes
here should help every app built from it: fixes, better defaults, and generic capabilities. A
feature for one product belongs in that product's own copy (README, "Your own template, then an
app").

## Before you start

- Read [`AGENTS.md`](AGENTS.md). Its rules apply to people as much as to agents, and the folder
  guides it links to cover each package.
- For anything structural (a new package, a new surface, a change to tenancy or auth), read
  [`SPEC.md`](SPEC.md) and open an issue first, so we can agree on the shape before you write it.
- Run it locally with the README's **Quickstart**. You don't need Cloudflare, Neon or GitHub
  secrets to develop or to pass CI on a pull request.

## Making a change

1. Fork the repository and branch from `main`.
2. Keep it generic: no product names, product modules, tables or screens. Demo rows stay in the
   Three Pigs voice (`packages/tooling/src/seed.ts`).
3. A new capability is an action, not a route (AGENTS.md, "Actions"). An action's contract is a
   public API: add optional fields freely, but rename or remove only in steps.
4. Migrations are numbered, append-only and expand-only (`packages/db/AGENTS.md`).
5. Run CI's checks before you open the pull request:

   ```bash
   pnpm format && pnpm typecheck && pnpm test
   ```

   ```bash
   pnpm check:migrations && pnpm check:boundaries && pnpm check:permissions
   ```

6. In the pull request, say what changed and why, and how you tested it. Update the README,
   `SPEC.md` or the folder guides in the same change when what they say is no longer true.

## Security issues

Don't open a public issue for a vulnerability. See [`SECURITY.md`](SECURITY.md).

By contributing, you agree that your contributions are licensed under the MIT License
([`LICENSE`](LICENSE)).
