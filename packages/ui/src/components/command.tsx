import { Dialog as DialogPrimitive } from "radix-ui";
import { Search } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type MouseEvent,
  type ReactNode,
} from "react";
import { cn } from "../lib/cn";
import { isApplePlatform } from "../lib/submit-shortcut";
import { Kbd } from "./display";
import { MultiSelect, type MultiSelectOption } from "./multi-select";
import { EmptyState } from "./patterns";

export type CommandItem = {
  id: string;
  /** Section heading, such as "Pages", "Actions" or "Boards". */
  group: string;
  label: string;
  description?: string;
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  keywords?: string[];
  /** Navigates. Modifier-click and ⌘↵ open it in a new tab. */
  href?: string;
  /** Runs instead of navigating. Used for actions that have no page. */
  onSelect?: () => void;
  /** The scope this item belongs to, such as another app. Leave unset for the current one. */
  scope?: string;
};

/**
 * Where Search all looks. The picker replaces the search icon and starts on `current` each time
 * the palette opens. Choosing "All" (an empty selection) shows every scope.
 */
export type CommandScopes = {
  options: MultiSelectOption[];
  current: string;
  onChange?: (value: string[]) => void;
};

/** Opening a page with this query parameter opens Search all with its value typed in. */
export const SEARCH_ALL_PARAM = "search-all";

/** A link to `url` that opens Search all there, searching for `query`. */
export function searchAllHref(url: string, query: string): string {
  const [path, hash = ""] = url.split("#", 2) as [string, string?];
  const joiner = path.includes("?") ? "&" : "?";
  return `${path}${joiner}${SEARCH_ALL_PARAM}=${encodeURIComponent(query)}${hash ? `#${hash}` : ""}`;
}

/** Whether an item is shown under the chosen scopes. An empty choice means all of them. */
export function inCommandScope(item: CommandItem, chosen: string[], current: string): boolean {
  return chosen.length === 0 || chosen.includes(item.scope ?? current);
}

/** Prefix matches rank above substring matches. Empty queries return every item, in order. */
export function filterCommandItems(items: CommandItem[], query: string): CommandItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items
    .map((item, index) => ({ item, index, score: matchScore(item, needle) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}

function matchScore(item: CommandItem, needle: string): number {
  const fields = [item.label, ...(item.keywords ?? [])];
  let best = 0;
  for (const field of fields) {
    const text = field.toLowerCase();
    if (text.startsWith(needle)) best = Math.max(best, 2);
    else if (text.includes(needle)) best = Math.max(best, 1);
  }
  return best;
}

/** Label for the primary modifier key, for shortcut hints. */
export function commandModifier(): string {
  if (typeof navigator === "undefined") return "⌘";
  return isApplePlatform() ? "⌘" : "Ctrl";
}

type CommandGroup = { key: string; group: string; items: CommandItem[] };

/** Groups keep their first position. Scopes are kept apart so two apps' "Pages" don't merge. */
function groupInOrder(items: CommandItem[]): CommandGroup[] {
  const groups: CommandGroup[] = [];
  for (const item of items) {
    const key = `${item.scope ?? ""}\u0000${item.group}`;
    const existing = groups.find((group) => group.key === key);
    if (existing) existing.items.push(item);
    else groups.push({ key, group: item.group, items: [item] });
  }
  return groups;
}

export function CommandPalette({
  open,
  onOpenChange,
  items,
  results,
  loading = false,
  onQueryChange,
  onNavigate,
  placeholder = "Search all...",
  scopes,
  defaultQuery = "",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pages and actions. Filtered inside the palette as the query changes. */
  items: CommandItem[];
  /** Records the caller already matched to the current query. Shown as given. */
  results?: CommandItem[];
  loading?: boolean;
  onQueryChange?: (query: string) => void;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
  placeholder?: string;
  scopes?: CommandScopes;
  /** The query the palette opens with. */
  defaultQuery?: string;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<string[]>(() => (scopes ? [scopes.current] : []));
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef(new Map<string, HTMLElement>());
  const onQueryChangeRef = useRef(onQueryChange);
  onQueryChangeRef.current = onQueryChange;
  const scopesRef = useRef(scopes);
  scopesRef.current = scopes;
  const defaultQueryRef = useRef(defaultQuery);
  defaultQueryRef.current = defaultQuery;
  const modifier = commandModifier();
  const queryActive = query.trim().length > 0;

  const visible = (item: CommandItem) => !scopes || inCommandScope(item, scope, scopes.current);
  const listed = [
    ...filterCommandItems(items.filter(visible), query),
    ...(queryActive ? (results ?? []).filter(visible) : []),
  ];
  const groups = groupInOrder(listed);
  const searchingHere = !scopes || scope.length === 0 || scope.includes(scopes.current);
  const showLoading = loading && queryActive && searchingHere;

  useEffect(() => {
    if (!open) return;
    const initial = defaultQueryRef.current;
    const current = scopesRef.current?.current;
    setQuery(initial);
    setActive(0);
    onQueryChangeRef.current?.(initial);
    if (current) {
      setScope([current]);
      scopesRef.current?.onChange?.([current]);
    }
  }, [open]);

  const activeId = listed[active]?.id;
  useEffect(() => {
    setActive((current) => (listed.length === 0 ? 0 : Math.min(current, listed.length - 1)));
  }, [listed.length]);

  useEffect(() => {
    if (activeId) optionRefs.current.get(activeId)?.scrollIntoView({ block: "nearest" });
  }, [active, activeId]);

  function changeQuery(next: string) {
    setQuery(next);
    setActive(0);
    onQueryChange?.(next);
  }

  function changeScope(next: string[]) {
    setScope(next);
    setActive(0);
    scopes?.onChange?.(next);
  }

  function activate(item: CommandItem, event: { metaKey: boolean; ctrlKey: boolean }) {
    const node = optionRefs.current.get(item.id);
    if (item.href && (event.metaKey || event.ctrlKey)) {
      window.open(item.href, "_blank", "noopener");
      return;
    }
    node?.click();
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay animate-ui-fade-in" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
          onKeyDown={(event) => {
            // Keys pressed in the scope picker's list bubble here through its portal.
            if (event.target !== inputRef.current) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((current) => Math.min(current + 1, Math.max(listed.length - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((current) => Math.max(current - 1, 0));
            } else if (event.key === "Enter" && listed[active]) {
              event.preventDefault();
              activate(listed[active], event);
            }
          }}
          className="fixed left-1/2 top-[12vh] z-50 flex max-h-[min(32rem,80vh)] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface-raised text-foreground shadow-lg animate-ui-slide-up focus:outline-none"
        >
          <DialogPrimitive.Title className="sr-only">Search all</DialogPrimitive.Title>
          <div className="flex items-center gap-2.5 border-b border-border px-3">
            {scopes ? (
              <MultiSelect
                variant="outline"
                aria-label="Search in"
                allLabel="All"
                options={scopes.options}
                value={scope}
                onValueChange={changeScope}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  inputRef.current?.focus();
                }}
                className="shrink-0"
              />
            ) : (
              <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            )}
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded
              aria-controls="command-list"
              aria-activedescendant={listed[active] ? optionId(listed[active].id) : undefined}
              aria-autocomplete="list"
              aria-label={placeholder}
              value={query}
              placeholder={placeholder}
              onChange={(event) => changeQuery(event.target.value)}
              className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/80"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {listed.length === 0 ? (
              showLoading ? (
                <p className="px-3 py-8 text-center text-sm text-muted-foreground" role="status">
                  Searching…
                </p>
              ) : (
                <EmptyState
                  title="No matches"
                  description="Try a different word."
                  className="border-0 py-8"
                />
              )
            ) : (
              <ul id="command-list" role="listbox" aria-label="Search results">
                {groups.map((group) => (
                  <li key={group.key} role="presentation">
                    <p className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted-foreground">
                      {group.group}
                    </p>
                    <ul role="presentation">
                      {group.items.map((item) => {
                        const index = listed.indexOf(item);
                        return (
                          <li key={item.id} role="presentation">
                            <CommandRow
                              item={item}
                              selected={index === active}
                              onHover={() => setActive(index)}
                              onNavigate={onNavigate}
                              onOpenChange={onOpenChange}
                              setNode={(node) => {
                                if (node) optionRefs.current.set(item.id, node);
                                else optionRefs.current.delete(item.id);
                              }}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
                {showLoading ? (
                  <li className="px-2.5 py-2 text-xs text-muted-foreground" role="status">
                    Searching…
                  </li>
                ) : null}
              </ul>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <Hint keys={["↑", "↓"]}>Navigate</Hint>
            <Hint keys={["↵"]}>Open</Hint>
            <Hint keys={[modifier, "↵"]}>Open in new tab</Hint>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Hint({ keys, children }: { keys: string[]; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
      {children}
    </span>
  );
}

/**
 * An absolute URL leaves the app, so it skips the in-app router. In-app links are paths; ui never
 * reads `window.location` (a desktop shell has its own), so any `scheme:` link counts as outside.
 */
function isOtherOrigin(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

function optionId(id: string): string {
  return `command-option-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function CommandRow({
  item,
  selected,
  onHover,
  onNavigate,
  onOpenChange,
  setNode,
}: {
  item: CommandItem;
  selected: boolean;
  onHover: () => void;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
  onOpenChange: (open: boolean) => void;
  setNode: (node: HTMLElement | null) => void;
}) {
  const Icon = item.icon;
  const className = cn(
    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm",
    selected && "bg-muted",
  );
  const body = (
    <>
      {Icon ? <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" /> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{item.label}</span>
        {item.description ? (
          <span className="block truncate text-xs text-muted-foreground">{item.description}</span>
        ) : null}
      </span>
    </>
  );
  if (item.href) {
    return (
      <a
        ref={setNode}
        id={optionId(item.id)}
        role="option"
        aria-selected={selected}
        href={item.href}
        onMouseEnter={onHover}
        onClick={(event) => {
          if (
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey ||
            event.button !== 0
          )
            return;
          if (!isOtherOrigin(item.href!)) onNavigate?.(item.href!, event);
          onOpenChange(false);
        }}
        className={className}
      >
        {body}
      </a>
    );
  }
  return (
    <button
      ref={setNode}
      id={optionId(item.id)}
      type="button"
      role="option"
      aria-selected={selected}
      onMouseEnter={onHover}
      onClick={() => {
        item.onSelect?.();
        onOpenChange(false);
      }}
      className={className}
    >
      {body}
    </button>
  );
}
