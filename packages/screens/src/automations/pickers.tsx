import type { AutomationCatalog, StepKind } from "@template/contracts";
import { Badge, cn, Dialog, DialogContent, EmptyState, Input } from "@template/ui";
import {
  Bell,
  Bolt,
  Brain,
  CalendarClock,
  Clock,
  Filter,
  Globe,
  Hand,
  Mail,
  Repeat,
  Search,
  Send,
  ShieldCheck,
  Shuffle,
  Split,
  Webhook,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";

export type PickerItem = {
  id: string;
  group: string;
  label: string;
  description?: string;
  icon?: LucideIcon;
  keywords?: string[];
  badge?: string;
  /** Shown instead of picking, e.g. "This deployment can't send email yet." */
  disabledReason?: string | null;
};

function score(item: PickerItem, words: string[]): number {
  if (words.length === 0) return 1;
  const label = item.label.toLowerCase();
  const rest = [item.group, item.description ?? "", ...(item.keywords ?? [])]
    .join(" ")
    .toLowerCase();
  // Every word counts; items matching more of them rank higher, so a phrase like
  // "every monday" still finds the schedule even though only "every" is a keyword.
  let total = 0;
  for (const word of words) {
    if (label.startsWith(word)) total += 3;
    else if (label.includes(word)) total += 2;
    else if (rest.includes(word)) total += 1;
  }
  return total;
}

/** Items matching the query, best first, grouped in the order the groups first appear. */
export function filterPickerItems(
  items: PickerItem[],
  query: string,
): { group: string; items: PickerItem[] }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = items
    .map((item, index) => ({ item, index, score: score(item, words) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => (words.length ? b.score - a.score : 0) || a.index - b.index)
    .map((m) => m.item);
  const out: { group: string; items: PickerItem[] }[] = [];
  for (const item of matches) {
    const existing = out.find((g) => g.group === item.group);
    if (existing) existing.items.push(item);
    else out.push({ group: item.group, items: [item] });
  }
  return out;
}

/**
 * A searchable list of things to add, grouped by kind. Typing filters every group at once;
 * arrow keys move and Enter picks.
 */
export function CatalogPicker({
  open,
  onOpenChange,
  title,
  description,
  placeholder,
  items,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  placeholder: string;
  items: PickerItem[];
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => filterPickerItems(items, query), [items, query]);
  const ordered = groups.flatMap((g) => g.items);

  const pick = (item: PickerItem | undefined) => {
    if (!item || item.disabledReason) return;
    onPick(item.id);
    onOpenChange(false);
    setQuery("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = Math.min(
        Math.max(active + (event.key === "ArrowDown" ? 1 : -1), 0),
        ordered.length - 1,
      );
      setActive(next);
      listRef.current
        ?.querySelector(`[data-index="${next}"]`)
        ?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      pick(ordered[active]);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery("");
      }}
    >
      <DialogContent title={title} description={description} size="lg">
        <div className="grid gap-3">
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              autoFocus
              aria-label={placeholder}
              placeholder={placeholder}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              className="pl-9"
              role="combobox"
              aria-expanded
              aria-controls="catalog-picker-list"
              aria-activedescendant={ordered[active] ? `pick-${active}` : undefined}
            />
          </div>
          <div
            ref={listRef}
            id="catalog-picker-list"
            role="listbox"
            aria-label={title}
            className="grid max-h-[55vh] gap-3 overflow-y-auto"
          >
            {groups.length === 0 ? (
              <EmptyState
                title="Nothing matches"
                description="Try other words, or describe it in the chat and the Builder will find the closest option."
              />
            ) : (
              groups.map((group) => (
                <div
                  key={group.group}
                  role="group"
                  aria-label={group.group}
                  className="grid gap-0.5"
                >
                  <p className="px-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    {group.group}
                  </p>
                  {group.items.map((item) => {
                    const index = ordered.indexOf(item);
                    const Icon = item.icon ?? Bolt;
                    return (
                      <button
                        key={item.id}
                        id={`pick-${index}`}
                        data-index={index}
                        type="button"
                        role="option"
                        aria-selected={index === active}
                        aria-disabled={Boolean(item.disabledReason)}
                        onMouseMove={() => setActive(index)}
                        onClick={() => pick(item)}
                        className={cn(
                          "flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                          index === active && "bg-muted",
                          item.disabledReason && "cursor-not-allowed opacity-60",
                        )}
                      >
                        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                          <Icon aria-hidden className="size-4" />
                        </span>
                        <span className="grid min-w-0 flex-1 gap-0.5">
                          <span className="flex flex-wrap items-center gap-2 font-medium">
                            {item.label}
                            {item.badge ? <Badge tone="outline">{item.badge}</Badge> : null}
                          </span>
                          {item.disabledReason || item.description ? (
                            <span className="line-clamp-2 text-xs text-muted-foreground">
                              {item.disabledReason ?? item.description}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------- what can be picked ----------

export const STEP_ICONS: Record<StepKind, LucideIcon> = {
  condition: Filter,
  map: Shuffle,
  approval: ShieldCheck,
  action: Bolt,
  delay: Clock,
  branch: Split,
  forEach: Repeat,
  "http.request": Globe,
  "ai.generate": Brain,
  notify: Bell,
  "email.send": Mail,
  "zapier.send": Send,
};

/** Triggers, recommended first: app events, then schedule, manual, Zapier and webhook. */
export function triggerItems(catalog: AutomationCatalog): PickerItem[] {
  return catalog.triggers.map((t): PickerItem => {
    switch (t.kind) {
      case "app.event":
        return {
          id: `app.event:${t.eventId}`,
          group: "When something happens",
          label: t.title.replace(/^When: /, ""),
          description: t.description,
          icon: Zap,
          keywords: [t.eventId, t.actionId],
        };
      case "schedule":
        return {
          id: "schedule",
          group: "Anytime",
          label: "On a schedule",
          description: t.description,
          icon: CalendarClock,
          keywords: [
            "every daily weekly monthly hourly cron time morning evening week month day hour",
            "monday tuesday wednesday thursday friday saturday sunday weekday",
          ],
        };
      case "manual":
        return {
          id: "manual",
          group: "Anytime",
          label: "Run it myself",
          description: t.description,
          icon: Hand,
          keywords: ["manual", "button", "form"],
        };
      case "webhook":
        return {
          id: "webhook",
          group: "Other systems",
          label: "Incoming webhook",
          description: t.description,
          icon: Webhook,
          keywords: ["http", "api", "external", "signed"],
        };
      case "zapier.event":
        return {
          id: "zapier.event",
          group: "Other systems",
          label: t.title,
          description: t.description,
          icon: Zap,
          keywords: [
            "zapier zap hubspot stripe sheets typeform mailchimp external integration crm deal invoice",
          ],
        };
    }
  });
}

export type StepChoice =
  { kind: Exclude<StepKind, "action"> } | { kind: "action"; actionId: string };

export function encodeStepChoice(choice: StepChoice): string {
  return choice.kind === "action" ? `action:${choice.actionId}` : choice.kind;
}

export function decodeStepChoice(id: string): StepChoice {
  return id.startsWith("action:")
    ? { kind: "action", actionId: id.slice("action:".length) }
    : { kind: id as Exclude<StepKind, "action"> };
}

const BUILTIN_KEYWORDS: Record<string, string[]> = {
  "ai.generate": ["gpt", "llm", "summarize", "classify", "extract", "draft", "write"],
  "http.request": ["api", "webhook", "post", "request", "url", "slack"],
  notify: ["alert", "tell", "message", "members", "team"],
  "email.send": ["mail", "message", "customer"],
  "zapier.send": ["zap", "hubspot", "sheets", "mailchimp", "crm", "external"],
};

/** Steps grouped the way people think about them: logic, built-in steps, then actions. */
export function stepItems(
  catalog: AutomationCatalog,
  context: { insideLoop: boolean },
): PickerItem[] {
  const logic: PickerItem[] = catalog.logic.map((l) => ({
    id: l.kind,
    group: "Logic",
    label: l.title,
    description: l.description,
    icon: STEP_ICONS[l.kind],
    disabledReason:
      context.insideLoop && (l.kind === "forEach" || l.kind === "approval")
        ? "Not available inside a For each."
        : null,
    keywords:
      l.kind === "branch"
        ? ["if", "else", "otherwise", "condition", "split"]
        : l.kind === "delay"
          ? ["wait", "pause", "later", "sleep", "remind"]
          : l.kind === "forEach"
            ? ["loop", "each", "every", "list", "repeat"]
            : [],
  }));
  const builtins: PickerItem[] = catalog.builtinActions.map((b) => ({
    id: b.kind,
    group: "Send and call",
    label: b.title,
    description: b.description,
    icon: STEP_ICONS[b.kind],
    disabledReason: b.status === "unavailable" ? b.statusReason : null,
    keywords: BUILTIN_KEYWORDS[b.kind] ?? [],
  }));
  const actions: PickerItem[] = [...catalog.actions]
    .sort((a, b) => (a.readOnly === b.readOnly ? 0 : a.readOnly ? 1 : -1))
    .map((a) => ({
      id: encodeStepChoice({ kind: "action", actionId: a.actionId }),
      group: "Actions",
      label: a.title,
      description: a.description,
      icon: a.readOnly ? Search : Bolt,
      badge: a.readOnly ? "Find" : a.confirm ? "Asks first" : undefined,
      keywords: [a.actionId, a.readOnly ? "find lookup get list search" : "create update"],
    }));
  return [...logic, ...builtins, ...actions];
}
