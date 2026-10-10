# desktop app

A placeholder: the template doesn't include a desktop app. Add one in an app built from the template
when that app needs it, not in the template itself. It reuses the server, the
OAuth flow and the actions (SPEC.md, "Shared UI and future clients"): a desktop shell provides its own `useApi` and `useNav` and renders `@template/screens`.
