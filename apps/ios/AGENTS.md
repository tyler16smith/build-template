# iOS app

A placeholder: the template doesn't include an iOS app. Add one in an app built from the template
when that app needs it, not in the template itself. It reuses the server, the
OAuth flow and the actions (SPEC.md, "Shared UI and future clients"): native code in Swift, with types generated from `packages/contracts/actions.schema.json` and OAuth with PKCE and a custom-scheme redirect.
