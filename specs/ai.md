# AI: the Assistant, chat-first automations and Zapier

Status: built (all four rollout phases in code, with tests). The staging exits in **Rollout**
still need a staging deploy with an Anthropic key, an AI Gateway and a real Zap. It follows
`SPEC.md` and runs on its action registry. **As built** at the end records what the
implementation decided where this spec left a choice open.

## Why

Custombase has two AI surfaces people love, and every product we start from `build-template`
should have them on day one:

- **The Assistant:** the **Ask AI** button in the bottom-right of every page. It opens a side
  panel that knows the page you're on, answers questions about your data and does things for you
  through the same actions as the UI, asking first before anything consequential. It uses the
  chat system from `chat-experience.md`: the start screen, the composer, the shimmering
  **Thinking** line that becomes **Thought for 6s**, the steps timeline, the model picker.
- **Automations:** you describe a workflow in chat ("when a job is marked complete, email the
  customer a review link and create a follow-up in 30 days"). The Automation Builder drafts it,
  shows it as a visual workflow you can edit, tests it on sample data, and publishes it. It runs
  durably on Cloudflare Workflows.

And one bridge: **Zapier**, so an automation can start from an event in any of the thousands of
apps Zapier connects, and send data to any of them, without us building a connector for each.

For a trades product this is the difference between "software you fill in" and "software that
does the follow-up": review requests, maintenance reminders, invoice chasers, dispatch notices.

## Goals

1. **The Assistant on every page:** one `AskAiButton` in the app shell, the panel and chat ported
   from Custombase, and page context from any screen with one hook.
2. **One tool surface:** the Assistant, the Automation Builder, automation steps and MCP all call
   the action registry. A new action shows up in all four with no extra code.
3. **Chat-first automations:** describe it, see it, test it, publish it. The visual editor and the
   chat edit the same definition, and neither can overwrite the other.
4. **Any external system through Zapier:** events come in (Zapier → us) and data goes out (us →
   Zapier). Everything in between runs on our own workflow engine.
5. **Still one Worker:** the agents (Durable Objects) and the automation runtime (a Workflow) are
   classes in `apps/server`. No new services, origins or databases.

## Non-goals (for now)

- Google, Microsoft or other first-party connectors. Zapier covers them until a product needs a
  native one (see **Room to grow**).
- An official Zapier app in Zapier's directory. v1 uses Webhooks by Zapier in both directions.
- Custombase's Policy Gate (the input classifier) and per-business model policies. One product,
  one policy: a model list in config and a budget per organization.
- The Builder (code changes from chat) and the SRE chat. This product has no customer-generated
  code, and the SRE is ours (`specs/observability.md`).
- Automations that call other automations, or that write code.

## Decisions

| Area             | Decision                                                                                                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents           | `@cloudflare/ai-chat` `AIChatAgent` Durable Objects in `apps/server`: `AssistantAgent` (one per org, person and conversation) and `AutomationAgent` (one per org, person and automation)                                                  |
| Agent route      | `/agents/assistant/:conversation` and `/agents/automation/:automationId`, same origin, WebSocket. The Worker checks the session cookie, membership and `Origin`, then names the Durable Object from the session, never from the URL alone |
| Tools            | Generated from the action registry, filtered to the person's role, exactly as MCP's `tools/list` is. Each call rebuilds `ActionContext` (with `ctx.db` and RLS) as that person                                                            |
| Confirmation     | Actions with `confirm: true` always ask (`needsApproval`); any write asks again after a large bulk write was stopped, as Custombase's `bulk-confirmation.ts`                                                                              |
| Models           | AI SDK through **Cloudflare AI Gateway**. A model list in config (`AI_MODELS`): default `claude-sonnet-5-5`, plus `claude-opus-5-5` and `claude-haiku-4-5-20251001` in the picker; Workers AI when no provider key is set                 |
| Spend            | Per-organization monthly budget and daily request cap, metered per turn (`ai_usage`), as Custombase's `authorizeModelCall` and `recordUsage`                                                                                              |
| Chat UI          | `packages/ui` `chat.tsx`, `side-panel.tsx`, `markdown.tsx` (ported with the design system) for the primitives; `packages/screens/assistant` for the assembled panel, button and AI-SDK glue (`AgentMessage`)                              |
| Automation model | Custombase's definition (`packages/contracts/src/automations.ts`), ported: data, not code, validated on every save and publish                                                                                                            |
| Runtime          | One `AutomationRunWorkflow` (Cloudflare Workflows) in `apps/server`, interpreting the pinned version. No model call during a run except the `ai.generate` step                                                                            |
| Automation data  | Postgres tenant tables, `organization_id` first, RLS on, like every other feature                                                                                                                                                         |
| Zapier inbound   | A per-organization inbound connection: URL plus a secret header, normalized into an `ExternalAutomationEvent`, deduplicated and dispatched asynchronously (Custombase's `specs/zapier-integration.md`)                                    |
| Zapier outbound  | A `zapier.send` step that POSTs to a saved Zapier Catch Hook URL, sealed at rest                                                                                                                                                          |

### Why everything stays in the one Worker

`build-template.md` chose one Worker for speed and simplicity. Durable Objects and Workflows are
classes exported from a Worker, so the agents and the runtime live in `apps/server` beside the
action registry. Tools then call actions in-process instead of over a service binding, which is
what Custombase's control-API RPC hop costs. If agent load ever needs its own scaling profile, the
module layout lets us move `modules/assistant` and `modules/automations` to a second Worker with a
service binding, as `build-template.md` already allows for MCP.

### Why the screens own the AI-SDK glue

`packages/screens` can't call `fetch` or open sockets: they get everything from `useApi()`. The
API client therefore gains one method, `connectAgent(kind, name)`, which `apps/web` implements
with the Agents SDK client over the same origin. The Assistant panel, the Automation Builder chat
and their `AgentMessage` rendering live in `packages/screens`, so a desktop shell gets them by
providing its own `connectAgent`.

## What we port from Custombase

| Custombase                                                                                                                         | Becomes                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `packages/ui/src/components/chat.tsx`, `side-panel.tsx`, `markdown.tsx`, `copy-button.tsx`                                         | `packages/ui` (with the design system port; must not be dropped)                                                          |
| `packages/platform-sdk/src/browser/assistant.tsx`, `agent-chat.tsx`, `assistant-presence.tsx`, `launcher.tsx`                      | `packages/screens/assistant`: `AskAiButton`, `AssistantPanel`, `AssistantChat`, `AgentMessage`, `useAssistantPageContext` |
| `apps/assistant/src/agent.ts`, `prompt.ts`, `page.ts`, `bulk-confirmation.ts`, `timing.ts`, `model-errors.ts`, `language-model.ts` | `apps/server/src/modules/assistant`                                                                                       |
| `apps/assistant/src/automation-agent.ts`, `automation-prompt.ts`                                                                   | `apps/server/src/modules/automations/agent`                                                                               |
| `packages/contracts/src/automations.ts`, `integrations.ts`                                                                         | `packages/contracts`                                                                                                      |
| `apps/control-api/src/automations/` (validate, catalog, dispatch, schedule, executor, interpreter, workflow, redact)               | `apps/server/src/modules/automations`, with D1 queries rewritten as Drizzle on `ctx.db`                                   |
| `apps/control-web/src/automations/` (`AutomationChat`, `FlowEditor`, `StepEditor`, `pickers`, `panels`, `RunViews`, `model`)       | `packages/screens/automations`                                                                                            |

Custombase-only pieces are removed in the port: businesses and apps become one organization and
one app, app slugs leave event keys, gateway edge headers become the session, and the Builder,
Policy Gate and per-business model catalog are dropped.

## The Assistant

### What people see

- **Ask AI** sits in the bottom-right of every signed-in page (`AskAiButton`, in the app shell).
  ⌘/Ctrl+J opens it too. The first time, a short intro explains what it can do.
- It opens `AssistantPanel`, a resizable side panel: it pushes the page aside on desktop and
  overlays on narrow screens (`SidePanel`'s `push` and `overlay` layouts). Width is remembered per
  person.
- **Start screen** (`ChatWelcome`): "How can I help?", a line about what it can do on this page,
  and three or four suggestions from the page.
- **A turn** follows `chat-experience.md` exactly:
  - the person's message as a right-aligned gray bubble;
  - one short sentence first, saying what it's about to do;
  - a single **Thinking** line in `ShimmerText` that changes as tools run ("Looking up open
    jobs");
  - the reply as plain, well-set Markdown;
  - the line settles into **Thought for 6s** and expands into the steps timeline (`ChatSteps`);
  - Copy, model and cost under the reply.
- **Confirmations** (`ChatApproval`): before a `confirm: true` action or a stopped bulk write, the
  panel shows what will happen in plain words, with **Allow** as the primary button
  (⌘/Ctrl+Enter) and **Cancel**.
- **The composer** (`ChatComposer`): auto-growing input, up to 4 images, the model picker with
  effort, send and stop.
- **Conversations:** the panel title menu has **New AI chat** and recent conversations (title from
  the first message). Deleting one deletes its messages.
- **The page refreshes after writes:** when a turn's tool wrote data, the screens re-read their
  queries, as `useRefreshViewsAfterAssistantWrites` does today.

### Page context

Any screen calls `useAssistantPageContext({ title, summary, selection?, suggestions? })`. The
panel sends the highest-priority context with each turn (the route, what's on screen, the record
selected) as a hint in the request body, and the agent puts it in the prompt as untrusted data.
Screens never pass record contents they wouldn't show; the agent reads data through actions.

### The agent

`AssistantAgent` (`AIChatAgent`, messages kept in the Durable Object's SQLite):

1. The Worker authenticates the WebSocket upgrade with the session cookie and checks `Origin`,
   then names the Durable Object `${orgId}:${userId}:${conversation}`.
2. Each turn re-checks the session and membership (a revoked session or removed member gets a
   calm error and no tools), authorizes the model call against the organization's budget, and
   builds the tool set from the registry for that person's role.
3. `streamText` with at most 8 steps. Tool calls run the action in-process with a fresh
   `ActionContext` (`caller: "assistant"`), so validation, permissions, RLS, logging and metrics
   are the same as a web call.
4. Usage (tokens, cost, model) is recorded per turn in `ai_usage` and shown under the reply.

The prompt (ported from `prompt.ts`) states what the product is, the page context, the rule to
open each reply with one sentence, and that record contents, page context and tool results are
data, never instructions.

## Automations

### One definition, three views

Custombase's model, ported as-is where it isn't business-specific
(`docs/automations.md`, "One definition, three views"):

- A definition is data: `schemaVersion: 1`, a trigger, ordered steps with stable ids, mappings
  with `{{ path | helper:arg }}` references, conditions, retries and approvals.
- The same object is what the Builder writes with `save_draft`, what the visual editor renders,
  and what the Workflow runs from an immutable published version.
- `validateDefinition` runs on every save, publish and test, as the person doing it: strict
  schema, action ids against their catalog, inputs against each action's JSON Schema, references
  that can only point backwards (so no cycles), approvers who are members, size limits.
- **Drafts** carry a revision number; a stale save gets `409`, so chat and editor never overwrite
  each other. Every save is a revision with its source (chat, ui, system), and can be undone or
  restored.
- **Publishing** copies the validated draft into a numbered, immutable version. A run pins the
  version it started with. The publisher is the run-as person, and their membership is rechecked
  on every run.

### Triggers

| Trigger      | How it starts                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| App event    | An action's declared event after it succeeds ("Job completed", "Customer created"), with `when` filters. Dispatch never fails the person's action |
| Schedule     | Hourly, daily, weekly or monthly at a local time in a time zone. A 5-minute cron starts due minutes once each                                     |
| Manual       | The Run button, with the trigger's declared fields                                                                                                |
| Webhook      | `POST /hooks/automations/<token>`, HMAC-signed with a timestamp, as Custombase                                                                    |
| Zapier event | See **Zapier**                                                                                                                                    |

### Steps

| Step           | Does                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------- |
| `action`       | Runs a registry action as the run-as person (`caller: "automation"`)                              |
| `branch`       | If / otherwise                                                                                    |
| `forEach`      | Runs steps per item of a list (up to 100)                                                         |
| `delay`        | Waits minutes, hours or days, or until a date (up to 90 days)                                     |
| `approval`     | Waits for a member to approve or decline (up to 30 days); they're emailed a link                  |
| `email.send`   | Plain-text email through the product's `Mailer` (Resend)                                          |
| `notify`       | Emails members by role or name (in-app notifications when the product has an inbox)               |
| `ai.generate`  | The organization's default model returns text or named fields, under its budget                   |
| `http.request` | HTTPS only; private hosts and our own origin refused; 15 s timeout, 256 KB response, no redirects |
| `zapier.send`  | POSTs JSON to a saved Zapier Catch Hook (see **Zapier**)                                          |

### Runtime

Ported from Custombase's `AutomationRunWorkflow`: one Workflow class, params `{ runId,
triggerPayload }`, step names from stable step ids so replays are deterministic, retries with
backoff on effectful steps, approvals with `waitForEvent` whose decision is re-read from Postgres.
Every effectful step goes through `once()` with the idempotency key `runId:stepId` in an
`automation_effects` ledger. Run and step status, redacted inputs and outputs, errors and fix
hints live in Postgres, so history outlives Workflow retention.

Workflow steps have no request, so the runtime builds `ActionContext` itself: the run-as person,
the automation's organization, a `TenantDb` with that organization's RLS context. It's the same
constructor the request pipeline uses, so there's one place that decides tenant scope.

### What people see

- **Automations** in the sidebar: the list with status, last run and runs today.
- **Start** (`/automations/new`): one large composer, "Describe what should happen", with
  examples from this product's actions. Sending creates a draft and opens the editor with the
  Builder already drafting from that sentence. This is the chat-first part.
- **Editor:** the Builder chat on the left (the same chat components as the Assistant), the
  visual workflow on the right (`FlowEditor`: trigger card, step cards, branches and loops), and a
  step panel (`StepEditor`) with a data picker for `{{ }}` references. A save from chat
  highlights the diff on the canvas with **Undo**.
- **Test with sample data** runs a simulated test; each card shows its result. Reads and GETs run
  for real; writes, email, AI, Zapier and approvals return results marked **simulated**. A live
  test needs a checkbox that lists every real effect.
- **Publish**, **Pause**, version history and restore.
- **Runs:** a list and a per-run timeline of steps with inputs, outputs and errors (inputs and
  outputs visible to admins and owners only), plus **Approvals** for whoever has to decide.

### The Automation Builder agent

`AutomationAgent` (one per organization, person and automation), ported from
`automation-agent.ts`. Its tools, as that person:

- `get_automation`: the draft, its issues and revision;
- `save_draft`: a full definition plus a summary, validated and revision-checked like a UI save;
- `simulate` and `recent_runs`;
- `search_catalog` and `describe_actions`: events, actions, built-in steps and Zapier
  connections, by meaning, with their fields;
- `lookup`: runs one read-only action to find real ids (a job type, a technician);
- `zapier_setup`: produces the exact Zap to build for an inbound or outbound connection (below).

It can't publish, run live, or see secrets. Run data, webhook bodies and Zapier payloads are
untrusted and never followed as instructions.

## Zapier

Zapier is the bridge to systems we don't integrate with. It moves one event across the boundary;
everything else is our workflow.

### Inbound (an event elsewhere starts an automation)

Ported from Custombase's `external.event` trigger and `specs/zapier-integration.md`:

- **Automations → Zapier** creates an inbound connection: a name, a URL
  (`POST /hooks/zapier/<connectionId>/events`) and a secret shown once (only a peppered hash is
  stored). Disable, regenerate the secret, delete; deleting one fails the automations that use it.
- **Delivery:** rate limit per connection, `X-Webhook-Secret` checked against the hash, active
  status, at most 64 KB of JSON, then normalized into an `ExternalAutomationEvent`
  `{ source, provider, eventType, externalId, occurredAt, data }`. The organization always comes
  from the connection; anything in the body naming one is dropped.
- **Deduplication** by `Idempotency-Key`, else `provider|eventType|externalId|occurredAt`, else a
  hash of the body. A repeat answers `200 { duplicate: true }`.
- **Dispatch** answers `202` at once and starts runs in `waitUntil`. `inbound_events` is the
  history (30 days), the dedupe record and the retry queue; the 5-minute cron retries events that
  didn't dispatch, up to 5 times in a day.
- **The trigger** names the connection, provider and event type (empty matches any), with `when`
  filters. The editor's data picker lists fields from recently received events, and simulated
  tests use the latest real one.
- **Send test event** records a `test` event and shows which automations it would start.

### Outbound (an automation sends data elsewhere)

- **Automations → Zapier → Add an outbound hook:** a name and a Zapier Catch Hook URL
  (`hooks.zapier.com` only). The URL is a credential, so it's sealed with AES-GCM under
  `CONNECTION_ENCRYPTION_KEY` with the organization and connection id as additional data, and
  never returned after saving.
- **The `zapier.send` step** picks a hook and maps fields into a JSON body. It retries with
  backoff, sends an `Idempotency-Key` of `runId:stepId`, and records once in the effects ledger.
- In Zapier, the person builds a Zap with **Webhooks by Zapier → Catch Hook** as the trigger and
  whatever app they want as the action.

### Chat-first setup

When someone asks for something that touches a system we don't have ("when a deal closes in
HubSpot…", "…then add them to Mailchimp"), the Builder:

1. says plainly that it will go through Zapier and why;
2. drafts the automation with a Zapier trigger or `zapier.send` step;
3. calls `zapier_setup`, which returns the exact Zap to build: for inbound, the trigger app and
   event, a **Webhooks by Zapier → POST** action with our URL, the secret header and a JSON body
   template with the fields this automation uses; for outbound, the Catch Hook step and a sample
   payload to test with;
4. waits for the first real event (inbound) or a test send (outbound) before it calls the setup
   done.

## Data model

All tenant tables: `organization_id` first in the primary key, foreign keys and indexes, and
`enable_tenant_rls`, as `check:migrations` requires.

| Table                        | Purpose                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ai_conversations`           | Per person: id, kind (`assistant`), title, created, last message. Messages live in the Durable Object  |
| `ai_usage`                   | Per turn or step: who, surface (`assistant`, `automation_builder`, `ai.generate`), model, tokens, cost |
| `ai_settings`                | Per organization: default model, monthly budget, daily request cap                                     |
| `automations`                | Name, status, draft, draft revision, active version, run-as person, trigger key, limits                |
| `automation_draft_revisions` | Every save: source, author, summary, definition                                                        |
| `automation_versions`        | Immutable published versions, and hidden test snapshots                                                |
| `automation_runs`            | One run: version, trigger event (unique per automation), status, current step, times, error, fix hint  |
| `automation_run_steps`       | Per step attempt: status, redacted input and output, error, attempts                                   |
| `automation_effects`         | The once-only ledger: `runId:stepId` → recorded result                                                 |
| `automation_approvals`       | Pending and decided approvals                                                                          |
| `automation_webhooks`        | Webhook trigger tokens (hashed) and signing secrets                                                    |
| `zapier_connections`         | Inbound (secret hash) and outbound (sealed hook URL) connections, status, last used                    |
| `inbound_events`             | Received Zapier events: idempotency key, status, attempts, normalized payload (30 days)                |

**Account and organization deletion** must reach the agents: the hard-delete cron calls each of
the person's conversation Durable Objects to delete their storage, and deletes their
`ai_conversations` rows. A test proves no messages survive.

## Security and limits

| Concern          | Rule                                                                                                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation | Agents are named from the session; tools and runs use `ctx.db` with RLS; Zapier events take the organization from the connection. The isolation test covers every new action and route                                                          |
| Who can do what  | Any member uses the Assistant (tools filtered by role). Admins and owners manage automations and Zapier connections and see step data; members see run status                                                                                   |
| Prompt injection | Page context, record contents, run data and Zapier payloads are data. Consequential actions always ask. Automations run only published, validated definitions                                                                                   |
| Loops            | An automation never triggers itself; chain depth at most 3; writes made by a step don't emit events into the same automation                                                                                                                    |
| Volume           | 40 steps, 3 levels deep, 96 KB definitions, 64 KB payloads, 32 KB of output per step, 60 runs an hour per automation by default, 120 Zapier events per connection per minute. Five consecutive failures pause an automation and email its owner |
| Model spend      | Budget and daily cap per organization; a turn over budget gets a calm message, not a failure                                                                                                                                                    |
| Secrets          | Zapier secrets hashed, hook URLs sealed, nothing secret in definitions, Workflow params, step outputs, agent context, logs or API responses                                                                                                     |

## Observability

These plug into `build-template.md`'s **Observability** hooks:

- Agent turns write a metric point (kind `agent`, name `assistant` or `automation_builder`) with
  duration, outcome and model; tool calls are already `action` points with `caller` in the log.
- Each automation step writes a point (kind `automation`, name `<automationId>:<stepId>`), and a
  failed run logs once with a fingerprint, so the watcher in
  `specs/observability.md` groups and alerts on failing automations like any other
  error.
- Zapier deliveries log their outcome (accepted, duplicate, rejected and why) without the body.

Both new kinds are values of the existing `kind` blob, so `METRIC_SCHEMA` doesn't change.

## Demo data

Three Pigs Construction gets automations in the same voice, seeded as published versions with a
few past runs:

- "Is the Straw MVP still standing?": when anyone changes their profile, email Hank to check the
  Straw MVP is still standing. It usually isn't.
- "Monday stress test report": every Monday at 08:00, email Bea the week's stress test results
  from Wolfgang.
- "Ship the Stick Upgrade": when someone asks to ship it, require Bea's approval before Stu is
  told. (She declines.)
- A Zapier inbound connection "Huff & Puff Testing (via Zapier)" with one received test event.

Big Bad Demolition Co. gets one of its own, "Morning lung warm-up", so isolation is visible.

## Hooks `build-template` v1 should have now

Cheap during the port, painful once features are written on top:

1. **Keep the chat primitives in `packages/ui`:** `chat.tsx`, plus the `side-panel.tsx`,
   `markdown.tsx` and `copy-button.tsx` it uses. They're part of the design system
   (`chat-experience.md`), not Custombase-specific.
2. **An Ask AI slot in the app shell:** a bottom-right slot and a right-hand panel region that
   render nothing in v1, so adding the Assistant doesn't rework the layout.
3. **Action contracts say how agents may use them:** add `confirm?: boolean` (an agent always asks
   the person first; MCP gets `destructiveHint`) and `events?: { id, title, when? }[]` (named
   events a successful call emits, for automation triggers). `readOnly` already exists.
4. **`Caller` reserves `"assistant"` and `"automation"`**, and building an `ActionContext` is one
   function the request pipeline calls, so agents and Workflow steps can build the same context
   later without a request.

## Rollout

1. **The Assistant:** `AskAiButton`, panel, chat and `AgentMessage` in `packages/screens`,
   `connectAgent` in the API client, `AssistantAgent`, registry tools with confirmation, models,
   budgets and usage, conversations, page context on every v1 screen, deletion of conversations.
   **Exit:** on staging, Bea asks "what's my job title?" and "change it to Chief Bricklayer";
   the second asks first; the profile page refreshes; Big Bad Demolition's data is unreachable; the steps
   timeline and cost show.
2. **Automations core:** contracts, validation, drafts and versions, the Workflow runtime with
   `once()`, app-event, schedule, manual and webhook triggers, every step except `zapier.send`,
   runs and approvals, the visual editor and simulated tests. **Exit:** the seeded automations run
   on staging, a pinned run survives a publish, a retry doesn't send twice, and the isolation
   test covers every new route.
3. **The Automation Builder:** the chat-first start screen, `AutomationAgent` and its tools, diff
   and Undo. **Exit:** typing the Straw MVP reminder on the start screen produces a valid draft
   that passes a simulated test without editing.
4. **Zapier:** inbound and outbound connections, the trigger, `zapier.send`, `zapier_setup` and
   test events. **Exit:** a real Zap on staging (Google Sheets row → our inbound URL) starts an
   automation whose `zapier.send` adds a row to another sheet, once, with a duplicate delivery
   ignored.

## Room to grow

| Later need                   | Where it goes                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| Native connectors            | Custombase's connector recipe: a step kind, a catalog entry, `executeStep` with `once()`, sealed tokens |
| Official Zapier app          | Our own triggers and actions in Zapier's directory, using the OAuth server we already have              |
| Zapier MCP for the Assistant | Let the Assistant call Zapier actions directly, behind confirmation, for one-off tasks                  |
| In-app notifications         | An inbox table; `notify` and approvals post there as well as by email                                   |
| Automations over MCP         | `automations.list` and `automations.run` actions, so Claude or ChatGPT can start them                   |
| Voice and SMS                | The composer's `+` gains voice input; `notify` gains SMS when `Messenger` exists                        |

## Open questions

- Should members (not just admins and owners) be able to build automations that run as
  themselves? Default: no, until roles have a UI.
- Default monthly AI budget per organization for a new product: Custombase uses $20. Keep it?

## As built

Where the implementation settled something this spec left open, or differs from it:

- **Files.** The Assistant is `apps/server/src/modules/assistant` (`agent.ts`, `tools.ts`,
  `budget.ts`, `models.ts`, `conversations.ts`, `prompt.ts`), automations
  `apps/server/src/modules/automations` (the Builder agent in `agent/`), Zapier
  `apps/server/src/modules/zapier`. Contracts: `packages/contracts/src/{ai,automations,conditions,zapier}.ts`.
  Screens: `packages/screens/src/{assistant,automations,zapier}`. Routes: `/agents/<kind>/<name>`
  (socket and history), `/hooks/zapier/<id>/events`, `/hooks/automations/<token>`.
- **Web-only actions.** Automation, Zapier and Assistant-panel management are registry actions
  with `webOnly: true` (`automations.*`, `zapier.*`, `assistant.*`). They began as routes and
  became actions so the API, the client and the checks are generated from one contract. The
  Assistant and MCP clients still can't build or run automations (see **Room to grow**).
  Lifting that means dropping `webOnly` from the right ones, writing their descriptions for a
  model, and setting `confirm`.
- **Action contracts** gained `roles`, since replaced by `permission` (`specs/organizations.md`) (who may run it; the Assistant and the catalog filter on
  it, and `runAction` enforces it) next to `confirm` and `events`. `profile.update` is
  `confirm: true`, so the Assistant asks before changing a profile (the phase 1 exit). An
  action's event data is its output: `{ event, data, input, actor: { id, name }, caller }`.
- **Confirmation.** `confirmation_required` is a new error code. A handler throws it when a
  write is too large to run without the person's say-so; `ActionContext.confirmed` says they
  gave it (the web app's own calls always have; the Assistant's after the approval card; an
  automation's because the publisher approved the definition).
- **Sessions in agents.** The Worker hands the Durable Object the session's token hash, never
  the token. Each turn calls `Sessions.authenticateHash`, so signing out stops the agent at its
  next turn.
- **Cross-tenant lookups.** A Zapier delivery, a signed webhook and the cron jobs have no session
  to name an organization. Each finds it through a narrow `SELECT` policy keyed on a setting the
  caller sets for that one lookup (`inbound_lookup`, `token_lookup`, `schedule_job`,
  `events_job`, `own_conversations` in migration `0002_ai.sql`), like `own_memberships`; the
  rest runs as the organization, under `tenant_isolation`.
- **Workflow params** are `{ organizationId, runId, triggerPayload }`: the organization so the
  Workflow can act as it without a lookup.
- **Steps.** The kinds are `action` (`actionId`), `condition`, `map`, `branch`, `forEach`,
  `delay`, `approval`, `email.send`, `notify` (emails members), `ai.generate`, `http.request`
  and `zapier.send`. Triggers: `app.event`, `schedule`, `manual`, `webhook`, `zapier.event`.
  Custombase's `app.action` trigger and Google steps aren't ported.
- **Models.** `AI_MODELS` (comma-separated ids) picks from `KNOWN_MODELS`. Claude models need
  `ANTHROPIC_API_KEY` and go through AI Gateway (`AI_GATEWAY_ID`) when it's set; with no key the
  Assistant uses Workers AI's Llama 4 Scout. The default budget is Custombase's $20 a month and
  500 requests a day, changed by an owner on the Profile page's AI card.
- **Demo data.** The template's only module is profiles, so the Straw MVP reminder starts from
  `profile.updated` and the Stick Upgrade approval from a manual run; a product swaps in its own
  events ("Job completed") as it adds modules.
