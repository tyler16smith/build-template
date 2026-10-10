# Screens

Every screen, as a component that a shell (`apps/web`, or a future desktop app) renders. The
root `AGENTS.md` UI rules and `packages/ui/GUIDE.md` apply. Screens are platform-free: they reach
the outside only through `useApi()`, `useNav()` and `useSession()` (`src/context.tsx`).

## State

**The server is the source of truth.** There's no client store and no query cache: no Redux,
Zustand, React Query or SWR. Don't add one. State lives in four places:

| State                                                           | Where it lives                                      | How to use it                                                                                                                                                                                                                        |
| --------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The person, their companies, the open one and their permissions | `useSession()`, loaded once from `GET /api/session` | Read it; don't fetch it again. After a write that changes something it holds (a name, the company's name), call `refresh()`. When a call returns a `SessionView` (switch, create, accept an invite), call `apply(view)`.             |
| The data a screen shows                                         | The screen, loaded on mount                         | `useLoad(load, key)` (`src/use-load.ts`): it reloads on `dataVersion`, keeps shown data on a failed refresh and polls on request. Older screens hand-roll a `load` callback with `dataVersion` in its effect; new ones use `useLoad` |
| Form and interface state                                        | `useState` in the lowest component that owns it     | `useSubmit(action)` for a submit: `pending`, per-field `fields` errors and a form `error`                                                                                                                                            |
| Where the person is                                             | The URL, through `useNav()`                         | `nav.path` and `queryParam(nav.path, name)`. A tab, filter or selected record that should survive a reload or be shareable goes in the query string                                                                                  |

- **After a write**, apply the result the action returned (actions return the changed record)
  with `useLoad`'s `update`, which costs no request. Reload the screen's data only when the
  result doesn't say everything. Never patch the same record in several places by hand. If the write
  changes something the session holds, also call `refresh()`.
- **Every effect that loads data lists `dataVersion`.** It goes up when the Assistant writes or
  the open company changes, and that's how those changes reach the screen.
- **Load a page's data in as few calls as possible.** Ask for an action that returns what the
  page needs (one batch on the server) rather than chaining calls in the screen.
- **Poll only while something is in progress:** a run, or a connection waiting for its first
  event. Use `useLoad`'s `pollMs` with `shouldPoll`.
- **Optimistic updates only when waiting would feel broken.** Roll back and reload on an error.
- **Browser storage** (`localStorage`) is for per-device conveniences only, like a dismissed
  intro. Never use it for data, or for anything that must follow the person to another device.

## Functional core, imperative shell (the client side)

Components connect state to pure functions. They don't hold rules.

- **The server decides.** A screen only hides what the person can't do: `useCan(permission)`,
  never a role comparison. The action refuses anyway.
- **A rule the screen and the server both need** lives once, as a pure function in
  `@template/contracts`. For example: which statuses a job can move to, a total, a description of
  a trigger. The server's core and the screen both call it, so they can't disagree.
- **Display logic** belongs in a `model.ts` next to the screen: formatting, grouping, sorting,
  labels, tones, what an empty or partial record shows. These are pure functions, tested without
  rendering. `src/automations/model.ts` is the example.

## Wiring a screen

- Export it from `src/app-entry.ts` and add its nav item in `src/app/layout.tsx`. Add its route
  under `app` in `apps/web/src/router.tsx`.
- Call `useAssistantPageContext({ title, summary, selection })` with only what the screen shows.
- Words: say what `ORGANIZATION_NOUN` says (`src/brand.ts`). Errors from the server are already
  written for the person; show them with `errorMessage(error)`.
- Tests: `test/screens.test.tsx` renders screens with `createApiClient({ fetch })` given a fake
  `fetch`. Test the `model.ts` functions directly.
