# UI guide

`@template/ui` is the design system every screen uses. It started as a copy of Custombase's
`@custombase/ui` and now evolves here. Using it keeps screens consistent, themed (one brand
accent, light and dark) and accessible. Import everything from `@template/ui`.

`ui` is the bottom of the UI stack: it imports no other workspace package, never calls `fetch`
and never reads `window.location` (`pnpm check:boundaries`), so a desktop shell can reuse it.

## Tokens

Colors come from semantic tokens exposed as Tailwind colors. Never hard-code hex values or use
Tailwind palette colors (`bg-blue-500`) for UI chrome; the brand accent and dark mode flow
through the tokens.

| Purpose            | Classes                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Page and panels    | `bg-background`, `bg-surface`, `bg-surface-raised`, `bg-surface-sunken`                                                         |
| Text               | `text-foreground`, `text-muted-foreground`                                                                                      |
| Brand (the accent) | `bg-primary text-primary-foreground`, `text-primary`                                                                            |
| Neutral fills      | `bg-muted`, `bg-secondary text-secondary-foreground`                                                                            |
| Borders and inputs | `border-border`, `border-border-strong`, `border-input`                                                                         |
| Status             | `text-danger` / `bg-danger-soft`, `success`, `warning`, `info` (each with `-soft`)                                              |
| Focus              | `outline-ring` on controls. In-place text uses `inlineFieldClass`: a light accent ring (`outline-ring-soft`) outside the radius |

Radii are `rounded-sm|md|lg|xl`; shadows `shadow-sm|lg`. Labels on cards use the nine label
colors via `ColorLabel` / `LABEL_COLOR_CLASSES` (`gray red orange yellow green teal blue purple
pink`).

## Components

- **Actions**: `Button` (`variant`: `primary` · `secondary` · `outline` · `ghost` · `destructive` ·
  `link`; `size`: `sm` · `md` · `lg` · `icon` · `icon-sm`; `loading`). Icon-only buttons need an
  `aria-label`. One primary button per view.
  `loading` disables the button and shows a spinner in the button's text color, so it stays
  visible on the accent. Don't put a `Spinner` inside a button yourself.
- **Forms**: wrap every control in `Field` (`label`, `hint`, `error`) — it wires `id`,
  `aria-describedby` and `aria-invalid`. Controls: `Input`, `Textarea`, `Select`, `Combobox`,
  `Checkbox`, `Switch`. Use `Combobox` when the list is long enough to search (accounts, people).
  Use `Select` for a short fixed list. A select keeps its chosen option on one line and
  ellipsizes when the label is wider than the control. Its list opens in line with the
  trigger, the chosen option over the button, not below it.
  Use `MultiSelect` to pick several options (`value: string[]`); it stays open while choices
  change. Pass `allLabel` for a first row that stands for every option (an empty `value`), and
  `variant="outline"` for a compact, transparent trigger inside a toolbar or search field.
  - Help text goes in `hint`, which shows as an info icon beside the label. Never put gray helper
    text under a control: it makes fields of different heights and pushes the label and input up
    out of line with the fields next to it. Keep hints to a sentence or two of supplementary help
    (format, an example, what a setting means). For a label outside `Field` (a section or column
    heading), use `InfoTip` directly.
  - Don't hand-roll a muted `<p>` under a control, and don't add margins to line up neighbours
    with a field's helper text.
  - Anything the person must see stays visible: validation messages go in `error`; warnings and
    required next steps ("Connect Google first") go in an `Alert`; "optional" goes in the label
    (`Logo URL (optional)`).
  - Toggle rows (a `Switch` or `Checkbox` with a title and description beside it) and a
    section's own description keep their visible text. They don't push a control out of line.
- **Submit shortcut**: ⌘+Enter on macOS and iOS, Ctrl+Enter on Windows, Linux and everything
  else, runs the primary action of the view the person is in. `ThemeProvider` installs it; there
  is nothing to wire per button. Don't write your own ⌘/Ctrl+Enter handlers.
  - The view is the nearest `<form>`, `DialogContent`, `SheetContent` or docked `SidePanel`
    around the focused element. Outside every view (a page's search box) nothing happens.
  - In a form it submits through the form's submit button (`type="submit"`), and does nothing
    while that button is disabled or loading, exactly like Enter. Otherwise it clicks the
    view's one enabled `primary` `Button`; with none or several it does nothing.
  - So: put a view's fields in a `<form onSubmit>` with a `type="submit"` primary `Button`, or
    give a dialog a single primary `Button`. Inline editors (add a card, a comment) are forms
    too.
  - Destructive buttons are never picked on their own. Pass `submitShortcut` to opt one in
    (a confirmation), or `submitShortcut={false}` to keep a primary button out.
  - A component that owns Enter (the chat composer) handles it and calls `preventDefault`.
  - Show the chord with `submitShortcutLabel()` ("⌘↵" or "Ctrl+Enter") in a `Kbd`, never a
    hard-coded "⌘".
- **Overlays**: `Dialog` + `DialogContent` + `DialogFooter`, `SheetContent` (side panel),
  `DropdownMenu*`, `Popover*`, `Tooltip`. They trap focus and restore it on close. A
  `DropdownMenuSubTrigger` shows a trailing chevron for the nested menu; don't add another one.
  - `SheetContent` is the side panel, on the right by default or the left with `side="left"`.
    It slides in from that edge and back out on close. It sits 5px in from the screen and has
    rounded corners; don't pin one flush to the viewport. Leave it mounted under `Dialog` so
    the close slide can play. The app shell's small-screen navigation and a docked `SidePanel`
    use the same inset and radius.
    Its body scrolls and is padded to line up with the header, so pass content straight in
    without adding your own padding. Pass `flush` only when the body lays itself out edge to
    edge, such as a form with a pinned footer or a chat.
- **Display**: `Card`/`CardHeader`/`CardBody`, `Table`/`THead`/`TBody`/`TR`/`TH`/`TD`, `Tabs*`,
  `Badge`, `Avatar`/`AvatarStack`, `Alert`, `Kbd`, `Skeleton`, `Separator`.
- **Page patterns**: `PageHeader` (renders the page's single `h1`, a description and actions),
  `EmptyState`, `LoadingState`, `ErrorState` (`error`, `onRetry`), `PermissionState`,
  `FilterBar`, `ActivityItem`, `formatRelative(date)`.
- **App shell**: `AppShell` frames a signed-in app. `brand` is the name and logo while the
  sidebar is open; `brandMark` is the logo alone, shown in the collapsed rail (hovering it
  reveals the control that opens the panel). The collapsed state is remembered. The sidebar is
  inset 5px with rounded corners, on desktop and in the small-screen drawer. The drawer slides
  in from the left over the page. There is no
  top bar on desktop: `actions` (account, notifications, a primary New button) sit in a
  row at the very bottom of the sidebar, below `footer`, and stack in the collapsed rail, where `useSidebarRail()` is
  true so a button can drop its text for an icon and a `Tooltip`. Those rail tooltips open to the right of the icon. Open their menus with
  `side="top" align="start"`. Appearance (light, dark, or system) is `AppearanceMenu`, nested
  in the account menu. Pages get the full window height, with extra space under the last block
  so it doesn't sit on the window edge or under the Ask AI button. A page that fills the window
  (a board, a builder) sets `data-fill-screen` on its root, and that space is omitted. Search all
  (also ⌘K / Ctrl+K) lists the pages in `nav`. Pass `search.items` for actions and
  `search.results` for records you have already matched to the query from `onQueryChange`.
  A result with `href` navigates like a sidebar link, including opening in a new tab.
- **Feedback**: `toast(title, { description, tone })` with `Toaster` mounted once by the shell.
  Add `actions` (`{ label, onClick }` or `{ label, href }`) only when there is a next step, such
  as "Request review"; a toast with actions stays up longer.
- **Chat** (any conversation or AI surface: the Ask AI Assistant and the Automation Builder, `specs/ai.md`):
  - `ChatThread` is the scrolling column. It follows new content unless the person scrolled up;
    pass `pinKey` (the number of sent messages) so sending scrolls back down.
  - `ChatMessage role="user"` with a `ChatBubble` for the person; `ChatMessage role="assistant"`
    with `ChatText` (Markdown set for chat) for replies, and `actions` such as `CopyButton`.
  - `ChatSteps` is the thinking line: while `active` it shows the current step's `cover` (one to
    five words, "Searching your jobs") in `ShimmerText`; afterwards it settles to a `summary`
    ("Thought for 6s") that opens every step with its detail. `ChatPending` is the line before a
    reply arrives. `stepCover(title, state)` turns "List cards" into "Listing cards" while it runs.
  - `ChatWelcome` starts a new conversation (title, description, suggestions); `ChatComposer` is
    the message box, with `leading` toolbar buttons (`ChatComposerButton`) and `trailing` ones
    such as `ModelPicker`; `ChatApproval` asks before a consequential action; `ChatError` shows a
    failed reply with retry.
  - Any text that says work is in progress uses `ShimmerText`, never a spinner beside "Thinking…".
    Don't hand-roll bubbles, tool badges or composers.
  - Screenshots and attached images use `LightboxImage`. A click opens the picture over the app.
- **Markdown**: `Markdown` renders model output safely (no raw HTML, images shown as links): headings,
  nested and task lists, fenced code with a copy button, tables, quotes, strikethrough, and links
  that open in a new tab. Bare URLs link with a short label and wrap instead of widening the page.

## Page recipe

Screens live in `packages/screens` and get the API through `useApi()` (never `fetch`):

```tsx
import { Button, Card, EmptyState, ErrorState, LoadingState, PageHeader } from "@template/ui";
import { useEffect, useState } from "react";
import { errorMessage, useApi } from "../context";

export function CustomersScreen() {
  const api = useApi();
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    api.customers
      .list()
      .then((r) => setCustomers(r.customers))
      .catch((e) => setError(errorMessage(e)));
  useEffect(() => void load(), []);
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-6 p-6">
      <PageHeader
        title="Customers"
        description="Everyone you do work for."
        actions={<Button>Add customer</Button>}
      />
      {error ? (
        <ErrorState error={new Error(error)} onRetry={load} />
      ) : !customers ? (
        <LoadingState />
      ) : customers.length ? (
        <Card>…</Card>
      ) : (
        <EmptyState title="No customers yet" description="Add the first one to start a job." />
      )}
    </div>
  );
}
```

## Accessibility checklist

- One `h1` per page (`PageHeader`); headings in order below it.
- Everything works with the keyboard; focus is always visible (don't remove outlines).
- ⌘/Ctrl+Enter submits every form and dialog (see Submit shortcut).
- Every input has a visible label (`Field`); errors are text, not color alone.
- Text contrast meets WCAG AA; use `readableForeground(hex)` for text on custom colors.
- Motion uses the `animate-ui-*` utilities, which are disabled under `prefers-reduced-motion`.
- Lists of actions are real `button`s or links, never clickable `div`s.
